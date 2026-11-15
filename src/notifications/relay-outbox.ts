/**
 * Private TableDO integration. No runtime binding or readiness is enabled here.
 * The caller owns durable scheduling, transactions and fresh authoritative joins.
 */
import type { CallbackRequest, CallbackTransportOutcome } from "./egress";
import {
  type AttemptOutcome,
  classifyAttemptOutcome,
  type OutboxLease,
  reconcileRelayOutboxAttempt,
} from "./outbox";
import {
  latestRelayAttempt,
  markRelayDispatched,
  markRelayUnknown,
  prepareRelayAttempt,
  type RelayAttemptIdentity,
  type RelayReceipt,
  readRelayDisposition,
  recordRelayReceipt,
} from "./relay-attempt-ledger";
import type { RelayClientConfiguration } from "./relay-client";
import { sendRelayMessage } from "./relay-message-client";
import { relayOperationDigest } from "./relay-operation";
import type { RelayHttpOutcome } from "./relay-outcome";
import { readRelayStatus } from "./relay-status-client";

export interface RelayOutboxAdapter {
  configuration: RelayClientConfiguration;
  send: typeof sendRelayMessage;
  read: typeof readRelayStatus;
}
export const relayOutboxAdapter = (
  configuration: RelayClientConfiguration,
): RelayOutboxAdapter => ({
  configuration,
  send: sendRelayMessage,
  read: readRelayStatus,
});
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function callbackOutcome(
  outcome: RelayHttpOutcome,
  now: number,
): CallbackTransportOutcome {
  if (outcome.status >= 200 && outcome.status < 300)
    return { ok: true, status: outcome.status, body: new Uint8Array() };
  // Legacy unknown advice is not observed absence. Conservatively wait the full
  // maximum supported Retry-After from this observation, never shorten it.
  const retryAfterMs =
    outcome.retryAfterState === "known"
      ? Math.max(
          0,
          outcome.retryAfterObservedAt + outcome.retryAfterSeconds * 1000 - now,
        )
      : outcome.retryAfterState === "unknown"
        ? 900000
        : undefined;
  return {
    ok: false,
    reason: "upstream-non-2xx",
    status: outcome.status,
    retryAfterMs,
  };
}

/** Identity is committed before transport; exceptions do not become no-send proof. */
export async function dispatchRelayOutbox(
  sql: DurableObjectStorage["sql"],
  transaction: <T>(work: () => T) => T,
  adapter: RelayOutboxAdapter,
  lease: OutboxLease,
  subscriptionId: string,
  destination: string,
  request: CallbackRequest,
  authorize: () => Promise<boolean>,
): Promise<CallbackTransportOutcome | null> {
  const issuedAt = Date.now();
  const requestId = crypto.randomUUID();
  const operationDigest = await relayOperationDigest({
    kind: "message",
    audience: adapter.configuration.audience,
    callerId: adapter.configuration.callerId,
    requestId,
    destination,
    headers: { ...request.headers },
    payload: base64(new Uint8Array(request.body)),
  });
  const identity: RelayAttemptIdentity = {
    requestId,
    eventId: lease.eventId,
    subscriptionId,
    generation: lease.generation,
    ordinal: lease.attemptCount,
    leaseToken: lease.leaseToken,
    firstAttemptAt: lease.firstAttemptAt,
    leaseDeadline: lease.leaseDeadline,
    audience: adapter.configuration.audience,
    callerId: adapter.configuration.callerId,
    issuedAt,
    acceptanceExpiresAt: issuedAt + 60000,
    operationDigest,
  };
  if (!(await authorize())) return null;
  const prepared = transaction(() =>
    prepareRelayAttempt(sql, identity, Date.now()),
  );
  if (!prepared.ok) return null;
  const result = await adapter.send(
    adapter.configuration,
    { requestId, timestamp: issuedAt },
    destination,
    request,
    async () => {
      if (!(await authorize())) return false;
      return transaction(() => markRelayDispatched(sql, identity, Date.now()))
        .ok;
    },
  );
  if (!result.ok) {
    transaction(() => markRelayUnknown(sql, identity));
    return null; // retains original lease/budget, recovery is separate
  }
  if (!transaction(() => recordRelayReceipt(sql, identity, result.outcome)).ok)
    return null;
  return callbackOutcome(result.outcome, Date.now());
}

/**
 * Reads the exact original request, never forwards or renews it. Expired current
 * attempts recover through #21 bounded at-least-once retry. An uncertain original
 * stays recorded even if a new ordinal later sends the same stable event ID.
 */
export async function recoverRelayOutbox(
  sql: DurableObjectStorage["sql"],
  transaction: <T>(work: () => T) => T,
  adapter: RelayOutboxAdapter,
  eventId: string,
  authorize: () => Promise<boolean>,
): Promise<boolean> {
  const identity = latestRelayAttempt(sql, eventId);
  if (!identity || identity.leaseDeadline > Date.now()) return false;
  const current = () =>
    sql
      .exec<{
        status: string;
        subscription_generation: number;
        lease_token: string | null;
        attempt_count: number;
        first_attempt_at: number | null;
        lease_deadline: number | null;
      }>("SELECT * FROM table_event_outbox WHERE event_id=?", eventId)
      .toArray()[0];
  const matches = () => {
    const row = current();
    return (
      row?.status === "in_flight" &&
      row.subscription_generation === identity.generation &&
      row.lease_token === identity.leaseToken &&
      row.attempt_count === identity.ordinal &&
      row.first_attempt_at === identity.firstAttemptAt &&
      row.lease_deadline === identity.leaseDeadline
    );
  };
  if (!matches()) return false; // refreshed generation cannot consume old receipt
  const hold = () => {
    transaction(() =>
      sql.exec(
        "UPDATE table_event_outbox SET relay_reconcile_after=? WHERE event_id=? AND status='in_flight' AND lease_token=? AND subscription_generation=?",
        Date.now() + 60000,
        eventId,
        identity.leaseToken,
        identity.generation,
      ),
    );
    return true;
  };
  if (!(await authorize())) return hold();
  // Durable definitive evidence outranks unavailable remote readback.
  const local = readRelayDisposition(
    sql,
    identity,
    {
      status: "in_flight",
      eventId,
      subscriptionId: identity.subscriptionId,
      generation: identity.generation,
      ordinal: identity.ordinal,
      leaseToken: identity.leaseToken,
      firstAttemptAt: identity.firstAttemptAt,
      leaseDeadline: identity.leaseDeadline,
    },
    Date.now(),
  );
  let receipt: RelayReceipt | undefined =
    local.ok && local.state === "completed" ? local.receipt : undefined;
  if (!receipt) {
    const status = await adapter.read(
      adapter.configuration,
      {
        requestId: identity.requestId,
        operationDigest: identity.operationDigest,
        timestamp: Date.now(),
      },
      async () => matches() && (await authorize()),
    );
    if (!(await authorize()) || !matches()) return hold();
    if (!status.ok && status.reason === "conflict") return hold();
    if (status.ok && status.state === "completed") {
      // A challenge receipt cannot settle a message operation.
      if (status.outcome.kind === "challenge") return hold();
      const messageReceipt = status.outcome;
      if (
        !transaction(() => recordRelayReceipt(sql, identity, messageReceipt)).ok
      )
        return hold();
      receipt = messageReceipt;
    }
  }
  if (!(await authorize()) || !matches()) return hold();
  const outcome: AttemptOutcome =
    receipt?.kind === "http"
      ? classifyAttemptOutcome(callbackOutcome(receipt, Date.now()))
      : { kind: "transient", category: "transport-error" };
  transaction(() =>
    reconcileRelayOutboxAttempt(
      sql,
      {
        eventId,
        generation: identity.generation,
        leaseToken: identity.leaseToken,
        attemptCount: identity.ordinal,
        firstAttemptAt: identity.firstAttemptAt,
        leaseDeadline: identity.leaseDeadline,
      },
      Date.now(),
      outcome,
    ),
  );
  return true;
}
