import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSha,
  makeFixture,
  makeGithubMock,
  makeProviderMock,
  now,
  runId,
} from "../test/helpers/release-fixtures.mjs";
import {
  authorizeRelease,
  githubReader,
  ReleaseAuthorizationError,
  verifyOperationalDecision,
} from "./release-authorization.mjs";

const valid = makeFixture();

function harness(overrides = {}) {
  const fixture = structuredClone({ ...valid, ...overrides });
  const config = JSON.parse(fixture.configText);
  const peer = JSON.parse(fixture.peerText);
  const cloudflare = makeProviderMock(config, peer);
  const github = makeGithubMock();
  return { fixture, cloudflare, github };
}

test("protected exact-main run plus independent provider and CI reads authorize manual staging only", async () => {
  const { fixture, cloudflare, github } = harness();
  const approval = await authorizeRelease({
    ...fixture,
    cloudflareRead: cloudflare.read,
    githubRead: github.read,
    now,
  });
  assert.equal(approval.deploymentApproved, true);
  assert.equal(
    approval.approvalSource,
    "protected-environment-and-live-provider-readback",
  );
  assert.equal(approval.buildSha, buildSha);
  assert.equal(approval.ciRunId, runId);
  assert.match(approval.providerReceiptSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(approval),
    /NEVER_ECHO_ME|secretNames|textBindings/,
  );
});

test("production needs its own protected workflow and separate owned resources", async () => {
  const fixture = makeFixture("production");
  const provider = makeProviderMock(
    JSON.parse(fixture.configText),
    JSON.parse(fixture.peerText),
  );
  const approval = await authorizeRelease({
    ...fixture,
    cloudflareRead: provider.read,
    githubRead: makeGithubMock("production").read,
    now,
  });
  assert.equal(approval.environment, "production");
  assert.equal(approval.providerReceipt.workerName, "agent-table-production");
  assert.equal(approval.deploymentApproved, true);

  fixture.workflow.environment = "staging";
  await assert.rejects(
    authorizeRelease({
      ...fixture,
      cloudflareRead: provider.read,
      githubRead: makeGithubMock("production").read,
      now,
    }),
    /unprotected-release-context/,
  );
});

test("a GitHub Environment label or claimed operator approval is not a review", async () => {
  const prefix = "/repos/kitamura-tetsuo/agent-table/actions/runs/2345";
  const cases = [
    (routes) => routes.set(`${prefix}/approvals`, []),
    (routes) => (routes.get(`${prefix}/approvals`)[0].state = "pending"),
    (routes) =>
      (routes.get(`${prefix}/approvals`)[0].environments[0].name =
        "production"),
    (routes) =>
      (routes.get(`${prefix}/approvals`)[0].user.login = "release-dispatcher"),
    (routes) => (routes.get(`${prefix}/approvals`)[0].user.type = "Bot"),
    (routes) => (routes.get(prefix).head_sha = "b".repeat(40)),
    (routes) => (routes.get(prefix).path = ".github/workflows/other.yml"),
    (routes) => (routes.get(prefix).status = "completed"),
    (routes) => (routes.get(prefix).run_attempt = 2),
  ];
  for (const mutate of cases) {
    const { fixture, cloudflare, github } = harness();
    mutate(github.routes);
    await assert.rejects(
      authorizeRelease({
        ...fixture,
        cloudflareRead: cloudflare.read,
        githubRead: github.read,
        now,
      }),
      /deployment-run-not-verified|independent-deployment-review-unverified/,
    );
  }
});

test("reruns cannot reuse earlier deployment approvals", async () => {
  const { fixture, cloudflare, github } = harness();
  fixture.workflow.runAttempt = "2";
  await assert.rejects(
    authorizeRelease({
      ...fixture,
      cloudflareRead: cloudflare.read,
      githubRead: github.read,
      now,
    }),
    /deployment-review-attempt-unverifiable/,
  );
});

test("invalid release context cannot borrow a provider readback", async () => {
  for (const changes of [
    { ref: "refs/heads/feature" },
    { repository: "attacker/agent-table" },
    { eventName: "pull_request" },
    { sha: "b".repeat(40) },
    { environment: "production" },
    { runId: "0" },
  ]) {
    const { fixture, cloudflare, github } = harness();
    fixture.workflow = { ...fixture.workflow, ...changes };
    await assert.rejects(
      authorizeRelease({
        ...fixture,
        cloudflareRead: cloudflare.read,
        githubRead: github.read,
        now,
      }),
      /unprotected-release-context/,
    );
  }
});

test("a green unrelated or wrong-head CI run never authorizes deployment", async () => {
  const mutants = [
    ["/actions/runs/1234", (run) => (run.conclusion = "failure")],
    ["/actions/runs/1234", (run) => (run.head_sha = "b".repeat(40))],
    ["/actions/runs/1234", (run) => (run.event = "pull_request")],
    ["/actions/runs/1234", (run) => (run.path = ".github/workflows/other.yml")],
    [
      "/jobs?per_page=100",
      (jobs) => (jobs.jobs[0].steps[1].conclusion = "skipped"),
    ],
  ];
  for (const [suffix, mutate] of mutants) {
    const { fixture, cloudflare, github } = harness();
    const path = [...github.routes.keys()].find((x) => x.endsWith(suffix));
    mutate(github.routes.get(path));
    await assert.rejects(
      authorizeRelease({
        ...fixture,
        cloudflareRead: cloudflare.read,
        githubRead: github.read,
        now,
      }),
      /ci-source-not-verified|ci-required-step-missing/,
    );
  }
});

test("main moving after the CI evidence run invalidates release authorization", async () => {
  const { fixture, cloudflare, github } = harness();
  github.routes.get(
    "/repos/kitamura-tetsuo/agent-table/git/ref/heads/main",
  ).object.sha = "b".repeat(40);
  await assert.rejects(
    authorizeRelease({
      ...fixture,
      cloudflareRead: cloudflare.read,
      githubRead: github.read,
      now,
    }),
    /main-head-changed/,
  );
});

test("operator disclosures must be current, exact-target and independently reviewed", async () => {
  for (const mutation of [
    (value) => (value.review.decision = "pending"),
    (value) => (value.review.reviewedAt = "2000-01-01T00:00:00Z"),
    (value) => (value.retention.backup.status = "unknown"),
    (value) => (value.retention.logs.source = "http://unverified.invalid"),
    (value) => (value.restore.type = "snapshot-restore"),
    (value) => (value.schema.nonDestructiveRollback = false),
    (value) => (value.cost.usageObserved = false),
    (value) => (value.configSha256 = "f".repeat(64)),
  ]) {
    const { fixture, cloudflare, github } = harness();
    mutation(fixture.operations);
    await assert.rejects(
      authorizeRelease({
        ...fixture,
        cloudflareRead: cloudflare.read,
        githubRead: github.read,
        now,
      }),
      (error) => error instanceof ReleaseAuthorizationError,
    );
  }
  assert.doesNotThrow(() =>
    verifyOperationalDecision(valid.operations, {
      environment: "staging",
      profile: "manual",
      buildSha,
      configSha256: valid.evidence.configSha256,
      origin: "https://staging.service.test",
      now,
    }),
  );
});

test("quarantine or notifications cannot be enabled by unchecked flags", async () => {
  for (const [key, value] of [
    ["RESTORE_QUARANTINE", "true"],
    ["ENABLE_MCP_SUBSCRIPTIONS", "true"],
    ["ENABLE_OPENAI_EVENTS", "true"],
    ["ALLOW_OUTBOUND_NOTIFICATIONS", "true"],
  ]) {
    const { fixture, cloudflare, github } = harness();
    const config = JSON.parse(fixture.configText);
    config.vars[key] = value;
    fixture.configText = JSON.stringify(config);
    fixture.evidence.configSha256 = fixture.operations.configSha256 = (
      await import("node:crypto")
    )
      .createHash("sha256")
      .update(fixture.configText)
      .digest("hex");
    await assert.rejects(
      authorizeRelease({
        ...fixture,
        cloudflareRead: cloudflare.read,
        githubRead: github.read,
        now,
      }),
      /unsupported-capability-or-quarantine-clearance|live-switch-without-live-evidence|events-switch-without-events-evidence/,
      key,
    );
  }
});

test("a previously quarantined live Worker cannot be cleared by operator checkbox", async () => {
  const { fixture, cloudflare, github } = harness();
  const path = [...cloudflare.routes.keys()].find((x) =>
    x.endsWith("/agent-table-staging/settings"),
  );
  const settings = cloudflare.routes.get(path);
  settings.bindings.find((x) => x.name === "RESTORE_QUARANTINE").text = "true";
  await assert.rejects(
    authorizeRelease({
      ...fixture,
      cloudflareRead: cloudflare.read,
      githubRead: github.read,
      now,
    }),
    /restore-reconciliation-required/,
  );
});

test("optional profiles remain blocked even with made-up passed reference URLs", async () => {
  const { fixture, cloudflare, github } = harness();
  const config = JSON.parse(fixture.configText);
  config.vars.RELEASE_PROFILE = "autonomous";
  fixture.configText = JSON.stringify(config);
  fixture.profile = "autonomous";
  fixture.evidence.configSha256 = fixture.operations.configSha256 = (
    await import("node:crypto")
  )
    .createHash("sha256")
    .update(fixture.configText)
    .digest("hex");
  for (const name of [
    "egress",
    "provider",
    "delivery",
    "real_host",
    "autonomous_runtime",
  ]) {
    fixture.evidence.checks[name] = {
      status: "passed",
      refs: [
        "https://github.com/kitamura-tetsuo/agent-table/actions/runs/1234",
      ],
    };
  }
  fixture.operations.profile = "autonomous";
  await assert.rejects(
    authorizeRelease({
      ...fixture,
      cloudflareRead: cloudflare.read,
      githubRead: github.read,
      now,
    }),
    /profile-real-host-evidence-not-verified/,
  );
});

test("GitHub API reader refuses unrelated endpoints, failure bodies and oversized receipts", async () => {
  const seen = [];
  const reader = githubReader("synthetic-github-token", async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ ok: true }));
  });
  assert.deepEqual(
    await reader(`/repos/kitamura-tetsuo/agent-table/actions/runs/${runId}`),
    { ok: true },
  );
  assert.equal(seen[0].opts.method, "GET");
  await assert.rejects(
    reader("/repos/other/repo/actions/runs/1"),
    /github-evidence-path-invalid/,
  );
  const rejected = githubReader(
    "synthetic-github-token",
    async () => new Response("DO_NOT_LOG_TOKEN", { status: 403 }),
  );
  await assert.rejects(
    rejected(`/repos/kitamura-tetsuo/agent-table/actions/runs/${runId}`),
    (error) => {
      assert.equal(error.message, "github-evidence-read-refused");
      return true;
    },
  );
  const oversized = githubReader(
    "synthetic-github-token",
    async () => new Response("x".repeat(300 * 1024)),
  );
  await assert.rejects(
    oversized(`/repos/kitamura-tetsuo/agent-table/actions/runs/${runId}`),
    /github-evidence-oversized/,
  );
});
