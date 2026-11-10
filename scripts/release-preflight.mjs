import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname) &&
      !url.hostname.endsWith(".localhost") &&
      !url.hostname.endsWith(".example") &&
      !url.hostname.endsWith(".invalid"),
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
  const oauthKvId = kvId(config);
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
  requireCondition(peerKv !== oauthKvId, "shared-oauth-kv");
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

function argumentValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  requireCondition(index >= 0 && argv[index + 1], `missing-argument:${name}`);
  return argv[index + 1];
}

function main() {
  try {
    const args = process.argv.slice(2);
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
