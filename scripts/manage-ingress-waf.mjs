#!/usr/bin/env node

/** Manage the host-scoped Cloudflare WAF guard against same-zone Worker subrequests. */

const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const PHASE = "http_request_firewall_custom";

function dnsName(value) {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value
      .split(".")
      .every((label) =>
        /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  );
}

export function ingressRule(hostname, zoneName) {
  if (
    !dnsName(hostname) ||
    !dnsName(zoneName) ||
    !hostname.endsWith(`.${zoneName}`)
  ) {
    throw new Error("Host must be a validated subdomain of the specified zone");
  }
  return {
    action: "block",
    enabled: true,
    description: `agent-table:deny-same-zone-worker:${hostname}`,
    expression: `(http.host eq "${hostname}" and cf.worker.upstream_zone eq "${zoneName}")`,
  };
}

export function parseArguments(args) {
  const options = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || options[match[1]] !== undefined) {
      throw new Error(`Unexpected or repeated argument: ${arg}`);
    }
    options[match[1]] = match[2];
  }
  const { mode, hostname, "zone-name": zoneName, "zone-id": zoneId } = options;
  if (!["plan", "check", "apply"].includes(mode)) {
    throw new Error("Specify --mode=plan, --mode=check, or --mode=apply");
  }
  if (!/^[a-f0-9]{32}$/i.test(zoneId ?? "")) {
    throw new Error("Specify a 32-character --zone-id");
  }
  const rule = ingressRule(hostname, zoneName);
  if (mode === "apply" && options["confirm-hostname"] !== hostname) {
    throw new Error(
      "--mode=apply requires --confirm-hostname matching the target",
    );
  }
  const known = new Set([
    "mode",
    "hostname",
    "zone-name",
    "zone-id",
    "confirm-hostname",
  ]);
  if (Object.keys(options).some((key) => !known.has(key))) {
    throw new Error("Unknown argument");
  }
  return { mode, zoneId, rule };
}

function verifyRules(rules, desired) {
  const matches = rules.filter(
    (rule) => rule.description === desired.description,
  );
  if (matches.length > 1) {
    throw new Error("Multiple matching rules require manual review");
  }
  if (matches.length === 0) return false;
  const existing = matches[0];
  if (
    existing.action !== desired.action ||
    existing.expression !== desired.expression ||
    existing.enabled !== true
  ) {
    throw new Error(
      "An existing managed rule differs; refusing to overwrite it",
    );
  }
  return true;
}

async function cloudflareRequest(fetcher, token, path, method = "GET", body) {
  let response;
  try {
    response = await fetcher(`${API_ORIGIN}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Cloudflare API request failed (network or timeout)");
  }
  if (response.status === 404 && method === "GET") return null;
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Cloudflare API returned non-JSON status ${response.status}`,
    );
  }
  if (!response.ok || result.success !== true) {
    const codes = Array.isArray(result.errors)
      ? result.errors.map((error) => error.code).filter(Number.isInteger)
      : [];
    throw new Error(
      `Cloudflare API rejected ${method} (HTTP ${response.status}; codes: ${codes.join(",") || "none"})`,
    );
  }
  return result.result;
}

/** Idempotent: only adds the exact host-scoped rule, never replaces other rules. */
export async function ensureIngressRule(
  { mode, zoneId, rule },
  token,
  fetcher = fetch,
) {
  if (mode === "plan") return { state: "planned", rule };
  if (!token)
    throw new Error("CLOUDFLARE_API_TOKEN is required for check/apply");
  const base = `/zones/${zoneId}/rulesets`;
  const entryPath = `${base}/phases/${PHASE}/entrypoint`;
  let entry = await cloudflareRequest(fetcher, token, entryPath);
  if (entry && verifyRules(entry.rules ?? [], rule)) {
    return { state: "installed", rule };
  }
  if (mode === "check") return { state: "missing", rule };

  if (entry) {
    // Insert first, before pre-existing skip rules can intercept this request.
    await cloudflareRequest(
      fetcher,
      token,
      `${base}/${entry.id}/rules`,
      "POST",
      {
        ...rule,
        position: { before: "" },
      },
    );
  } else {
    await cloudflareRequest(fetcher, token, base, "POST", {
      name: "Agent Table ingress protection",
      kind: "zone",
      phase: PHASE,
      rules: [rule],
    });
  }
  entry = await cloudflareRequest(fetcher, token, entryPath);
  if (!entry || !verifyRules(entry.rules ?? [], rule)) {
    throw new Error(
      "The rule was not present after applying; inspect Cloudflare",
    );
  }
  return { state: "installed", rule };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await ensureIngressRule(
      options,
      process.env.CLOUDFLARE_API_TOKEN,
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.state === "missing") process.exitCode = 2;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "WAF operation failed",
    );
    process.exitCode = 1;
  }
}
