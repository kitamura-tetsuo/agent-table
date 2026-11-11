import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const EXPECTED_DOS = new Map([
  ["TABLES", "TableDO"],
  ["GUESTS", "GuestDO"],
  ["OAUTH_SERIALIZER", "OAuthTokenDO"],
  ["ADMISSION", "AdmissionDO"],
]);
// Historical SQLite class declarations are immutable. Replaying an altered
// migration list can bind the wrong DO namespace or lose prior authority.
const EXPECTED_SQLITE_MIGRATIONS = [
  { tag: "v1", new_sqlite_classes: ["TableDO", "GuestDO"] },
  { tag: "v2", new_sqlite_classes: ["OAuthTokenDO"] },
  { tag: "v3", new_sqlite_classes: ["AdmissionDO"] },
];

// Wrangler can replace root-level bindings when --env is selected, and custom
// build/unsafe configuration can change the deployed entry or its bindings.
// The offline checker only evaluates this one explicit Worker configuration;
// refuse unexamined alternatives rather than validating a different runtime.
function validateUnambiguousWorkerConfig(config) {
  requireCondition(
    config && typeof config === "object" && !Array.isArray(config),
    "invalid-worker-config",
  );
  for (const [key, code] of [
    ["env", "unsupported-wrangler-environments"],
    ["build", "unsupported-wrangler-build"],
    ["unsafe", "unsupported-wrangler-unsafe"],
    // Additional entry points are outside the reviewed single-origin profile.
    ["route", "unreviewed-wrangler-exposure"],
    ["routes", "unreviewed-wrangler-exposure"],
    ["assets", "unreviewed-wrangler-exposure"],
    ["site", "unreviewed-wrangler-exposure"],
    ["triggers", "unreviewed-wrangler-exposure"],
  ]) {
    requireCondition(!Object.hasOwn(config, key), code);
  }
}

// Wrangler defaults workers.dev exposure on. Explicitly opt out for a
// reviewed, origin-bound release; actual domain routing is checked separately.
function requireReviewedWorkerExposure(config) {
  requireCondition(
    config.workers_dev === false && config.preview_urls === false,
    "unreviewed-worker-public-exposure",
  );
}

function validateSqliteMigrationHistory(config) {
  const actual = config?.migrations;
  requireCondition(
    Array.isArray(actual) &&
      actual.length === EXPECTED_SQLITE_MIGRATIONS.length &&
      actual.every((entry, index) => {
        const expected = EXPECTED_SQLITE_MIGRATIONS[index];
        return (
          entry &&
          typeof entry === "object" &&
          Object.keys(entry).sort().join(",") === "new_sqlite_classes,tag" &&
          entry.tag === expected.tag &&
          Array.isArray(entry.new_sqlite_classes) &&
          entry.new_sqlite_classes.length ===
            expected.new_sqlite_classes.length &&
          entry.new_sqlite_classes.every(
            (name, i) => name === expected.new_sqlite_classes[i],
          )
        );
      }),
    "unsafe-sqlite-migration-history",
  );
}

const REQUIRED_SECRETS = [
  "INVITATION_RESPONSE_KEYRING",
  "CALLBACK_CREDENTIAL_KEYRING",
];
const EVIDENCE_CHECKS = {
  manual: ["application", "security", "browser"],
  live: ["application", "security", "browser", "live_runtime"],
  events: [
    "application",
    "security",
    "browser",
    "egress",
    "provider",
    "delivery",
    "real_host",
  ],
  autonomous: [
    "application",
    "security",
    "browser",
    "egress",
    "provider",
    "delivery",
    "real_host",
    "autonomous_runtime",
  ],
};

export class PreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreflightError";
  }
}

function requireCondition(value, code) {
  if (!value) throw new PreflightError(code);
}

function placeholder(value) {
  return (
    typeof value !== "string" ||
    !value.trim() ||
    /^(?:0{8,}|replace[_-]?me|todo|placeholder|your[_-]|example)/i.test(
      value,
    ) ||
    /<|>/.test(value)
  );
}

function parseOrigin(origin, environment) {
  requireCondition(!placeholder(origin), "invalid-public-origin");
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new PreflightError("invalid-public-origin");
  }
  requireCondition(
    url.protocol === "https:" &&
      url.toString() === `${origin}/` &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.port &&
      // Release origins require public DNS names, not IP or intranet aliases.
      isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 &&
      url.hostname.includes(".") &&
      !url.hostname.endsWith(".") &&
      ![".localhost", ".example", ".invalid", ".local", ".internal"].some(
        (suffix) => url.hostname.endsWith(suffix),
      ),
    "invalid-public-origin",
  );
  requireCondition(
    environment === "production" ? !url.hostname.startsWith("staging.") : true,
    "production-origin-looks-like-staging",
  );
  return url;
}

function getNames(config) {
  const bindings = config?.durable_objects?.bindings;
  requireCondition(Array.isArray(bindings), "durable-object-bindings-missing");
  const actual = new Map();
  for (const binding of bindings) {
    requireCondition(
      !actual.has(binding?.name),
      "duplicate-durable-object-binding",
    );
    requireCondition(
      !binding?.script_name,
      "cross-worker-durable-object-binding",
    );
    actual.set(binding?.name, binding?.class_name);
  }
  for (const [name, className] of EXPECTED_DOS) {
    requireCondition(
      actual.get(name) === className,
      "incorrect-durable-object-binding",
    );
  }
  requireCondition(
    actual.size === EXPECTED_DOS.size,
    "unexpected-durable-object-binding",
  );
}

function kvId(config) {
  const namespaces = config?.kv_namespaces;
  requireCondition(
    Array.isArray(namespaces) &&
      namespaces.length === 1 &&
      namespaces[0]?.binding === "OAUTH_KV" &&
      !placeholder(namespaces[0]?.id) &&
      /^[a-f0-9]{32}$/i.test(namespaces[0].id) &&
      !/^0+$/.test(namespaces[0].id),
    "invalid-oauth-kv",
  );
  return namespaces[0].id.toLowerCase();
}

function validateSecretInventory(secrets, environment, worker) {
  // Inventory is a redacted output of an authenticated external secret-list check.
  // It validates presence metadata, not secret material or the caller's authority.
  requireCondition(
    secrets?.environment === environment &&
      secrets?.workerName === worker &&
      Array.isArray(secrets?.bindings),
    "secret-inventory-mismatch",
  );
  for (const required of REQUIRED_SECRETS) {
    requireCondition(
      secrets.bindings.includes(required),
      "required-secret-not-observed",
    );
  }
  requireCondition(
    secrets.bindings.every(
      (name) => typeof name === "string" && /^[A-Z][A-Z0-9_]+$/.test(name),
    ),
    "invalid-secret-inventory",
  );
}

function verifyEvidence(
  evidence,
  { environment, buildSha, configSha256, profile },
) {
  requireCondition(
    evidence?.environment === environment &&
      evidence?.buildSha === buildSha &&
      evidence?.configSha256 === configSha256,
    "evidence-target-mismatch",
  );
  for (const check of EVIDENCE_CHECKS[profile]) {
    const record = evidence?.checks?.[check];
    requireCondition(
      record?.status === "passed" &&
        Array.isArray(record.refs) &&
        record.refs.length > 0 &&
        record.refs.every((ref) => {
          try {
            const parsed = new URL(ref);
            return (
              parsed.protocol === "https:" &&
              !parsed.username &&
              !parsed.password
            );
          } catch {
            return false;
          }
        }),
      `missing-or-unverified-evidence:${check}`,
    );
  }
}

function validatePeerIsolation(config, peer, environment) {
  validateUnambiguousWorkerConfig(peer);
  requireReviewedWorkerExposure(peer);
  const vars = config.vars;
  requireCondition(
    peer?.vars?.RELEASE_ENVIRONMENT ===
      (environment === "staging" ? "production" : "staging"),
    "peer-environment-marker-mismatch",
  );
  requireCondition(
    typeof peer.name === "string" && peer.name !== config.name,
    "shared-worker-name",
  );
  // The counterpart is part of the isolation decision, not just a namespace
  // comparison. A partial or weakened peer configuration must fail closed.
  const peerEnvironment = environment === "staging" ? "production" : "staging";
  requireCondition(
    peer.name.endsWith(`-${peerEnvironment}`),
    "peer-worker-name-mismatch",
  );
  requireCondition(
    peer.main === "src/index.ts",
    "peer-unexpected-worker-entry",
  );
  requireCondition(
    peer?.compatibility_flags?.includes("global_fetch_strictly_public"),
    "peer-missing-strict-public-fetch",
  );
  requireCondition(
    peer?.vars?.RESTORE_QUARANTINE === "true" ||
      peer?.vars?.RESTORE_QUARANTINE === "false",
    "peer-restore-quarantine-mode-missing",
  );
  requireCondition(
    [
      "ENABLE_MCP_SUBSCRIPTIONS",
      "ENABLE_OPENAI_EVENTS",
      "ALLOW_OUTBOUND_NOTIFICATIONS",
      "ALLOW_NEW_GUESTS",
      "ALLOW_NEW_TABLES",
    ].every(
      (name) => peer?.vars?.[name] === "true" || peer?.vars?.[name] === "false",
    ),
    "peer-invalid-capability-switch",
  );
  const peerKv = kvId(peer);
  requireCondition(peerKv !== kvId(config), "shared-oauth-kv");
  const peerOrigin = parseOrigin(
    peer?.vars?.PUBLIC_ORIGIN,
    environment === "staging" ? "production" : "staging",
  );
  requireCondition(
    peerOrigin.origin !== new URL(vars.PUBLIC_ORIGIN).origin,
    "shared-public-origin",
  );
  getNames(peer);
  validateSqliteMigrationHistory(peer);
}

export function validateRelease({
  environment,
  profile,
  buildSha,
  configText,
  peerText,
  secrets,
  evidence,
}) {
  requireCondition(
    ["staging", "production"].includes(environment),
    "invalid-environment",
  );
  requireCondition(Object.hasOwn(EVIDENCE_CHECKS, profile), "invalid-profile");
  requireCondition(/^[a-f0-9]{40}$/i.test(buildSha), "invalid-build-sha");

  // Keep the reviewed bytes for this decision; whitespace edits change the digest.
  const configSha256 = createHash("sha256").update(configText).digest("hex");
  let config;
  let peer;
  try {
    config = JSON.parse(configText);
    peer = JSON.parse(peerText);
  } catch {
    throw new PreflightError("invalid-config-json");
  }
  validateUnambiguousWorkerConfig(config);
  requireReviewedWorkerExposure(config);
  const vars = config?.vars ?? {};
  requireCondition(
    vars.RELEASE_ENVIRONMENT === environment,
    "environment-marker-mismatch",
  );
  requireCondition(
    typeof config.name === "string" && config.name.endsWith(`-${environment}`),
    "worker-name-mismatch",
  );
  requireCondition(config.main === "src/index.ts", "unexpected-worker-entry");
  requireCondition(
    config?.compatibility_flags?.includes("global_fetch_strictly_public"),
    "missing-strict-public-fetch",
  );
  parseOrigin(vars.PUBLIC_ORIGIN, environment);
  getNames(config);
  validateSqliteMigrationHistory(config);
  kvId(config);
  requireCondition(
    vars.RESTORE_QUARANTINE === "true" || vars.RESTORE_QUARANTINE === "false",
    "restore-quarantine-mode-missing",
  );
  requireCondition(
    [
      "ENABLE_MCP_SUBSCRIPTIONS",
      "ENABLE_OPENAI_EVENTS",
      "ALLOW_OUTBOUND_NOTIFICATIONS",
      "ALLOW_NEW_GUESTS",
      "ALLOW_NEW_TABLES",
    ].every((name) => vars[name] === "true" || vars[name] === "false"),
    "invalid-capability-switch",
  );

  validatePeerIsolation(config, peer, environment);

  validateSecretInventory(secrets, environment, config.name);
  // A runtime switch cannot assert readiness for a profile lacking independent evidence.
  const enabledLive = vars.ENABLE_MCP_SUBSCRIPTIONS === "true";
  const enabledEvents =
    vars.ENABLE_OPENAI_EVENTS === "true" ||
    vars.ALLOW_OUTBOUND_NOTIFICATIONS === "true";
  requireCondition(
    !enabledLive || ["live", "events", "autonomous"].includes(profile),
    "live-switch-without-live-evidence",
  );
  requireCondition(
    !enabledEvents || ["events", "autonomous"].includes(profile),
    "events-switch-without-events-evidence",
  );
  verifyEvidence(evidence, { environment, buildSha, configSha256, profile });
  return {
    preflightValid: true,
    deploymentApproved: false,
    environment,
    profile,
    buildSha,
    configSha256,
  };
}

/**
 * Generate a restore-specific Worker configuration from an operator-supplied
 * candidate. Never inherit a clear quarantine or enabled capability from an
 * older snapshot. This function cannot reconcile external post-snapshot
 * revocations; it deliberately has no clear-quarantine operation.
 */
export function prepareQuarantinedRestoreConfig(configText, peerText) {
  let source;
  try {
    source = JSON.parse(configText);
  } catch {
    throw new PreflightError("invalid-config-json");
  }
  validateUnambiguousWorkerConfig(source);
  const environment = source?.vars?.RELEASE_ENVIRONMENT;
  requireCondition(
    environment === "staging" || environment === "production",
    "invalid-restore-environment",
  );
  requireCondition(
    typeof source.name === "string" &&
      source.name.endsWith(`-${environment}`) &&
      source.main === "src/index.ts" &&
      source.compatibility_flags?.includes("global_fetch_strictly_public"),
    "invalid-restore-worker",
  );
  parseOrigin(source.vars.PUBLIC_ORIGIN, environment);
  kvId(source);
  getNames(source);
  validateSqliteMigrationHistory(source);
  // An isolated restore cannot be prepared without the separately reviewed
  // counterpart configuration. A reused KV namespace or shared origin must
  // fail before writing even a quarantined candidate.
  requireCondition(typeof peerText === "string", "missing-restore-peer");
  let peer;
  try {
    peer = JSON.parse(peerText);
  } catch {
    throw new PreflightError("invalid-peer-config-json");
  }
  validatePeerIsolation(source, peer, environment);
  const candidate = structuredClone(source);
  // Restore an inaccessible candidate even if the old config relied on
  // Wrangler's public workers.dev default or had preview links enabled.
  candidate.workers_dev = false;
  candidate.preview_urls = false;
  candidate.vars.RESTORE_QUARANTINE = "true";
  for (const name of [
    "ENABLE_MCP_SUBSCRIPTIONS",
    "ENABLE_OPENAI_EVENTS",
    "ALLOW_OUTBOUND_NOTIFICATIONS",
    "ALLOW_NEW_GUESTS",
    "ALLOW_NEW_TABLES",
  ]) {
    candidate.vars[name] = "false";
  }
  return `${JSON.stringify(candidate, null, 2)}\n`;
}

function argumentValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  requireCondition(index >= 0 && argv[index + 1], `missing-argument:${name}`);
  return argv[index + 1];
}

function main() {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--prepare-restore")) {
      const configText = readFileSync(argumentValue(args, "config"), "utf8");
      const restoredText = prepareQuarantinedRestoreConfig(
        configText,
        readFileSync(argumentValue(args, "peer-config"), "utf8"),
      );
      // Exclusive, owner-readable output: never clobber an operator config.
      writeFileSync(argumentValue(args, "output"), restoredText, {
        flag: "wx",
        mode: 0o600,
      });
      const digest = createHash("sha256").update(restoredText).digest("hex");
      process.stdout.write(`RESTORE_QUARANTINED ${digest}\n`);
      return;
    }
    const configText = readFileSync(argumentValue(args, "config"), "utf8");
    const result = validateRelease({
      environment: argumentValue(args, "environment"),
      profile: argumentValue(args, "profile"),
      buildSha: argumentValue(args, "build-sha"),
      configText,
      peerText: readFileSync(argumentValue(args, "peer-config"), "utf8"),
      secrets: JSON.parse(
        readFileSync(argumentValue(args, "secret-inventory"), "utf8"),
      ),
      evidence: JSON.parse(
        readFileSync(argumentValue(args, "evidence"), "utf8"),
      ),
    });
    process.stdout.write(
      `PREFLIGHT_MANIFEST_VALID ${JSON.stringify(result)}\n`,
    );
  } catch (error) {
    // Do not print source values, secret inventory or exception stacks.
    const code =
      error instanceof PreflightError
        ? error.message
        : "unreadable-or-invalid-input";
    process.stderr.write(`PREFLIGHT_BLOCKED ${code}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
