import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PreflightError,
  prepareQuarantinedRestoreConfig,
  validateRelease,
} from "./release-preflight.mjs";

const buildSha = "a".repeat(40);
const makeConfig = (environment, overrides = {}) => ({
  name: `agent-table-${environment}`,
  main: "src/index.ts",
  compatibility_flags: ["global_fetch_strictly_public", "nodejs_compat"],
  durable_objects: {
    bindings: [
      { name: "TABLES", class_name: "TableDO" },
      { name: "GUESTS", class_name: "GuestDO" },
      { name: "OAUTH_SERIALIZER", class_name: "OAuthTokenDO" },
      { name: "ADMISSION", class_name: "AdmissionDO" },
    ],
  },
  migrations: [
    { tag: "v1", new_sqlite_classes: ["TableDO", "GuestDO"] },
    { tag: "v2", new_sqlite_classes: ["OAuthTokenDO"] },
    { tag: "v3", new_sqlite_classes: ["AdmissionDO"] },
  ],
  kv_namespaces: [
    {
      binding: "OAUTH_KV",
      id: environment === "staging" ? "1".repeat(32) : "2".repeat(32),
    },
  ],
  vars: {
    RELEASE_ENVIRONMENT: environment,
    RESTORE_QUARANTINE: "true",
    PUBLIC_ORIGIN: `https://${environment}.service.test`,
    ENABLE_MCP_SUBSCRIPTIONS: "false",
    ENABLE_OPENAI_EVENTS: "false",
    ALLOW_NEW_GUESTS: "false",
    ALLOW_NEW_TABLES: "true",
    ALLOW_OUTBOUND_NOTIFICATIONS: "false",
  },
  ...overrides,
});

function fixture({
  config = makeConfig("staging"),
  peer = makeConfig("production"),
  profile = "manual",
} = {}) {
  const configText = JSON.stringify(config);
  const configSha256 = createHash("sha256").update(configText).digest("hex");
  return {
    environment: "staging",
    profile,
    buildSha,
    configText,
    peerText: JSON.stringify(peer),
    secrets: {
      environment: "staging",
      workerName: config.name,
      bindings: ["INVITATION_RESPONSE_KEYRING", "CALLBACK_CREDENTIAL_KEYRING"],
    },
    evidence: {
      environment: "staging",
      buildSha,
      configSha256,
      checks: Object.fromEntries(
        [
          "application",
          "security",
          "browser",
          "live_runtime",
          "egress",
          "provider",
          "delivery",
          "real_host",
          "autonomous_runtime",
        ].map((x) => [
          x,
          {
            status: "passed",
            refs: [`https://github.com/example/test/actions/runs/${x}`],
          },
        ]),
      ),
    },
  };
}

const blocked = (args, code) =>
  assert.throws(
    () => validateRelease(args),
    (err) => err instanceof PreflightError && err.message === code,
  );

test("eligible isolated manual profile requires exact build/config-bound evidence", () => {
  const args = fixture();
  assert.deepEqual(validateRelease(args), {
    preflightValid: true,
    deploymentApproved: false,
    environment: "staging",
    profile: "manual",
    buildSha,
    configSha256: args.evidence.configSha256,
  });
  blocked(
    { ...args, evidence: { ...args.evidence, buildSha: "b".repeat(40) } },
    "evidence-target-mismatch",
  );
  blocked(
    { ...args, configText: `${args.configText} ` },
    "evidence-target-mismatch",
  );
});

test("rejects placeholders, non-HTTPS, missing secrets, and cross-environment namespace reuse", () => {
  const args = fixture();
  const config = JSON.parse(args.configText);
  config.kv_namespaces[0].id = "0".repeat(32);
  blocked({ ...args, configText: JSON.stringify(config) }, "invalid-oauth-kv");
  config.kv_namespaces[0].id = "1".repeat(32);
  config.vars.PUBLIC_ORIGIN = "http://staging.service.test";
  blocked(
    { ...args, configText: JSON.stringify(config) },
    "invalid-public-origin",
  );
  blocked(
    {
      ...args,
      secrets: { ...args.secrets, bindings: ["INVITATION_RESPONSE_KEYRING"] },
    },
    "required-secret-not-observed",
  );
  const peer = makeConfig("production");
  peer.kv_namespaces[0].id = "1".repeat(32);
  blocked({ ...args, peerText: JSON.stringify(peer) }, "shared-oauth-kv");
  peer.kv_namespaces[0].id = "2".repeat(32);
  peer.vars.PUBLIC_ORIGIN = "https://staging.service.test";
  blocked(
    { ...args, peerText: JSON.stringify(peer) },
    "production-origin-looks-like-staging",
  );
});

test("rejects runtime capability switches without evidence for their distinct profile", () => {
  const args = fixture();
  const config = JSON.parse(args.configText);
  config.vars.ENABLE_MCP_SUBSCRIPTIONS = "true";
  blocked(
    { ...args, configText: JSON.stringify(config) },
    "live-switch-without-live-evidence",
  );
  config.vars.ENABLE_MCP_SUBSCRIPTIONS = "false";
  config.vars.ENABLE_OPENAI_EVENTS = "true";
  blocked(
    { ...args, configText: JSON.stringify(config) },
    "events-switch-without-events-evidence",
  );
});

test("rejects absent, failed, non-URL, or wrong-target evidence", () => {
  const args = fixture();
  delete args.evidence.checks.browser;
  blocked(args, "missing-or-unverified-evidence:browser");
  args.evidence.checks.browser = {
    status: "failed",
    refs: ["https://github.com/example"],
  };
  blocked(args, "missing-or-unverified-evidence:browser");
  args.evidence.checks.browser = {
    status: "passed",
    refs: ["http://example.com"],
  };
  blocked(args, "missing-or-unverified-evidence:browser");
});

test("optional profiles require their own measured checks, not inherited manual evidence", () => {
  const args = fixture({ profile: "live" });
  delete args.evidence.checks.live_runtime;
  blocked(args, "missing-or-unverified-evidence:live_runtime");
  const events = fixture({ profile: "events" });
  delete events.evidence.checks.egress;
  blocked(events, "missing-or-unverified-evidence:egress");
  const autonomy = fixture({ profile: "autonomous" });
  delete autonomy.evidence.checks.autonomous_runtime;
  blocked(autonomy, "missing-or-unverified-evidence:autonomous_runtime");
});

test("rejects mismatched environment markers and worker names", () => {
  const args = fixture();
  const config = JSON.parse(args.configText);
  config.vars.RELEASE_ENVIRONMENT = "production";
  blocked(
    { ...args, configText: JSON.stringify(config) },
    "environment-marker-mismatch",
  );
  config.vars.RELEASE_ENVIRONMENT = "staging";
  config.name = "agent-table-production";
  blocked(
    { ...args, configText: JSON.stringify(config) },
    "worker-name-mismatch",
  );
});

test("the peer must also have a complete fail-closed deployment profile", () => {
  const args = fixture();
  for (const [mutate, expected] of [
    [(peer) => (peer.name = "agent-table-other"), "peer-worker-name-mismatch"],
    [(peer) => (peer.main = "src/legacy.ts"), "peer-unexpected-worker-entry"],
    [
      (peer) => (peer.compatibility_flags = ["nodejs_compat"]),
      "peer-missing-strict-public-fetch",
    ],
    [
      (peer) => delete peer.vars.RESTORE_QUARANTINE,
      "peer-restore-quarantine-mode-missing",
    ],
    [
      (peer) => (peer.vars.RESTORE_QUARANTINE = "maybe"),
      "peer-restore-quarantine-mode-missing",
    ],
    [
      (peer) => delete peer.vars.ENABLE_OPENAI_EVENTS,
      "peer-invalid-capability-switch",
    ],
    [
      (peer) => (peer.vars.ALLOW_NEW_TABLES = "maybe"),
      "peer-invalid-capability-switch",
    ],
  ]) {
    const peer = JSON.parse(args.peerText);
    mutate(peer);
    blocked({ ...args, peerText: JSON.stringify(peer) }, expected);
  }
  assert.equal(validateRelease(args).deploymentApproved, false);
});

test("requires an explicit independent restore-quarantine binding for a release", () => {
  const args = fixture();
  const config = JSON.parse(args.configText);
  delete config.vars.RESTORE_QUARANTINE;
  blocked(
    { ...args, configText: JSON.stringify(config) },
    "restore-quarantine-mode-missing",
  );
  config.vars.RESTORE_QUARANTINE = "invalid";
  blocked(
    { ...args, configText: JSON.stringify(config) },
    "restore-quarantine-mode-missing",
  );
});

test("fails closed on altered SQLite migration history in either environment", () => {
  const args = fixture();
  const base = JSON.parse(args.configText);
  const missing = { ...base };
  delete missing.migrations;
  blocked(
    { ...args, configText: JSON.stringify(missing) },
    "unsafe-sqlite-migration-history",
  );
  for (const mutation of [
    (config) => config.migrations.reverse(),
    (config) => (config.migrations[0].new_sqlite_classes = ["TableDO"]),
    (config) => (config.migrations[1].tag = "v2-replaced"),
    (config) => (config.migrations[2].deleted_classes = ["TableDO"]),
    (config) =>
      config.migrations.push({ tag: "v4", new_sqlite_classes: ["TableDO"] }),
  ]) {
    const config = JSON.parse(args.configText);
    mutation(config);
    blocked(
      { ...args, configText: JSON.stringify(config) },
      "unsafe-sqlite-migration-history",
    );
  }
  const peer = JSON.parse(args.peerText);
  peer.migrations[0].new_sqlite_classes = ["GuestDO", "TableDO"];
  blocked(
    { ...args, peerText: JSON.stringify(peer) },
    "unsafe-sqlite-migration-history",
  );
});

test("restore config generation overrides stale snapshot permissions and remains quarantined", () => {
  const original = makeConfig("staging");
  original.vars.RESTORE_QUARANTINE = "false";
  original.vars.ENABLE_MCP_SUBSCRIPTIONS = "true";
  original.vars.ENABLE_OPENAI_EVENTS = "true";
  original.vars.ALLOW_OUTBOUND_NOTIFICATIONS = "true";
  original.vars.ALLOW_NEW_GUESTS = "true";
  original.vars.ALLOW_NEW_TABLES = "true";

  const peerText = JSON.stringify(makeConfig("production"));
  const restoredText = prepareQuarantinedRestoreConfig(
    JSON.stringify(original),
    peerText,
  );
  const restored = JSON.parse(restoredText);
  assert.equal(restored.vars.RESTORE_QUARANTINE, "true");
  for (const flag of [
    "ENABLE_MCP_SUBSCRIPTIONS",
    "ENABLE_OPENAI_EVENTS",
    "ALLOW_OUTBOUND_NOTIFICATIONS",
    "ALLOW_NEW_GUESTS",
    "ALLOW_NEW_TABLES",
  ]) {
    assert.equal(restored.vars[flag], "false", flag);
  }
  assert.deepEqual(restored.durable_objects, original.durable_objects);
  assert.deepEqual(restored.migrations, original.migrations);
  assert.deepEqual(restored.kv_namespaces, original.kv_namespaces);
  assert.equal(
    prepareQuarantinedRestoreConfig(restoredText, peerText),
    restoredText,
  );

  // The generated bytes need fresh build/config evidence; their existence is
  // not release authority or proof of independent post-snapshot reconciliation.
  const args = fixture({ config: restored });
  assert.equal(validateRelease(args).deploymentApproved, false);
  assert.notEqual(
    args.evidence.configSha256,
    createHash("sha256").update(JSON.stringify(original)).digest("hex"),
  );
});

test("restore generator refuses invalid worker schema rather than emitting a usable config", () => {
  const config = makeConfig("staging");
  config.main = "src/other.ts";
  blockedRestore(config, "invalid-restore-worker");
  config.main = "src/index.ts";
  config.vars.PUBLIC_ORIGIN = "http://localhost:8787";
  blockedRestore(config, "invalid-public-origin");
  config.vars.PUBLIC_ORIGIN = "https://staging.service.test";
  config.migrations.reverse();
  blockedRestore(config, "unsafe-sqlite-migration-history");
  assert.throws(
    () => prepareQuarantinedRestoreConfig("{", "{}"),
    (error) =>
      error instanceof PreflightError &&
      error.message === "invalid-config-json",
  );
});

function blockedRestore(
  config,
  code,
  peer = makeConfig(
    config.vars.RELEASE_ENVIRONMENT === "production" ? "staging" : "production",
  ),
) {
  assert.throws(
    () =>
      prepareQuarantinedRestoreConfig(
        JSON.stringify(config),
        JSON.stringify(peer),
      ),
    (error) => error instanceof PreflightError && error.message === code,
  );
}

test("restore preparation CLI writes a private exclusive file without releasing quarantine", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-table-restore-"));
  try {
    const inputPath = join(dir, "candidate.json");
    const outputPath = join(dir, "restored.json");
    const peerPath = join(dir, "peer.json");
    writeFileSync(peerPath, JSON.stringify(makeConfig("staging")));
    const candidate = makeConfig("production");
    candidate.vars.RESTORE_QUARANTINE = "false";
    candidate.vars.ALLOW_OUTBOUND_NOTIFICATIONS = "true";
    writeFileSync(inputPath, JSON.stringify(candidate));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "scripts/release-preflight.mjs",
          "--prepare-restore",
          "--config",
          inputPath,
          "--peer-config",
          peerPath,
          "--output",
          outputPath,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const restoredBytes = readFileSync(outputPath, "utf8");
    assert.match(first.stdout, /^RESTORE_QUARANTINED [a-f0-9]{64}\n$/);
    assert.equal(JSON.parse(restoredBytes).vars.RESTORE_QUARANTINE, "true");
    assert.equal(
      JSON.parse(restoredBytes).vars.ALLOW_OUTBOUND_NOTIFICATIONS,
      "false",
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    }
    const second = run();
    assert.notEqual(second.status, 0);
    assert.match(
      second.stderr,
      /^PREFLIGHT_BLOCKED unreadable-or-invalid-input\n$/,
    );
    assert.equal(readFileSync(outputPath, "utf8"), restoredBytes);
    assert.equal(second.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore preparation fails closed without an independently isolated peer", () => {
  const source = makeConfig("staging");
  const configText = JSON.stringify(source);
  assert.throws(
    () => prepareQuarantinedRestoreConfig(configText),
    (error) =>
      error instanceof PreflightError &&
      error.message === "missing-restore-peer",
  );
  assert.throws(
    () => prepareQuarantinedRestoreConfig(configText, "{"),
    (error) =>
      error instanceof PreflightError &&
      error.message === "invalid-peer-config-json",
  );
  for (const [mutate, code] of [
    [
      (peer) => (peer.kv_namespaces[0].id = source.kv_namespaces[0].id),
      "shared-oauth-kv",
    ],
    [
      (peer) => (peer.vars.PUBLIC_ORIGIN = source.vars.PUBLIC_ORIGIN),
      "production-origin-looks-like-staging",
    ],
    [(peer) => (peer.name = source.name), "shared-worker-name"],
    [
      (peer) => delete peer.vars.RESTORE_QUARANTINE,
      "peer-restore-quarantine-mode-missing",
    ],
    [
      (peer) => (peer.vars.ENABLE_OPENAI_EVENTS = "unknown"),
      "peer-invalid-capability-switch",
    ],
    [(peer) => peer.migrations.reverse(), "unsafe-sqlite-migration-history"],
  ]) {
    const peer = makeConfig("production");
    mutate(peer);
    assert.throws(
      () => prepareQuarantinedRestoreConfig(configText, JSON.stringify(peer)),
      (error) => error instanceof PreflightError && error.message === code,
    );
  }
  const neutralSource = makeConfig("staging");
  neutralSource.vars.PUBLIC_ORIGIN = "https://common.service.test";
  const neutralPeer = makeConfig("production");
  neutralPeer.vars.PUBLIC_ORIGIN = "https://common.service.test";
  blockedRestore(neutralSource, "shared-public-origin", neutralPeer);
});

test("restore CLI refuses missing or mixed counterpart before writing anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-table-restore-peer-"));
  try {
    const configPath = join(dir, "staging.json");
    const peerPath = join(dir, "production.json");
    const outputPath = join(dir, "output.json");
    const staging = makeConfig("staging");
    const production = makeConfig("production");
    production.kv_namespaces[0].id = staging.kv_namespaces[0].id;
    writeFileSync(configPath, JSON.stringify(staging));
    writeFileSync(peerPath, JSON.stringify(production));
    const args = [
      "scripts/release-preflight.mjs",
      "--prepare-restore",
      "--config",
      configPath,
      "--peer-config",
      peerPath,
      "--output",
      outputPath,
    ];
    const mixed = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /^PREFLIGHT_BLOCKED shared-oauth-kv\n$/);
    assert.equal(mixed.stdout, "");
    assert.equal(existsSync(outputPath), false);

    const absent = spawnSync(
      process.execPath,
      args.filter((_, index) => index !== 4 && index !== 5),
      { encoding: "utf8" },
    );
    assert.notEqual(absent.status, 0);
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
