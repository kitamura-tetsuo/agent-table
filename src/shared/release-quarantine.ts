import { privatePilotConfiguration } from "./private-pilot";

/**
 * This independent Worker binding is outside restored Durable Object state.
 * A missing mode, missing quarantine flag, or unknown value fails closed.
 * It must be set to false only after independently authorized release.
 */
export function isRestoreQuarantined(
  env: Partial<
    Pick<
      Env,
      | "RELEASE_ENVIRONMENT"
      | "RESTORE_QUARANTINE"
      | "RELEASE_BUILD_SHA"
      | "RELEASE_PROFILE"
      | "ENABLE_MCP_SUBSCRIPTIONS"
      | "ENABLE_OPENAI_EVENTS"
      | "ALLOW_OUTBOUND_NOTIFICATIONS"
      | "PRIVATE_PILOT_POLICY"
    >
  >,
): boolean {
  const knownEnvironment =
    env.RELEASE_ENVIRONMENT === "local" ||
    env.RELEASE_ENVIRONMENT === "staging" ||
    env.RELEASE_ENVIRONMENT === "production";
  if (!knownEnvironment || env.RESTORE_QUARANTINE !== "false") return true;
  if (env.RELEASE_ENVIRONMENT === "local") return false;
  if (privatePilotConfiguration(env)) return false;
  // The initial public profile is manual-only. A feature flag or old Worker
  // configuration must not promote unverified live or autonomous capability.
  return !(
    env.RELEASE_PROFILE === "manual" &&
    /^[a-f0-9]{40}$/.test(env.RELEASE_BUILD_SHA ?? "") &&
    env.ENABLE_MCP_SUBSCRIPTIONS === "false" &&
    env.ENABLE_OPENAI_EVENTS === "false" &&
    env.ALLOW_OUTBOUND_NOTIFICATIONS === "false"
  );
}

export function rejectRestoredAccess(
  env: Parameters<typeof isRestoreQuarantined>[0],
): Response | null {
  if (!isRestoreQuarantined(env)) return null;
  return new Response("Service unavailable during recovery", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "300",
    },
  });
}

// Park an already-fired DO alarm without touching restored private SQL rows.
// Without rearming, an inactive DO might never reconstruct after release and
// expired data would lack its scheduled cleanup wakeup.
export const RESTORE_QUARANTINE_RECHECK_MS = 6 * 60 * 60_000;

export async function deferQuarantinedAlarm(
  env: Parameters<typeof isRestoreQuarantined>[0],
  storage: DurableObjectStorage,
): Promise<boolean> {
  if (!isRestoreQuarantined(env)) return false;
  await storage.setAlarm(Date.now() + RESTORE_QUARANTINE_RECHECK_MS);
  return true;
}
