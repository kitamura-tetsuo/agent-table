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
) {
  return spawnSync(
    process.execPath,
    [gate.pathname, environment, buildSha, configDigest],
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
  for (const input of [
    "",
    "{",
    "PREFLIGHT_BLOCKED missing-secret",
    "PREFLIGHT_MANIFEST_VALID {}",
  ]) {
    assert.equal(inspect(input).status, 1);
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
  assert.match(shared, /"\$TARGET_ENVIRONMENT" "\$GITHUB_SHA" "\$config_sha"/);
  assert.match(shared, /sha256sum "\$config"/);
  assert.match(shared, /wrangler deploy --config "\$config"/);
  assert.match(shared, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(shared, /if:\s*always\(\)/);
});
