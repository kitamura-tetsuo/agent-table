import assert from "node:assert/strict";
import test from "node:test";
import { waitForValidation } from "./wait-for-validation.mjs";

const REPOSITORY = "kitamura-tetsuo/agent-table";
const HEAD = "a".repeat(40);
const RUN_ID = 1234;
const PATH = `/repos/${REPOSITORY}/actions/runs/${RUN_ID}`;

function run(overrides = {}) {
  return {
    id: RUN_ID,
    repository: { full_name: REPOSITORY, fork: false },
    head_repository: { full_name: REPOSITORY, fork: false },
    path: ".github/workflows/ci.yml",
    head_sha: HEAD,
    head_branch: "automation/runtime-updates",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function fixture(results = [run()]) {
  let time = 0;
  const requests = [];
  const sleeps = [];
  const options = {
    runId: RUN_ID,
    expectedHead: HEAD,
    target: "update",
    now: () => time,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
    api: async (path) => {
      requests.push(path);
      const result = results[Math.min(requests.length - 1, results.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return {
    options,
    requests,
    sleeps,
    advance: (milliseconds) => {
      time += milliseconds;
    },
  };
}

test("returns the exact successful runtime or Dependabot run", async () => {
  for (const candidate of [
    run(),
    run({
      event: "pull_request",
      head_branch: "dependabot/multi-ecosystem-dependencies-abc",
    }),
  ]) {
    const f = fixture([candidate]);
    assert.equal(await waitForValidation(f.options), candidate);
    assert.deepEqual(f.requests, [PATH]);
    assert.deepEqual(f.sleeps, []);
  }
});

test("polls only the requested run until every supported active state completes", async () => {
  const final = run();
  const f = fixture([
    ...["queued", "in_progress", "waiting", "pending"].map((status) =>
      run({ status, conclusion: null }),
    ),
    final,
  ]);
  assert.equal(await waitForValidation(f.options), final);
  assert.deepEqual(f.requests, Array(5).fill(PATH));
  assert.deepEqual(f.sleeps, Array(4).fill(15_000));
});

test("requested runs can advance through queued and running to success", async () => {
  const final = run();
  const f = fixture([
    ...["requested", "queued", "in_progress"].map((status) =>
      run({ status, conclusion: null }),
    ),
    final,
  ]);
  assert.equal(await waitForValidation(f.options), final);
  assert.deepEqual(f.requests, Array(4).fill(PATH));
  assert.deepEqual(f.sleeps, Array(3).fill(15_000));
});

test("main target accepts only push or dispatch Validation runs on main", async () => {
  for (const event of ["push", "workflow_dispatch"]) {
    const candidate = run({ event, head_branch: "main" });
    const f = fixture([candidate]);
    assert.equal(
      await waitForValidation({ ...f.options, target: "main" }),
      candidate,
    );
  }
  for (const candidate of [
    run({ event: "pull_request", head_branch: "main" }),
    run(),
    run({
      event: "pull_request",
      head_branch: "dependabot/npm_and_yarn/group",
    }),
  ]) {
    const f = fixture([candidate]);
    await assert.rejects(
      waitForValidation({ ...f.options, target: "main" }),
      /source-mismatch/,
    );
    assert.equal(f.requests.length, 1);
  }
});

test("identity is revalidated on each poll, including repository, fork, SHA, run, and workflow", async () => {
  const mutations = [
    { id: RUN_ID + 1 },
    { id: String(RUN_ID) },
    { repository: { full_name: "other/agent-table" } },
    { head_repository: { full_name: "fork/agent-table" } },
    { repository: { full_name: REPOSITORY, fork: true } },
    { head_repository: { full_name: REPOSITORY, fork: true } },
    { head_repository: null },
    { path: ".github/workflows/other.yml" },
    { head_sha: "b".repeat(40) },
  ];
  for (const mutation of mutations) {
    const f = fixture([
      run({ status: "queued", conclusion: null }),
      run(mutation),
    ]);
    await assert.rejects(waitForValidation(f.options), /identity-mismatch/);
    assert.deepEqual(f.requests, [PATH, PATH]);
    assert.deepEqual(f.sleeps, [15_000]);
  }
});

test("update target rejects unrelated branch and event combinations", async () => {
  for (const mutation of [
    { head_branch: "main" },
    { head_branch: "automation/unrelated" },
    { event: "push" },
    { event: "pull_request" },
    { event: "pull_request", head_branch: "dependabot/" },
    { event: "pull_request", head_branch: "dependabot/fake branch" },
    {
      event: "pull_request_target",
      head_branch: "dependabot/npm_and_yarn/group",
    },
    {
      event: "workflow_dispatch",
      head_branch: "dependabot/npm_and_yarn/group",
    },
  ]) {
    const f = fixture([run(mutation)]);
    await assert.rejects(waitForValidation(f.options), /source-mismatch/);
    assert.deepEqual(f.sleeps, []);
  }
});

test("failed or non-successful completed runs never authorize continuation", async () => {
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "neutral",
    "skipped",
    "stale",
    null,
  ]) {
    const f = fixture([run({ conclusion })]);
    await assert.rejects(waitForValidation(f.options), /not-successful/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.sleeps, []);
  }
  for (const candidate of [
    run({ status: "unknown", conclusion: null }),
    run({ status: "in_progress", conclusion: "success" }),
  ]) {
    const f = fixture([candidate]);
    await assert.rejects(
      waitForValidation(f.options),
      /invalid-validation-run-state/,
    );
  }
});

test("timeout bounds the final sleep and prevents another request after the deadline", async () => {
  const f = fixture([run({ status: "in_progress", conclusion: null })]);
  await assert.rejects(
    waitForValidation({ ...f.options, timeoutMs: 35_000 }),
    /wait-timeout/,
  );
  assert.deepEqual(f.requests, [PATH, PATH, PATH]);
  assert.deepEqual(f.sleeps, [15_000, 15_000, 5_000]);
});

test("a response arriving after the deadline cannot authorize continuation", async () => {
  const f = fixture();
  const api = f.options.api;
  f.options.api = async (path) => {
    f.advance(1_000);
    return api(path);
  };
  await assert.rejects(
    waitForValidation({ ...f.options, timeoutMs: 1_000 }),
    /wait-timeout/,
  );
  assert.deepEqual(f.requests, [PATH]);
  assert.deepEqual(f.sleeps, []);
});

test("invalid inputs are rejected before requesting GitHub", async () => {
  const invalidOptions = [
    ...[
      0,
      -1,
      1.1,
      "1234",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ].map((runId) => ({ runId })),
    ...["", "a".repeat(39), "A".repeat(40), null, 1234].map((expectedHead) => ({
      expectedHead,
    })),
    { target: "production" },
    { target: undefined },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { timeoutMs: 25 * 60 * 1000 + 1 },
    { pollIntervalMs: 0 },
    { pollIntervalMs: -1 },
    { pollIntervalMs: Number.NaN },
    { now: () => Number.NaN },
    { sleep: null },
    { now: null },
    { api: null },
  ];
  for (const override of invalidOptions) {
    const f = fixture();
    await assert.rejects(
      waitForValidation({ ...f.options, ...override }),
      /invalid-validation/,
    );
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.sleeps, []);
  }
});

test("API errors and a clock moving backwards fail closed without further requests", async () => {
  const unavailable = fixture([new Error("synthetic-github-unavailable")]);
  await assert.rejects(
    waitForValidation(unavailable.options),
    /synthetic-github-unavailable/,
  );
  assert.deepEqual(unavailable.requests, [PATH]);
  assert.deepEqual(unavailable.sleeps, []);
  const backwards = fixture([run({ status: "queued", conclusion: null })]);
  backwards.options.sleep = async () => backwards.advance(-1);
  await assert.rejects(
    waitForValidation(backwards.options),
    /invalid-validation-clock/,
  );
  assert.deepEqual(backwards.requests, [PATH]);
});
