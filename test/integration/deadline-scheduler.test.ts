import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DEADLINE_POLICY,
  type DurableDeadlineScheduler,
} from "../../src/shared/deadlines";

type Checkpoint = (phase: string) => Promise<void>;

function schedulerOn(instance: object): DurableDeadlineScheduler {
  return (instance as { deadlines: DurableDeadlineScheduler }).deadlines;
}

async function withCheckpoint<T>(
  scheduler: DurableDeadlineScheduler,
  hook: Checkpoint,
  operation: () => Promise<T>,
): Promise<T> {
  const internal = scheduler as unknown as { checkpoint: Checkpoint };
  const original = internal.checkpoint;
  internal.checkpoint = hook;
  try {
    return await operation();
  } finally {
    internal.checkpoint = original;
  }
}

describe("real SQLite Durable Object alarm scheduling boundaries", () => {
  it("does not erase a new producer's alarm while an old alarm is draining", async () => {
    const table = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    expect(await table.schemaVersion()).toBeGreaterThan(0);
    await runInDurableObject(table, async (instance, state) => {
      const scheduler = schedulerOn(instance);
      state.storage.sql.exec(
        "CREATE TABLE competing_deadlines (id INTEGER PRIMARY KEY, due INTEGER NOT NULL)",
      );
      const expired = Date.now() - 1;
      const newDeadline = Date.now() + 30_000;
      await scheduler.commitWithWakeup(expired, () => {
        state.storage.sql.exec(
          "INSERT INTO competing_deadlines (id, due) VALUES (1, ?)",
          expired,
        );
      });
      const earliest = () =>
        state.storage.sql
          .exec<{ due: number | null }>(
            "SELECT MIN(due) AS due FROM competing_deadlines",
          )
          .one().due;
      let entered: () => void = () => {};
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await withCheckpoint(
        scheduler,
        async (phase) => {
          if (phase === "before-rearm") {
            entered();
            await gate;
          }
        },
        async () => {
          const draining = scheduler.drainDueWork(earliest, (now) => {
            state.storage.sql.exec(
              "DELETE FROM competing_deadlines WHERE due <= ?",
              now,
            );
            return state.storage.sql
              .exec<{ count: number }>("SELECT changes() AS count")
              .one().count;
          });
          await waiting;
          const arriving = scheduler.commitWithWakeup(newDeadline, () => {
            state.storage.sql.exec(
              "INSERT INTO competing_deadlines (id, due) VALUES (2, ?)",
              newDeadline,
            );
          });
          release();
          await Promise.all([draining, arriving]);
        },
      );
      expect(await state.storage.getAlarm()).toBe(newDeadline);
      expect(
        state.storage.sql.exec("SELECT id FROM competing_deadlines").toArray(),
      ).toEqual([{ id: 2 }]);
    });
  });

  it("keeps the future TableDO alarm entry free of imaginary lifecycle work", async () => {
    const table = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    expect(await table.schemaVersion()).toBeGreaterThan(0);
    await runInDurableObject(table, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 10_000);
    });
    expect(await runDurableObjectAlarm(table)).toBe(true);
    await runInDurableObject(table, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(null);
      expect(
        state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
      ).toEqual([]);
    });
  });

  it("rolls back both an arm and a creation, but keeps the wakeup after a lost response", async () => {
    const guestId = crypto.randomUUID();
    const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    expect(await guest.schemaVersion()).toBeGreaterThan(0);
    let persistedExpiry = 0;

    await runInDurableObject(guest, async (instance, state) => {
      const scheduler = schedulerOn(instance);
      for (const phase of ["before-arm", "after-arm", "after-mutation"]) {
        await withCheckpoint(
          scheduler,
          async (at) => {
            if (at === phase) throw new Error(`Injected crash ${phase}`);
          },
          async () => {
            await expect(instance.createSession(guestId)).rejects.toThrow(
              `Injected crash ${phase}`,
            );
          },
        );
        expect(await state.storage.getAlarm()).toBe(null);
        expect(
          state.storage.sql.exec("SELECT * FROM guest_identity").toArray(),
        ).toHaveLength(0);
        expect(
          state.storage.sql.exec("SELECT * FROM guest_sessions").toArray(),
        ).toHaveLength(0);
      }

      await withCheckpoint(
        scheduler,
        async (at) => {
          if (at === "after-durable-commit") {
            throw new Error("Injected lost response after commit");
          }
        },
        async () => {
          await expect(instance.createSession(guestId)).rejects.toThrow(
            "Injected lost response after commit",
          );
        },
      );
      persistedExpiry = state.storage.sql
        .exec<{ expires_at: number }>("SELECT expires_at FROM guest_sessions")
        .one().expires_at;
      expect(await state.storage.getAlarm()).toBe(persistedExpiry);
      expect(
        state.storage.sql.exec("SELECT * FROM guest_identity").toArray(),
      ).toHaveLength(1);
    });

    await evictDurableObject(guest);
    expect(await guest.schemaVersion()).toBeGreaterThan(0);
    await runInDurableObject(guest, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(persistedExpiry);
      expect(
        state.storage.sql.exec("SELECT * FROM guest_sessions").toArray(),
      ).toHaveLength(1);
    });
  });

  it("serializes competing later and earlier requests without postponing the earliest alarm", async () => {
    const table = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    expect(await table.schemaVersion()).toBeGreaterThan(0);
    await runInDurableObject(table, async (instance, state) => {
      const scheduler = schedulerOn(instance);
      state.storage.sql.exec(
        "CREATE TABLE deadline_fixture (id INTEGER PRIMARY KEY, due INTEGER NOT NULL)",
      );
      const early = Date.now() + 45_000;
      const late = early + 60_000;
      let entered: () => void = () => {};
      let resume: () => void = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let arrivals = 0;
      await withCheckpoint(
        scheduler,
        async (phase) => {
          if (phase === "after-arm" && ++arrivals === 1) {
            entered();
            await gate;
          }
        },
        async () => {
          const a = scheduler.commitWithWakeup(early, () => {
            state.storage.sql.exec(
              "INSERT INTO deadline_fixture (id, due) VALUES (?, ?)",
              1,
              early,
            );
            return 1;
          });
          await reached;
          const b = scheduler.commitWithWakeup(late, () => {
            state.storage.sql.exec(
              "INSERT INTO deadline_fixture (id, due) VALUES (?, ?)",
              2,
              late,
            );
            return 2;
          });
          resume();
          expect((await Promise.all([a, b])).map((x) => x.value)).toEqual([
            1, 2,
          ]);
        },
      );
      expect(await state.storage.getAlarm()).toBe(early);
      expect(
        state.storage.sql.exec("SELECT id FROM deadline_fixture").toArray(),
      ).toEqual([{ id: 1 }, { id: 2 }]);
      expect(arrivals).toBe(2);

      // A still-earlier producer can advance, but never postpone, the alarm.
      const earliest = early - 10_000;
      await scheduler.commitWithWakeup(earliest, () => {
        state.storage.sql.exec(
          "INSERT INTO deadline_fixture (id, due) VALUES (?, ?)",
          3,
          earliest,
        );
      });
      expect(await state.storage.getAlarm()).toBe(earliest);
    });
  });

  it("keeps a separate safety alarm through handler failures, then re-arms remaining work", async () => {
    const table = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    expect(await table.schemaVersion()).toBeGreaterThan(0);
    let safetyAlarm = 0;
    await runInDurableObject(table, async (instance, state) => {
      const scheduler = schedulerOn(instance);
      state.storage.sql.exec(
        "CREATE TABLE scheduled_fixture (id INTEGER PRIMARY KEY, due INTEGER NOT NULL)",
      );
      const due = Date.now() - 1;
      await scheduler.commitWithWakeup(due, () => {
        state.storage.sql.exec(
          "INSERT INTO scheduled_fixture (id, due) VALUES (1, ?)",
          due,
        );
      });

      const earliest = () =>
        state.storage.sql
          .exec<{ due: number | null }>(
            "SELECT MIN(due) AS due FROM scheduled_fixture",
          )
          .one().due;
      const process = (now: number, budget: number) => {
        state.storage.sql.exec(
          "DELETE FROM scheduled_fixture WHERE id IN (SELECT id FROM scheduled_fixture WHERE due <= ? LIMIT ?)",
          now,
          budget,
        );
        return state.storage.sql
          .exec<{ count: number }>("SELECT changes() AS count")
          .one().count;
      };

      await withCheckpoint(
        scheduler,
        async (phase) => {
          if (phase === "before-safety-arm") {
            throw new Error("Crash before safety arm");
          }
        },
        async () => {
          await expect(
            scheduler.drainDueWork(earliest, process),
          ).rejects.toThrow("Crash before safety arm");
        },
      );
      expect(earliest()).toBe(due);

      await withCheckpoint(
        scheduler,
        async (phase) => {
          if (phase === "after-safety-arm")
            throw new Error("Crash after safety arm");
        },
        async () => {
          await expect(
            scheduler.drainDueWork(earliest, process),
          ).rejects.toThrow("Crash after safety arm");
        },
      );
      safetyAlarm = (await state.storage.getAlarm()) ?? 0;
      expect(safetyAlarm).toBeGreaterThan(0);
      expect(earliest()).toBe(due);

      for (const phase of ["after-mutation", "before-rearm"]) {
        await withCheckpoint(
          scheduler,
          async (at) => {
            if (at === phase) throw new Error(`Crash ${phase}`);
          },
          async () => {
            await expect(
              scheduler.drainDueWork(earliest, process),
            ).rejects.toThrow(`Crash ${phase}`);
          },
        );
        // The inner atomic transaction rolls back work and keeps its safety alarm.
        expect(earliest()).toBe(due);
        expect(await state.storage.getAlarm()).not.toBe(null);
      }
    });

    await evictDurableObject(table);
    await runInDurableObject(table, async (instance, state) => {
      const scheduler = schedulerOn(instance);
      const earliest = () =>
        state.storage.sql
          .exec<{ due: number | null }>(
            "SELECT MIN(due) AS due FROM scheduled_fixture",
          )
          .one().due;
      const result = await scheduler.drainDueWork(earliest, (now) => {
        state.storage.sql.exec(
          "DELETE FROM scheduled_fixture WHERE due <= ?",
          now,
        );
        return state.storage.sql
          .exec<{ count: number }>("SELECT changes() AS count")
          .one().count;
      });
      expect(result).toEqual({
        processed: 1,
        nextDeadline: null,
        alarmAt: null,
      });
      expect(await state.storage.getAlarm()).toBe(null);
      expect(earliest()).toBe(null);
    });
    expect(safetyAlarm).toBeGreaterThan(0);
    expect(DEADLINE_POLICY.maxDrainBatch).toBe(100);
  });
});
