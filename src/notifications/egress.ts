/**
 * Safe callback destination preflight.
 *
 * This layer deliberately performs no network I/O. The Workers runtime has
 * not yet demonstrated address policy at the connection boundary and TLS
 * validation against the intended hostname. An allowlist is never proof of
 * either requirement; do not replace the fail-closed sender with fetch().
 */
export type CallbackFailure =
  | "destination-rejected"
  | "request-too-large"
  | "connection-boundary-unverified";

export interface ReviewedCallbackTarget {
  /** Canonical HTTPS origin, reviewed by the operator. */
  origin: string;
  /**
   * Canonical path prefix on that origin, with a path-segment boundary.
   * Use "/" only when the provider generates unrelated opaque paths.
   */
  pathPrefix: string;
}

export type CallbackDestinationDecision =
  | { ok: true; url: URL }
  | { ok: false; reason: "destination-rejected" };

export type CallbackTransportOutcome =
  | { ok: true; status: number; body: Uint8Array }
  | { ok: false; reason: CallbackFailure };

export interface CallbackRequest {
  body: Uint8Array;
  method: "POST";
}

/** This is a policy cap, not an assertion that network requests are enabled. */
export const MAX_CALLBACK_REQUEST_BYTES = 16 * 1024;
export const PLANNED_MAX_CALLBACK_RESPONSE_BYTES = 64 * 1024;
export const PLANNED_CALLBACK_TIMEOUT_MS = 10_000;

const MAX_URL_LENGTH = 2_048;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".invalid",
];

function hasUnsafeRawCharacters(raw: string): boolean {
  for (const character of raw) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127 || character === "#" || character === "\\") {
      return true;
    }
  }
  return false;
}

function isPublicDnsName(hostname: string): boolean {
  if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    hostname.startsWith("[") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
  ) {
    return false;
  }
  if (
    RESERVED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    hostname === "localhost"
  ) {
    return false;
  }
  return hostname.split(".").every((label) => DNS_LABEL.test(label));
}

function matchesReviewedTarget(
  url: URL,
  target: ReviewedCallbackTarget,
): boolean {
  if (
    typeof target.origin !== "string" ||
    typeof target.pathPrefix !== "string" ||
    url.origin !== target.origin ||
    !target.pathPrefix.startsWith("/") ||
    target.pathPrefix.startsWith("//") ||
    target.pathPrefix.length > MAX_URL_LENGTH ||
    hasUnsafeRawCharacters(target.pathPrefix) ||
    target.pathPrefix.includes("?")
  ) {
    return false;
  }

  // Reject non-canonical policy paths so URL normalization cannot widen them.
  const policyPath = new URL(target.pathPrefix, target.origin);
  if (
    policyPath.origin !== target.origin ||
    policyPath.pathname !== target.pathPrefix
  ) {
    return false;
  }

  const prefix = target.pathPrefix;
  return (
    prefix === "/" ||
    url.pathname === prefix ||
    url.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
  );
}

/**
 * Reject unexpected origins and paths before any I/O. A provider may supply
 * an opaque per-subscription suffix or query without individual path review.
 * Successful preflight does not prove connection-time DNS/IP/TLS safety.
 */
export function validateReviewedCallbackDestination(
  raw: string,
  reviewed: readonly ReviewedCallbackTarget[],
): CallbackDestinationDecision {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_URL_LENGTH ||
    !raw.startsWith("https://") ||
    raw !== raw.trim() ||
    hasUnsafeRawCharacters(raw)
  ) {
    return { ok: false, reason: "destination-rejected" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "destination-rejected" };
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !isPublicDnsName(url.hostname) ||
    !reviewed.some((target) => matchesReviewedTarget(url, target))
  ) {
    return { ok: false, reason: "destination-rejected" };
  }
  return { ok: true, url };
}

/**
 * Explicit safety gate. Neither global fetch nor cloudflare:sockets currently
 * has verified connection-time IP policy and intended-host TLS proof here.
 * Never replace this stub with an implicit outbound request or a mock result.
 */
export async function sendVerifiedHttps(
  raw: string,
  reviewed: readonly ReviewedCallbackTarget[],
  request: CallbackRequest,
): Promise<CallbackTransportOutcome> {
  const destination = validateReviewedCallbackDestination(raw, reviewed);
  if (!destination.ok) {
    return destination;
  }
  if (request.body.byteLength > MAX_CALLBACK_REQUEST_BYTES) {
    return { ok: false, reason: "request-too-large" };
  }
  return { ok: false, reason: "connection-boundary-unverified" };
}

/** Release capability is fixed off until REQ-002 and REQ-006 are proven. */
export function callbackTransportReadiness(): {
  enabled: false;
  reason: "connection-boundary-unverified";
} {
  return { enabled: false, reason: "connection-boundary-unverified" };
}
