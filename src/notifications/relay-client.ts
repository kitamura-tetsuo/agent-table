/**
 * Unwired Worker-to-relay transport adapter. A release profile must select it
 * explicitly; this module never enables Events or creates secrets on import.
 */
import {
  type CallbackRequest,
  type CallbackTransportOutcome,
  type ReviewedCallbackTarget,
  validateReviewedCallbackDestination,
} from "./egress";

export interface RelayClientConfiguration {
  origin: string;
  callerId: string;
  audience: string;
  /** Operator-provisioned environment-specific Ed25519 PKCS8, base64. */
  signingKeyPkcs8: string;
  callbackTargets: readonly ReviewedCallbackTarget[];
}
export interface RelayOperation {
  /** Persisted caller operation identity; never mint a new key on retry. */
  requestId: string;
  timestamp: number;
}
const ID = /^[A-Za-z0-9_-]{16,128}$/;
const allowedHeaders = new Set([
  "content-type",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "x-mcp-signature",
  "x-mcp-subscription-id",
]);
const base64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
};
const decode = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Final fresh authorization is called AFTER async signing and immediately
 * before fetch. Caller must include current grant/lifecycle/generation/lease
 * checks and return false on unavailable evidence. No retries occur here.
 */
export async function sendRelayHttps(
  configuration: RelayClientConfiguration,
  operationInput: RelayOperation,
  destination: string,
  request: CallbackRequest,
  authorizeBeforeSend: () => Promise<boolean>,
  transport: typeof fetch = fetch,
): Promise<CallbackTransportOutcome> {
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = structuredClone(configuration);
    const operation = structuredClone(operationInput);
    controller = new AbortController();
    const signal = controller.signal;
    timer = setTimeout(() => controller?.abort(), 15000);
    const bounded = async <T>(promise: Promise<T>): Promise<T> => {
      if (signal.aborted) throw new Error("deadline");
      let rejectAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_, reject) => {
            rejectAbort = () => reject(new Error("deadline"));
            signal.addEventListener("abort", rejectAbort, { once: true });
          }),
        ]);
      } finally {
        if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
      }
    };
    const origin = new URL(config.origin);
    if (
      origin.origin !== config.origin ||
      !validateReviewedCallbackDestination(config.origin + "/relay/v1", [
        { origin: config.origin, pathPrefix: "/relay/v1" },
      ]).ok ||
      !/^(production|test):[a-z][a-z0-9-]{2,63}$/.test(config.audience) ||
      !ID.test(config.callerId) ||
      !ID.test(operation.requestId) ||
      !Number.isSafeInteger(operation.timestamp) ||
      Math.abs(Date.now() - operation.timestamp) > 60000 ||
      !validateReviewedCallbackDestination(destination, config.callbackTargets)
        .ok ||
      request.method !== "POST" ||
      request.body.byteLength > 16384 ||
      typeof authorizeBeforeSend !== "function"
    )
      return { ok: false, reason: "destination-rejected" };
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (
        !allowedHeaders.has(key) ||
        typeof value !== "string" ||
        value.length > 4096 ||
        /[\r\n]/.test(value) ||
        value.includes("\0")
      )
        return { ok: false, reason: "invalid-headers" };
      headers[key] = value;
    }
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        audience: config.audience,
        requestId: operation.requestId,
        timestamp: operation.timestamp,
        destination,
        headers,
        payload: base64(new Uint8Array(request.body)),
      }),
    );
    if (bytes.byteLength > 32768 || config.signingKeyPkcs8.length > 1024)
      return { ok: false, reason: "request-too-large" };
    const pkcs8 = decode(config.signingKeyPkcs8);
    const key = await bounded(
      crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, [
        "sign",
      ]),
    );
    const prefix = new TextEncoder().encode(
      "POST\n/relay/v1\n" + config.callerId + "\n",
    );
    const signing = new Uint8Array(prefix.length + bytes.length);
    signing.set(prefix);
    signing.set(bytes, prefix.length);
    const signature = new Uint8Array(
      await bounded(crypto.subtle.sign("Ed25519", key, signing)),
    );
    if (
      (await bounded(authorizeBeforeSend())) !== true ||
      signal.aborted ||
      Math.abs(Date.now() - operation.timestamp) > 60000
    )
      return { ok: false, reason: "connection-boundary-unverified" };
    const response = await bounded(
      transport(config.origin + "/relay/v1", {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-agent-table-caller": config.callerId,
          "x-agent-table-signature": base64(signature),
        },
        body: bytes,
      }),
    );
    if (response.status !== 200) {
      if (response.body) await bounded(response.body.cancel());
      return {
        ok: false,
        reason:
          response.status >= 300 && response.status < 400
            ? "redirect-refused"
            : "transport-error",
      };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, reason: "transport-error" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await bounded(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > 90000) {
        await bounded(reader.cancel());
        return { ok: false, reason: "response-too-large" };
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(new TextDecoder().decode(joined));
    if (
      !value ||
      Object.keys(value).sort().join(",") !== "payload,status" ||
      !Number.isInteger(value.status) ||
      value.status < 200 ||
      value.status >= 300 ||
      typeof value.payload !== "string" ||
      value.payload.length > 87384
    )
      return { ok: false, reason: "transport-error" };
    const body = decode(value.payload);
    if (base64(body) !== value.payload || body.length > 65536)
      return { ok: false, reason: "response-too-large" };
    return { ok: true, status: value.status, body };
  } catch {
    return {
      ok: false,
      reason: controller?.signal.aborted ? "deadline" : "transport-error",
    };
  } finally {
    clearTimeout(timer);
    controller?.abort();
  }
}
