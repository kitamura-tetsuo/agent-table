import {
  reviewedCallbackTargets,
  validateReviewedCallbackDestination,
} from "../notifications/egress";
import {
  parseEventSubscriptionParams,
  verifyCallbackControl,
} from "../notifications/openai-events";
import type { VerifiedConnectionActor } from "../shared/auth";

export type EventServiceFailure =
  | "invalid"
  | "denied"
  | "conflict"
  | "stale"
  | "unavailable"
  | "callback_destination_rejected"
  | "callback_challenge_failed"
  | "callback_transport_failed";

export type EventServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: EventServiceFailure };

function failed(code: string): EventServiceResult<never> {
  const reason: EventServiceFailure =
    code === "INVALID_REQUEST"
      ? "invalid"
      : code === "CONFLICT"
        ? "conflict"
        : code === "STALE" || code === "TABLE_TERMINAL"
          ? "stale"
          : code === "TEMPORARILY_UNAVAILABLE"
            ? "unavailable"
            : "denied";
  return { ok: false, reason };
}

/**
 * All subscription state changes cross the actual TableDO RPC boundary.
 * Only the controlled external receiver is contacted between the two fenced
 * transactions, never as a substitute for authorization or persistence.
 */
export async function subscribeEvent(
  env: Env,
  actor: VerifiedConnectionActor,
  input: unknown,
): Promise<
  EventServiceResult<{
    id: string;
    refreshBefore: string;
    cursor: null;
    truncated: false;
  }>
> {
  const parsed = parseEventSubscriptionParams(input, "subscribe");
  if (!parsed) return { ok: false, reason: "invalid" };
  const reviewed = reviewedCallbackTargets(
    env.EVENTS_REVIEWED_CALLBACK_TARGETS,
  );
  if (!validateReviewedCallbackDestination(parsed.delivery.url, reviewed).ok)
    return { ok: false, reason: "callback_destination_rejected" };

  try {
    const table = env.TABLES.get(
      env.TABLES.idFromName(parsed.arguments.table_id),
    );
    const candidate = await table.beginEventSubscription(actor, parsed);
    if (!candidate.ok) return failed(candidate.code);
    const checked = await verifyCallbackControl(
      parsed.delivery.url,
      reviewed,
      parsed.delivery.secret as string,
      candidate.value.subscriptionId,
    );
    if (checked !== "verified") {
      await table.discardEventCandidate(actor, candidate.value.candidateId);
      return {
        ok: false,
        reason:
          checked === "challenge-failed"
            ? "callback_challenge_failed"
            : "callback_transport_failed",
      };
    }
    const committed = await table.commitVerifiedEventSubscription(
      actor,
      candidate.value.candidateId,
    );
    if (!committed.ok) return failed(committed.code);
    return {
      ok: true,
      value: {
        id: committed.value.id,
        refreshBefore: new Date(committed.value.expiresAt).toISOString(),
        cursor: null,
        truncated: false,
      },
    };
  } catch {
    // RPC/crypto/transport errors must not contain callback or secret details.
    return { ok: false, reason: "unavailable" };
  }
}

export async function unsubscribeEvent(
  env: Env,
  actor: VerifiedConnectionActor,
  input: unknown,
): Promise<EventServiceResult<Record<string, never>>> {
  const parsed = parseEventSubscriptionParams(input, "unsubscribe");
  if (!parsed) return { ok: false, reason: "invalid" };
  try {
    const table = env.TABLES.get(
      env.TABLES.idFromName(parsed.arguments.table_id),
    );
    const result = await table.unsubscribeEvent(actor, input);
    return result.ok ? { ok: true, value: {} } : failed(result.code);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
