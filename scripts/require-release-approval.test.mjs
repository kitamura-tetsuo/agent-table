import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sha = "a".repeat(40);
const configSha = "b".repeat(64);
const gate = new URL("./require-release-approval.mjs", import.meta.url);

function inspect(
  input,
  environment = "staging",
  buildSha = sha,
  configDigest = configSha,
  profile = "manual",
) {
  return spawnSync(
    process.execPath,
    [gate.pathname, environment, buildSha, configDigest, profile],
    {
      input,
      encoding: "utf8",
    },
  );
}

test("release gate refuses a merely valid preflight, missing approval or mismatched target", () => {
  const valid = {
    preflightValid: true,
    deploymentApproved: false,
    environment: "staging",
    profile: "manual",
    buildSha: sha,
    configSha256: configSha,
  };
  for (const manifest of [
    valid,
    { ...valid, deploymentApproved: null },
    { ...valid, deploymentApproved: "true" },
    { ...valid, deploymentApproved: true, environment: "production" },
    { ...valid, deploymentApproved: true, buildSha: "b".repeat(40) },
    { ...valid, deploymentApproved: true, profile: "events" },
    { ...valid, deploymentApproved: true, configSha256: "c".repeat(64) },
  ]) {
    const result = inspect(
      `PREFLIGHT_MANIFEST_VALID ${JSON.stringify(manifest)}\n`,
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^DEPLOYMENT_BLOCKED independent-approval-unavailable\n$/,
    );
  }
  const independentlyVerified = {
    ...valid,
    deploymentApproved: true,
    approvalSource: "protected-environment-and-live-provider-readback",
    workflowRunId: "2345",
    workflowRunAttempt: "1",
    ciRunId: "1234",
    providerReceiptSha256: "c".repeat(64),
    providerReceipt: {
      environment: "staging",
      workerName: "agent-table-staging",
    },
  };
  assert.equal(
    inspect(`RELEASE_APPROVAL_VALID ${JSON.stringify(independentlyVerified)}\n`)
      .status,
    0,
  );
  for (const manifest of [
    { ...independentlyVerified, approvalSource: "offline" },
    { ...independentlyVerified, providerReceiptSha256: "bad" },
    { ...independentlyVerified, workflowRunAttempt: "0" },
    {
      ...independentlyVerified,
      providerReceipt: {
        ...independentlyVerified.providerReceipt,
        environment: "production",
      },
    },
  ]) {
    assert.equal(
      inspect(`RELEASE_APPROVAL_VALID ${JSON.stringify(manifest)}\n`).status,
      1,
    );
  }
  for (const input of [
    "",
    "{",
    "PREFLIGHT_BLOCKED missing-secret",
    "PREFLIGHT_MANIFEST_VALID {}",
  ]) {
    assert.equal(inspect(input).status, 1);
  }
});

test("private gate binds the explicit staging profile and rechecks its finite send window", () => {
  const current = Date.now();
  const manifest = {
    preflightValid: true,
    deploymentApproved: true,
    environment: "staging",
    profile: "private-pilot-a-only",
    buildSha: sha,
    configSha256: configSha,
    approvalSource: "protected-environment-and-live-provider-readback",
    workflowRunId: "2345",
    workflowRunAttempt: "1",
    ciRunId: "1234",
    providerReceiptSha256: "c".repeat(64),
    providerReceipt: {
      environment: "staging",
      workerName: "agent-table-staging",
    },
    privatePilot: {
      mode: "a-only",
      policySha256: "d".repeat(64),
      notBefore: new Date(current - 60_000).toISOString(),
      expiresAt: new Date(current + 60_000).toISOString(),
      deliveryEnabled: true,
    },
  };
  const check = (
    value,
    environment = "staging",
    profile = "private-pilot-a-only",
  ) =>
    inspect(
      `RELEASE_APPROVAL_VALID ${JSON.stringify(value)}\n`,
      environment,
      sha,
      configSha,
      profile,
    ).status;
  assert.equal(check(manifest), 0);
  assert.equal(check(manifest, "staging", "manual"), 1);
  assert.equal(
    check({ ...manifest, environment: "production" }, "production"),
    1,
  );
  for (const change of [
    { mode: "bidirectional" },
    { policySha256: "bad" },
    { notBefore: new Date(current + 30_000).toISOString() },
    { expiresAt: new Date(current - 30_000).toISOString() },
    { expiresAt: new Date(current + 3 * 60 * 60_000).toISOString() },
    { deliveryEnabled: "false" },
    { observationMode: "raw" },
  ]) {
    assert.equal(
      check({
        ...manifest,
        privatePilot: { ...manifest.privatePilot, ...change },
      }),
      1,
    );
  }
  assert.equal(
    check({
      ...manifest,
      privatePilot: {
        ...manifest.privatePilot,
        expiresAt: new Date(current - 30_000).toISOString(),
        deliveryEnabled: false,
      },
    }),
    0,
  );
  const discovery = {
    ...manifest,
    privatePilot: {
      ...manifest.privatePilot,
      mode: "a-only-discovery",
      observationMode: "private-redacted",
      deliveryEnabled: false,
    },
  };
  assert.equal(check(discovery), 0);
  for (const patch of [
    { deliveryEnabled: true },
    { observationMode: undefined },
    { observationMode: "raw" },
    { notBefore: new Date(current + 30_000).toISOString() },
    { expiresAt: new Date(current - 30_000).toISOString() },
  ]) {
    assert.equal(
      check({
        ...discovery,
        privatePilot: { ...discovery.privatePilot, ...patch },
      }),
      1,
    );
  }
});

test("current offline validator never manufactures a deployment approval", async () => {
  const { validateRelease } = await import("./release-preflight.mjs");
  const source = readFileSync(
    new URL(
      "../test/fixtures/quarantined-restore-generated.json",
      import.meta.url,
    ),
    "utf8",
  );
  const peer = JSON.parse(source);
  peer.name = "agent-table-production";
  peer.vars.RELEASE_ENVIRONMENT = "production";
  peer.vars.PUBLIC_ORIGIN = "https://production.service.test";
  peer.kv_namespaces[0].id = "2".repeat(32);
  const crypto = await import("node:crypto");
  const sha256 = crypto.createHash("sha256").update(source).digest("hex");
  const result = validateRelease({
    environment: "staging",
    profile: "manual",
    buildSha: sha,
    configText: source,
    peerText: JSON.stringify(peer),
    secrets: {
      environment: "staging",
      workerName: "agent-table-staging",
      bindings: ["INVITATION_RESPONSE_KEYRING", "CALLBACK_CREDENTIAL_KEYRING"],
    },
    evidence: {
      environment: "staging",
      buildSha: sha,
      configSha256: sha256,
      checks: Object.fromEntries(
        ["application", "security", "browser"].map((name) => [
          name,
          {
            status: "passed",
            refs: ["https://github.com/example/synthetic"],
          },
        ]),
      ),
    },
  });
  assert.equal(result.preflightValid, true);
  assert.equal(result.deploymentApproved, false);
  assert.equal(
    inspect(
      `PREFLIGHT_MANIFEST_VALID ${JSON.stringify(result)}\n`,
      "staging",
      sha,
      sha256,
    ).status,
    1,
  );
});

test("release workflows remain explicit main-only manual dispatches with environment gate", () => {
  for (const environment of ["staging", "production"]) {
    const workflow = readFileSync(
      new URL(
        `../.github/workflows/deploy-${environment}.yml`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /pull_request:|\bpush:/);
    assert.match(workflow, new RegExp(`target_environment: ${environment}`));
    assert.match(workflow, /expected_sha:/);
    assert.match(workflow, /_deploy-reviewed.yml/);
    assert.match(workflow, /actions: read/);
  }
  const shared = readFileSync(
    new URL("../.github/workflows/_deploy-reviewed.yml", import.meta.url),
    "utf8",
  );
  assert.match(shared, /github\.ref == 'refs\/heads\/main'/);
  assert.match(shared, /github\.repository == 'kitamura-tetsuo\/agent-table'/);
  assert.match(shared, /github\.event_name == 'workflow_dispatch'/);
  assert.match(
    shared,
    /environment:[\s\S]*name: \$\{\{ inputs\.target_environment \}\}/,
  );
  assert.match(shared, /persist-credentials: false/);
  assert.match(shared, /require-release-approval\.mjs/);
  assert.match(shared, /wrangler deploy --dry-run/);
  assert.match(shared, /config_sha=/);
  assert.match(
    shared,
    /"\$TARGET_ENVIRONMENT" "\$GITHUB_SHA" "\$EXPECTED_CONFIG_SHA"/,
  );
  assert.match(shared, /sha256sum "\$config"/);
  assert.match(shared, /wrangler deploy --config "\$config"/);
  assert.match(shared, /verifyCurrentMainHead/);
  assert.match(shared, /"\$RELEASE_PROFILE" == "private-pilot-a-only"/);
  assert.match(shared, /"\$TARGET_ENVIRONMENT" == "staging"/);
  assert.match(shared, /"\$BOOTSTRAP_STAGING" == "false"/);
  assert.equal(
    (shared.match(/node scripts\/require-release-approval\.mjs/g) ?? []).length,
    2,
  );
  assert.match(shared, /CLOUDFLARE_API_TOKEN/);
  assert.match(shared, /if: steps\.gate\.outputs\.approved == 'true'/);
  assert.match(shared, /if: always\(\)/);
  const gateStep = shared
    .split(
      "- name: Validate candidate without access to deployment credentials",
    )[1]
    .split("- name: Authenticate provider ownership and release evidence")[0];
  assert.doesNotMatch(gateStep, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(gateStep, /CLOUDFLARE_READ_TOKEN/);
  const liveApproval = shared
    .split("- name: Authenticate provider ownership and release evidence")[1]
    .split("- name: Publish only")[0];
  assert.match(liveApproval, /release-authorization\.mjs/);
  assert.match(liveApproval, /CLOUDFLARE_READ_TOKEN/);
  assert.match(liveApproval, /RELEASE_OPERATIONS_JSON|operations\.json/);
});
