import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  makeFixture,
  makeGithubMock,
  makeProviderMock,
  now,
} from "../test/helpers/release-fixtures.mjs";
import { authorizeRelease } from "./release-authorization.mjs";
import { verifyPublishedRelease } from "./release-postverify.mjs";
import { validateRelease } from "./release-preflight.mjs";
import { verifyDeployedConfiguration } from "./release-provider.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const f = makeFixture();
  const config = JSON.parse(f.configText);
  Object.assign(config.vars, {
    RELEASE_PROFILE: "test-native-events",
    ENABLE_MCP_SUBSCRIPTIONS: "true",
    ENABLE_OPENAI_EVENTS: "true",
    ALLOW_OUTBOUND_NOTIFICATIONS: "true",
    TEST_NATIVE_EVENTS_RISK_ACCEPTANCE: "accept-unverified-dns-peer-boundary",
    EVENTS_REVIEWED_CALLBACK_TARGETS: JSON.stringify([
      {
        origin: "https://events.provider.example.org",
        pathPrefix: "/callback",
      },
    ]),
  });
  f.profile = config.vars.RELEASE_PROFILE;
  f.configText = JSON.stringify(config);
  f.evidence.configSha256 = hash(f.configText);
  Object.assign(f.operations, {
    profile: f.profile,
    configSha256: hash(f.configText),
    testNativeEvents: {
      risk: config.vars.TEST_NATIVE_EVENTS_RISK_ACCEPTANCE,
      targetsSha256: hash(config.vars.EVENTS_REVIEWED_CALLBACK_TARGETS),
      allAuthorizedTablesReviewed: true,
      callbackDataDisclosureReviewed: true,
      monitoringAndStopPlanReviewed: true,
    },
  });
  return f;
}
test("staging exception requires protected owner approval and exact provider readback", async () => {
  const f = fixture(),
    config = JSON.parse(f.configText),
    peer = JSON.parse(f.peerText);
  assert.equal(
    validateRelease({ ...f, secrets: f.inventory }).preflightValid,
    true,
  );
  const cloudflare = makeProviderMock(config, peer);
  const result = await authorizeRelease({
    ...f,
    cloudflareRead: cloudflare.read,
    githubRead: makeGithubMock().read,
    now,
  });
  assert.equal(result.deploymentApproved, true);
  assert.equal(
    result.testNativeEvents.risk,
    "accept-unverified-dns-peer-boundary",
  );
  assert.equal(
    result.testNativeEvents.targetsSha256,
    hash(config.vars.EVENTS_REVIEWED_CALLBACK_TARGETS),
  );
  const options = {
    configText: f.configText,
    peer,
    approval: result,
    cloudflareRead: cloudflare.read,
    httpFetch: async () =>
      Response.json(
        {
          status: "ok",
          release: {
            environment: "staging",
            profile: f.profile,
            buildSha: f.buildSha,
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      ),
  };
  assert.equal((await verifyPublishedRelease(options)).verified, true);
  const bad = structuredClone(result);
  bad.testNativeEvents.risk = "not-approved";
  await assert.rejects(
    verifyPublishedRelease({ ...options, approval: bad }),
    /post-deploy-test-native-events-approval-mismatch/,
  );
  const gate = (manifest) =>
    spawnSync(
      process.execPath,
      [
        "scripts/require-release-approval.mjs",
        "staging",
        f.buildSha,
        hash(f.configText),
        f.profile,
      ],
      {
        input: `RELEASE_APPROVAL_VALID ${JSON.stringify(manifest)}`,
        encoding: "utf8",
      },
    );
  assert.equal(gate(result).status, 0);
  assert.equal(gate(bad).status, 1);
});
test("no exception in production or without explicit risk/config", () => {
  for (const mutation of [
    (v) => (v.RELEASE_ENVIRONMENT = "production"),
    (v) => delete v.TEST_NATIVE_EVENTS_RISK_ACCEPTANCE,
    (v) => (v.EVENTS_REVIEWED_CALLBACK_TARGETS = "[]"),
    (v) => (v.EVENTS_RELAY_CONFIGURATION = "{}"),
    (v) => (v.PRIVATE_PILOT_POLICY = "{}"),
  ]) {
    const f = fixture(),
      config = JSON.parse(f.configText);
    mutation(config.vars);
    f.configText = JSON.stringify(config);
    f.evidence.configSha256 = hash(f.configText);
    assert.throws(() => validateRelease({ ...f, secrets: f.inventory }));
  }
});
test("scope, data and stop-plan approvals cannot be omitted", async () => {
  for (const name of [
    "allAuthorizedTablesReviewed",
    "callbackDataDisclosureReviewed",
    "monitoringAndStopPlanReviewed",
    "risk",
    "targetsSha256",
  ]) {
    const f = fixture();
    delete f.operations.testNativeEvents[name];
    const config = JSON.parse(f.configText),
      peer = JSON.parse(f.peerText);
    await assert.rejects(
      authorizeRelease({
        ...f,
        cloudflareRead: makeProviderMock(config, peer).read,
        githubRead: makeGithubMock().read,
        now,
      }),
      /test-native-events-risk-not-approved/,
    );
  }
});
test("native activation refuses a retained relay secret in inventory or any provider surface", async () => {
  const f = fixture();
  const secretName = "EVENTS_RELAY_SIGNING_KEY_PKCS8";
  assert.throws(
    () =>
      validateRelease({
        ...f,
        secrets: {
          ...f.inventory,
          bindings: [...f.inventory.bindings, secretName],
        },
      }),
    /relay-secret-in-test-native-profile/,
  );
  const config = JSON.parse(f.configText),
    peer = JSON.parse(f.peerText);
  for (const surface of ["settings", "version", "secrets"]) {
    const provider = makeProviderMock(config, peer);
    const base = `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}`;
    const binding = { name: secretName, type: "secret_text" };
    if (surface === "settings")
      provider.routes.get(`${base}/settings`).bindings.push(binding);
    if (surface === "version")
      provider.routes
        .get(`${base}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)
        .resources.bindings.push(binding);
    if (surface === "secrets")
      provider.routes.get(`${base}/secrets`).push(binding);
    await assert.rejects(
      authorizeRelease({
        ...f,
        cloudflareRead: provider.read,
        githubRead: makeGithubMock().read,
        now,
      }),
      /provider-test-native-relay-secret-present/,
    );
  }
  assert.throws(
    () =>
      verifyDeployedConfiguration(
        {
          textBindings: config.vars,
          secretNames: [secretName],
        },
        config,
      ),
    /provider-deployed-test-native-profile-unverified/,
  );
  assert.doesNotThrow(() =>
    verifyDeployedConfiguration(
      {
        textBindings: config.vars,
        secretNames: f.inventory.bindings,
      },
      config,
    ),
  );
});
test("postdeploy readback requires exact risk and callback binding removal on rollback", () => {
  const f = fixture(),
    config = JSON.parse(f.configText);
  const observed = {
    textBindings: { ...config.vars },
    secretNames: f.inventory.bindings,
  };
  verifyDeployedConfiguration(observed, config);
  for (const name of [
    "TEST_NATIVE_EVENTS_RISK_ACCEPTANCE",
    "EVENTS_REVIEWED_CALLBACK_TARGETS",
  ]) {
    const changed = structuredClone(observed);
    changed.textBindings[name] = "changed";
    assert.throws(
      () => verifyDeployedConfiguration(changed, config),
      /provider-deployed-test-native-binding-mismatch/,
    );
  }
  const manual = JSON.parse(makeFixture().configText);
  assert.throws(() =>
    verifyDeployedConfiguration(
      {
        textBindings: {
          ...manual.vars,
          TEST_NATIVE_EVENTS_RISK_ACCEPTANCE:
            config.vars.TEST_NATIVE_EVENTS_RISK_ACCEPTANCE,
        },
      },
      manual,
    ),
  );
});
test("emergency-paused native deployment remains readable for manual rollback and as a peer", async () => {
  const active = fixture(),
    paused = JSON.parse(active.configText);
  paused.vars.ALLOW_OUTBOUND_NOTIFICATIONS = "false";
  const manual = makeFixture(),
    production = JSON.parse(manual.peerText);
  const rollback = await authorizeRelease({
    ...manual,
    cloudflareRead: makeProviderMock(paused, production).read,
    githubRead: makeGithubMock().read,
    now,
  });
  assert.equal(rollback.deploymentApproved, true);
  assert.equal(rollback.profile, "manual");
  const prod = makeFixture("production");
  prod.peerText = JSON.stringify(paused);
  const result = await authorizeRelease({
    ...prod,
    cloudflareRead: makeProviderMock(production, paused).read,
    githubRead: makeGithubMock("production").read,
    now,
  });
  assert.equal(result.deploymentApproved, true);
  const invalid = fixture();
  invalid.configText = JSON.stringify(paused);
  invalid.evidence.configSha256 = hash(invalid.configText);
  assert.throws(
    () => validateRelease({ ...invalid, secrets: invalid.inventory }),
    /invalid-test-native-events-configuration/,
  );
});

test("initial staging evidence collection needs no invented hosted success", () => {
  const f = fixture();
  for (const name of ["live_runtime", "provider", "delivery", "real_host"]) {
    assert.equal(f.evidence.checks[name], undefined);
  }
  assert.equal(
    validateRelease({ ...f, secrets: f.inventory }).preflightValid,
    true,
  );
  for (const name of ["application", "security", "browser"]) {
    const missing = structuredClone(f);
    delete missing.evidence.checks[name];
    assert.throws(
      () => validateRelease({ ...missing, secrets: missing.inventory }),
      new RegExp(`missing-or-unverified-evidence:${name}`),
    );
  }
  const wrongBuild = structuredClone(f);
  wrongBuild.evidence.buildSha = "f".repeat(40);
  assert.throws(
    () => validateRelease({ ...wrongBuild, secrets: wrongBuild.inventory }),
    /evidence-target-mismatch/,
  );
  const wrongConfig = structuredClone(f);
  wrongConfig.evidence.configSha256 = "f".repeat(64);
  assert.throws(
    () => validateRelease({ ...wrongConfig, secrets: wrongConfig.inventory }),
    /evidence-target-mismatch/,
  );
});
