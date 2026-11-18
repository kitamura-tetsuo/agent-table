import type { EventDiagnosticTrace } from "../mcp/event-diagnostic-trace";
import {
  reviewedCallbackTargets,
  validateReviewedCallbackDestination,
} from "../notifications/egress";
import {
  inspectEventSubscriptionParams,
  parseEventSubscriptionParams,
  signWebhook,
  verifyCallbackControl,
} from "../notifications/openai-events";
import { selectProductionRelayAdapters } from "../notifications/production-relay-adapters";
import { relayOperationDigest } from "../notifications/relay-operation";
import { parseRelayChallengeOutcome } from "../notifications/relay-outcome";
import type { RelayVerificationAdapter } from "../notifications/relay-verification";
import type { VerifiedConnectionActor } from "../shared/auth";
import {
  activePrivatePilotDiscoveryPolicy,
  activePrivatePilotPolicy,
  PRIVATE_PILOT_PROFILE,
  privatePilotConfiguration,
  privatePilotEventAllowed,
  privatePilotRecipientMatches,
} from "../shared/private-pilot";
import { productionRelayProfileSelected } from "../shared/production-relay-events";

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
  relay: RelayVerificationAdapter | null = null,
): Promise<
  EventServiceResult<{
    id: string;
    refreshBefore: string;
    cursor: null;
    truncated: false;
  }>
> {
  relay ??= selectProductionRelayAdapters(env)?.verification ?? null;
  // An unavailable production relay is not permission to fall back to native fetch.
  if (productionRelayProfileSelected(env) && !relay)
    return { ok: false, reason: "unavailable" };
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
  if (
    env.RELEASE_PROFILE === PRIVATE_PILOT_PROFILE &&
    !privatePilotEventAllowed(privatePilotConfiguration(env), parsed.name)
  )
    return { ok: false, reason: "denied" };
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
        !privatePilotEventAllowed(currentPilot, parsed.name) ||
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
    let checked: "verified" | "challenge-failed" | "transport-failed";
    if (relay) {
      const configuration = structuredClone(relay.configuration);
      const issuedAt = Date.now(),
        requestId = crypto.randomUUID();
      const challenge = crypto.randomUUID();
      const signed = signWebhook(
        { type: "verification", challenge },
        `msg_verification_${crypto.randomUUID().replace(/-/g, "")}`,
        candidate.value.subscriptionId,
        [parsed.delivery.secret as string],
        new Date(issuedAt),
      );
      const request = { method: "POST" as const, ...signed };
      const operation = {
        requestId,
        issuedAt,
        acceptanceExpiresAt: issuedAt + 60000,
        audience: configuration.audience,
        callerId: configuration.callerId,
        operationDigest: await relayOperationDigest({
          kind: "challenge",
          audience: configuration.audience,
          callerId: configuration.callerId,
          requestId,
          destination: parsed.delivery.url,
          headers: { ...signed.headers },
          payload: btoa(String.fromCharCode(...new Uint8Array(signed.body))),
        }),
      };
      const prepared = await table.prepareRelayVerification(
        actor,
        candidate.value.candidateId,
        operation,
      );
      if (!prepared.ok) return failed(prepared.code);
      // An exception/ambiguous result retains its original record, never creates
      // a replacement challenge ID or discards the uncertain candidate.
      const result = await relay.send(
        configuration,
        { requestId, timestamp: issuedAt },
        parsed.delivery.url,
        request,
        () =>
          table.authorizeRelayVerification(
            actor,
            candidate.value.candidateId,
            operation,
            true,
          ),
      );
      let outcome = result.ok ? result.outcome : null;
      // One bounded status read for this exact operation only. A fresh read
      // timestamp never extends the original candidate or transport deadline.
      if (
        !result.ok &&
        (await table.authorizeRelayVerification(
          actor,
          candidate.value.candidateId,
          operation,
          false,
        ))
      ) {
        try {
          const readback = await relay.read(
            configuration,
            {
              requestId,
              operationDigest: operation.operationDigest,
              timestamp: Date.now(),
            },
            () =>
              table.authorizeRelayVerification(
                actor,
                candidate.value.candidateId,
                operation,
                false,
              ),
          );
          if (readback.ok && readback.state === "completed") {
            outcome = parseRelayChallengeOutcome(readback.outcome);
          }
        } catch {
          // Readback errors preserve the original unknown record.
        }
      }
      const recorded = await table.recordRelayVerification(
        actor,
        candidate.value.candidateId,
        operation,
        outcome,
      );
      if (!recorded.ok) return failed(recorded.code);
      if (!outcome) return { ok: false, reason: "callback_transport_failed" };
      checked =
        outcome.verification === "verified" ? "verified" : "challenge-failed";
    } else {
      checked = await verifyCallbackControl(
        parsed.delivery.url,
        verificationTargets,
        parsed.delivery.secret as string,
        candidate.value.subscriptionId,
      );
    }
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
