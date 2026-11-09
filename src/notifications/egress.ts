/**
 * Reviewed callback URL policy and bounded native Workers HTTPS transport.
 *
 * Hosted Workers public-network proxy behavior is the transport premise, not
 * proof of REQ-002's DNS-rebinding and TLS connection-boundary acceptance.
 * Public Events must remain gated off until real-host adversarial evidence
 * verifies that boundary. This sender makes no DNS preflight or IP override.
 */
export type CallbackFailure =
  | "destination-rejected"
  | "request-too-large"
  | "invalid-headers"
  | "redirect-refused"
  | "response-too-large"
  | "deadline"
  | "transport-error"
  | "upstream-non-2xx"
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
  | {
      ok: false;
      reason: CallbackFailure;
      status?: number;
      cfErrorCode?: number;
    };

export interface CallbackRequest {
  body: Uint8Array;
  method: "POST";
  /** Only explicitly supported callback-control and signed-event headers. */
  headers?: Readonly<Record<string, string>>;
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

const ALLOWED_HEADER_NAMES = new Set([
  "content-type",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "x-mcp-signature",
  "x-mcp-subscription-id",
]);
const HEADER_VALUE = /^[\x20-\x7e]{1,2048}$/;

/** Refuse arbitrary headers that could change HTTP routing or leak credentials. */
function callbackHeaders(
  input: Readonly<Record<string, string>> | undefined,
): Headers | null {
  const result = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  if (input === undefined) return result;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const entries = Object.entries(input);
  if (entries.length > 8) return null;
  for (const [key, value] of entries) {
    if (
      !ALLOWED_HEADER_NAMES.has(key.toLowerCase()) ||
      typeof value !== "string" ||
      !HEADER_VALUE.test(value)
    )
      return null;
    result.set(key, value);
  }
  return result;
}

/**
 * Read a response within one total request deadline, with no unbounded
 * arrayBuffer()/text() and no response-header or body logging.
 */
async function readBoundedResponse(
  response: Response,
  deadline: Promise<never>,
): Promise<Uint8Array | null> {
  const length = response.headers.get("Content-Length");
  if (
    length !== null &&
    (!/^\d{1,10}$/.test(length) ||
      Number(length) > PLANNED_MAX_CALLBACK_RESPONSE_BYTES)
  )
    return null;
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) {
        completed = true;
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > PLANNED_MAX_CALLBACK_RESPONSE_BYTES) return null;
      chunks.push(next.value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    if (!completed) {
      // Do not wait indefinitely for an untrusted peer to finish cancellation.
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

/**
 * Safely inspect a 5xx upstream response for a Cloudflare 1xxx error code.
 *
 * Header and body patterns are untrusted diagnostic hints, NOT authenticated
 * proof that Cloudflare generated the response or rejected a connection.
 * An upstream can spoof Server, CF-Ray and 1xxx values. The sender's public
 * capability remains disabled independently of this diagnostic.
 *
 * Reads at most 4 KiB across stream chunks within the shared deadline and
 * returns only a numeric hint without logging headers, URLs or response bodies.
 */
export async function extractSafeCloudflareErrorCode(
  response: Response,
  deadline?: Promise<never>,
): Promise<number | undefined> {
  // Only 5xx status codes represent origin/edge errors
  if (response.status < 500 || response.status >= 600) {
    return undefined;
  }

  // Heuristic only: even Cloudflare-shaped headers can be supplied by an origin.
  const serverHeader = response.headers.get("server")?.toLowerCase() ?? "";
  const cfRay = response.headers.get("cf-ray");
  const resemblesCloudflareError =
    serverHeader.includes("cloudflare") || cfRay !== null;
  if (!resemblesCloudflareError) {
    // No Cloudflare-shaped diagnostic indicators; provenance is unverified.
    return undefined;
  }

  // Official Cloudflare edge diagnostic headers
  const cfErrorType = response.headers.get("cf-error-type");
  if (cfErrorType && /^1\d{3}$/.test(cfErrorType)) {
    return Number(cfErrorType);
  }

  const headerCode = response.headers.get("cf-error-code");
  if (headerCode && /^1\d{3}$/.test(headerCode)) {
    return Number(headerCode);
  }

  if (response.statusText && /^1\d{3}$/.test(response.statusText)) {
    return Number(response.statusText);
  }

  // Inspect HTML/text body only if content-type is compatible
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    contentType &&
    !contentType.includes("text/html") &&
    !contentType.includes("text/plain") &&
    !contentType.includes("application/xhtml+xml")
  ) {
    return undefined;
  }

  if (!response.body) return undefined;

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body.getReader();
    const prefix = new Uint8Array(4096);
    let used = 0;
    while (used < prefix.byteLength) {
      const readPromise = reader.read();
      const next = deadline
        ? await Promise.race([readPromise, deadline])
        : await readPromise;
      if (next.done) break;

      const slice = next.value.subarray(0, prefix.byteLength - used);
      prefix.set(slice, used);
      used += slice.byteLength;

      // Search after every chunk so an early 1xxx hint does not wait for EOF.
      const text = new TextDecoder().decode(prefix.subarray(0, used));
      const match =
        text.match(/class=["']cf-error-code["']>\s*(1\d{3})\s*</i) ??
        text.match(/data-translate=["']error_(1\d{3})["']/i) ??
        text.match(/error\s*(?:reference\s*number|code)?[:\s]+(1\d{3})\b/i) ??
        text.match(/error\s+(1\d{3})\b/i) ??
        text.match(/"code"\s*:\s*(1\d{3})\b/);
      if (match) {
        const parsed = Number(match[1]);
        if (parsed >= 1000 && parsed <= 1999) return parsed;
      }
    }
  } catch {
    // Fail closed with undefined on read/timeout/abort errors; never throw or leak
  } finally {
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return undefined;
}

export interface SendVerifiedHttpsOptions {
  /**
   * Include opt-in Cloudflare 1xxx diagnostic error code inspection for 5xx.
   * Diagnostic / probe worker use only; defaults to false in production.
   */
  diagnostics?: boolean;
}

/**
 * Candidate production sender. Only an explicitly reviewed destination may
 * reach the global Workers fetch; no per-request proxy, resolveOverride,
 * socket fallback, automatic redirect or retry is permitted.
 *
 * This function is exercised by the isolated diagnostic and SDK-side tests,
 * but is NOT evidence of final-IP/TLS safety on hosted Workers. The separate
 * capability readiness gate stays false until REQ-002/006 are proven.
 */
export async function sendVerifiedHttps(
  raw: string,
  reviewed: readonly ReviewedCallbackTarget[],
  request: CallbackRequest,
  options?: SendVerifiedHttpsOptions,
): Promise<CallbackTransportOutcome> {
  const destination = validateReviewedCallbackDestination(raw, reviewed);
  if (!destination.ok) return destination;
  if (
    !(request.body instanceof Uint8Array) ||
    request.method !== "POST" ||
    request.body.byteLength > MAX_CALLBACK_REQUEST_BYTES
  )
    return { ok: false, reason: "request-too-large" };
  const headers = callbackHeaders(request.headers);
  if (!headers) return { ok: false, reason: "invalid-headers" };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("callback-deadline"));
    }, PLANNED_CALLBACK_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      fetch(destination.url.toString(), {
        method: "POST",
        body: new Uint8Array(request.body).buffer,
        headers,
        redirect: "manual",
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    )
      return { ok: false, reason: "redirect-refused" };
    if (response.status < 200 || response.status >= 300) {
      if (controller.signal.aborted) {
        return { ok: false, reason: "deadline" };
      }
      let cfErrorCode: number | undefined;
      if (
        options?.diagnostics &&
        response.status >= 500 &&
        response.status < 600
      ) {
        cfErrorCode = await extractSafeCloudflareErrorCode(response, deadline);
        if (controller.signal.aborted) {
          return { ok: false, reason: "deadline" };
        }
      } else if (response.body) {
        void response.body.cancel().catch(() => undefined);
      }
      controller.abort();
      return {
        ok: false,
        reason: "upstream-non-2xx",
        status: response.status,
        ...(cfErrorCode !== undefined ? { cfErrorCode } : {}),
      };
    }
    const body = await readBoundedResponse(response, deadline);
    if (!body) {
      controller.abort();
      return { ok: false, reason: "response-too-large" };
    }
    return { ok: true, status: response.status, body };
  } catch {
    // Never surface platform exception text (it may include secrets or URL).
    return {
      ok: false,
      reason: controller.signal.aborted ? "deadline" : "transport-error",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/** Public Events remain unavailable while REQ-002/006 are not verified. */
export function callbackTransportReadiness(): {
  enabled: false;
  reason: "connection-boundary-unverified";
} {
  return { enabled: false, reason: "connection-boundary-unverified" };
}
