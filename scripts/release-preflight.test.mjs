import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PreflightError, validateRelease } from "./release-preflight.mjs";

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
  kv_namespaces: [
    {
      binding: "OAUTH_KV",
      id: environment === "staging" ? "1".repeat(32) : "2".repeat(32),
    },
  ],
  vars: {
    RELEASE_ENVIRONMENT: environment,
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
