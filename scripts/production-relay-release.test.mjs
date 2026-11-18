import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  makeFixture,
  makeGithubMock,
  makePrivatePilotFixture,
  makeProviderMock,
  now,
} from "../test/helpers/release-fixtures.mjs";
import { authorizeRelease } from "./release-authorization.mjs";
import { verifyNormalPause } from "./release-pause-readback.mjs";
import { verifyPublishedRelease } from "./release-postverify.mjs";
import { validateRelease } from "./release-preflight.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const f = makeFixture("production"),
    config = JSON.parse(f.configText),
    peer = JSON.parse(f.peerText);
  Object.assign(config.vars, {
    RELEASE_PROFILE: "production-relay-events",
    ENABLE_MCP_SUBSCRIPTIONS: "true",
    ENABLE_OPENAI_EVENTS: "true",
    ALLOW_OUTBOUND_NOTIFICATIONS: "true",
    EVENTS_REVIEWED_CALLBACK_TARGETS: JSON.stringify([
      { origin: "https://events.example.org", pathPrefix: "/callback" },
    ]),
    EVENTS_RELAY_CONFIGURATION: JSON.stringify({
      version: 1,
      environment: "production",
      buildSha: f.buildSha,
      origin: "https://relay.example.org",
      callerId: "synthetic_caller_123",
      audience: "production:agent-table",
      signingPublicKeySha256: "b".repeat(64),
    }),
  });
  f.profile = "production-relay-events";
  f.configText = JSON.stringify(config);
  f.inventory.bindings = [
    ...f.inventory.bindings,
    "EVENTS_RELAY_SIGNING_KEY_PKCS8",
  ];
  f.operations.profile = f.profile;
  f.operations.configSha256 = f.evidence.configSha256 = hash(f.configText);
  for (const name of ["egress", "provider", "delivery", "real_host"])
    f.evidence.checks[name] = {
      status: "passed",
      refs: ["https://synthetic.example.org/operator-observations"],
    };
  f.operations.productionRelay = {
    reviewKind: "operator-reviewed",
    configurationSha256: hash(config.vars.EVENTS_RELAY_CONFIGURATION),
    callbackTargetsSha256: hash(config.vars.EVENTS_REVIEWED_CALLBACK_TARGETS),
    signingPublicKeySha256: "b".repeat(64),
    transportIdentity: {
      host: "synthetic-host",
      artifact: "synthetic-image-digest",
      process: "synthetic-process",
    },
    connectionSecurityEvidence: ["https://synthetic.example.org/security"],
    hostBehaviorEvidence: ["https://synthetic.example.org/host"],
    limitations: ["synthetic fixture, not live acceptance"],
    dataHandling: {
      keyOwnership: "synthetic owner",
      limits: "synthetic quotas",
      retention: "synthetic metadata only",
      rollback: "synthetic outbound pause",
      uncertainRestart:
        "synthetic old process confirmed stopped; preserve unknown",
    },
  };
  const cf = makeProviderMock(config, peer),
    gh = makeGithubMock("production"),
    prefix = `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}`;
  for (const rows of [
    cf.routes.get(`${prefix}/settings`).bindings,
    cf.routes.get(`${prefix}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)
      .resources.bindings,
    cf.routes.get(`${prefix}/secrets`),
  ])
    rows.push({
      name: "EVENTS_RELAY_SIGNING_KEY_PKCS8",
      type: "secret_text",
      text: "NEVER_ECHO_RELAY_KEY",
    });
  return { f, config, peer, cf, gh };
}
const authorize = ({ f, cf, gh, clock }) =>
  authorizeRelease({
    ...f,
    cloudflareRead: cf.read,
    githubRead: gh.read,
    now: clock ?? now,
  });
test("production relay uses existing protected owner/main/CI/provider authority, not passed refs alone", async () => {
  const v = fixture();
  const approval = await authorize(v);
  assert.equal(approval.deploymentApproved, true);
  assert.equal(
    approval.productionRelay.reviewAuthority,
    "operator-reviewed-under-protected-environment",
  );
  assert.equal(
    approval.productionRelay.machineVerifiedTransportEvidence,
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(approval),
    /NEVER_ECHO|synthetic-host|synthetic-image/,
  );
  const cli = spawnSync(
    process.execPath,
    [
      "scripts/require-release-approval.mjs",
      "production",
      v.f.buildSha,
      hash(v.f.configText),
      v.f.profile,
    ],
    {
      input: `RELEASE_APPROVAL_VALID ${JSON.stringify(approval)}`,
      encoding: "utf8",
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const post = await verifyPublishedRelease({
    configText: v.f.configText,
    peer: v.peer,
    approval,
    cloudflareRead: v.cf.read,
    httpFetch: async () =>
      Response.json(
        {
          status: "ok",
          release: {
            environment: "production",
            profile: v.f.profile,
            buildSha: v.f.buildSha,
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      ),
  });
  assert.equal(post.verified, true);
  for (const mutate of [
    (v) => delete v.f.operations.productionRelay,
    (v) =>
      (v.f.operations.productionRelay.configurationSha256 = "c".repeat(64)),
    (v) =>
      (v.f.operations.productionRelay.signingPublicKeySha256 = "c".repeat(64)),
    (v) => (v.f.operations.productionRelay.connectionSecurityEvidence = []),
    (v) => (v.f.operations.review.decision = "pending"),
    (v) => (v.f.workflow.runAttempt = "2"),
    (v) => (v.f.operations.schema.testedVersion = 13),
  ]) {
    const bad = fixture();
    mutate(bad);
    await assert.rejects(authorize(bad));
  }
  const badOwner = fixture();
  const original = badOwner.gh.read;
  badOwner.gh.read = async (p) => (p.endsWith("/approvals") ? [] : original(p));
  await assert.rejects(
    authorize(badOwner),
    /independent-deployment-review-unverified/,
  );
});
test("production relay offline preflight never grants deployment; absent key inventory and plaintext credentials refuse", () => {
  const v = fixture();
  assert.equal(
    validateRelease({ ...v.f, secrets: v.f.inventory }).deploymentApproved,
    false,
  );
  v.f.inventory.bindings.pop();
  assert.throws(
    () => validateRelease({ ...v.f, secrets: v.f.inventory }),
    /relay-configuration/,
  );
  const other = fixture();
  const cfg = JSON.parse(other.f.configText);
  cfg.vars.EVENTS_RELAY_SIGNING_KEY_PKCS8 = "not-a-secret-binding";
  other.f.configText = JSON.stringify(cfg);
  assert.throws(
    () => validateRelease({ ...other.f, secrets: other.f.inventory }),
    /relay-secret-in-plain-config/,
  );
});

test("paused production relay can be verified without granting activation or resetting identity", async () => {
  const v = fixture();
  for (const key of [
    "ALLOW_NEW_GUESTS",
    "ALLOW_NEW_TABLES",
    "ENABLE_MCP_SUBSCRIPTIONS",
    "ENABLE_OPENAI_EVENTS",
    "ALLOW_OUTBOUND_NOTIFICATIONS",
  ])
    v.config.vars[key] = "false";
  for (const obj of v.cf.routes.values()) {
    const bindings = obj.bindings ?? obj.resources?.bindings;
    if (
      bindings?.some(
        (b) =>
          b.name === "PUBLIC_ORIGIN" && b.text === v.config.vars.PUBLIC_ORIGIN,
      )
    )
      for (const b of bindings)
        if (b.type === "plain_text" && Object.hasOwn(v.config.vars, b.name))
          b.text = v.config.vars[b.name];
  }
  const result = await verifyNormalPause({
    config: v.config,
    peer: v.peer,
    expectedVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    cloudflareRead: v.cf.read,
  });
  assert.equal(result.admission, "paused");
  const bad = structuredClone(v.config);
  bad.vars.ALLOW_OUTBOUND_NOTIFICATIONS = "true";
  await assert.rejects(
    verifyNormalPause({
      config: bad,
      peer: v.peer,
      expectedVersionId: result.versionId,
      cloudflareRead: v.cf.read,
    }),
    /pause-config-not-disabled/,
  );
});

// Independent expected states: neither a JSON claim nor provider/health success
// is an oracle for an actual authenticated host run/read/reply (#74 REQ-006).
const pendingAcceptance = {
  completed: false,
  delivery: "pending",
  realHost: "pending",
};
function publicationGate(v, approval) {
  return spawnSync(
    process.execPath,
    [
      "scripts/require-release-approval.mjs",
      "production",
      v.f.buildSha,
      hash(v.f.configText),
      v.f.profile,
    ],
    {
      input: `RELEASE_APPROVAL_VALID ${JSON.stringify(approval)}`,
      encoding: "utf8",
    },
  );
}
function observedHealth(v) {
  return async () =>
    Response.json(
      {
        status: "ok",
        release: {
          environment: "production",
          profile: v.f.profile,
          buildSha: v.f.buildSha,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
}
test("P1: pending host metadata cannot authorize an all-table production profile", async () => {
  const v = fixture();
  assert.equal(v.config.vars.ENABLE_MCP_SUBSCRIPTIONS, "true");
  assert.equal(v.config.vars.ENABLE_OPENAI_EVENTS, "true");
  assert.equal(v.config.vars.ALLOW_OUTBOUND_NOTIFICATIONS, "true");
  delete v.f.evidence.checks.delivery;
  delete v.f.evidence.checks.real_host;
  assert.throws(
    () => validateRelease({ ...v.f, secrets: v.f.inventory }),
    /missing-or-unverified-evidence:delivery/,
  );
  await assert.rejects(authorize(v), /missing-or-unverified-evidence:delivery/);
  v.f.evidence.checks.delivery = {
    status: "passed",
    refs: ["https://synthetic.example.org/delivery"],
  };
  await assert.rejects(
    authorize(v),
    /missing-or-unverified-evidence:real_host/,
  );
});
test("failed, unknown or pending host proof cannot enable public production", async () => {
  for (const name of ["delivery", "real_host"])
    for (const status of ["failed", "unknown", "pending"]) {
      const v = fixture();
      v.f.evidence.checks[name] = {
        status,
        refs: ["https://synthetic.example.org/claim"],
      };
      await assert.rejects(
        authorize(v),
        new RegExp(`missing-or-unverified-evidence:${name}`),
      );
    }
});
test("full evidence authorization and config/health readback do not themselves claim host completion", async () => {
  const v = fixture(),
    approval = await authorize(v);
  assert.equal(approval.deploymentApproved, true);
  assert.deepEqual(approval.productionAcceptance, pendingAcceptance);
  assert.equal(publicationGate(v, approval).status, 0);
  const post = await verifyPublishedRelease({
    configText: v.f.configText,
    peer: v.peer,
    approval,
    cloudflareRead: v.cf.read,
    httpFetch: observedHealth(v),
  });
  assert.equal(post.verified, true);
  assert.equal(post.verificationScope, "serving-configuration");
  assert.deepEqual(post.productionAcceptance, pendingAcceptance);
  assert.equal(post.configSha256, hash(v.f.configText));
});
test("production deployment still refuses absent security/transport, foreign target and unavailable approvals", async () => {
  for (const name of [
    "application",
    "security",
    "browser",
    "egress",
    "provider",
  ]) {
    const v = fixture();
    delete v.f.evidence.checks[name];
    assert.throws(
      () => validateRelease({ ...v.f, secrets: v.f.inventory }),
      new RegExp(`missing-or-unverified-evidence:${name}`),
    );
  }
  for (const patch of [
    (v) => (v.f.evidence.buildSha = "c".repeat(40)),
    (v) => (v.f.evidence.configSha256 = "c".repeat(64)),
    (v) => (v.f.evidence.environment = "staging"),
    (v) => (v.f.operations.review.decision = "pending"),
    (v) => (v.f.operations.productionRelay.connectionSecurityEvidence = []),
    (v) => (v.f.operations.productionRelay.hostBehaviorEvidence = []),
  ]) {
    const v = fixture();
    patch(v);
    await assert.rejects(authorize(v));
  }
  const owner = fixture(),
    gh = owner.gh.read;
  owner.gh.read = async (path) => (path.endsWith("/approvals") ? [] : gh(path));
  await assert.rejects(
    authorize(owner),
    /independent-deployment-review-unverified/,
  );
  const provider = fixture();
  provider.cf.read = async () => {
    throw Error("unavailable");
  };
  await assert.rejects(authorize(provider));
});
test("normal Events/autonomous completion evidence remains required", () => {
  for (const profile of ["events", "autonomous"]) {
    const v = fixture();
    delete v.f.evidence.checks.delivery;
    delete v.f.evidence.checks.real_host;
    v.config.vars.RELEASE_PROFILE = profile;
    v.f.profile = profile;
    v.f.configText = JSON.stringify(v.config);
    v.f.evidence.configSha256 = hash(v.f.configText);
    assert.throws(
      () => validateRelease({ ...v.f, secrets: v.f.inventory }),
      /missing-or-unverified-evidence:delivery/,
    );
    v.f.evidence.checks.delivery = {
      status: "passed",
      refs: ["https://synthetic.example.org/delivery"],
    };
    assert.throws(
      () => validateRelease({ ...v.f, secrets: v.f.inventory }),
      /missing-or-unverified-evidence:real_host/,
    );
  }
});
test("publication gate and config readback reject fabricated completed host acceptance", async () => {
  const v = fixture(),
    a = await authorize(v);
  for (const productionAcceptance of [
    undefined,
    { ...pendingAcceptance, completed: true },
    { ...pendingAcceptance, realHost: "passed" },
    { ...pendingAcceptance, delivery: "passed" },
    { ...pendingAcceptance, receipt: "https://synthetic.example.org/claim" },
  ]) {
    const forged = { ...a, productionAcceptance };
    assert.notEqual(publicationGate(v, forged).status, 0);
    let reads = 0;
    await assert.rejects(
      verifyPublishedRelease({
        configText: v.f.configText,
        peer: v.peer,
        approval: forged,
        cloudflareRead: async (p) => {
          reads++;
          return v.cf.read(p);
        },
        httpFetch: observedHealth(v),
      }),
      /post-deploy-production-relay-approval-mismatch/,
    );
    assert.equal(reads, 0);
  }
});

function isolatedFixture() {
  const v = fixture(),
    privateBase = makePrivatePilotFixture();
  v.clock = Date.now();
  const policy = JSON.parse(
    JSON.parse(privateBase.configText).vars.PRIVATE_PILOT_POLICY,
  );
  Object.assign(policy, {
    buildSha: v.f.buildSha,
    approvedAt: new Date(v.clock - 2000).toISOString(),
    notBefore: new Date(v.clock - 1000).toISOString(),
    expiresAt: new Date(v.clock + 3600000).toISOString(),
    callbackTargets: JSON.parse(v.config.vars.EVENTS_REVIEWED_CALLBACK_TARGETS),
  });
  Object.assign(v.config.vars, {
    RELEASE_PROFILE: "private-pilot-a-only",
    ENABLE_MCP_SUBSCRIPTIONS: "false",
    ENABLE_OPENAI_EVENTS: "false",
    PRIVATE_PILOT_POLICY: JSON.stringify(policy),
  });
  v.f.profile = "private-pilot-a-only";
  v.f.configText = JSON.stringify(v.config);
  v.f.evidence.configSha256 = v.f.operations.configSha256 = hash(
    v.f.configText,
  );
  delete v.f.evidence.checks.delivery;
  delete v.f.evidence.checks.real_host;
  v.f.operations.profile = v.f.profile;
  v.f.operations.review.reviewedAt = new Date(v.clock - 1000).toISOString();
  for (const value of Object.values(v.f.operations.retention))
    value.reviewedAt = new Date(v.clock - 1000).toISOString();
  v.f.operations.privatePilot = {
    ...privateBase.operations.privatePilot,
    policySha256: hash(v.config.vars.PRIVATE_PILOT_POLICY),
    nativeFetchRiskAccepted: false,
  };
  v.cf = makeProviderMock(v.config, v.peer);
  const prefix = `/client/v4/accounts/${v.config.account_id}/workers/scripts/${v.config.name}`;
  for (const rows of [
    v.cf.routes.get(`${prefix}/settings`).bindings,
    v.cf.routes.get(`${prefix}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)
      .resources.bindings,
    v.cf.routes.get(`${prefix}/secrets`),
  ])
    rows.push({ name: "EVENTS_RELAY_SIGNING_KEY_PKCS8", type: "secret_text" });
  return v;
}
function changeScope(v, patch) {
  v.config.vars.PRIVATE_PILOT_POLICY = JSON.stringify({
    ...JSON.parse(v.config.vars.PRIVATE_PILOT_POLICY),
    ...patch,
  });
  v.f.configText = JSON.stringify(v.config);
  v.f.evidence.configSha256 = v.f.operations.configSha256 = hash(
    v.f.configText,
  );
  v.f.operations.privatePilot.policySha256 = hash(
    v.config.vars.PRIVATE_PILOT_POLICY,
  );
}
test("explicit production private relay scope can collect pending evidence without a global Events profile", async () => {
  const v = isolatedFixture();
  assert.equal(v.config.vars.ENABLE_MCP_SUBSCRIPTIONS, "false");
  assert.equal(v.config.vars.ENABLE_OPENAI_EVENTS, "false");
  const a = await authorize(v);
  assert.equal(a.deploymentApproved, true);
  assert.deepEqual(a.productionAcceptance, pendingAcceptance);
  assert.equal(a.privatePilot.mode, "a-only");
  assert.equal(a.productionRelay.machineVerifiedTransportEvidence, false);
  assert.equal(publicationGate(v, a).status, 0);
  const post = await verifyPublishedRelease({
    configText: v.f.configText,
    peer: v.peer,
    approval: a,
    cloudflareRead: v.cf.read,
    httpFetch: observedHealth(v),
  });
  assert.deepEqual(post.productionAcceptance, pendingAcceptance);
  assert.equal(post.verificationScope, "serving-configuration");
});
test("isolated relay release refuses missing prior transport evidence, missing consent, native waiver and false completion", async () => {
  for (const name of [
    "application",
    "security",
    "browser",
    "egress",
    "provider",
  ]) {
    const v = isolatedFixture();
    delete v.f.evidence.checks[name];
    await assert.rejects(authorize(v));
  }
  for (const mutate of [
    (v) => delete v.f.operations.privatePilot,
    (v) => delete v.f.operations.productionRelay,
    (v) => (v.f.operations.privatePilot.nativeFetchRiskAccepted = true),
    (v) =>
      (v.f.operations.privatePilot.independentOwnerConsentsReviewed = false),
    (v) => (v.f.operations.privatePilot.stopPlanReviewed = false),
    (v) => (v.f.operations.review.decision = "pending"),
  ]) {
    const v = isolatedFixture();
    mutate(v);
    await assert.rejects(authorize(v));
  }
  const v = isolatedFixture(),
    a = await authorize(v);
  assert.notEqual(
    publicationGate(v, {
      ...a,
      productionAcceptance: { ...pendingAcceptance, completed: true },
    }).status,
    0,
  );
});
test("expired/not-yet-active scope, global switches, invalid bounds and callback widening refuse before publication", async () => {
  for (const kind of [
    "expired",
    "future",
    "wide-callback",
    "overlong",
    "discovery",
    "global",
  ]) {
    const v = isolatedFixture();
    if (kind === "expired")
      changeScope(v, {
        approvedAt: new Date(v.clock - 200000).toISOString(),
        notBefore: new Date(v.clock - 120000).toISOString(),
        expiresAt: new Date(v.clock - 1000).toISOString(),
      });
    if (kind === "future")
      changeScope(v, { notBefore: new Date(v.clock + 60000).toISOString() });
    if (kind === "wide-callback")
      changeScope(v, {
        callbackTargets: [
          { origin: "https://other.example.org", pathPrefix: "/" },
        ],
      });
    if (kind === "overlong")
      changeScope(v, {
        expiresAt: new Date(v.clock + 3 * 3600000).toISOString(),
      });
    if (kind === "discovery")
      changeScope(v, {
        mode: "a-only-discovery",
        callbackTargets: [],
        observationMode: "private-redacted",
      });
    if (kind === "global") {
      v.config.vars.ENABLE_MCP_SUBSCRIPTIONS = "true";
      v.config.vars.ENABLE_OPENAI_EVENTS = "true";
      v.f.configText = JSON.stringify(v.config);
      v.f.evidence.configSha256 = v.f.operations.configSha256 = hash(
        v.f.configText,
      );
    }
    await assert.rejects(authorize(v));
  }
});
test("pending scoped observations do not promote a changed all-table target", async () => {
  const v = isolatedFixture();
  await authorize(v);
  delete v.config.vars.PRIVATE_PILOT_POLICY;
  v.config.vars.RELEASE_PROFILE = "production-relay-events";
  v.config.vars.ENABLE_MCP_SUBSCRIPTIONS = "true";
  v.config.vars.ENABLE_OPENAI_EVENTS = "true";
  v.f.profile = "production-relay-events";
  v.f.operations.profile = v.f.profile;
  v.f.configText = JSON.stringify(v.config);
  v.f.evidence.configSha256 = v.f.operations.configSha256 = hash(
    v.f.configText,
  );
  await assert.rejects(authorize(v), /missing-or-unverified-evidence:delivery/);
});

test("private production provider readback and normal pause require the actual relay secret and safe switches", async () => {
  const v = isolatedFixture(),
    a = await authorize(v);
  const prefix = `/client/v4/accounts/${v.config.account_id}/workers/scripts/${v.config.name}`;
  for (const rows of [
    v.cf.routes.get(`${prefix}/settings`).bindings,
    v.cf.routes.get(`${prefix}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)
      .resources.bindings,
    v.cf.routes.get(`${prefix}/secrets`),
  ])
    rows.splice(
      rows.findIndex((b) => b.name === "EVENTS_RELAY_SIGNING_KEY_PKCS8"),
      1,
    );
  let health = 0;
  await assert.rejects(
    verifyPublishedRelease({
      configText: v.f.configText,
      peer: v.peer,
      approval: a,
      cloudflareRead: v.cf.read,
      httpFetch: async () => {
        health++;
        return observedHealth(v)();
      },
    }),
  );
  assert.equal(health, 0);
  const paused = isolatedFixture();
  for (const name of [
    "ALLOW_NEW_GUESTS",
    "ALLOW_NEW_TABLES",
    "ENABLE_MCP_SUBSCRIPTIONS",
    "ENABLE_OPENAI_EVENTS",
    "ALLOW_OUTBOUND_NOTIFICATIONS",
  ])
    paused.config.vars[name] = "false";
  const cf = makeProviderMock(paused.config, paused.peer),
    pp = `/client/v4/accounts/${paused.config.account_id}/workers/scripts/${paused.config.name}`;
  for (const rows of [
    cf.routes.get(`${pp}/settings`).bindings,
    cf.routes.get(`${pp}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)
      .resources.bindings,
    cf.routes.get(`${pp}/secrets`),
  ])
    rows.push({ name: "EVENTS_RELAY_SIGNING_KEY_PKCS8", type: "secret_text" });
  const result = await verifyNormalPause({
    config: paused.config,
    peer: paused.peer,
    expectedVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    cloudflareRead: cf.read,
  });
  assert.equal(result.verified, true);
  assert.equal(result.admission, "paused");
});

test("reusable workflow context permits only the scoped production profile and never a production native-risk profile", () => {
  const source = readFileSync(".github/workflows/_deploy-reviewed.yml", "utf8");
  const start = source.indexOf(
    'if [[ "$RELEASE_PROFILE" == "production-relay-events" ]]',
  );
  const end = source.indexOf("\n          fi", start);
  assert.ok(start >= 0 && end > start);
  const block = `${source.slice(start, end)}\nfi`;
  for (const [profile, environment, bootstrap, allowed] of [
    ["private-pilot-a-only", "production", "false", true],
    ["private-pilot-a-only", "staging", "false", true],
    ["production-relay-events", "production", "false", true],
    ["production-relay-events", "staging", "false", false],
    ["test-native-events", "production", "false", false],
    ["unknown", "production", "false", false],
    ["private-pilot-a-only", "production", "true", false],
  ]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${block}`], {
      env: {
        PATH: "/usr/bin:/bin",
        RELEASE_PROFILE: profile,
        TARGET_ENVIRONMENT: environment,
        BOOTSTRAP_STAGING: bootstrap,
      },
      encoding: "utf8",
    });
    assert.equal(
      result.status === 0,
      allowed,
      `${profile}/${environment}/${bootstrap}`,
    );
  }
});

function stagingSignedFixture() {
  const f = makePrivatePilotFixture(),
    config = JSON.parse(f.configText),
    peer = JSON.parse(f.peerText);
  const production = fixture();
  config.vars.EVENTS_REVIEWED_CALLBACK_TARGETS = JSON.stringify(
    JSON.parse(config.vars.PRIVATE_PILOT_POLICY).callbackTargets,
  );
  config.vars.EVENTS_RELAY_CONFIGURATION = JSON.stringify({
    ...JSON.parse(production.config.vars.EVENTS_RELAY_CONFIGURATION),
    environment: "staging",
    audience: "test:agent-table",
  });
  f.configText = JSON.stringify(config);
  f.inventory.bindings = [
    ...f.inventory.bindings,
    "EVENTS_RELAY_SIGNING_KEY_PKCS8",
  ];
  f.operations.configSha256 = f.evidence.configSha256 = hash(f.configText);
  f.operations.privatePilot.nativeFetchRiskAccepted = false;
  f.operations.productionRelay = {
    ...production.f.operations.productionRelay,
    configurationSha256: hash(config.vars.EVENTS_RELAY_CONFIGURATION),
    callbackTargetsSha256: hash(config.vars.EVENTS_REVIEWED_CALLBACK_TARGETS),
  };
  const cf = makeProviderMock(config, peer),
    gh = makeGithubMock("staging"),
    prefix = `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}`;
  for (const rows of [
    cf.routes.get(`${prefix}/settings`).bindings,
    cf.routes.get(`${prefix}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)
      .resources.bindings,
    cf.routes.get(`${prefix}/secrets`),
  ])
    rows.push({ name: "EVENTS_RELAY_SIGNING_KEY_PKCS8", type: "secret_text" });
  return { f, config, peer, cf, gh };
}
test("staging private signed relay uses test audience and real release authority without production promotion", async () => {
  const v = stagingSignedFixture();
  const a = await authorize(v);
  assert.equal(a.deploymentApproved, true);
  assert.equal(a.environment, "staging");
  assert.equal(a.productionRelay.machineVerifiedTransportEvidence, false);
  assert.deepEqual(a.productionAcceptance, pendingAcceptance);
  for (const mutate of [
    (v) => delete v.f.operations.productionRelay,
    (v) => (v.f.operations.privatePilot.nativeFetchRiskAccepted = true),
    (v) => {
      const c = JSON.parse(v.f.configText);
      c.vars.EVENTS_RELAY_CONFIGURATION = JSON.stringify({
        ...JSON.parse(c.vars.EVENTS_RELAY_CONFIGURATION),
        audience: "production:agent-table",
      });
      v.f.configText = JSON.stringify(c);
      v.f.evidence.configSha256 = v.f.operations.configSha256 = hash(
        v.f.configText,
      );
    },
    (v) =>
      (v.f.inventory.bindings = v.f.inventory.bindings.filter(
        (k) => k !== "EVENTS_RELAY_SIGNING_KEY_PKCS8",
      )),
  ]) {
    const bad = stagingSignedFixture();
    mutate(bad);
    await assert.rejects(authorize(bad));
  }
});
