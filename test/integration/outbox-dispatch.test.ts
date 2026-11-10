import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";
import type {
  CallbackRequest,
  CallbackTransportOutcome,
} from "../../src/notifications/egress";
import { callbackTransportReadiness } from "../../src/notifications/egress";
import {
  OUTBOX_LEASE_MS,
  reserveOutboxAttempt,
  settleOutboxAttempt,
} from "../../src/notifications/outbox";
import { sealSecret } from "../../src/shared/secret-envelope";

const SECRET = `whsec_${btoa("D".repeat(32))}`;
const SUB = "sub_syntheticDispatcher123456";
const CALLBACK = "https://events.provider.example.org/callback/synthetic";

type Harness = {
  outboxDispatchEnabled(): boolean;
  sendOutboxWebhook(
    destination: string,
    request: CallbackRequest,
  ): Promise<CallbackTransportOutcome>;
  deadlines: { checkpoint(phase: string): Promise<void> };
};

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

// These private in-object replacements are deliberately not runtime bindings,
// public RPCs, a readiness claim, or evidence of production-origin delivery.
async function syntheticAlarm(
  f: Awaited<ReturnType<typeof fixture>>,
  send: Harness["sendOutboxWebhook"],
) {
  await runInDurableObject(f.stub, async (instance) => {
    const harness = instance as unknown as Harness;
    harness.outboxDispatchEnabled = () => true;
    harness.sendOutboxWebhook = send;
    await instance.alarm();
  });
}

describe("alarm outbox dispatcher in Workerd/SQLite (synthetic transport, not REQ-010 acceptance)", () => {
  it("keeps the real capability gate closed without attempts or due-alarm spin, including reconstruction", async () => {
    const f = await fixture();
    expect(callbackTransportReadiness()).toEqual({
      enabled: false,
      reason: "connection-boundary-unverified",
    });
    for (let pass = 0; pass < 2; pass++) {
      await runInDurableObject(f.stub, async (instance, state) => {
        await instance.alarm();
        expect(await state.storage.getAlarm()).toBeGreaterThan(
          Date.now() + 60_000,
        );
      });
      expect((await f.rows())[0]).toMatchObject({
        status: "pending",
        attempt_count: 0,
        first_attempt_at: null,
      });
      await evictDurableObject(f.stub);
    }
  });

  it("persists a bounded lease before transport, signs only original committed metadata and accepts 2xx", async () => {
    const f = await fixture();
    const original = (await f.rows())[0];
    let calls = 0;
    await runInDurableObject(f.stub, async (instance, state) => {
      const h = instance as unknown as Harness;
      h.outboxDispatchEnabled = () => true;
      h.sendOutboxWebhook = async (destination, request) => {
        calls++;
        const row = state.storage.sql
          .exec<Row>("SELECT * FROM table_event_outbox")
          .one();
        expect(row).toMatchObject({ status: "in_flight", attempt_count: 1 });
        expect(row.lease_token).toBeTruthy();
        expect((row.lease_deadline ?? 0) - (row.first_attempt_at ?? 0)).toBe(
          OUTBOX_LEASE_MS,
        );
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(destination).toBe(CALLBACK);
        const body = new TextDecoder().decode(request.body);
        expect(body).not.toContain("PRIVATE SYNTHETIC BODY");
        expect(body).not.toContain(f.guestId);
        const verified = new Webhook(SECRET).verify(
          body,
          request.headers as Record<string, string>,
        );
        expect(verified).toEqual({
          eventId: original.event_id,
          name: "table.message.created",
          timestamp: new Date(original.created_at).toISOString(),
          cursor: null,
          data: {
            table_id: f.tableId,
            message_id: original.message_id,
            seq: 1,
            inbox_uri: `agent-table://tables/${f.tableId}/inbox/${f.memberId}`,
          },
        });
        return { ok: true, status: 204, body: new Uint8Array() };
      };
      await instance.alarm();
    });
    expect(calls).toBe(1);
    expect((await f.rows())[0]).toMatchObject({
      status: "accepted",
      attempt_count: 1,
      lease_token: null,
    });
  });

  it("bounds a batch, preserves retry identity/budget across eviction, and schedules only remaining work", async () => {
    const f = await fixture(6);
    const before = await f.rows();
    let calls = 0;
    await syntheticAlarm(f, async () => {
      calls++;
      return { ok: false, reason: "upstream-non-2xx", status: 503 };
    });
    expect(calls).toBe(4);
    const retried = await f.rows();
    expect(retried.filter((row) => row.attempt_count === 1)).toHaveLength(4);
    expect(retried.every((row) => row.status === "pending")).toBe(true);
    await evictDurableObject(f.stub);
    // Reconstruct with the real disabled gate. No retries are consumed.
    await runInDurableObject(f.stub, (instance) => instance.alarm());
    expect(await f.rows()).toEqual(retried);
    expect(
      (await f.rows()).map((row) => [row.event_id, row.message_id]),
    ).toEqual(before.map((row) => [row.event_id, row.message_id]));
  });

  it("does not reserve for revoked grants, expired subscriptions, or mismatched memberships", async () => {
    for (const intervention of ["revoke", "expire", "membership"] as const) {
      const f = await fixture();
      if (intervention === "revoke") await f.revoke();
      else
        await runInDurableObject(f.stub, (_instance, state) => {
          state.storage.sql.exec(
            intervention === "expire"
              ? "UPDATE table_event_subscriptions SET expires_at = 1"
              : "UPDATE table_event_subscriptions SET guest_id = 'not-the-member'",
          );
        });
      let calls = 0;
      await syntheticAlarm(f, async () => {
        calls++;
        throw new Error("Unexpected send");
      });
      expect(calls).toBe(0);
      expect((await f.rows())[0]).toMatchObject({
        status: "cancelled",
        attempt_count: 0,
        first_attempt_at: null,
      });
    }
  });

  it("refunds an unsent reservation when pause or grant revocation occurs after durable commit", async () => {
    for (const intervention of ["pause", "revoke", "close"] as const) {
      const f = await fixture();
      await runInDurableObject(f.stub, async (instance, state) => {
        const h = instance as unknown as Harness;
        let enabled = true;
        h.outboxDispatchEnabled = () => enabled;
        h.sendOutboxWebhook = async () => {
          throw new Error("Must not send");
        };
        h.deadlines.checkpoint = async (phase) => {
          if (phase !== "after-durable-commit") return;
          const row = state.storage.sql
            .exec<Row>("SELECT * FROM table_event_outbox")
            .one();
          if (row.status !== "in_flight") return;
          if (intervention === "pause") enabled = false;
          else if (intervention === "revoke") {
            const guest = env.GUESTS.get(env.GUESTS.idFromName(f.guestId));
            await guest.revokeConnection(
              f.session.sessionId,
              f.session.secret,
              f.grant.connectionId,
            );
          } else
            state.storage.sql.exec(
              "UPDATE table_metadata SET state = 'closed'",
            );
        };
        await instance.alarm();
      });
      const row = (await f.rows())[0];
      expect(row.attempt_count).toBe(0);
      expect(row.first_attempt_at).toBeNull();
      expect(row.status).toBe(
        intervention === "revoke" ? "cancelled" : "pending",
      );
    }
  });

  it("rejects late completion after cancellation, generation change, or purge without resurrecting data", async () => {
    for (const intervention of ["cancel", "generation", "purge"] as const) {
      const f = await fixture();
      await runInDurableObject(f.stub, async (instance, state) => {
        const h = instance as unknown as Harness;
        h.outboxDispatchEnabled = () => true;
        h.sendOutboxWebhook = async () => {
          if (intervention === "purge")
            state.storage.sql.exec("DELETE FROM table_event_outbox");
          else if (intervention === "cancel")
            state.storage.sql.exec(
              "UPDATE table_event_outbox SET status = 'cancelled', lease_token = NULL, lease_deadline = NULL",
            );
          else {
            state.storage.sql.exec(
              "UPDATE table_event_subscriptions SET generation = 2, fence = 2",
            );
            state.storage.sql.exec(
              "UPDATE table_event_outbox SET subscription_generation = 2",
            );
          }
          return { ok: true, status: 200, body: new Uint8Array() };
        };
        await instance.alarm();
      });
      const rows = await f.rows();
      if (intervention === "purge") expect(rows).toEqual([]);
      else
        expect(rows[0].status).toBe(
          intervention === "cancel" ? "cancelled" : "in_flight",
        );
    }
  });

  it("reclaims a persisted abandoned lease after eviction and rejects its stale completion", async () => {
    const f = await fixture();
    const original = (await f.rows())[0];
    const lease = await runInDurableObject(f.stub, (_instance, state) =>
      reserveOutboxAttempt(state.storage.sql, original.event_id, 1, Date.now()),
    );
    if (!lease) throw new Error("Missing lease");
    // Move the abandoned lease to a deterministic elapsed deadline.
    await runInDurableObject(f.stub, (_instance, state) =>
      state.storage.sql.exec(
        "UPDATE table_event_outbox SET lease_deadline = ?",
        Date.now() - 1,
      ),
    );
    await evictDurableObject(f.stub);
    await syntheticAlarm(f, async () => ({
      ok: true,
      status: 204,
      body: new Uint8Array(),
    }));
    const row = (await f.rows())[0];
    expect(row).toMatchObject({
      event_id: original.event_id,
      attempt_count: 2,
      first_attempt_at: lease.firstAttemptAt,
      status: "accepted",
    });
    expect(
      await runInDurableObject(f.stub, (_instance, state) =>
        settleOutboxAttempt(state.storage.sql, lease, Date.now(), {
          kind: "accepted",
        }),
      ),
    ).toBeNull();
  });

  it("defers an unavailable GuestDO without charging attempts or spinning alarms", async () => {
    const f = await fixture();
    await runInDurableObject(f.guest, (instance) => {
      instance.authorizeConnection = () => ({
        allowed: false,
        reason: "unavailable",
      });
    });
    let calls = 0;
    await syntheticAlarm(f, async () => {
      calls++;
      return { ok: true, status: 204, body: new Uint8Array() };
    });
    const row = (await f.rows())[0];
    expect(calls).toBe(0);
    expect(row).toMatchObject({
      status: "pending",
      attempt_count: 0,
      first_attempt_at: null,
    });
    expect(row.next_attempt_at).toBeGreaterThan(Date.now() + 50_000);
    await runInDurableObject(f.stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(row.next_attempt_at);
    });
  });

  it("makes 410 and 413 terminal through the alarm without another attempt", async () => {
    for (const status of [410, 413]) {
      const f = await fixture();
      let calls = 0;
      const send: Harness["sendOutboxWebhook"] = async () => {
        calls++;
        return { ok: false, reason: "upstream-non-2xx", status };
      };
      await syntheticAlarm(f, send);
      await syntheticAlarm(f, send);
      expect(calls).toBe(1);
      expect((await f.rows())[0]).toMatchObject({
        status: "failed",
        attempt_count: 1,
        next_attempt_at: null,
      });
    }
  });

  it("exhausts eight attempts across reconstructions while preserving event and first-attempt identity", async () => {
    const f = await fixture();
    const original = (await f.rows())[0];
    let first: number | null = null;
    for (let attempt = 1; attempt <= 8; attempt++) {
      // Advance only the due timestamp; budget, lease and horizon stay persisted.
      await runInDurableObject(f.stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_event_outbox SET next_attempt_at = ? WHERE status = 'pending'",
          Date.now() - 1,
        );
      });
      await evictDurableObject(f.stub);
      await syntheticAlarm(f, async () => ({ ok: false, reason: "deadline" }));
      const row = (await f.rows())[0];
      first ??= row.first_attempt_at;
      expect(row).toMatchObject({
        event_id: original.event_id,
        message_id: original.message_id,
        first_attempt_at: first,
        attempt_count: attempt,
        status: attempt === 8 ? "failed" : "pending",
      });
      if (attempt < 8) expect(row.next_attempt_at).toBeGreaterThan(Date.now());
    }
    let calls = 0;
    await syntheticAlarm(f, async () => {
      calls++;
      throw new Error("Exhausted");
    });
    expect(calls).toBe(0);
  });

  it("bounds Retry-After and retains the same signed event after an ambiguous response loss", async () => {
    const f = await fixture();
    const bodies: string[] = [];
    await syntheticAlarm(f, async (_destination, request) => {
      bodies.push(new TextDecoder().decode(request.body));
      return {
        ok: false,
        reason: "upstream-non-2xx",
        status: 429,
        retryAfterMs: 99_000_000,
      };
    });
    const delayed = (await f.rows())[0];
    expect(delayed.next_attempt_at).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(delayed.next_attempt_at).toBeGreaterThan(Date.now() + 890_000);
    await runInDurableObject(f.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE table_event_outbox SET next_attempt_at = ?",
        Date.now() - 1,
      );
    });
    await evictDurableObject(f.stub);
    await syntheticAlarm(f, async (_destination, request) => {
      bodies.push(new TextDecoder().decode(request.body));
      // Synthetic receiver acceptance followed by a lost response. No real
      // receiver capture or exactly-once delivery is asserted here.
      throw new Error("Synthetic response loss");
    });
    expect(bodies[1]).toBe(bodies[0]);
    expect((await f.rows())[0]).toMatchObject({
      status: "pending",
      attempt_count: 2,
      first_attempt_at: delayed.first_attempt_at,
    });
  });

  it("recovers a failed lease commit without starting transport or consuming an attempt", async () => {
    const f = await fixture();
    let calls = 0;
    await runInDurableObject(f.stub, async (instance, state) => {
      const h = instance as unknown as Harness;
      h.outboxDispatchEnabled = () => true;
      h.sendOutboxWebhook = async () => {
        calls++;
        throw new Error("Uncommitted");
      };
      h.deadlines.checkpoint = async (phase) => {
        if (
          phase === "after-mutation" &&
          state.storage.sql.exec<Row>("SELECT * FROM table_event_outbox").one()
            .status === "in_flight"
        )
          throw new Error("Synthetic lease transaction fault");
      };
      await expect(instance.alarm()).rejects.toThrow(
        "Table cleanup unavailable",
      );
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(calls).toBe(0);
    expect((await f.rows())[0]).toMatchObject({
      status: "pending",
      attempt_count: 0,
    });
    await evictDurableObject(f.stub);
    await syntheticAlarm(f, async () => ({
      ok: true,
      status: 204,
      body: new Uint8Array(),
    }));
    expect((await f.rows())[0]).toMatchObject({
      status: "accepted",
      attempt_count: 1,
    });
  });

  it("measures bounded failing-callback workload without logging private fields", async () => {
    const f = await fixture(6);
    const captured: Array<Record<string, unknown>> = [];
    const recorder = vi.spyOn(console, "log").mockImplementation((value) => {
      if (value && typeof value === "object")
        captured.push(value as Record<string, unknown>);
    });
    try {
      await syntheticAlarm(f, async () => ({
        ok: false,
        reason: "upstream-non-2xx",
        status: 503,
      }));
      const metrics = captured.filter((row) => row.kind === "metric");
      expect(
        metrics
          .filter((row) => row.name === "outbox.attempt")
          .reduce((sum, row) => sum + Number(row.value), 0),
      ).toBe(4);
      expect(
        metrics
          .filter((row) => row.name === "outbox.retry")
          .reduce((sum, row) => sum + Number(row.value), 0),
      ).toBe(4);
      expect(metrics).toContainEqual(
        expect.objectContaining({ name: "outbox.pending", value: 6 }),
      );
      expect(metrics).toContainEqual(
        expect.objectContaining({
          name: "outbox.oldest_age_ms",
          value: expect.any(Number),
        }),
      );
      const serialized = JSON.stringify(captured);
      for (const privateField of [
        f.tableId,
        f.guestId,
        f.memberId,
        CALLBACK,
        SECRET,
        "PRIVATE SYNTHETIC BODY",
      ])
        expect(serialized).not.toContain(privateField);
    } finally {
      recorder.mockRestore();
    }
  });

  it("refuses completion at its exact lease deadline even without a newer lease", async () => {
    const f = await fixture();
    await runInDurableObject(f.stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<Row>("SELECT * FROM table_event_outbox")
        .one();
      const lease = reserveOutboxAttempt(
        state.storage.sql,
        row.event_id,
        1,
        Date.now(),
      );
      if (!lease) throw new Error("Missing lease");
      expect(
        settleOutboxAttempt(state.storage.sql, lease, lease.leaseDeadline, {
          kind: "accepted",
        }),
      ).toBeNull();
      expect(
        state.storage.sql.exec<Row>("SELECT * FROM table_event_outbox").one()
          .status,
      ).toBe("in_flight");
    });
  });
});
