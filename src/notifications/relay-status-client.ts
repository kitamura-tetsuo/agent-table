/** Unwired, metadata-only authenticated readback. Never forwards a callback. */
import { validateReviewedCallbackDestination } from "./egress";
import type { RelayClientConfiguration } from "./relay-client";

export type RelayStatusOutcome =
  | { ok: true; state: "pending" | "unknown" }
  | {
      ok: true;
      state: "completed";
      outcome: { kind: "http"; status: number } | { kind: "not-sent" };
    }
  | { ok: false; reason: "unavailable" | "conflict" };
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const exact = (
  value: unknown,
  keys: string[],
): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === keys.sort().join(",");

/**
 * Fresh read timestamp does NOT change original forwarding timestamp/expiry.
 * Authority must include current caller/grant policy; unknown never grants retry.
 */
export async function readRelayStatus(
  configuration: RelayClientConfiguration,
  requestInput: {
    requestId: string;
    operationDigest: string;
    timestamp: number;
  },
  authorizeRead: () => Promise<boolean>,
  transport: typeof fetch = fetch,
): Promise<RelayStatusOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const unavailable = { ok: false, reason: "unavailable" } as const;
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw new Error("deadline");
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((_, reject) => {
          abort = () => reject(new Error("deadline"));
          controller.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) controller.signal.removeEventListener("abort", abort);
    }
  };
  try {
    const config = structuredClone(configuration);
    const request = structuredClone(requestInput);
    if (
      !/^[A-Za-z0-9_-]{16,128}$/.test(config.callerId) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId) ||
      !/^[a-f0-9]{64}$/.test(request.operationDigest) ||
      !/^(production|test):[a-z][a-z0-9-]{2,63}$/.test(config.audience) ||
      !Number.isSafeInteger(request.timestamp) ||
      Math.abs(Date.now() - request.timestamp) > 60000 ||
      typeof authorizeRead !== "function" ||
      config.signingKeyPkcs8.length > 1024 ||
      new URL(config.origin).origin !== config.origin ||
      !validateReviewedCallbackDestination(config.origin + "/relay/v1/status", [
        { origin: config.origin, pathPrefix: "/relay/v1/status" },
      ]).ok
    )
      return unavailable;
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        audience: config.audience,
        requestId: request.requestId,
        timestamp: request.timestamp,
        operationDigest: request.operationDigest,
      }),
    );
    if (bytes.length > 1024) return unavailable;
    const keyBytes = Uint8Array.from(atob(config.signingKeyPkcs8), (c) =>
      c.charCodeAt(0),
    );
    const key = await bounded(
      crypto.subtle.importKey("pkcs8", keyBytes, { name: "Ed25519" }, false, [
        "sign",
      ]),
    );
    const prefix = new TextEncoder().encode(
      "POST\n/relay/v1/status\n" + config.callerId + "\n",
    );
    const signing = new Uint8Array(prefix.length + bytes.length);
    signing.set(prefix);
    signing.set(bytes, prefix.length);
    const signature = new Uint8Array(
      await bounded(crypto.subtle.sign("Ed25519", key, signing)),
    );
    if (
      (await bounded(authorizeRead())) !== true ||
      controller.signal.aborted ||
      Math.abs(Date.now() - request.timestamp) > 60000
    )
      return unavailable;
    const response = await bounded(
      transport(config.origin + "/relay/v1/status", {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-agent-table-caller": config.callerId,
          "x-agent-table-signature": b64(signature),
        },
        body: bytes,
      }),
    );
    if (response.status !== 200) {
      if (response.body) await bounded(response.body.cancel());
      return response.status === 409
        ? { ok: false, reason: "conflict" }
        : unavailable;
    }
    const reader = response.body?.getReader();
    if (!reader) return unavailable;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      size += value.length;
      if (size > 1024) {
        await bounded(reader.cancel());
        return unavailable;
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) {
      joined.set(chunk, position);
      position += chunk.length;
    }
    const result: unknown = JSON.parse(new TextDecoder().decode(joined));
    if (
      exact(result, ["state"]) &&
      (result.state === "pending" || result.state === "unknown")
    )
      return { ok: true, state: result.state };
    if (!exact(result, ["state", "outcome"]) || result.state !== "completed")
      return unavailable;
    const outcome = result.outcome;
    if (exact(outcome, ["kind"]) && outcome.kind === "not-sent")
      return { ok: true, state: "completed", outcome: { kind: "not-sent" } };
    if (
      exact(outcome, ["kind", "status"]) &&
      outcome.kind === "http" &&
      typeof outcome.status === "number" &&
      Number.isInteger(outcome.status) &&
      outcome.status >= 100 &&
      outcome.status <= 599
    )
      return {
        ok: true,
        state: "completed",
        outcome: { kind: "http", status: outcome.status },
      };
    return unavailable;
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
