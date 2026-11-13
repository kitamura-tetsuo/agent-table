import type { EventDiagnosticTrace } from "../mcp/event-diagnostic-trace";
import {
  reviewedCallbackTargets,
  validateReviewedCallbackDestination,
} from "../notifications/egress";
import {
  inspectEventSubscriptionParams,
  parseEventSubscriptionParams,
  verifyCallbackControl,
} from "../notifications/openai-events";
import type { VerifiedConnectionActor } from "../shared/auth";
import {
  activePrivatePilotDiscoveryPolicy,
  activePrivatePilotPolicy,
  PRIVATE_PILOT_PROFILE,
  privatePilotConfiguration,
  privatePilotRecipientMatches,
} from "../shared/private-pilot";

export type EventServiceFailure =
  | "invalid"
  | "denied"
  | "conflict"
  | "stale"
  | "unavailable"
  | "callback_destination_rejected"
  | "callback_challenge_failed"
  | "callback_transport_failed"
  | "callback_operator_review_required";

export type EventServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: EventServiceFailure };

function failed(code: string): {
  ok: false;
  reason: "invalid" | "conflict" | "stale" | "unavailable" | "denied";
} {
  const reason =
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
  diagnostics?: EventDiagnosticTrace,
): Promise<
  EventServiceResult<{
    id: string;
    refreshBefore: string;
    cursor: null;
    truncated: false;
  }>
> {
  const inspected = inspectEventSubscriptionParams(input, "subscribe");
  if (!inspected.ok) {
    diagnostics?.record(
      "events/subscribe",
      "parameters",
      "invalid",
      inspected.detail,
    );
    return { ok: false, reason: "invalid" };
  }
  const parsed = inspected.value;
  diagnostics?.record("events/subscribe", "parameters", "valid");
  const discovery = activePrivatePilotDiscoveryPolicy(env);
  if (discovery) {
    if (
      !privatePilotRecipientMatches(discovery, actor, parsed.arguments.table_id)
    ) {
      diagnostics?.record("events/subscribe", "recipient", "denied");
      return { ok: false, reason: "denied" };
    }
    try {
      const result = await env.TABLES.get(
        env.TABLES.idFromName(parsed.arguments.table_id),
      ).observeEventCallback(actor, input);
      diagnostics?.record("events/subscribe", "table", "received");
      diagnostics?.record(
        "events/subscribe",
        "table",
        result.ok ? "success" : failed(result.code).reason,
      );
      // Observation never acknowledges an active subscription or sends a
      // challenge. A separate reviewed delivery configuration is required.
      return result.ok
        ? { ok: false, reason: "callback_operator_review_required" }
        : failed(result.code);
    } catch {
      diagnostics?.record("events/subscribe", "table", "unavailable");
      return { ok: false, reason: "unavailable" };
    }
  }
  const privateProfile = env.RELEASE_PROFILE === PRIVATE_PILOT_PROFILE;
  const pilot = activePrivatePilotPolicy(env);
  if (
    privateProfile &&
    (!pilot ||
      !privatePilotRecipientMatches(pilot, actor, parsed.arguments.table_id))
  )
    return { ok: false, reason: "denied" };
  const reviewed =
    pilot?.callbackTargets ??
    reviewedCallbackTargets(env.EVENTS_REVIEWED_CALLBACK_TARGETS);
  if (!validateReviewedCallbackDestination(parsed.delivery.url, reviewed).ok)
    return { ok: false, reason: "callback_destination_rejected" };

  try {
    const table = env.TABLES.get(
      env.TABLES.idFromName(parsed.arguments.table_id),
    );
    const candidate = await table.beginEventSubscription(actor, parsed);
    if (!candidate.ok) return failed(candidate.code);
    let verificationTargets = reviewed;
    if (privateProfile) {
      // Reservation can outlive its approved window while the RPC is pending.
      // Recheck before any verification bytes leave this Worker.
      const currentPilot = activePrivatePilotPolicy(env);
      if (
        !currentPilot ||
        !privatePilotRecipientMatches(
          currentPilot,
          actor,
          parsed.arguments.table_id,
        ) ||
        !validateReviewedCallbackDestination(
          parsed.delivery.url,
          currentPilot.callbackTargets,
        ).ok
      ) {
        await table.discardEventCandidate(actor, candidate.value.candidateId);
        return { ok: false, reason: "denied" };
      }
      verificationTargets = currentPilot.callbackTargets;
    }
    const checked = await verifyCallbackControl(
      parsed.delivery.url,
      verificationTargets,
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
  if (env.RELEASE_PROFILE === PRIVATE_PILOT_PROFILE) {
    const policy = privatePilotConfiguration(env);
    if (
      !policy ||
      !privatePilotRecipientMatches(policy, actor, parsed.arguments.table_id)
    )
      return { ok: false, reason: "denied" };
  }
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
