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

export function guestChallengeConfiguration(
  env: Env,
): GuestChallengeConfiguration {
  const mode = env.GUEST_CHALLENGE_MODE ?? "off";
  if (mode === "off") return { mode: "off" };
  if (
    mode !== "required" ||
    !/^[A-Za-z0-9_-]{3,128}$/.test(env.TURNSTILE_SITE_KEY ?? "") ||
    !env.TURNSTILE_SECRET ||
    env.TURNSTILE_SECRET.length > 256
  ) {
    return { mode: "unavailable" };
  }
  return { mode: "required", siteKey: env.TURNSTILE_SITE_KEY as string };
}

const MAX_CHALLENGE_VERDICT_BYTES = 4 * 1024;

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
  if (config.mode !== "required" || !/^[A-Za-z0-9._-]{1,2048}$/.test(token))
    return false;
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
        // Workers accepts manual, not the Fetch standard's "error" mode.
        redirect: "manual",
        signal: AbortSignal.timeout(3_000),
      },
    );
    // Never follow verifier redirects, even if the target returns a Location.
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400) ||
      !response.ok
    )
      return false;
    // Bound an external verifier response before JSON parsing or allocation.
    // A valid Siteverify verdict is small; excess or malformed data fails closed.
    const declaredBytes = response.headers.get("Content-Length");
    if (
      declaredBytes !== null &&
      (!/^\d{1,10}$/.test(declaredBytes) ||
        Number(declaredBytes) > MAX_CHALLENGE_VERDICT_BYTES)
    ) {
      return false;
    }
    if (!response.body) return false;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > MAX_CHALLENGE_VERDICT_BYTES) {
          void reader.cancel().catch(() => undefined);
          return false;
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Never retain the response or include token/error details in diagnostics.
    const verdict: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
      return false;
    }
    const fields = verdict as Record<string, unknown>;
    const issued =
      typeof fields.challenge_ts === "string"
        ? Date.parse(fields.challenge_ts)
        : NaN;
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

/** All requests from one edge source share one durable rate authority. */
export type EdgeAdmissionCategory =
  | "guest"
  | "dcr"
  | "protocol"
  | "application"
  | "invitation";

const EDGE_DEFAULTS = {
  guest: 30,
  dcr: 30,
  protocol: 120,
  application: 600,
  invitation: 60,
} as const;

const EDGE_RATE_SETTINGS = {
  guest: "EDGE_GUEST_RATE_PER_MINUTE",
  dcr: "EDGE_DCR_RATE_PER_MINUTE",
  protocol: "EDGE_PROTOCOL_RATE_PER_MINUTE",
  application: "EDGE_APPLICATION_RATE_PER_MINUTE",
  invitation: "EDGE_INVITATION_RATE_PER_MINUTE",
} as const;

type RateSetting = (typeof EDGE_RATE_SETTINGS)[EdgeAdmissionCategory];

/** Invalid operator limits fail closed rather than silently disabling quotas. */
function configuredRate(
  env: Env,
  setting: RateSetting | "PRINCIPAL_RATE_PER_MINUTE",
  defaultLimit: number,
): number | null {
  const raw = env[setting];
  if (raw === undefined) return defaultLimit;
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) return null;
  const count = Number(raw);
  return count <= 10_000 ? count : null;
}

function admissionResponse(status: 429 | 503, retryAfterMs?: number): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  if (retryAfterMs !== undefined) {
    headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
    );
  }
  return new Response(
    status === 429 ? "RATE_LIMITED" : "Admission authority unavailable",
    { status, headers },
  );
}

async function admissionKey(identity: string): Promise<string> {
  const data = new TextEncoder().encode(identity);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * CF-Connecting-IP is meaningful only on the trusted direct edge boundary.
 * Canonicalize valid IPv4/IPv6 forms before assigning a durable rate bucket.
 * Malformed values share the same bounded unknown-source bucket; forwarding
 * from a same-zone Worker still requires independent ingress trust controls.
 */
function edgeSource(request: Request): string {
  const source = request.headers.get("CF-Connecting-IP");
  if (!source || source.length > 64 || !/^[0-9a-fA-F:.]+$/.test(source)) {
    return "unknown-source";
  }
  const ipv6 = source.includes(":");
  if (!ipv6) {
    const octets = source.split(".");
    if (
      octets.length !== 4 ||
      octets.some(
        (octet) => !/^(0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255,
      )
    ) {
      return "unknown-source";
    }
  }
  try {
    const address = ipv6 ? `[${source}]` : source;
    const canonical = new URL(`http://${address}/`).hostname.toLowerCase();
    if (ipv6 && (!canonical.startsWith("[") || !canonical.endsWith("]"))) {
      return "unknown-source";
    }
    return canonical;
  } catch {
    return "unknown-source";
  }
}

async function consumeAdmission(
  env: Env,
  identity: string,
  category: EdgeAdmissionCategory,
  limit: number | null,
): Promise<Response | null> {
  if (limit === null) return admissionResponse(503);
  try {
    const key = await admissionKey(identity);
    const stub = env.ADMISSION.get(env.ADMISSION.idFromName(key));
    const outcome = await stub.consume(category, limit);
    return outcome.allowed
      ? null
      : admissionResponse(429, outcome.retryAfterMs);
  } catch {
    // No fail-open path on an absent/broken DO or invalid configuration.
    return admissionResponse(503);
  }
}

/** Cross-guest ingress policy; applied before sensitive public route handlers. */
export function checkEdgeAdmission(
  request: Request,
  env: Env,
  category: EdgeAdmissionCategory,
): Promise<Response | null> {
  const limit = configuredRate(
    env,
    EDGE_RATE_SETTINGS[category],
    EDGE_DEFAULTS[category],
  );
  return consumeAdmission(
    env,
    `edge-v1:${edgeSource(request)}`,
    category,
    limit,
  );
}

/**
 * A verified OAuth guest is the principal across all of its connections.
 * Multiple tokens, Worker isolates or concurrent requests cannot evade the
 * default 60 application requests per rolling minute.
 */
export function checkPrincipalAdmission(
  env: Env,
  verifiedGuestId: string,
): Promise<Response | null> {
  const limit = configuredRate(
    env,
    "PRINCIPAL_RATE_PER_MINUTE",
    INGRESS_LIMITS.principalRequestsPerMinute,
  );
  return consumeAdmission(
    env,
    `principal-v1:${verifiedGuestId}`,
    "application",
    limit,
  );
}
