import { reviewedCallbackTargets } from "../notifications/egress.ts";

/**
 * Explicit staging exception, NOT evidence of public transport readiness.
 * Native Workers fetch does not prove DNS answers match the connected peer.
 * Only a separately approved staging deployment may accept that residual risk.
 */
export const TEST_NATIVE_EVENTS_PROFILE = "test-native-events";
export const TEST_NATIVE_EVENTS_RISK = "accept-unverified-dns-peer-boundary";

export interface TestNativeBindings {
  RELEASE_ENVIRONMENT?: string;
  RELEASE_PROFILE?: string;
  RELEASE_BUILD_SHA?: string;
  RESTORE_QUARANTINE?: string;
  ENABLE_MCP_SUBSCRIPTIONS?: string;
  ENABLE_OPENAI_EVENTS?: string;
  ALLOW_OUTBOUND_NOTIFICATIONS?: string;
  TEST_NATIVE_EVENTS_RISK_ACCEPTANCE?: string;
  EVENTS_REVIEWED_CALLBACK_TARGETS?: string;
}

/** No table/guest exception: normal durable membership and scope checks apply. */
export function testNativeEventsAllowed(env: TestNativeBindings): boolean {
  return (
    env.RELEASE_ENVIRONMENT === "staging" &&
    env.RELEASE_PROFILE === TEST_NATIVE_EVENTS_PROFILE &&
    /^[a-f0-9]{40}$/.test(env.RELEASE_BUILD_SHA ?? "") &&
    env.RESTORE_QUARANTINE === "false" &&
    env.ENABLE_MCP_SUBSCRIPTIONS === "true" &&
    env.ENABLE_OPENAI_EVENTS === "true" &&
    env.ALLOW_OUTBOUND_NOTIFICATIONS === "true" &&
    env.TEST_NATIVE_EVENTS_RISK_ACCEPTANCE === TEST_NATIVE_EVENTS_RISK &&
    reviewedCallbackTargets(env.EVENTS_REVIEWED_CALLBACK_TARGETS).length > 0
  );
}

/** Readback only: a paused deployment remains inspectable for manual rollback. */
export function testNativeEventsInspectable(env: TestNativeBindings): boolean {
  return (
    testNativeEventsAllowed(env) ||
    (env.ALLOW_OUTBOUND_NOTIFICATIONS === "false" &&
      testNativeEventsAllowed({ ...env, ALLOW_OUTBOUND_NOTIFICATIONS: "true" }))
  );
}
