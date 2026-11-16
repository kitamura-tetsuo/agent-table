import {
  parseRelayHttpOutcome,
  type RelayHttpOutcome,
} from "./relay-outcome.ts";
/**
 * SQL-only relay attempt evidence. No network or readiness authorization.
 * Call mutations within the caller's storage transaction.
 * SQL/receipt producers are trusted adapters; remote JSON is NOT a receipt.
 */
export interface RelayAttemptSql {
  exec<
    T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>,
  >(query: string, ...bindings: (string | number | null)[]): { toArray(): T[] };
}
export interface RelayAttemptIdentity {
  requestId: string;
  eventId: string;
  subscriptionId: string;
  generation: number;
  ordinal: number;
  leaseToken: string;
  firstAttemptAt: number;
  leaseDeadline: number;
  audience: string;
  callerId: string;
  issuedAt: number;
  acceptanceExpiresAt: number;
  operationDigest: string;
}
export type RelayReceipt = RelayHttpOutcome | { kind: "not-sent" };
type Row = {
  request_id: string;
  event_id: string;
  subscription_id: string;
  generation: number;
  ordinal: number;
  lease_token: string;
  first_attempt_at: number;
  lease_deadline: number;
  audience: string;
  caller_id: string;
  issued_at: number;
  acceptance_expires_at: number;
  operation_digest: string;
  transport_reserved: number;
  state: "prepared" | "dispatched" | "unknown" | "completed";
  outcome_kind: "http" | "not-sent" | null;
  http_status: number | null;
  outcome_json: string | null;
};
const columns = [
  "request_id",
  "event_id",
  "subscription_id",
  "generation",
  "ordinal",
  "lease_token",
  "first_attempt_at",
  "lease_deadline",
  "audience",
  "caller_id",
  "issued_at",
  "acceptance_expires_at",
  "operation_digest",
] as const;
const values = (i: RelayAttemptIdentity) => [
  i.requestId,
  i.eventId,
  i.subscriptionId,
  i.generation,
  i.ordinal,
  i.leaseToken,
  i.firstAttemptAt,
  i.leaseDeadline,
  i.audience,
  i.callerId,
  i.issuedAt,
  i.acceptanceExpiresAt,
  i.operationDigest,
];
const integer = (n: number) => Number.isSafeInteger(n) && n > 0;
const id = (s: string) =>
  typeof s === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(s);
function valid(i: RelayAttemptIdentity): boolean {
  return (
    !!i &&
    [i.requestId, i.eventId, i.subscriptionId, i.leaseToken, i.callerId].every(
      id,
    ) &&
    [
      i.generation,
      i.ordinal,
      i.firstAttemptAt,
      i.leaseDeadline,
      i.issuedAt,
      i.acceptanceExpiresAt,
    ].every(integer) &&
    i.ordinal <= 8 &&
    i.issuedAt >= i.firstAttemptAt &&
    i.leaseDeadline > i.issuedAt &&
    i.leaseDeadline <= i.firstAttemptAt + 3600000 &&
    // Current signed relay wire authenticates exactly timestamp + 60 seconds.
    i.acceptanceExpiresAt === i.issuedAt + 60000 &&
    /^(production|test):[a-z][a-z0-9-]{2,63}$/.test(i.audience) &&
    typeof i.operationDigest === "string" &&
    /^[a-f0-9]{64}$/.test(i.operationDigest)
  );
}
function read(sql: RelayAttemptSql, i: RelayAttemptIdentity): Row | undefined {
  return sql
    .exec<Row>(
      "SELECT * FROM table_event_relay_attempts WHERE request_id = ?",
      i.requestId,
    )
    .toArray()[0];
}
function matches(row: Row, i: RelayAttemptIdentity) {
  return columns.every((column, index) => row[column] === values(i)[index]);
}
const failure = (reason: string) => ({ ok: false as const, reason });
const success = () => ({ ok: true as const });

/** Never replace an identity, extend an expiry, or bypass an unresolved predecessor. */
export function prepareRelayAttempt(
  sql: RelayAttemptSql,
  i: RelayAttemptIdentity,
  now: number,
) {
  if (!valid(i) || !integer(now)) return failure("invalid");
  const existing = read(sql, i);
  if (existing)
    return matches(existing, i) ? success() : failure("identity-conflict");
  if (
    now < i.issuedAt ||
    now >= i.acceptanceExpiresAt ||
    now >= i.leaseDeadline
  )
    return failure("expired");
  const prior = sql
    .exec<Row>(
      "SELECT * FROM table_event_relay_attempts WHERE event_id = ? ORDER BY ordinal",
      i.eventId,
    )
    .toArray();
  // #21 is at-least-once: preserve the uncertain predecessor unchanged while
  // allowing a new charged ordinal only after its recovery deadline.
  // This is not reuse of the old request ID, nor proof it was never delivered.
  if (
    prior.some((p) => p.state !== "completed" && i.issuedAt < p.lease_deadline)
  )
    return failure("unresolved-predecessor");
  if (
    prior.some(
      (p) =>
        p.ordinal >= i.ordinal ||
        p.generation > i.generation ||
        p.first_attempt_at !== i.firstAttemptAt ||
        p.subscription_id !== i.subscriptionId,
    )
  )
    return failure("attempt-conflict");
  sql.exec(
    `INSERT INTO table_event_relay_attempts (${columns.join(",")},state)
    VALUES (${columns.map(() => "?").join(",")},'prepared')`,
    ...values(i),
  );
  return success();
}

/** Persist this BEFORE external I/O. Crash after this call is unknown, not no-send. */
export function markRelayDispatched(
  sql: RelayAttemptSql,
  i: RelayAttemptIdentity,
  now: number,
) {
  if (!valid(i) || !integer(now)) return failure("invalid");
  const row = read(sql, i);
  if (!row || !matches(row, i)) return failure("identity-conflict");
  if (row.state !== "prepared") return failure("already-reserved");
  if (
    now < row.issued_at ||
    now >= row.acceptance_expires_at ||
    now >= row.lease_deadline
  )
    return failure("expired");
  sql.exec(
    "UPDATE table_event_relay_attempts SET state = 'dispatched', transport_reserved = 1 WHERE request_id = ? AND state = 'prepared'",
    i.requestId,
  );
  return success();
}

/** Uncertainty never clears a reservation or authorizes a new logical attempt. */
export function markRelayUnknown(
  sql: RelayAttemptSql,
  i: RelayAttemptIdentity,
) {
  if (!valid(i)) return failure("invalid");
  const row = read(sql, i);
  if (!row || !matches(row, i)) return failure("identity-conflict");
  if (row.state === "completed") return failure("already-completed");
  sql.exec(
    "UPDATE table_event_relay_attempts SET state = 'unknown' WHERE request_id = ?",
    i.requestId,
  );
  return success();
}

/** Only authenticated exact-operation readback or a verified local transport result. */
export function recordRelayReceipt(
  sql: RelayAttemptSql,
  i: RelayAttemptIdentity,
  receipt: RelayReceipt,
) {
  if (
    !valid(i) ||
    !receipt ||
    typeof receipt !== "object" ||
    (receipt.kind !== "not-sent" && receipt.kind !== "http") ||
    (receipt.kind === "not-sent"
      ? Object.keys(receipt).join(",") !== "kind"
      : !parseRelayHttpOutcome(receipt))
  )
    return failure("invalid");
  const row = read(sql, i);
  if (!row || !matches(row, i)) return failure("identity-conflict");
  const normalized =
    receipt.kind === "http"
      ? parseRelayHttpOutcome(receipt)
      : { kind: "not-sent" as const };
  if (!normalized) return failure("invalid");
  receipt = normalized;
  const status = receipt.kind === "http" ? receipt.status : null;
  if (row.state === "completed")
    return row.outcome_json === JSON.stringify(receipt)
      ? success()
      : failure("outcome-conflict");
  // prepared means transport was never marked started; only proof of no-send fits.
  if (row.transport_reserved !== 1 && receipt.kind !== "not-sent")
    return failure("not-dispatched");
  sql.exec(
    "UPDATE table_event_relay_attempts SET state = 'completed', outcome_kind = ?, http_status = ?, outcome_json = ? WHERE request_id = ?",
    receipt.kind,
    status,
    JSON.stringify(receipt),
    i.requestId,
  );
  return success();
}

export interface CurrentOutboxAttempt {
  status: "pending" | "in_flight" | "accepted" | "failed" | "cancelled";
  eventId: string;
  subscriptionId: string;
  generation: number;
  ordinal: number;
  leaseToken: string;
  firstAttemptAt: number;
  leaseDeadline: number;
}
/**
 * Does NOT settle outbox or grant send permission. Current outbox/grant/lifecycle
 * authority must be freshly read by the integrator, not supplied by the network.
 * A matching receipt after execution-lease expiry is evidence for a separate
 * reconciler only, never permission to pretend the old execution lease is live.
 */
export function readRelayDisposition(
  sql: RelayAttemptSql,
  i: RelayAttemptIdentity,
  current: CurrentOutboxAttempt,
  now: number,
) {
  if (!valid(i) || !integer(now) || !current) return failure("invalid");
  const row = read(sql, i);
  if (!row || !matches(row, i)) return failure("identity-conflict");
  if (
    current.status !== "in_flight" ||
    current.eventId !== row.event_id ||
    current.subscriptionId !== row.subscription_id ||
    current.generation !== row.generation ||
    current.ordinal !== row.ordinal ||
    current.leaseToken !== row.lease_token ||
    current.firstAttemptAt !== row.first_attempt_at ||
    current.leaseDeadline !== row.lease_deadline
  )
    return failure("stale-target");
  if (now < row.issued_at) return failure("clock-regression");
  if (row.state !== "completed")
    return { ok: true as const, state: "unknown" as const };
  if (now >= row.first_attempt_at + 3600000)
    return failure("retry-horizon-ended");
  return {
    ok: true as const,
    state: "completed" as const,
    executionLeaseExpired: now >= row.lease_deadline,
    receipt: JSON.parse(row.outcome_json as string) as RelayReceipt,
  };
}

/** SQL-only readback for the latest charged attempt; never reconstruct identity
 * from fresh credentials or a new timestamp. Private TableDO integration only. */
export function latestRelayAttempt(
  sql: RelayAttemptSql,
  eventId: string,
): RelayAttemptIdentity | null {
  const row = sql
    .exec<Row>(
      "SELECT * FROM table_event_relay_attempts WHERE event_id = ? ORDER BY ordinal DESC LIMIT 1",
      eventId,
    )
    .toArray()[0];
  return row
    ? {
        requestId: row.request_id,
        eventId: row.event_id,
        subscriptionId: row.subscription_id,
        generation: row.generation,
        ordinal: row.ordinal,
        leaseToken: row.lease_token,
        firstAttemptAt: row.first_attempt_at,
        leaseDeadline: row.lease_deadline,
        audience: row.audience,
        callerId: row.caller_id,
        issuedAt: row.issued_at,
        acceptanceExpiresAt: row.acceptance_expires_at,
        operationDigest: row.operation_digest,
      }
    : null;
}
