import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CreationReservation } from "../../src/objects/guest";
import { createTable } from "../../src/services/tables";
import {
  authorizeGuestConnection,
  type VerifiedConnectionActor,
} from "../../src/shared/auth";
import type { SafeTableMetadata, TableResult } from "../../src/shared/table";

const input = {
  request_id: "retry_create_table_request_001",
  title: "Crash-safe table",
  purpose: "Synthetic only",
};

async function makeOwner() {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const grant = await guest.createConnection(
    session.sessionId,
    session.secret,
    ["tables:read", "tables:write"],
    Date.now() + 24 * 60 * 60 * 1000,
  );
  if (!grant) throw new Error("Missing test grant");
  const write = await authorizeGuestConnection(
    env,
    guestId,
    grant.connectionId,
    "tables:write",
  );
  if (!write.allowed) throw new Error("Write grant unavailable");
  const read = await authorizeGuestConnection(
    env,
    guestId,
    grant.connectionId,
    "tables:read",
  );
  if (!read.allowed) throw new Error("Read grant unavailable");
  return { guest, write: write.actor, read: read.actor };
}

type TableStub = ReturnType<Env["TABLES"]["get"]>;
type Initialize = (
  stub: TableStub,
  actor: VerifiedConnectionActor,
  request: unknown,
  receipt: CreationReservation,
) => Promise<TableResult<SafeTableMetadata>>;

/**
 * Intercepts only the TableDO RPC boundary. The wrapped method always invokes
 * the real persisted Durable Object when the scenario permits the call.
 */
function withInitializer(initialize: Initialize): Env {
  const tables = {
    idFromName: (name: string) => env.TABLES.idFromName(name),
    get: (id: DurableObjectId) => ({
      initializeTable: (
        actor: VerifiedConnectionActor,
        request: unknown,
        receipt: CreationReservation,
      ) => initialize(env.TABLES.get(id), actor, request, receipt),
    }),
  };
  return { ...env, TABLES: tables as unknown as Env["TABLES"] };
}

async function reservationRows(guest: ReturnType<Env["GUESTS"]["get"]>) {
  return runInDurableObject(guest, async (_instance, state) =>
    state.storage.sql
      .exec<{
        table_id: string;
        outcome: string;
        charged_at: number;
        expires_at: number;
      }>(
        "SELECT table_id, outcome, charged_at, expires_at FROM guest_creation_reservations",
      )
      .toArray(),
  );
}

describe("create_table recovery at actual GuestDO/TableDO persistence boundaries", () => {
  it("does not report an uninitialized reservation and recovers the same ID", async () => {
    const owner = await makeOwner();
    const denied = await createTable(
      withInitializer(async () => {
        throw new Error("Injected TableDO transport unavailable");
      }),
      owner.write,
      input,
    );
    expect(denied).toEqual({ ok: false, code: "TEMPORARILY_UNAVAILABLE" });
    const reserved = await reservationRows(owner.guest);
    expect(reserved).toHaveLength(1);
    expect(reserved[0].outcome).toBe("reserved");
    const table = env.TABLES.get(env.TABLES.idFromName(reserved[0].table_id));
    expect(await table.getMetadata(owner.read)).toEqual({
      ok: false,
      code: "TABLE_NOT_FOUND",
    });

    await evictDurableObject(owner.guest);
    await evictDurableObject(table);
    const retried = await createTable(env, owner.write, input);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.tableId).toBe(reserved[0].table_id);
    expect(Date.parse(retried.value.expiresAt)).toBe(reserved[0].expires_at);
    expect(await reservationRows(owner.guest)).toEqual([
      { ...reserved[0], outcome: "initialized" },
    ]);
  });

  it("does not claim success after a committed initializer response is dropped", async () => {
    const owner = await makeOwner();
    let committedAttempts = 0;
    const dropped = await createTable(
      withInitializer(async (stub, actor, request, receipt) => {
        const real = await stub.initializeTable(actor, request, receipt);
        expect(real.ok).toBe(true);
        committedAttempts++;
        throw new Error("Injected lost RPC response after persisted commit");
      }),
      owner.write,
      input,
    );
    expect(dropped).toEqual({ ok: false, code: "TEMPORARILY_UNAVAILABLE" });
    expect(committedAttempts).toBe(1);
    const reserved = await reservationRows(owner.guest);
    expect(reserved).toHaveLength(1);
    expect(reserved[0].outcome).toBe("reserved");
    const table = env.TABLES.get(env.TABLES.idFromName(reserved[0].table_id));
    const alreadyCommitted = await table.getMetadata(owner.read);
    expect(alreadyCommitted.ok).toBe(true);

    await evictDurableObject(owner.guest);
    await evictDurableObject(table);
    const retried = await createTable(env, owner.write, input);
    expect(retried).toEqual(alreadyCommitted);
    const rows = await reservationRows(owner.guest);
    expect(rows).toEqual([{ ...reserved[0], outcome: "initialized" }]);
    await runInDurableObject(table, async (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
      ).toHaveLength(1);
    });
  });

  it("joins overlapping retries at the initializer and commits one identity", async () => {
    const owner = await makeOwner();
    let entered = 0;
    let signalBoth = () => {};
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      signalBoth = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withInitializer(async (stub, actor, request, receipt) => {
      entered++;
      if (entered === 2) signalBoth();
      await gate;
      return stub.initializeTable(actor, request, receipt);
    });
    const first = createTable(held, owner.write, input);
    const second = createTable(held, owner.write, input);
    try {
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Initializer did not overlap")), 5_000),
        ),
      ]);
      expect(entered).toBe(2);
    } finally {
      release();
    }
    const [left, right] = await Promise.all([first, second]);
    expect(left.ok).toBe(true);
    expect(right).toEqual(left);
    const rows = await reservationRows(owner.guest);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("initialized");
    const table = env.TABLES.get(env.TABLES.idFromName(rows[0].table_id));
    await runInDurableObject(table, async (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
      ).toHaveLength(1);
    });
  });
});
