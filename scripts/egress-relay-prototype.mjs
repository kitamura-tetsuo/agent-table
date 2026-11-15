/**
 * Unconnected Node relay transport prototype. No listener, CLI, credentials,
 * retries or production import. Never invoke with private production payloads
 * before independent review and an approved authenticated relay deployment.
 */
import https from "node:https";
import tls from "node:tls";
import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import { validateReviewedCallbackDestination } from "../src/notifications/egress.ts";

const DENIED = [
  [0, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];
export function publicV4(address) {
  if (isIP(address) !== 4) return false;
  const n = address.split(".").reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0);
  return !DENIED.some(
    ([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits),
  );
}

/** Resolve once; reject mixed public/private A answers; never resolve at dial. */
export async function preparePinnedRequest(
  destination,
  targets,
  resolve = resolve4,
) {
  const checked = validateReviewedCallbackDestination(destination, targets);
  if (!checked.ok) throw new Error("destination-rejected");
  const answers = await resolve(checked.url.hostname);
  if (
    !Array.isArray(answers) ||
    answers.length === 0 ||
    answers.length > 64 ||
    !answers.every(publicV4)
  )
    throw new Error("address-rejected");
  return Object.freeze({
    hostname: checked.url.hostname,
    address: answers[0],
    path: checked.url.pathname + checked.url.search,
  });
}

/**
 * Only release the socket to HTTP after TLS identity AND actual peer IP match.
 * Using the resolved literal removes a hostname relookup/validation-to-dial gap.
 * Each invocation owns a new agent: no pooled socket reuse across destinations.
 */
export class PinnedAgent extends https.Agent {
  constructor(plan, connect = tls.connect) {
    super({ keepAlive: false, maxSockets: 1 });
    if (!publicV4(plan.address)) throw new Error("address-rejected");
    this.plan = plan;
    this.connect = connect;
    this.pending = new Set();
  }
  createConnection(_options, callback) {
    const { hostname, address } = this.plan;
    let finished = false;
    let socket;
    const done = (error) => {
      if (finished) return;
      finished = true;
      this.pending.delete(cancel);
      if (error) socket?.destroy();
      callback(error, error ? undefined : socket);
    };
    const cancel = () => done(new Error("transport-error"));
    this.pending.add(cancel);
    try {
      socket = this.connect({
        host: address,
        port: 443,
        family: 4,
        servername: hostname,
        rejectUnauthorized: true,
        // Never infer certificate identity from the literal-IP dial target.
        checkServerIdentity: (_name, certificate) =>
          tls.checkServerIdentity(hostname, certificate),
      });
    } catch {
      done(new Error("transport-error"));
      return;
    }
    socket.once("error", cancel);
    socket.once("close", cancel);
    socket.once("secureConnect", () => {
      if (
        !socket.authorized ||
        socket.remoteAddress !== address ||
        socket.remotePort !== 443
      ) {
        done(new Error("connection-boundary-rejected"));
        return;
      }
      done(null);
    });
    // No early socket return: HTTP cannot write before the boundary checks.
  }
  destroy() {
    for (const cancel of [...this.pending]) cancel();
    super.destroy();
  }
}

const ALLOWED_HEADERS = new Set([
  "content-type",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "x-mcp-signature",
  "x-mcp-subscription-id",
]);
export function checkedHeaders(headers) {
  const result = Object.create(null);
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (
      !ALLOWED_HEADERS.has(key) ||
      typeof value !== "string" ||
      value.length > 4096 ||
      /[\r\n\x00]/.test(value)
    )
      throw new Error("invalid-headers");
    result[key] = value;
  }
  return result;
}

/**
 * Library-only candidate. A future relay must authenticate the caller, enforce
 * rate/body bounds and replay protection BEFORE calling this function.
 * Hard deadline includes DNS, TLS and response. Errors never expose URL/secrets.
 */
export function createPrototypeSender({
  resolve = resolve4,
  requestHttps = https.request,
  schedule = setTimeout,
} = {}) {
  return async function sendPinnedPrototype(
    destination,
    targets,
    body,
    headers = {},
  ) {
    if (!(body instanceof Uint8Array) || body.byteLength > 16384)
      throw new Error("request-too-large");
    const safeHeaders = checkedHeaders(headers);
    const payload = Buffer.from(body); // snapshot before asynchronous DNS
    let expired = false;
    let agent;
    let request;
    let timer;
    const work = async () => {
      const plan = await preparePinnedRequest(destination, targets, resolve);
      if (expired) throw new Error("deadline");
      agent = new PinnedAgent(plan);
      return await new Promise((resolve, reject) => {
        request = requestHttps(
          {
            hostname: plan.hostname,
            port: 443,
            method: "POST",
            path: plan.path,
            agent,
            headers: { ...safeHeaders, "content-length": payload.length },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              response.destroy();
              reject(
                new Error(
                  status >= 300 && status < 400
                    ? "redirect-refused"
                    : "upstream-non-2xx",
                ),
              );
              return;
            }
            let size = 0;
            const chunks = [];
            response.on("data", (chunk) => {
              size += chunk.length;
              if (size > 65536) {
                response.destroy();
                reject(new Error("response-too-large"));
              } else chunks.push(Buffer.from(chunk));
            });
            response.once("end", () =>
              resolve({ status, body: new Uint8Array(Buffer.concat(chunks)) }),
            );
            response.once("error", () => reject(new Error("transport-error")));
            response.once("aborted", () =>
              reject(new Error("transport-error")),
            );
          },
        );
        request.once("error", () => reject(new Error("transport-error")));
        request.end(payload);
      });
    };
    try {
      return await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = schedule(() => {
            expired = true;
            request?.destroy();
            agent?.destroy();
            reject(new Error("deadline"));
          }, 10000);
        }),
      ]);
    } catch {
      // Fixed output; no DNS/TLS exception strings containing destinations.
      throw new Error(expired ? "deadline" : "delivery-failed");
    } finally {
      expired = true;
      clearTimeout(timer);
      request?.destroy();
      agent?.destroy();
    }
  };
}
// Production callers must not supply dependency overrides. No server invokes this.
export const sendPinnedPrototype = createPrototypeSender();
