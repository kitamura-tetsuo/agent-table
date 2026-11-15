import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sealSecret } from "../../src/shared/secret-envelope";

const SECRET = `whsec_${btoa("D".repeat(32))}`;
const SUB = "sub_syntheticDispatcher123456";
const CALLBACK = "https://events.provider.example.org/callback/synthetic";

type Row = {
  event_id: string;
  message_id: string;
  message_seq: number;
  created_at: number;
  status: string;
  attempt_count: number;
  lease_token: string | null;
  first_attempt_at: number | null;
  next_attempt_at: number | null;
  lease_deadline: number | null;
};

/** Real GuestDO grants and TableDO SQLite; transport outcomes are synthetic only. */
async function fixture(count = 1) {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const grant = await guest.createConnection(
    session.sessionId,
    session.secret,
    ["events:subscribe"],
    Date.now() + 3_600_000,
  );
  if (!grant) throw new Error("Missing synthetic grant");
  const tableId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const senderId = crypto.randomUUID();
  const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
  const envelope = await sealSecret(
    "callback-credential",
    SECRET,
    { recordId: `event:${SUB}` },
    env,
  );
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const now = Date.now();
    sql.exec(
      "INSERT INTO table_metadata (singleton, table_id, creation_request_id, request_digest, creator_guest_id, title, state, created_at, expires_at, last_seq) VALUES (1, ?, ?, ?, ?, 'Synthetic dispatch', 'open', ?, ?, ?)",
      tableId,
      crypto.randomUUID(),
      "a".repeat(64),
      guestId,
      now - 1000,
      now + 3_600_000,
      count,
    );
    sql.exec(
      "INSERT INTO table_memberships (membership_id, table_id, guest_id, seat, role, joined_at) VALUES (?, ?, ?, 1, 'creator', ?)",
      memberId,
      tableId,
      guestId,
      now,
    );
    sql.exec(
      "INSERT INTO table_memberships (membership_id, table_id, guest_id, seat, role, joined_at) VALUES (?, ?, ?, 2, 'invitee', ?)",
      senderId,
      tableId,
      crypto.randomUUID(),
      now,
    );
    sql.exec(
      "INSERT INTO table_event_subscriptions (membership_id, generation, fence, status, guest_id, connection_id, subscription_id, callback_url, secret_envelope, expires_at) VALUES (?, 1, 1, 'active', ?, ?, ?, ?, ?, ?)",
      memberId,
      guestId,
      grant.connectionId,
      SUB,
      CALLBACK,
      envelope,
      now + 3_600_000,
    );
    for (let seq = 1; seq <= count; seq++) {
      const messageId = crypto.randomUUID();
      sql.exec(
        "INSERT INTO table_messages (seq, message_id, sender_membership_id, body, body_bytes, created_at) VALUES (?, ?, ?, 'PRIVATE SYNTHETIC BODY', 22, ?)",
        seq,
        messageId,
        senderId,
        now - 1000,
      );
      sql.exec(
        "INSERT INTO table_event_outbox (event_id, message_id, message_seq, recipient_membership_id, subscription_id, subscription_generation, created_at, expires_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
        crypto.randomUUID(),
        messageId,
        seq,
        memberId,
        SUB,
        now - 1000,
        now + 3_600_000,
        now - 1,
      );
    }
  });
  const rows = () =>
    runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Row>("SELECT * FROM table_event_outbox ORDER BY message_seq")
        .toArray(),
    );
  const revoke = () =>
    guest.revokeConnection(
      session.sessionId,
      session.secret,
      grant.connectionId,
    );
  return {
    context: {} as {
      instance: import("../../src/objects/table").TableDO;
      storage: DurableObjectStorage;
    },
    stub,
    rows,
    revoke,
    tableId,
    memberId,
    guestId,
    guest,
    grant,
    session,
  };
}

type RelayHarness = {
  outboxDispatchEnabled(): boolean;
  relayOutboxTransport():
    | import("../../src/notifications/relay-outbox").RelayOutboxAdapter
    | null;
};
const configuration = {
  origin: "https://relay.example.org",
  callerId: "synthetic-caller-01",
  audience: "test:synthetic-relay",
  signingKeyPkcs8: "unused-synthetic-seam",
  callbackTargets: [],
};
async function relayAlarm(
  f: Awaited<ReturnType<typeof fixture>>,
  send: import("../../src/notifications/relay-outbox").RelayOutboxAdapter["send"],
  read: import("../../src/notifications/relay-outbox").RelayOutboxAdapter["read"] = async () => ({
    ok: true,
    state: "unknown",
  }),
) {
  await runInDurableObject(f.stub, async (instance, state) => {
    f.context.instance = instance;
    f.context.storage = state.storage;
    const h = instance as unknown as RelayHarness;
    h.outboxDispatchEnabled = () => true;
    let failure: unknown;
    h.relayOutboxTransport = () => ({
      configuration,
      send: async (...args) => {
        try {
          return await send(...args);
        } catch (error) {
          failure = error;
          throw error;
        }
      },
      read: async (...args) => {
        try {
          return await read(...args);
        } catch (error) {
          failure = error;
          throw error;
        }
      },
    });
    await instance.alarm();
    if (failure) throw failure;
  });
}
const ledger = (f: Awaited<ReturnType<typeof fixture>>) =>
  runInDurableObject(f.stub, (_instance, state) =>
    state.storage.sql
      .exec("SELECT * FROM table_event_relay_attempts ORDER BY ordinal")
      .toArray(),
  );
afterEach(() => vi.useRealTimers());
describe("relay TableDO candidate, real SQL/alarm with synthetic relay only", () => {
  it("records identity before forwarding and accepts only exact current lease", async () => {
    const f = await fixture();
    await relayAlarm(f, async (_c, op, _d, _r, authorize) => {
      expect(await authorize()).toBe(true);
      const rows = f.context.storage.sql
        .exec("SELECT * FROM table_event_relay_attempts")
        .toArray();
      expect(rows[0]).toMatchObject({
        request_id: op.requestId,
        issued_at: op.timestamp,
        state: "dispatched",
      });
      return {
        ok: true,
        outcome: { kind: "http", status: 204, retryAfterState: "absent" },
      };
    });
    expect((await f.rows())[0].status).toBe("accepted");
    expect((await ledger(f))[0]).toMatchObject({
      state: "completed",
      transport_reserved: 1,
    });
  });
  it("retains unknown identity across reconstruction and retries a new ordinal within original budget", async () => {
    const f = await fixture();
    const sends: string[] = [];
    const send: import("../../src/notifications/relay-outbox").RelayOutboxAdapter["send"] =
      async (_c, op, _d, _r, authorize) => {
        expect(await authorize()).toBe(true);
        sends.push(op.requestId);
        return { ok: false, reason: "transport-error" };
      };
    await relayAlarm(f, send);
    const original = (await ledger(f))[0];
    const first = (await f.rows())[0];
    await evictDurableObject(f.stub);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((first.lease_deadline ?? 0) + 1);
    let reads = 0;
    await relayAlarm(f, send, async (_c, request, authorize) => {
      expect(request.requestId).toBe(original.request_id);
      expect(request.operationDigest).toBe(original.operation_digest);
      expect(await authorize()).toBe(true);
      reads++;
      return { ok: true, state: "unknown" };
    });
    const recovered = (await f.rows())[0];
    expect(reads).toBe(1);
    expect(sends).toHaveLength(1);
    expect(recovered.status).toBe("pending");
    expect(recovered.attempt_count).toBe(1);
    vi.setSystemTime((recovered.next_attempt_at ?? 0) + 1);
    await relayAlarm(f, send);
    expect(sends).toHaveLength(2);
    expect(sends[1]).not.toBe(sends[0]);
    expect((await f.rows())[0]).toMatchObject({
      event_id: first.event_id,
      attempt_count: 2,
      first_attempt_at: first.first_attempt_at,
    });
    expect((await ledger(f))[0]).toEqual(original);
  });
  it("never applies challenge status evidence to a message operation", async () => {
    const f = await fixture();
    let sends = 0;
    const send: import("../../src/notifications/relay-outbox").RelayOutboxAdapter["send"] =
      async (_c, _o, _d, _r, authorize) => {
        expect(await authorize()).toBe(true);
        sends++;
        return { ok: false, reason: "transport-error" };
      };
    await relayAlarm(f, send);
    const original = (await ledger(f))[0];
    const first = (await f.rows())[0];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((first.lease_deadline ?? 0) + 1);
    await relayAlarm(f, send, async () => ({
      ok: true,
      state: "completed",
      outcome: { kind: "challenge", verification: "verified" },
    }));
    expect(sends).toBe(1);
    expect((await f.rows())[0]).toMatchObject({
      status: "in_flight",
      lease_token: first.lease_token,
      attempt_count: 1,
    });
    expect((await ledger(f))[0]).toEqual(original);
  });
  it("does not apply old generation receipt after refresh", async () => {
    const f = await fixture();
    await relayAlarm(f, async (_c, _o, _d, _r, authorize) => {
      expect(await authorize()).toBe(true);
      f.context.storage.sql.exec(
        "UPDATE table_event_subscriptions SET generation=2, fence=2",
      );
      f.context.storage.sql.exec(
        "UPDATE table_event_outbox SET subscription_generation=2",
      );
      return {
        ok: true,
        outcome: { kind: "http", status: 204, retryAfterState: "absent" },
      };
    });
    expect((await f.rows())[0].status).toBe("in_flight");
    expect((await ledger(f))[0].generation).toBe(1);
  });
  it("legacy advice unknown waits longer than observed absent and never extends the original horizon", async () => {
    for (const advice of ["unknown", "absent"] as const) {
      const f = await fixture();
      await relayAlarm(f, async (_c, _o, _d, _r, authorize) => {
        expect(await authorize()).toBe(true);
        return {
          ok: true,
          outcome: { kind: "http", status: 503, retryAfterState: advice },
        };
      });
      const row = (await f.rows())[0];
      expect(row.status).toBe("pending");
      const remaining = (row.next_attempt_at ?? 0) - Date.now();
      if (advice === "unknown") expect(remaining).toBeGreaterThan(890000);
      else expect(remaining).toBeLessThan(2000);
    }
  });
  it("deletion purge removes ledger and refuses late completion resurrection", async () => {
    const f = await fixture();
    await relayAlarm(f, async (_c, _o, _d, _r, authorize) => {
      expect(await authorize()).toBe(true);
      (
        f.context.instance as unknown as {
          purgeContent(now: number, state: "deleted"): unknown;
        }
      ).purgeContent(Date.now(), "deleted");
      return {
        ok: true,
        outcome: { kind: "http", status: 204, retryAfterState: "absent" },
      };
    });
    expect(await f.rows()).toEqual([]);
    expect(await ledger(f)).toEqual([]);
  });
});

describe("relay recovery budgets and original Retry-After clock", () => {
  it("charges exactly eight attempts across unknown recoveries, never a ninth", async () => {
    const f = await fixture();
    let sends = 0;
    const send: import("../../src/notifications/relay-outbox").RelayOutboxAdapter["send"] =
      async (_c, _o, _d, _r, authorize) => {
        expect(await authorize()).toBe(true);
        sends++;
        return { ok: false, reason: "transport-error" };
      };
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let count = 1; count <= 8; count++) {
      await relayAlarm(f, send);
      const row = (await f.rows())[0];
      expect(row.attempt_count).toBe(count);
      vi.setSystemTime((row.lease_deadline ?? 0) + 1);
      await relayAlarm(f, send);
      const recovered = (await f.rows())[0];
      if (count < 8) {
        expect(recovered.status).toBe("pending");
        vi.setSystemTime((recovered.next_attempt_at ?? 0) + 1);
      }
    }
    expect(sends).toBe(8);
    expect((await f.rows())[0].status).toBe("failed");
    await relayAlarm(f, send);
    expect(sends).toBe(8);
    expect(await ledger(f)).toHaveLength(8);
  });
  it("readback uses original observation time, not a renewed Retry-After delay", async () => {
    const f = await fixture();
    let timestamp = 0;
    await relayAlarm(f, async (_c, op, _d, _r, authorize) => {
      expect(await authorize()).toBe(true);
      timestamp = op.timestamp;
      return { ok: false, reason: "transport-error" };
    });
    const original = (await f.rows())[0];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((original.lease_deadline ?? 0) + 1);
    await relayAlarm(
      f,
      async () => {
        throw new Error("readback must not forward");
      },
      async (_c, _r, authorize) => {
        expect(await authorize()).toBe(true);
        return {
          ok: true,
          state: "completed",
          outcome: {
            kind: "http",
            status: 429,
            retryAfterState: "known",
            retryAfterSeconds: 30,
            retryAfterObservedAt: timestamp,
          },
        };
      },
    );
    const row = (await f.rows())[0];
    expect(row.status).toBe("pending");
    expect((row.next_attempt_at ?? 0) - Date.now()).toBeLessThan(2000);
    expect((await ledger(f))[0].state).toBe("completed");
  });
  it("original validity horizon and observed revocation prohibit later sends", async () => {
    const f = await fixture();
    let sends = 0;
    const send: import("../../src/notifications/relay-outbox").RelayOutboxAdapter["send"] =
      async (_c, _o, _d, _r, authorize) => {
        expect(await authorize()).toBe(true);
        sends++;
        return { ok: false, reason: "transport-error" };
      };
    await relayAlarm(f, send);
    await f.revoke();
    const row = (await f.rows())[0];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((row.lease_deadline ?? 0) + 1);
    await relayAlarm(f, send);
    expect(sends).toBe(1);
    expect((await f.rows())[0].status).toBe("cancelled");
    vi.setSystemTime((row.first_attempt_at ?? 0) + 3600001);
    await relayAlarm(f, send);
    expect(sends).toBe(1);
  });
});

it("saved definitive 204/410 survives a lost settlement and unavailable remote readback", async () => {
  for (const status of [204, 410]) {
    const f = await fixture();
    let sends = 0;
    let reads = 0;
    await relayAlarm(f, async (_c, _o, _d, _r, authorize) => {
      expect(await authorize()).toBe(true);
      sends++;
      const row = f.context.storage.sql
        .exec<{ lease_deadline: number }>(
          "SELECT lease_deadline FROM table_event_outbox",
        )
        .one();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(row.lease_deadline + 1);
      return {
        ok: true,
        outcome: { kind: "http", status, retryAfterState: "absent" },
      };
    });
    expect((await f.rows())[0].status).toBe("in_flight");
    expect((await ledger(f))[0].state).toBe("completed");
    await relayAlarm(
      f,
      async () => {
        sends++;
        throw new Error("must not send");
      },
      async () => {
        reads++;
        return { ok: false, reason: "unavailable" };
      },
    );
    expect((await f.rows())[0].status).toBe(
      status === 204 ? "accepted" : "failed",
    );
    expect(sends).toBe(1);
    expect(reads).toBe(0);
    vi.useRealTimers();
  }
});

it("temporary credential decryption failure cannot erase a saved relay receipt lease", async () => {
  const f = await fixture();
  let envelope = "";
  let sends = 0;
  await relayAlarm(f, async (_c, _o, _d, _r, authorize) => {
    expect(await authorize()).toBe(true);
    sends++;
    envelope = f.context.storage.sql
      .exec<{ secret_envelope: string }>(
        "SELECT secret_envelope FROM table_event_subscriptions",
      )
      .one().secret_envelope;
    const lease = f.context.storage.sql
      .exec<{ lease_deadline: number }>(
        "SELECT lease_deadline FROM table_event_outbox",
      )
      .one().lease_deadline;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(lease + 1);
    return {
      ok: true,
      outcome: { kind: "http", status: 410, retryAfterState: "absent" },
    };
  });
  const original = (await f.rows())[0];
  await runInDurableObject(f.stub, (_i, state) => {
    state.storage.sql.exec(
      "UPDATE table_event_subscriptions SET secret_envelope='invalid-synthetic-envelope'",
    );
  });
  await relayAlarm(f, async () => {
    throw new Error("must not forward");
  });
  expect((await f.rows())[0]).toMatchObject({
    status: "in_flight",
    lease_token: original.lease_token,
    attempt_count: 1,
  });
  await runInDurableObject(f.stub, (_i, state) => {
    state.storage.sql.exec(
      "UPDATE table_event_subscriptions SET secret_envelope=?",
      envelope,
    );
  });
  vi.setSystemTime(Date.now() + 60001);
  await relayAlarm(f, async () => {
    sends++;
    throw new Error("must not forward");
  });
  expect((await f.rows())[0].status).toBe("failed");
  expect(sends).toBe(1);
});

it("eighth charged attempt's saved acceptance wins over budget-only expiry cleanup", async () => {
  const f = await fixture();
  let sends = 0;
  await runInDurableObject(f.stub, (_i, state) => {
    state.storage.sql.exec(
      "UPDATE table_event_outbox SET attempt_count=7, first_attempt_at=?",
      Date.now(),
    );
  });
  await relayAlarm(f, async (_c, _o, _d, _r, authorize) => {
    expect(await authorize()).toBe(true);
    sends++;
    const row = f.context.storage.sql
      .exec<{ lease_deadline: number; attempt_count: number }>(
        "SELECT lease_deadline,attempt_count FROM table_event_outbox",
      )
      .one();
    expect(row.attempt_count).toBe(8);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(row.lease_deadline + 1);
    return {
      ok: true,
      outcome: { kind: "http", status: 204, retryAfterState: "absent" },
    };
  });
  expect((await f.rows())[0].status).toBe("in_flight");
  await runInDurableObject(f.stub, async (instance, state) => {
    (instance as unknown as RelayHarness).outboxDispatchEnabled = () => false;
    await instance.alarm();
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + 60000);
  });
  expect((await f.rows())[0].status).toBe("in_flight");
  await relayAlarm(
    f,
    async () => {
      sends++;
      throw new Error("ninth send forbidden");
    },
    async () => {
      throw new Error("local receipt exists");
    },
  );
  expect((await f.rows())[0]).toMatchObject({
    status: "accepted",
    attempt_count: 8,
  });
  expect(sends).toBe(1);
});
