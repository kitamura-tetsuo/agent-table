/** Internal preparation is not release authorization or transport attestation. */

import {
  type ProductionRelayBindings,
  productionRelayConfiguration,
  productionRelayReadiness,
} from "../shared/production-relay-events";
import { reviewedCallbackTargets } from "./egress";
import { sendRelayChallenge } from "./relay-challenge-client";
import type { RelayClientConfiguration } from "./relay-client";
import { sendRelayMessage } from "./relay-message-client";
import type { RelayOutboxAdapter } from "./relay-outbox";
import { relaySigningPublicKeySha256 } from "./relay-signing-key";
import { readRelayStatus } from "./relay-status-client";
import type { RelayVerificationAdapter } from "./relay-verification";

type Bindings = ProductionRelayBindings & {
  EVENTS_RELAY_SIGNING_KEY_PKCS8?: string;
};
export interface PreparedProductionRelayAdapters {
  /** Public-key fingerprint only, for later exact release-authority binding. */
  signingPublicKeySha256: string;
  verification: RelayVerificationAdapter;
  outbox: RelayOutboxAdapter;
}

/** No key generation, I/O, state changes, readiness or native transport fallback. */
export function prepareProductionRelayAdapters(
  env: Bindings,
): PreparedProductionRelayAdapters | null {
  const snapshot = { ...env };
  const config = productionRelayConfiguration(snapshot);
  const encoded = snapshot.EVENTS_RELAY_SIGNING_KEY_PKCS8;
  if (
    !config ||
    typeof encoded !== "string" ||
    encoded.length > 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    return null;
  try {
    const signingPublicKeySha256 = relaySigningPublicKeySha256(encoded);
    if (
      !signingPublicKeySha256 ||
      signingPublicKeySha256 !== config.signingPublicKeySha256
    )
      return null;
    const targets = reviewedCallbackTargets(
      snapshot.EVENTS_REVIEWED_CALLBACK_TARGETS,
    ).map((target) => Object.freeze({ ...target }));
    const configuration: RelayClientConfiguration = Object.freeze({
      origin: config.origin,
      callerId: config.callerId,
      audience: config.audience,
      signingKeyPkcs8: encoded,
      callbackTargets: Object.freeze(targets),
    });
    const fields = [
      "RELEASE_ENVIRONMENT",
      "RELEASE_PROFILE",
      "RELEASE_BUILD_SHA",
      "RESTORE_QUARANTINE",
      "ENABLE_MCP_SUBSCRIPTIONS",
      "ENABLE_OPENAI_EVENTS",
      "EVENTS_REVIEWED_CALLBACK_TARGETS",
      "EVENTS_RELAY_CONFIGURATION",
      "EVENTS_RELAY_SIGNING_KEY_PKCS8",
      "TEST_NATIVE_EVENTS_RISK_ACCEPTANCE",
      "PRIVATE_PILOT_POLICY",
    ] as const;
    const current = (send = true) =>
      fields.every((name) => env[name] === snapshot[name]) &&
      (send
        ? env.ALLOW_OUTBOUND_NOTIFICATIONS === "true"
        : ["true", "false"].includes(env.ALLOW_OUTBOUND_NOTIFICATIONS ?? ""));
    const authorize =
      (check: () => Promise<boolean>, send = true) =>
      async () =>
        current(send) && (await check()) && current(send);
    const read: typeof readRelayStatus = (
      _unused,
      operation,
      check,
      transport,
    ) =>
      readRelayStatus(
        configuration,
        operation,
        authorize(check, false),
        transport,
      );
    return Object.freeze({
      signingPublicKeySha256,
      verification: Object.freeze({
        configuration,
        read,
        send: ((_unused, operation, destination, request, check, transport) =>
          sendRelayChallenge(
            configuration,
            operation,
            destination,
            request,
            authorize(check),
            transport,
          )) as typeof sendRelayChallenge,
      }),
      outbox: Object.freeze({
        configuration,
        read,
        send: ((_unused, operation, destination, request, check, transport) =>
          sendRelayMessage(
            configuration,
            operation,
            destination,
            request,
            authorize(check),
            transport,
          )) as typeof sendRelayMessage,
      }),
    });
  } catch {
    return null;
  }
}

/** Runtime boundary consumes protected-deployment configuration, never caller flags. */
export function selectProductionRelayAdapters(
  env: Bindings,
): PreparedProductionRelayAdapters | null {
  if (!productionRelayReadiness(env).enabled) return null;
  return prepareProductionRelayAdapters(env);
}
