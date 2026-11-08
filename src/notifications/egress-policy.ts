import { isIP } from "node:net";

export type EgressFailure =
  | "policy"
  | "dns"
  | "tls"
  | "timeout"
  | "size"
  | "protocol"
  | "redirect"
  | "transport";

/** Never include an input URL, secret, response or platform error in an egress error. */
export class SafeEgressError extends Error {
  constructor(readonly code: EgressFailure) {
    super(`Safe callback egress: ${code}`);
    this.name = "SafeEgressError";
  }
}

const HOST_PATTERN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validHostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.toLowerCase() &&
    HOST_PATTERN.test(value) &&
    isIP(value) === 0 &&
    !value.endsWith(".local") &&
    !value.endsWith(".internal") &&
    !value.endsWith(".localhost") &&
    !value.endsWith(".test") &&
    !value.endsWith(".example") &&
    !value.endsWith(".invalid")
  );
}

export interface DestinationPolicy {
  readonly hostnames: ReadonlySet<string>;
}

/** Operator input is a JSON list of concrete hostnames, never a wildcard or suffix. */
export function parseDestinationPolicy(
  value: string | undefined,
): DestinationPolicy {
  if (!value || value.length > 4_096) {
    throw new SafeEgressError("policy");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SafeEgressError("policy");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 16 ||
    !parsed.every(validHostname) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new SafeEgressError("policy");
  }
  return { hostnames: new Set(parsed) };
}

export interface VerifiedDestination {
  readonly hostname: string;
  readonly target: string;
}

/** Parses URL syntax only; address/TLS enforcement happens in the socket transport. */
export function parseVerifiedDestination(
  input: string,
  policy: DestinationPolicy,
): VerifiedDestination {
  if (
    typeof input !== "string" ||
    input.length > 4_096 ||
    !input.startsWith("https://") ||
    Array.from(input).some((char) => {
      const code = char.charCodeAt(0);
      return code <= 32 || code === 127 || char === "\\";
    })
  ) {
    throw new SafeEgressError("policy");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeEgressError("policy");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.port !== "" ||
    !validHostname(url.hostname) ||
    !policy.hostnames.has(url.hostname)
  ) {
    throw new SafeEgressError("policy");
  }
  const authority = input.slice(8).split(/[/?#]/, 1)[0];
  if (
    authority.includes("@") ||
    authority.includes("%") ||
    authority.endsWith(".")
  ) {
    throw new SafeEgressError("policy");
  }
  const target = `${url.pathname}${url.search}`;
  if (target.length > 4_096) {
    throw new SafeEgressError("policy");
  }
  return { hostname: url.hostname, target };
}

function ipv4Number(address: string): number {
  return (
    address
      .split(".")
      .reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0
  );
}

const RESERVED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Conservative global-unicast IPv4 policy; IPv6 is not yet a supported route. */
export function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) {
    return false;
  }
  const actual = ipv4Number(address);
  return !RESERVED_IPV4.some(([network, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (actual & mask) >>> 0 === (ipv4Number(network) & mask) >>> 0;
  });
}

/** Reject a mixed public/private DNS answer; the caller must pin a checked A record. */
export function selectPinnedIpv4(answers: readonly string[]): string {
  if (
    answers.length === 0 ||
    answers.length > 32 ||
    !answers.every(isPublicIpv4)
  ) {
    throw new SafeEgressError("dns");
  }
  return answers[0];
}
