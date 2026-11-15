import {
  reviewedCallbackTargets,
  validateReviewedCallbackDestination,
} from "../notifications/egress.ts";
import { relaySigningPublicKeySha256 } from "../notifications/relay-signing-key.ts";

export const PRODUCTION_RELAY_EVENTS_PROFILE = "production-relay-events";

export interface ProductionRelayBindings {
  RELEASE_ENVIRONMENT?: string;
  RELEASE_PROFILE?: string;
  RELEASE_BUILD_SHA?: string;
  RESTORE_QUARANTINE?: string;
  ENABLE_MCP_SUBSCRIPTIONS?: string;
  ENABLE_OPENAI_EVENTS?: string;
  ALLOW_OUTBOUND_NOTIFICATIONS?: string;
  EVENTS_REVIEWED_CALLBACK_TARGETS?: string;
  EVENTS_RELAY_CONFIGURATION?: string;
  EVENTS_RELAY_SIGNING_KEY_PKCS8?: string;
  TEST_NATIVE_EVENTS_RISK_ACCEPTANCE?: string;
  PRIVATE_PILOT_POLICY?: string;
}

/** Non-secret configuration only. A parsed value NEVER grants delivery. */
export interface ProductionRelayConfiguration {
  version: 1;
  environment: "production";
  buildSha: string;
  origin: string;
  callerId: string;
  audience: string;
  signingPublicKeySha256: string;
}

/**
 * Offline shape/environment binding, not a release approval or peer-safety
 * attestation. Unknown keys (including credentials) fail closed. Live keys
 * belong to separate secret storage; this parser never reads or returns one.
 */
export function productionRelayConfiguration(
  env: ProductionRelayBindings,
): ProductionRelayConfiguration | null {
  if (
    env.RELEASE_ENVIRONMENT !== "production" ||
    env.RELEASE_PROFILE !== PRODUCTION_RELAY_EVENTS_PROFILE ||
    !/^[a-f0-9]{40}$/.test(env.RELEASE_BUILD_SHA ?? "") ||
    env.RESTORE_QUARANTINE !== "false" ||
    env.ENABLE_MCP_SUBSCRIPTIONS !== "true" ||
    env.ENABLE_OPENAI_EVENTS !== "true" ||
    !["true", "false"].includes(env.ALLOW_OUTBOUND_NOTIFICATIONS ?? "") ||
    env.TEST_NATIVE_EVENTS_RISK_ACCEPTANCE !== undefined ||
    env.PRIVATE_PILOT_POLICY !== undefined ||
    reviewedCallbackTargets(env.EVENTS_REVIEWED_CALLBACK_TARGETS).length ===
      0 ||
    typeof env.EVENTS_RELAY_CONFIGURATION !== "string" ||
    env.EVENTS_RELAY_CONFIGURATION.length > 2048
  )
    return null;
  try {
    const value: unknown = JSON.parse(env.EVENTS_RELAY_CONFIGURATION);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const config = value as Record<string, unknown>;
    if (
      Object.keys(config).sort().join(",") !==
        "audience,buildSha,callerId,environment,origin,signingPublicKeySha256,version" ||
      config.version !== 1 ||
      config.environment !== "production" ||
      config.buildSha !== env.RELEASE_BUILD_SHA ||
      typeof config.signingPublicKeySha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(config.signingPublicKeySha256) ||
      typeof config.origin !== "string" ||
      typeof config.callerId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(config.callerId) ||
      typeof config.audience !== "string" ||
      !/^production:[a-z][a-z0-9-]{2,63}$/.test(config.audience)
    )
      return null;
    const url = new URL(config.origin);
    if (
      url.origin !== config.origin ||
      !validateReviewedCallbackDestination(`${config.origin}/relay/v1`, [
        { origin: config.origin, pathPrefix: "/relay/v1" },
      ]).ok
    )
      return null;
    return config as unknown as ProductionRelayConfiguration;
  } catch {
    return null;
  }
}

/** Active or fully/partly paused configuration; not capability permission. */
export function productionRelayInspectableConfiguration(
  env: ProductionRelayBindings,
): ProductionRelayConfiguration | null {
  if (
    ![
      "ENABLE_MCP_SUBSCRIPTIONS",
      "ENABLE_OPENAI_EVENTS",
      "ALLOW_OUTBOUND_NOTIFICATIONS",
    ].every((name) =>
      ["true", "false"].includes(
        env[name as keyof ProductionRelayBindings] ?? "",
      ),
    )
  )
    return null;
  return productionRelayConfiguration({
    ...env,
    ENABLE_MCP_SUBSCRIPTIONS: "true",
    ENABLE_OPENAI_EVENTS: "true",
  });
}
/** Preserve ordinary service access during an independently requested pause. */
export function productionRelayAccessAllowed(
  env: ProductionRelayBindings,
): boolean {
  const config = productionRelayInspectableConfiguration(env);
  return (
    !!config &&
    relaySigningPublicKeySha256(env.EVENTS_RELAY_SIGNING_KEY_PKCS8) ===
      config.signingPublicKeySha256
  );
}
/**
 * Runtime trusts configuration installed through the protected release workflow.
 * This validates its exact key identity, not the truth of host acceptance evidence.
 * Release authorization independently binds operator review and provider facts.
 */
export function productionRelayReadiness(env: ProductionRelayBindings): {
  enabled: boolean;
  configured: boolean;
  reason:
    | "relay-configuration-invalid"
    | "relay-key-unavailable"
    | "relay-ready"
    | "relay-disabled";
} {
  const config = productionRelayInspectableConfiguration(env);
  if (!config)
    return {
      enabled: false,
      configured: false,
      reason: "relay-configuration-invalid",
    };
  const key = relaySigningPublicKeySha256(env.EVENTS_RELAY_SIGNING_KEY_PKCS8);
  if (key === null || key !== config.signingPublicKeySha256)
    return {
      enabled: false,
      configured: true,
      reason: "relay-key-unavailable",
    };
  const enabled =
    env.ENABLE_MCP_SUBSCRIPTIONS === "true" &&
    env.ENABLE_OPENAI_EVENTS === "true";
  return {
    enabled,
    configured: true,
    reason: enabled ? "relay-ready" : "relay-disabled",
  };
}
