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
const authorize = ({ f, cf, gh }) =>
  authorizeRelease({ ...f, cloudflareRead: cf.read, githubRead: gh.read, now });
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
