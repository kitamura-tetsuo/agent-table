/** Bounded Worker ingress and independently controlled admission switches. */

const HTTP_METHODS_WITH_BODIES = new Set(["POST", "PUT", "PATCH"]);
const MAX_URL_BYTES = 2_048;
const MAX_COOKIE_BYTES = 8_192;
const MAX_AUTHORIZATION_BYTES = 8_192;

export type AdmissionCategory =
  | "guest"
  | "dcr"
  | "protocol"
  | "invitation"
  | "application"
  | "existing-finalize";

export const INGRESS_LIMITS = {
  guestBodyBytes: 4 * 1_024,
  dcrBodyBytes: 8 * 1_024,
  protocolBodyBytes: 8 * 1_024,
  applicationBodyBytes: 32 * 1_024,
  principalRequestsPerMinute: 60,
} as const;

/** A paused new-table switch never disables close/delete operations. */
export function allowNewTables(env: Env): boolean {
  return env.ALLOW_NEW_TABLES === "true";
}

/**
 * Outbound authorization must be checked again immediately before any
 * future delivery. This is only a control hook, not a delivery producer.
 */
export function allowOutboundNotifications(env: Env): boolean {
  return env.ALLOW_OUTBOUND_NOTIFICATIONS === "true";
}

/** No raw body, token, IP or table identifier is echoed in this response. */
function reject(status: number): Response {
  return new Response(
    status === 413
      ? "Request too large"
      : status === 414
        ? "Request target too long"
        : "Invalid request",
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    },
  );
}

function bodyLimit(url: URL): number {
  const path = url.pathname;
  if (path === "/oauth/register") return INGRESS_LIMITS.dcrBodyBytes;
  if (
    path === "/oauth/token" ||
    path === "/oauth/revoke" ||
    path === "/authorize"
  ) {
    return INGRESS_LIMITS.protocolBodyBytes;
  }
  if (
    path === "/guest/session" ||
    path === "/guest/delete" ||
    path === "/guest/connections/revoke"
  ) {
    return INGRESS_LIMITS.guestBodyBytes;
  }
  return INGRESS_LIMITS.applicationBodyBytes;
}

/**
 * Check actual streamed bytes before handlers parse or allocate a request
 * body. A Content-Length claim is never sufficient evidence of its size.
 * No per-isolate counters, client-supplied identities, or auth overrides.
 */
export async function rejectOversizedIngress(
  request: Request,
): Promise<Response | null> {
  if (new TextEncoder().encode(request.url).byteLength > MAX_URL_BYTES) {
    return reject(414);
  }
  if (
    (request.headers.get("Cookie")?.length ?? 0) > MAX_COOKIE_BYTES ||
    (request.headers.get("Authorization")?.length ?? 0) >
      MAX_AUTHORIZATION_BYTES
  ) {
    return reject(413);
  }
  if (!HTTP_METHODS_WITH_BODIES.has(request.method) || !request.body) {
    return null;
  }
  const limit = bodyLimit(new URL(request.url));
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^\d{1,12}$/.test(declared)) return reject(400);
    if (Number(declared) > limit) return reject(413);
  }
  let consumed = 0;
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return null;
      consumed += next.value.byteLength;
      if (consumed > limit) {
        void reader.cancel().catch(() => undefined);
        return reject(413);
      }
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return reject(400);
  } finally {
    reader.releaseLock();
  }
}

/** A misconfigured required challenge must never silently allow new guests. */
export type GuestChallengeConfiguration =
  | { mode: "off" }
  | { mode: "required"; siteKey: string }
  | { mode: "unavailable" };

export function guestChallengeConfiguration(env: Env): GuestChallengeConfiguration {
  const mode = env.GUEST_CHALLENGE_MODE ?? "off";
  if (mode === "off") return { mode: "off" };
  if (mode !== "required" ||
      !/^[A-Za-z0-9_-]{3,128}$/.test(env.TURNSTILE_SITE_KEY ?? "") ||
      !env.TURNSTILE_SECRET ||
      env.TURNSTILE_SECRET.length > 256) {
    return { mode: "unavailable" };
  }
  return { mode: "required", siteKey: env.TURNSTILE_SITE_KEY as string };
}

/**
 * Verify a single-use Turnstile token with the official server-side endpoint.
 * A browser verdict, forwarded IP address or unrecognized response is never proof.
 * The secret is a Worker secret, not a committed Wrangler var.
 */
export async function verifyGuestChallenge(
  env: Env,
  token: string,
  verifierFetch: typeof fetch = fetch,
): Promise<boolean> {
  const config = guestChallengeConfiguration(env);
  if (config.mode === "off") return true;
  if (config.mode !== "required" ||
      !/^[A-Za-z0-9._-]{1,2048}$/.test(token)) return false;
  let hostname: string;
  try {
    hostname = new URL(env.PUBLIC_ORIGIN).hostname;
    if (!hostname) return false;
  } catch {
    return false;
  }
  try {
    const response = await verifierFetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET as string,
          response: token,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) return false;
    // Never retain response content or include token/error details in diagnostics.
    const verdict: unknown = await response.json();
    if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
      return false;
    }
    const fields = verdict as Record<string, unknown>;
    const issued = typeof fields.challenge_ts === "string" ?
      Date.parse(fields.challenge_ts) : NaN;
    return (
      fields.success === true &&
      fields.action === "create_guest" &&
      fields.hostname === hostname &&
      Number.isFinite(issued) &&
      issued <= Date.now() + 30_000 &&
      issued > Date.now() - 300_000
    );
  } catch {
    return false;
  }
}
