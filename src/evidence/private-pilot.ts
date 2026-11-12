import type {
  CallbackTransportObserver,
  CallbackTransportOutcome,
} from "../notifications/egress";
import { sanitizedCallbackOrigin } from "../notifications/egress";
import { classifyAttemptOutcome } from "../notifications/outbox";
import {
  activePrivatePilotDiscoveryPolicy,
  activePrivatePilotPolicy,
  PRIVATE_PILOT_MAX_MESSAGE_SEQ,
  privatePilotRecipientMatches,
} from "../shared/private-pilot";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBSCRIPTION = /^sub_[A-Za-z0-9_-]{16,64}$/;
const SCHEMA = "agent-table.private-pilot.v1";

/** This opt-in stream is separate from routine categorical telemetry. */
function emit(record: Record<string, unknown>): void {
  try {
    console.info(JSON.stringify(record));
  } catch {
    // A failed/lost observation must be treated as incomplete by the collector.
  }
}

export function observePrivateCallbackOrigin(
  env: Env,
  actor: { guestId: string; connectionId: string },
  tableId: string,
  membershipId: string,
  origin: string,
): boolean {
  const now = Date.now();
  const policy = activePrivatePilotDiscoveryPolicy(env, now);
  if (
    !policy ||
    !privatePilotRecipientMatches(policy, actor, tableId) ||
    !UUID.test(membershipId) ||
    sanitizedCallbackOrigin(origin) !== origin
  )
    return false;
  emit({
    schema: SCHEMA,
    kind: "callback-origin",
    buildSha: policy.buildSha,
    approvalRef: policy.approvalRef,
    tableId,
    membershipId,
    observedAt: now,
    callbackOrigin: origin,
  });
  return true;
}

export interface PilotAttemptIdentity {
  tableId: string;
  eventId: string;
  messageId: string;
  seq: number;
  membershipId: string;
  subscriptionId: string;
  generation: number;
  attempt: number;
  createdAt: number;
  guestId: string;
  connectionId: string;
}

export interface PilotAttemptObserver extends CallbackTransportObserver {
  completed(
    outcome: CallbackTransportOutcome,
    settled: "accepted" | "pending" | "failed" | null,
    at: number,
  ): void;
}

/** Called only after the final grant, local lifecycle and lease checks. */
export function observePrivateAttempt(
  env: Env,
  identity: PilotAttemptIdentity,
  authorizedAt: number,
): PilotAttemptObserver | undefined {
  const policy = activePrivatePilotPolicy(env, authorizedAt);
  if (
    policy?.observationMode !== "private-redacted" ||
    !privatePilotRecipientMatches(policy, identity, identity.tableId) ||
    ![identity.eventId, identity.messageId, identity.membershipId].every((id) =>
      UUID.test(id),
    ) ||
    !SUBSCRIPTION.test(identity.subscriptionId) ||
    !Number.isSafeInteger(identity.seq) ||
    identity.seq < 1 ||
    identity.seq > PRIVATE_PILOT_MAX_MESSAGE_SEQ ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 1 ||
    !Number.isSafeInteger(identity.attempt) ||
    identity.attempt < 1 ||
    identity.attempt > 8 ||
    identity.createdAt < Date.parse(policy.notBefore)
  )
    return undefined;
  // Construct the fixed projection explicitly. Never spread an RPC/SQL input.
  const common = {
    schema: SCHEMA,
    buildSha: policy.buildSha,
    approvalRef: policy.approvalRef,
    tableId: identity.tableId,
    eventId: identity.eventId,
    messageId: identity.messageId,
    seq: identity.seq,
    membershipId: identity.membershipId,
    subscriptionId: identity.subscriptionId,
    generation: identity.generation,
    attempt: identity.attempt,
  };
  let invoked = false;
  let responded = false;
  emit({ ...common, kind: "attempt-authorized", observedAt: authorizedAt });
  return {
    transportInvoked(at) {
      invoked = true;
      emit({ ...common, kind: "transport-invoked", observedAt: at });
    },
    responseHeaders(at, status) {
      responded = true;
      emit({ ...common, kind: "response-headers", observedAt: at, status });
    },
    completed(outcome, settled, at) {
      const classified = classifyAttemptOutcome(outcome);
      // Keep completion after expiry/cancellation. This context was captured
      // at authorization, and must never recreate or reauthorize an SQL row.
      emit({
        ...common,
        kind: "attempt-completed",
        observedAt: at,
        outcome: classified.kind,
        ...(classified.kind === "accepted"
          ? {}
          : { errorCategory: classified.category }),
        settled,
        transportInvoked: invoked,
        responseObserved: responded,
      });
    },
  };
}
