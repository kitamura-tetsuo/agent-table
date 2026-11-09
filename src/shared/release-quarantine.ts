/**
 * This independent Worker binding is outside restored Durable Object state.
 * A missing mode, missing quarantine flag, or unknown value fails closed.
 * It must be set to false only after independently authorized release.
 */
export function rejectRestoredAccess(
  env: Pick<Env, "RELEASE_ENVIRONMENT" | "RESTORE_QUARANTINE">,
): Response | null {
  const knownEnvironment =
    env.RELEASE_ENVIRONMENT === "local" ||
    env.RELEASE_ENVIRONMENT === "staging" ||
    env.RELEASE_ENVIRONMENT === "production";
  if (knownEnvironment && env.RESTORE_QUARANTINE === "false") return null;
  return new Response("Service unavailable during recovery", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "300",
    },
  });
}
