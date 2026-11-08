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
    if (!/^\\d{1,12}$/.test(declared)) return reject(400);
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
