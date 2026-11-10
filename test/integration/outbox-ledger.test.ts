import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  classifyAttemptOutcome,
  expireOutboxWork,
  OUTBOX_MAX_ATTEMPTS,
  reserveOutboxAttempt,
  settleOutboxAttempt,
} from "../../src/notifications/outbox";

type Sql = DurableObjectStorage["sql"];

function createLedger(sql: Sql, now: number) {
  const tableId = crypto.randomUUID();
  const creatorId = crypto.randomUUID();
  const peerId = crypto.randomUUID();
  const subscriptionId = "sub_exampleLedgerSubscriber1234";
  const expiry = now + 2 * 60 * 60_000;
  sql.exec(
    "INSERT INTO table_metadata (singleton, table_id, creation_request_id, request_digest, creator_guest_id, title, state, created_at, expires_at, last_seq) VALUES (1, ?, ?, ?, ?, 'Synthetic retry ledger', 'open', ?, ?, 3)",
    tableId,
    crypto.randomUUID(),
    "a".repeat(64),
    crypto.randomUUID(),
    now - 1_000,
    expiry,
  );
  sql.exec(
    "INSERT INTO table_memberships (membership_id, table_id, guest_id, seat, role, joined_at) VALUES (?, ?, ?, 1, 'creator', ?)",
    creatorId,
    tableId,
    crypto.randomUUID(),
    now,
  );
  sql.exec(
    "INSERT INTO table_memberships (membership_id, table_id, guest_id, seat, role, joined_at) VALUES (?, ?, ?, 2, 'invitee', ?)",
    peerId,
    tableId,
    crypto.randomUUID(),
    now,
  );
  sql.exec(
    "INSERT INTO table_event_subscriptions (membership_id, generation, fence, status, guest_id, connection_id, subscription_id, expires_at) VALUES (?, 1, 1, 'active', ?, ?, ?, ?)",
    peerId,
    crypto.randomUUID(),
    crypto.randomUUID(),
    subscriptionId,
    expiry,
  );
  const eventIds: string[] = [];
  for (let seq = 1; seq <= 3; seq++) {
    const messageId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    eventIds.push(eventId);
    sql.exec(
      "INSERT INTO table_messages (seq, message_id, sender_membership_id, body, body_bytes, created_at) VALUES (?, ?, ?, 'synthetic', 9, ?)",
      seq,
      messageId,
      creatorId,
      now,
    );
    sql.exec(
      "INSERT INTO table_event_outbox (event_id, message_id, message_seq, recipient_membership_id, subscription_id, subscription_generation, created_at, expires_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
      eventId,
      messageId,
      seq,
      peerId,
      subscriptionId,
      now,
      expiry,
      now + 1_000,
    );
  }
  return { eventIds, peerId, subscriptionId };
}

describe("real-SQL durable outbox lease ledger (no outbound transport)", () => {
  it("persists exactly eight reservations and conserves the original horizon", async () => {
    const stub = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    const now = Date.now();
    const { eventIds } = await runInDurableObject(stub, (_instance, state) =>
      state.storage.transactionSync(() => createLedger(state.storage.sql, now)),
    );
    let due = now + 1_000;
    let originalFirstAttempt: number | null = null;
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      const result = await runInDurableObject(stub, (_instance, state) =>
        state.storage.transactionSync(() => {
          const lease = reserveOutboxAttempt(
            state.storage.sql,
            eventIds[0],
            1,
            due,
          );
          if (!lease) throw new Error("Missing expected lease");
          const outcome = settleOutboxAttempt(
            state.storage.sql,
            lease,
            due + 1,
            { kind: "transient", category: "server-error" },
          );
          const persisted = state.storage.sql
            .exec<{
              first_attempt_at: number;
              next_attempt_at: number | null;
              status: string;
              attempt_count: number;
            }>(
              "SELECT first_attempt_at, next_attempt_at, status, attempt_count FROM table_event_outbox WHERE event_id = ?",
              eventIds[0],
            )
            .one();
          return { lease, outcome, persisted };
        }),
      );
      originalFirstAttempt ??= result.lease.firstAttemptAt;
      expect(result.lease.firstAttemptAt).toBe(originalFirstAttempt);
      expect(result.lease.attemptCount).toBe(attempt);
      expect(result.persisted.attempt_count).toBe(attempt);
      if (attempt === OUTBOX_MAX_ATTEMPTS) {
        expect(result.outcome).toBe("failed");
        expect(result.persisted).toMatchObject({
          next_attempt_at: null,
          status: "failed",
        });
      } else {
        expect(result.outcome).toBe("pending");
        expect(result.persisted.status).toBe("pending");
        expect(result.persisted.next_attempt_at).toBeGreaterThan(due);
        due = result.persisted.next_attempt_at as number;
      }
    }
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.transactionSync(() =>
          reserveOutboxAttempt(
            state.storage.sql,
            eventIds[0],
            1,
            due + 30 * 60_000,
          ),
        ),
      ),
    ).toBeNull();
  });

  it("fences old generations and terminalizes expired work through the real DO alarm", async () => {
    const stub = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    const now = Date.now();
    const { eventIds, peerId } = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.transactionSync(() =>
          createLedger(state.storage.sql, now),
        ),
    );
    const first = await runInDurableObject(stub, (_instance, state) =>
      state.storage.transactionSync(() =>
        reserveOutboxAttempt(state.storage.sql, eventIds[0], 1, now + 1_000),
      ),
    );
    if (!first) throw new Error("Missing initial lease");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          "UPDATE table_event_subscriptions SET generation = 2, fence = 2 WHERE membership_id = ?",
          peerId,
        );
        state.storage.sql.exec(
          "UPDATE table_event_outbox SET subscription_generation = 2 WHERE event_id = ?",
          eventIds[0],
        );
      });
    });
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.transactionSync(() =>
          settleOutboxAttempt(state.storage.sql, first, now + 1_100, {
            kind: "accepted",
          }),
        ),
      ),
    ).toBeNull();
    const recovered = await runInDurableObject(stub, (_instance, state) =>
      state.storage.transactionSync(() =>
        reserveOutboxAttempt(
          state.storage.sql,
          eventIds[0],
          2,
          first.leaseDeadline + 1,
        ),
      ),
    );
    expect(recovered).toMatchObject({
      eventId: first.eventId,
      firstAttemptAt: first.firstAttemptAt,
      attemptCount: 2,
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE table_event_outbox SET expires_at = ? WHERE event_id = ?",
        now - 1,
        eventIds[1],
      );
      // Keep this event's table and subscription active but expire its
      // original retry horizon. The alarm must make it terminal without
      // waiting for its later subscription expiry.
      state.storage.sql.exec(
        `UPDATE table_event_outbox
         SET status = 'in_flight', attempt_count = 1,
           first_attempt_at = ?, lease_token = ?, lease_deadline = ?,
           next_attempt_at = NULL
         WHERE event_id = ?`,
        now - 60 * 60_000 - 1_000,
        crypto.randomUUID(),
        now - 1_000,
        eventIds[2],
      );
    });
    await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      const expired = state.storage.sql
        .exec<{ status: string; last_error_category: string }>(
          "SELECT status, last_error_category FROM table_event_outbox WHERE event_id = ?",
          eventIds[1],
        )
        .one();
      expect(expired).toEqual({
        status: "failed",
        last_error_category: "retry-exhausted",
      });
      const horizonExpired = state.storage.sql
        .exec<{ status: string; last_error_category: string }>(
          "SELECT status, last_error_category FROM table_event_outbox WHERE event_id = ?",
          eventIds[2],
        )
        .one();
      expect(horizonExpired).toEqual({
        status: "failed",
        last_error_category: "retry-exhausted",
      });
      expect(
        state.storage.sql
          .exec<{ total: number }>(
            "SELECT COUNT(*) AS total FROM table_messages",
          )
          .one().total,
      ).toBe(3);
      expect(expireOutboxWork(state.storage.sql, now, 10)).toBe(0);
    });
  });
});

describe("bounded delivery outcome classifier", () => {
  it("never retries 410, 413, redirects, or unavailable security boundaries", () => {
    for (const status of [410, 413, 401, 400]) {
      expect(
        classifyAttemptOutcome({
          ok: false,
          reason: "upstream-non-2xx",
          status,
        }).kind,
      ).toBe("permanent");
    }
    for (const reason of [
      "redirect-refused",
      "connection-boundary-unverified",
    ] as const) {
      expect(classifyAttemptOutcome({ ok: false, reason }).kind).toBe(
        "permanent",
      );
    }
    expect(
      classifyAttemptOutcome({ ok: true, status: 204, body: new Uint8Array() })
        .kind,
    ).toBe("accepted");
  });

  it("retries 429/5xx, deadlines and transport failures without claiming host execution", () => {
    for (const status of [429, 500, 503, 599]) {
      expect(
        classifyAttemptOutcome({
          ok: false,
          reason: "upstream-non-2xx",
          status,
        }).kind,
      ).toBe("transient");
    }
    for (const reason of ["deadline", "transport-error"] as const) {
      expect(classifyAttemptOutcome({ ok: false, reason }).kind).toBe(
        "transient",
      );
    }
  });
});
