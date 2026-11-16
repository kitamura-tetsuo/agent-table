/** Read-only observation library. No CLI, setup, enable, send, or release authority. */

import { createHash } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { open } from "node:fs/promises";
import https from "node:https";
import { isIP } from "node:net";

const expected = Buffer.from('{"code":"unavailable"}');
const observations = new WeakSet();
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const codes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const states = new Set(["healthy", "degraded", "inactive", "down"]);
const levels = new Set(["debug", "info", "warn", "error"]);
const messages = new Map([
  ["Registered tunnel connection", "connection_registered"],
  ["Unregistered tunnel connection", "connection_unregistered"],
  ["Initiating graceful shutdown due to signal terminated ...", "shutdown"],
]);
const public4 = (s) => {
  if (isIP(s) !== 4) return false;
  const n = s.split(".").reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0);
  return ![
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
  ].some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
};
const errorCode = (e) => (codes.has(e?.code) ? e.code : "unavailable");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const bounded = async (fn, ms) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(), { code: "ETIMEDOUT" })),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Only fixed fields/categories survive. Never persist raw log lines/messages. */
export function sanitizeTunnelLogs(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536)
    return {
      state: "unknown",
      reason: "log-unavailable-or-oversize",
      events: [],
    };
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length > 128)
    return { state: "unknown", reason: "log-line-limit", events: [] };
  const events = lines.map((line) => {
    try {
      const v = JSON.parse(line);
      return {
        level: levels.has(v.level) ? v.level : "unknown",
        event: messages.get(v.message) ?? "unclassified",
      };
    } catch {
      return { level: "unknown", event: "unclassified" };
    }
  });
  return { state: "observed", lineCount: lines.length, events };
}

/** Wire both child output streams here. Raw content is never written to disk;
 * only a bounded unfinished line exists in memory until categorized/discarded. */
export function createTunnelLogCapture() {
  let pending = "",
    failed = false;
  const lines = [];
  return {
    write(chunk) {
      if (failed) return;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > 65536) {
        failed = true;
        pending = "";
        return;
      }
      pending += Buffer.from(chunk).toString("utf8");
      if (Buffer.byteLength(pending) > 65536) {
        failed = true;
        pending = "";
        return;
      }
      const split = pending.split("\n");
      pending = split.pop();
      for (const line of split.filter(Boolean)) {
        if (lines.length >= 128) {
          failed = true;
          pending = "";
          return;
        }
        const event = sanitizeTunnelLogs(line).events[0];
        lines.push(
          JSON.stringify({
            level: event?.level ?? "unknown",
            message:
              [...messages].find(([, value]) => value === event?.event)?.[0] ??
              "",
          }),
        );
      }
    },
    read() {
      // An unterminated record is incomplete, not evidence of complete log capture.
      if (failed || pending) return undefined;
      return lines.join("\n");
    },
  };
}

function probe({ hostname, port, address, ca, timeoutMs }) {
  return new Promise((resolve) => {
    let done = false,
      request,
      timer;
    const result = { tls: { state: "unknown" }, http: { state: "unknown" } };
    const finish = (patch) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request?.destroy();
      resolve({ ...result, ...patch });
    };
    try {
      request = https.request(
        {
          hostname,
          port,
          path: "/",
          method: "GET",
          agent: false,
          ca,
          rejectUnauthorized: true,
          servername: hostname,
          // One already-observed address; no late hostname lookup and no redirects.
          lookup: (_host, _options, callback) =>
            callback(null, [{ address, family: 4 }]),
          headers: { connection: "close" },
        },
        (response) => {
          result.http = { state: "observed", status: response.statusCode };
          let bytes = 0;
          const chunks = [];
          response.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 4096) {
              finish({ ready: false, reason: "response-limit" });
              return;
            }
            chunks.push(chunk);
          });
          response.on("aborted", () =>
            finish({ ready: false, reason: "response-incomplete" }),
          );
          response.on("error", () =>
            finish({ ready: false, reason: "response-incomplete" }),
          );
          response.on("end", () => {
            const body = Buffer.concat(chunks);
            result.http.bodyBytes = bytes;
            result.http.bodySha256 = body.equals(expected)
              ? hash(expected)
              : null;
            result.http.expectedBody = body.equals(expected);
            finish({
              ready:
                result.tls.state === "verified" &&
                response.statusCode === 404 &&
                body.equals(expected),
              reason:
                response.statusCode === 404 && body.equals(expected)
                  ? "endpoint-observed"
                  : "endpoint-mismatch",
            });
          });
        },
      );
      request.on("socket", (socket) =>
        socket.once("secureConnect", () => {
          const peer = socket.remoteAddress?.replace(/^::ffff:/, "");
          if (
            !socket.authorized ||
            peer !== address ||
            socket.remotePort !== port
          ) {
            finish({ ready: false, reason: "tls-peer-mismatch" });
            return;
          }
          const fp = socket.getPeerCertificate()?.fingerprint256;
          if (
            typeof fp !== "string" ||
            !/^[0-9A-F:]{95}$/.test(fp) ||
            !["TLSv1.2", "TLSv1.3"].includes(socket.getProtocol())
          ) {
            finish({ ready: false, reason: "tls-evidence-unavailable" });
            return;
          }
          result.tls = {
            state: "verified",
            peerAddress: peer,
            peerPort: socket.remotePort,
            protocol: ["TLSv1.2", "TLSv1.3"].includes(socket.getProtocol())
              ? socket.getProtocol()
              : "unknown",
            certificateSha256:
              typeof fp === "string" && /^[0-9A-F:]{95}$/.test(fp)
                ? fp.replaceAll(":", "").toLowerCase()
                : null,
          };
        }),
      );
      request.on("error", (e) =>
        finish({
          ready: false,
          reason: "connection-failed",
          errorCode: errorCode(e),
        }),
      );
      timer = setTimeout(
        () =>
          finish({
            ready: false,
            reason: "probe-timeout",
            errorCode: "ETIMEDOUT",
          }),
        timeoutMs,
      );
      request.end();
    } catch (e) {
      finish({ ready: false, reason: "probe-failed", errorCode: errorCode(e) });
    }
  });
}

/** Fixture mode can dial loopback only and can never yield live acceptance.
 * The caller supplies the already-approved public endpoint and authenticated
 * read-only provider/log adapters. This function does not grant that approval.
 */
export async function observeReadiness({
  hostname,
  port = 443,
  mode,
  tunnelId,
  tunnelRead,
  logRead,
  resolve = resolve4,
  ca,
  timeoutMs = 3000,
}) {
  if (
    !["fixture", "approved-live"].includes(mode) ||
    typeof hostname !== "string" ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname) ||
    isIP(hostname) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (mode === "approved-live" && (port !== 443 || ca !== undefined)) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      tunnelId,
    ) ||
    typeof tunnelRead !== "function" ||
    typeof logRead !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 10000
  )
    throw new Error("invalid-readiness-input");
  const out = {
    version: 1,
    kind: "readiness-observation",
    mode,
    startedUTC: new Date().toISOString(),
    productionAcceptance: false,
    ready: false,
    dns: { state: "unknown" },
    tls: { state: "unknown" },
    http: { state: "unknown" },
    tunnel: { state: "unknown" },
    logs: { state: "unknown" },
  };
  await Promise.all([
    (async () => {
      try {
        const rows = await bounded(() => resolve(hostname), timeoutMs);
        if (
          !Array.isArray(rows) ||
          !rows.length ||
          rows.length > 64 ||
          !rows.every((x) =>
            mode === "fixture" ? x === "127.0.0.1" : public4(x),
          )
        ) {
          out.dns = { state: "rejected", reason: "address-policy" };
          return;
        }
        out.dns = { state: "observed", addresses: [...new Set(rows)] };
        Object.assign(
          out,
          await probe({ hostname, port, address: rows[0], ca, timeoutMs }),
        );
      } catch (e) {
        out.dns = { state: "unknown", errorCode: errorCode(e) };
      }
    })(),
    (async () => {
      try {
        const t = await bounded(tunnelRead, timeoutMs);
        out.tunnel =
          t?.id === tunnelId && states.has(t.status)
            ? { state: "observed", id: tunnelId, status: t.status }
            : { state: "unknown", reason: "target-or-state-mismatch" };
      } catch {
        out.tunnel = { state: "unknown", reason: "provider-read-failed" };
      }
    })(),
    (async () => {
      try {
        out.logs = sanitizeTunnelLogs(await bounded(logRead, timeoutMs));
      } catch {
        out.logs = { state: "unknown", reason: "log-read-failed", events: [] };
      }
    })(),
  ]);
  out.ready =
    out.ready === true &&
    out.tunnel.state === "observed" &&
    out.tunnel.status === "healthy" &&
    out.logs.state === "observed";
  out.finishedUTC = new Date().toISOString();
  observations.add(out);
  return freeze(out);
}

/** Persist only a library-produced observation, without overwriting prior evidence. */
export async function retainObservation(path, observation) {
  // Only immutable records produced here are eligible; reject arbitrary additions.
  if (!observations.has(observation)) throw new Error("invalid-observation");
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(observation)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}
