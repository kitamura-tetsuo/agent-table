import { resolve4 } from "node:dns/promises";
import { checkServerIdentity, connect } from "node:tls";
import {
  type DestinationPolicy,
  isPublicIpv4,
  parseVerifiedDestination,
  SafeEgressError,
  selectPinnedIpv4,
} from "./egress-policy";
import { BoundedHttpReplyReader, type BoundedReply } from "./http-reply";

export interface EgressRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface EgressLimits {
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

export const DEFAULT_EGRESS_LIMITS: EgressLimits = {
  connectTimeoutMs: 3_000,
  totalTimeoutMs: 10_000,
  maxRequestBytes: 16_384,
  maxResponseBytes: 32_768,
};

function checkedLimits(limits: EgressLimits): EgressLimits {
  if (
    !Number.isInteger(limits.connectTimeoutMs) ||
    limits.connectTimeoutMs < 100 ||
    limits.connectTimeoutMs > 5_000 ||
    !Number.isInteger(limits.totalTimeoutMs) ||
    limits.totalTimeoutMs < limits.connectTimeoutMs ||
    limits.totalTimeoutMs > 15_000 ||
    !Number.isInteger(limits.maxRequestBytes) ||
    limits.maxRequestBytes < 1 ||
    limits.maxRequestBytes > 16_384 ||
    !Number.isInteger(limits.maxResponseBytes) ||
    limits.maxResponseBytes < 1 ||
    limits.maxResponseBytes > 32_768
  ) {
    throw new SafeEgressError("policy");
  }
  return limits;
}

function serializedRequest(
  request: EgressRequest,
  hostname: string,
  target: string,
  maxRequestBytes: number,
): Uint8Array {
  const body = request.body ?? new Uint8Array();
  if (
    (request.method !== "GET" && request.method !== "POST") ||
    !(body instanceof Uint8Array) ||
    body.byteLength > maxRequestBytes
  ) {
    throw new SafeEgressError("size");
  }
  const entries = Object.entries(request.headers ?? {});
  if (entries.length > 16) {
    throw new SafeEgressError("policy");
  }
  const names = new Set<string>();
  const outbound: string[] = [];
  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      typeof value !== "string" ||
      value.length > 1_024 ||
      Array.from(value).some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code > 126;
      }) ||
      names.has(name) ||
      [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "upgrade",
        "proxy-authorization",
        "proxy-connection",
      ].includes(name)
    ) {
      throw new SafeEgressError("policy");
    }
    names.add(name);
    outbound.push(`${name}: ${value}`);
  }
  const headers = [
    `${request.method} ${target} HTTP/1.1`,
    `Host: ${hostname}`,
    "Connection: close",
    `Content-Length: ${body.byteLength}`,
    ...outbound,
    "",
    "",
  ].join("\r\n");
  const head = Buffer.from(headers, "ascii");
  if (
    head.byteLength > 4_096 ||
    head.byteLength + body.byteLength > maxRequestBytes
  ) {
    throw new SafeEgressError("size");
  }
  return Buffer.concat([head, body]);
}

async function pinnedAddress(
  hostname: string,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      resolve4(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SafeEgressError("timeout")),
          timeoutMs,
        );
      }),
    ]);
    return selectPinnedIpv4(result);
  } catch (error) {
    if (error instanceof SafeEgressError) {
      throw error;
    }
    throw new SafeEgressError("dns");
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Candidate pinned-address HTTPS transport for the exact operator allowlist.
 * Do not activate the public Events profile until an actual deployed Workers
 * probe proves pinned remote-address reporting and expected-name TLS checks.
 */
export async function sendVerifiedHttps(
  request: EgressRequest,
  policy: DestinationPolicy,
  limits: EgressLimits = DEFAULT_EGRESS_LIMITS,
): Promise<BoundedReply> {
  const startedAt = Date.now();
  const bounds = checkedLimits(limits);
  const destination = parseVerifiedDestination(request.url, policy);
  const bytes = serializedRequest(
    request,
    destination.hostname,
    destination.target,
    bounds.maxRequestBytes,
  );
  const address = await pinnedAddress(
    destination.hostname,
    bounds.connectTimeoutMs,
  );
  if (!isPublicIpv4(address)) {
    throw new SafeEgressError("dns");
  }
  const remainingTimeMs = bounds.totalTimeoutMs - (Date.now() - startedAt);
  if (remainingTimeMs < 100) {
    throw new SafeEgressError("timeout");
  }

  return new Promise<BoundedReply>((resolve, reject) => {
    const reader = new BoundedHttpReplyReader(8_192, bounds.maxResponseBytes);
    let socket: ReturnType<typeof connect>;
    try {
      socket = connect({
        host: address,
        port: 443,
        servername: destination.hostname,
        rejectUnauthorized: true,
        ALPNProtocols: ["http/1.1"],
      });
    } catch {
      reject(new SafeEgressError("tls"));
      return;
    }
    let completed = false;
    let connected = false;
    const complete = (value: BoundedReply | SafeEgressError) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(connectDeadline);
      clearTimeout(totalDeadline);
      socket.destroy();
      if (value instanceof SafeEgressError) {
        reject(value);
      } else {
        resolve(value);
      }
    };
    const connectDeadline = setTimeout(
      () => complete(new SafeEgressError("timeout")),
      Math.min(bounds.connectTimeoutMs, remainingTimeMs),
    );
    const totalDeadline = setTimeout(
      () => complete(new SafeEgressError("timeout")),
      remainingTimeMs,
    );

    socket.once("secureConnect", () => {
      if (completed) {
        return;
      }
      try {
        const certificate = socket.getPeerCertificate();
        if (
          !socket.authorized ||
          socket.remoteAddress !== address ||
          (socket.alpnProtocol && socket.alpnProtocol !== "http/1.1") ||
          !certificate ||
          Object.keys(certificate).length === 0 ||
          checkServerIdentity(destination.hostname, certificate) !== undefined
        ) {
          complete(new SafeEgressError("tls"));
          return;
        }
        connected = true;
        clearTimeout(connectDeadline);
        socket.write(bytes);
      } catch {
        complete(new SafeEgressError("tls"));
      }
    });
    socket.on("data", (data: Buffer) => {
      try {
        const reply = reader.push(data);
        if (reply) {
          complete(reply);
        }
      } catch (error) {
        complete(
          error instanceof SafeEgressError
            ? error
            : new SafeEgressError("protocol"),
        );
      }
    });
    socket.on("end", () => {
      try {
        complete(reader.end());
      } catch (error) {
        complete(
          error instanceof SafeEgressError
            ? error
            : new SafeEgressError("protocol"),
        );
      }
    });
    socket.on("error", () => {
      complete(new SafeEgressError(connected ? "transport" : "tls"));
    });
    socket.on("close", () => {
      if (!completed) {
        complete(new SafeEgressError("transport"));
      }
    });
  });
}
