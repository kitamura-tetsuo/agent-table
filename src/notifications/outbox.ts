/**
 * Durable delivery attempt ledger. These are SQL-only transitions: callers
 * must first obtain fresh external grant authority and arm a recovery alarm.
 * No exported transition authorizes a network request or enables public Events.
 */
import type { CallbackTransportOutcome } from "./egress";

export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_RETRY_HORIZON_MS = 60 * 60_000;
export const OUTBOX_LEASE_MS = 30_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const RETRY_AFTER_MAX_MS = 15 * 60_000;

type OutboxSql = DurableObjectStorage["sql"];

type OutboxRow = {
  event_id: string;
  subscription_generation: number;
  status: "pending" | "in_flight" | "accepted" | "failed" | "cancelled";
  attempt_count: number;
  first_attempt_at: number | null;
  next_attempt_at: number | null;
  lease_token: string | null;
  lease_deadline: number | null;
  expires_at: number;
};

export type OutboxLease = {
  eventId: string;
  generation: number;
  leaseToken: string;
  attemptCount: number;
  firstAttemptAt: number;
  leaseDeadline: number;
};

type SafeFailure =
  | "transport-error"
  | "deadline"
  | "rate-limited"
  | "server-error"
  | "receiver-gone"
  | "payload-rejected"
  | "authorization-revoked"
  | "retry-exhausted";

export type AttemptOutcome =
  | { kind: "accepted" }
  | { kind: "permanent"; category: SafeFailure }
  | {
      kind: "transient";
      category: SafeFailure;
      retryAfterMs?: number;
    };

/** Transport interpretation is separate from host execution or transcript read. */
export function classifyAttemptOutcome(
  response: CallbackTransportOutcome,
  retryAfterMs?: number,
): AttemptOutcome {
  if (response.ok) return { kind: "accepted" };
  if (response.reason === "upstream-non-2xx") {
    if (response.status === 410)
      return { kind: "permanent", category: "receiver-gone" };
    if (response.status === 413)
      return { kind: "permanent", category: "payload-rejected" };
    if (response.status === 429)
      return { kind: "transient", category: "rate-limited", retryAfterMs };
    if (response.status && response.status >= 500 && response.status <= 599)
      return { kind: "transient", category: "server-error", retryAfterMs };
    return { kind: "permanent", category: "payload-rejected" };
  }
  if (response.reason === "deadline")
    return { kind: "transient", category: "deadline" };
  if (response.reason === "transport-error")
    return { kind: "transient", category: "transport-error" };
  return {
    kind: "permanent",
    category:
      response.reason === "connection-boundary-unverified"
        ? "authorization-revoked"
        : "payload-rejected",
  };
}

/**
 * Reserve the next due event without resetting any already-reserved budget.
 * The caller MUST reauthorize the owner connection immediately before sending.
 * A timed-out lease can only be reclaimed after its original deadline.
 * Execute inside a DO storage transaction with a prearmed recovery wakeup.
 */
export function reserveOutboxAttempt(
  sql: OutboxSql,
  eventId: string,
  generation: number,
  now: number,
): OutboxLease | null {
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !Number.isSafeInteger(generation)
  )
    return null;
  const row = sql
    .exec<OutboxRow>(
      "SELECT * FROM table_event_outbox WHERE event_id = ?",
      eventId,
    )
    .toArray()[0];
  if (!row || row.subscription_generation !== generation) return null;
  if (
    row.attempt_count >= OUTBOX_MAX_ATTEMPTS ||
    (row.first_attempt_at !== null &&
      now >= row.first_attempt_at + OUTBOX_RETRY_HORIZON_MS) ||
    now >= row.expires_at
  )
    return null;
  const due =
    (row.status === "pending" &&
      row.next_attempt_at !== null &&
      row.next_attempt_at <= now) ||
    (row.status === "in_flight" &&
      row.lease_deadline !== null &&
      row.lease_deadline <= now);
  if (!due) return null;

  const firstAttemptAt = row.first_attempt_at ?? now;
  const leaseDeadline = Math.min(
    now + OUTBOX_LEASE_MS,
    firstAttemptAt + OUTBOX_RETRY_HORIZON_MS,
    row.expires_at,
  );
  if (leaseDeadline <= now) return null;
  const leaseToken = crypto.randomUUID();
  sql.exec(
    `UPDATE table_event_outbox
     SET status = 'in_flight', attempt_count = attempt_count + 1,
         first_attempt_at = COALESCE(first_attempt_at, ?),
         lease_token = ?, lease_deadline = ?, next_attempt_at = NULL
     WHERE event_id = ? AND subscription_generation = ?
       AND attempt_count = ? AND status = ?
       AND ((status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'in_flight' AND lease_deadline <= ?))
       AND expires_at > ?
       AND EXISTS (
         SELECT 1 FROM table_event_subscriptions AS s
         WHERE s.membership_id = table_event_outbox.recipient_membership_id
           AND s.subscription_id = table_event_outbox.subscription_id
           AND s.generation = table_event_outbox.subscription_generation
           AND s.status = 'active' AND s.expires_at > ?
       )
       AND EXISTS (
         SELECT 1 FROM table_metadata
         WHERE state IN ('waiting', 'open') AND expires_at > ?
       )`,
    firstAttemptAt,
    leaseToken,
    leaseDeadline,
    eventId,
    generation,
    row.attempt_count,
    row.status,
    now,
    now,
    now,
    now,
    now,
  );
  if (
    sql.exec<{ changed: number }>("SELECT changes() AS changed").one()
      .changed !== 1
  )
    return null;
  return {
    eventId,
    generation,
    leaseToken,
    attemptCount: row.attempt_count + 1,
    firstAttemptAt,
    leaseDeadline,
  };
}

function retryDelayMs(eventId: string, attemptCount: number): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attemptCount - 1));
  // Stable bounded jitter preserves retry determinism across DO reconstructions.
  const residue = Array.from(eventId).reduce(
    (value, character) => (value * 33 + character.charCodeAt(0)) % 997,
    0,
  );
  return base + Math.floor((base * residue) / 4_985);
}

/**
 * Persist a result only for the exact lease and generation that sent it.
 * Missing, cancelled, refreshed or terminal work must never be upserted.
 */
export function settleOutboxAttempt(
  sql: OutboxSql,
  lease: OutboxLease,
  now: number,
  outcome: AttemptOutcome,
): "accepted" | "pending" | "failed" | null {
  if (!Number.isSafeInteger(now) || now <= 0) return null;
  const row = sql
    .exec<OutboxRow>(
      "SELECT * FROM table_event_outbox WHERE event_id = ?",
      lease.eventId,
    )
    .toArray()[0];
  if (
    !row ||
    row.status !== "in_flight" ||
    row.lease_token !== lease.leaseToken ||
    row.subscription_generation !== lease.generation ||
    row.attempt_count !== lease.attemptCount ||
    row.first_attempt_at !== lease.firstAttemptAt
  )
    return null;
  let status: "accepted" | "pending" | "failed";
  let error: SafeFailure | null = null;
  let due: number | null = null;
  if (outcome.kind === "accepted") {
    status = "accepted";
  } else if (outcome.kind === "permanent") {
    status = "failed";
    error = outcome.category;
  } else {
    const delay = Math.max(
      retryDelayMs(lease.eventId, lease.attemptCount),
      Number.isFinite(outcome.retryAfterMs)
        ? Math.min(RETRY_AFTER_MAX_MS, Math.max(0, outcome.retryAfterMs ?? 0))
        : 0,
    );
    due = now + Math.ceil(delay);
    const terminal = Math.min(
      row.expires_at,
      lease.firstAttemptAt + OUTBOX_RETRY_HORIZON_MS,
    );
    if (row.attempt_count >= OUTBOX_MAX_ATTEMPTS || due >= terminal) {
      status = "failed";
      error = "retry-exhausted";
      due = null;
    } else {
      status = "pending";
      error = outcome.category;
    }
  }

  sql.exec(
    `UPDATE table_event_outbox SET
        status = ?, last_error_category = ?, next_attempt_at = ?,
        lease_token = NULL, lease_deadline = NULL
     WHERE event_id = ? AND subscription_generation = ?
       AND status = 'in_flight' AND lease_token = ?
       AND attempt_count = ? AND first_attempt_at = ?
       AND expires_at > ?
       AND EXISTS (
         SELECT 1 FROM table_event_subscriptions AS s
         WHERE s.membership_id = table_event_outbox.recipient_membership_id
           AND s.subscription_id = table_event_outbox.subscription_id
           AND s.generation = table_event_outbox.subscription_generation
           AND s.status = 'active' AND s.expires_at > ?
       )
       AND EXISTS (
         SELECT 1 FROM table_metadata
         WHERE state IN ('waiting', 'open') AND expires_at > ?
       )`,
    status,
    error,
    due,
    lease.eventId,
    lease.generation,
    lease.leaseToken,
    lease.attemptCount,
    lease.firstAttemptAt,
    now,
    now,
    now,
  );
  return sql.exec<{ changed: number }>("SELECT changes() AS changed").one()
    .changed === 1
    ? status
    : null;
}

/**
 * Terminalize expired retained work without authorizing dispatch. Safe even
 * while public Events are disabled. Terminal work is kept for safe status.
 */
export function expireOutboxWork(
  sql: OutboxSql,
  now: number,
  budget: number,
): number {
  if (!Number.isSafeInteger(now) || budget <= 0) return 0;
  sql.exec(
    `UPDATE table_event_outbox
     SET status = 'failed', last_error_category = 'retry-exhausted',
         next_attempt_at = NULL, lease_token = NULL, lease_deadline = NULL
     WHERE event_id IN (
       SELECT event_id FROM table_event_outbox
       WHERE status IN ('pending', 'in_flight') AND
         (expires_at <= ? OR
          (first_attempt_at IS NOT NULL AND
           first_attempt_at + ? <= ?) OR
          (status = 'in_flight' AND attempt_count >= 8
           AND lease_deadline <= ?))
       ORDER BY expires_at LIMIT ?
     )`,
    now,
    OUTBOX_RETRY_HORIZON_MS,
    now,
    now,
    budget,
  );
  return sql.exec<{ changed: number }>("SELECT changes() AS changed").one()
    .changed;
}
