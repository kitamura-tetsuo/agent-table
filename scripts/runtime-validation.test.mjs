import assert from "node:assert/strict";
import test from "node:test";
import {
  coordinateRuntimeValidation,
  runtimeApprovalClient,
  runtimeValidationInput,
  runtimeValidationSummary,
} from "./runtime-validation.mjs";

const REPOSITORY = "kitamura-tetsuo/agent-table";
const PREFIX = `/repos/${REPOSITORY}`;
const MAIN = "1".repeat(40);
const HEAD = "2".repeat(40);
const OTHER = "3".repeat(40);
const NUMBER = 97;
const RUN = 12345;
const BRANCH = "automation/runtime-updates";
const FILES = [
  ".node-version",
  "package.json",
  "package-lock.json",
  "deploy/relay/node-image.txt",
];

function contents(node, npm, digest) {
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    engines: { node },
    packageManager: `npm@${npm}`,
    dependencies: { example: "1.0.0" },
    devDependencies: { checker: "2.0.0" },
    scripts: { test: "node --test" },
  };
  return {
    ".node-version": `${node}\n`,
    "package.json": JSON.stringify(manifest),
    "package-lock.json": JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages: {
        "": {
          name: manifest.name,
          version: manifest.version,
          engines: manifest.engines,
          dependencies: manifest.dependencies,
          devDependencies: manifest.devDependencies,
        },
      },
    }),
    "deploy/relay/node-image.txt": `docker.io/library/node:${node}-bookworm-slim@sha256:${digest.repeat(64)}\n`,
  };
}

function fixture() {
  const state = {
    main: MAIN,
    head: HEAD,
    time: 0,
    prReads: 0,
    runReads: 0,
    listReads: 0,
    emptyLists: 0,
    listOverride: null,
    runOverride: null,
    onPrRead: () => {},
    onRunRead: () => {},
    pr: {
      number: NUMBER,
      user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
      state: "open",
      draft: false,
      merged: false,
      labels: [],
      changed_files: 4,
      base: {
        ref: "main",
        sha: MAIN,
        repo: { full_name: REPOSITORY, fork: false },
      },
      head: {
        ref: BRANCH,
        sha: HEAD,
        repo: { full_name: REPOSITORY, fork: false },
      },
    },
    comparison: {
      status: "ahead",
      behind_by: 0,
      ahead_by: 1,
      merge_base_commit: { sha: MAIN },
    },
    files: FILES.map((filename) => ({ filename, status: "modified" })),
    before: contents("24.22.1", "11.9.0", "a"),
    after: contents("24.22.3", "11.21.3", "b"),
    run: {
      id: RUN,
      repository: { full_name: REPOSITORY, fork: false },
      head_repository: { full_name: REPOSITORY, fork: false },
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      head_branch: BRANCH,
      head_sha: HEAD,
      status: "completed",
      conclusion: "action_required",
      pull_requests: [
        { number: NUMBER, base: { sha: MAIN }, head: { sha: HEAD } },
      ],
    },
  };
  const calls = [],
    writes = [],
    approvals = [],
    sleeps = [];
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (options.method && options.method !== "GET") {
      writes.push({ path, ...options });
      assert.equal(
        path,
        `${PREFIX}/actions/workflows/dependency-automerge.yml/dispatches`,
      );
      return null;
    }
    if (path === `${PREFIX}/pulls/${NUMBER}`) {
      state.prReads++;
      state.onPrRead(state.prReads);
      return structuredClone(state.pr);
    }
    if (path === `${PREFIX}/git/ref/heads/main`)
      return { object: { sha: state.main } };
    if (path === `${PREFIX}/git/ref/heads/${BRANCH}`)
      return { object: { sha: state.head } };
    if (path === `${PREFIX}/compare/${MAIN}...${HEAD}`)
      return structuredClone(state.comparison);
    if (path === `${PREFIX}/pulls/${NUMBER}/files?per_page=100`)
      return structuredClone(state.files);
    if (path.startsWith(`${PREFIX}/contents/`)) {
      const [name, ref] = path
        .slice(`${PREFIX}/contents/`.length)
        .split("?ref=");
      const text = (ref === MAIN ? state.before : state.after)[name];
      assert.ok(text, `Unexpected file request: ${name}`);
      return {
        type: "file",
        encoding: "base64",
        size: Buffer.byteLength(text),
        content: Buffer.from(text).toString("base64"),
      };
    }
    if (
      path ===
      `${PREFIX}/actions/workflows/ci.yml/runs?branch=automation%2Fruntime-updates&event=pull_request&head_sha=${HEAD}&per_page=100`
    ) {
      state.listReads++;
      if (state.listOverride) return structuredClone(state.listOverride);
      if (state.listReads <= state.emptyLists)
        return { total_count: 0, workflow_runs: [] };
      return { total_count: 1, workflow_runs: [structuredClone(state.run)] };
    }
    if (path === `${PREFIX}/actions/runs/${RUN}`) {
      state.runReads++;
      state.onRunRead(state.runReads);
      return structuredClone(state.runOverride || state.run);
    }
    throw new Error(`Unexpected read: ${path}`);
  };
  const approveApi = async (path, options) => {
    approvals.push({ path, ...options });
    state.run.status = "queued";
    state.run.conclusion = null;
    return null;
  };
  const options = {
    api,
    prNumber: NUMBER,
    expectedHead: HEAD,
    now: () => state.time,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      state.time += milliseconds;
    },
  };
  return { state, calls, writes, approvals, sleeps, options, approveApi };
}

function expectedDispatch() {
  return {
    path: `${PREFIX}/actions/workflows/dependency-automerge.yml/dispatches`,
    method: "POST",
    body: {
      ref: "main",
      inputs: { validation_run_id: String(RUN), expected_sha: HEAD },
    },
  };
}

test("approval-required PR validation returns an actionable result without any write", async () => {
  for (const waiting of [false, true]) {
    const f = fixture();
    if (waiting) {
      f.state.run.status = "waiting";
      f.state.run.conclusion = null;
    }
    const result = await coordinateRuntimeValidation(f.options);
    assert.equal(result.status, "approval-required");
    assert.equal(result.runId, RUN);
    assert.equal(
      result.url,
      `https://github.com/${REPOSITORY}/actions/runs/${RUN}`,
    );
    assert.match(runtimeValidationSummary(result), /Approve workflows/);
    assert.ok(
      runtimeValidationSummary(result).includes(
        `https://github.com/${REPOSITORY}/pull/${NUMBER}`,
      ),
    );
    assert.match(
      runtimeValidationSummary(result),
      /rerun \*\*Runtime updates\*\*/,
    );
    assert.match(runtimeValidationSummary(result), /RUNTIME_WORKFLOW_TOKEN/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.approvals, []);
    assert.deepEqual(f.sleeps, []);
  }
});

test("external approval is restricted to the verified PR run and precedes trusted merge continuation", async () => {
  const f = fixture();
  const result = await coordinateRuntimeValidation({
    ...f.options,
    approveApi: f.approveApi,
  });
  assert.equal(result.status, "continuation-dispatched");
  assert.equal(result.approvalGranted, true);
  assert.deepEqual(f.approvals, [
    { path: `${PREFIX}/actions/runs/${RUN}/approve`, method: "POST" },
  ]);
  assert.deepEqual(f.writes, [expectedDispatch()]);
  assert.equal(f.state.prReads, 3);
  assert.deepEqual(f.sleeps, [5_000]);
});

test("active or successful real PR validation is reused without approval", async () => {
  for (const status of [
    "requested",
    "queued",
    "in_progress",
    "pending",
    "completed",
  ]) {
    const f = fixture();
    f.state.run.status = status;
    f.state.run.conclusion = status === "completed" ? "success" : null;
    const result = await coordinateRuntimeValidation({
      ...f.options,
      approveApi: f.approveApi,
    });
    assert.equal(result.approvalGranted, false);
    assert.deepEqual(f.approvals, []);
    assert.deepEqual(f.writes, [expectedDispatch()]);
  }
});

test("spoofed bots, forks, stale refs, and non-open candidates never authorize approval", async () => {
  const mutations = [
    (s) => {
      s.pr.user.id = 1;
    },
    (s) => {
      s.pr.user.login = "other[bot]";
    },
    (s) => {
      s.pr.user.type = "User";
    },
    (s) => {
      s.pr.head.repo.full_name = "other/agent-table";
    },
    (s) => {
      s.pr.head.repo.fork = true;
    },
    (s) => {
      s.pr.base.repo.fork = true;
    },
    (s) => {
      s.pr.base.ref = "release";
    },
    (s) => {
      s.pr.head.ref = "automation/other";
    },
    (s) => {
      s.pr.head.sha = OTHER;
    },
    (s) => {
      s.head = OTHER;
    },
    (s) => {
      s.main = OTHER;
    },
    (s) => {
      s.pr.state = "closed";
    },
    (s) => {
      s.pr.merged = true;
    },
    (s) => {
      s.pr.draft = true;
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f.state);
    await assert.rejects(
      coordinateRuntimeValidation({ ...f.options, approveApi: f.approveApi }),
      /runtime-pull-request-not-current/,
    );
    assert.deepEqual(f.approvals, []);
    assert.deepEqual(f.writes, []);
  }
});

test("an opt-out label suppresses approval and continuation even if added after initial validation", async () => {
  for (const late of [false, true]) {
    const f = fixture();
    if (late)
      f.state.onPrRead = (count) => {
        if (count === 2) f.state.pr.labels = [{ name: "manual-review" }];
      };
    else f.state.pr.labels = [{ name: "no-automerge" }];
    const result = await coordinateRuntimeValidation({
      ...f.options,
      approveApi: f.approveApi,
    });
    assert.equal(result.status, "skipped");
    assert.deepEqual(f.approvals, []);
    assert.deepEqual(f.writes, []);
  }
});

test("only modified runtime pins with a current-main ancestor can be approved", async () => {
  const mutations = [
    (s) => {
      s.comparison.behind_by = 1;
    },
    (s) => {
      s.comparison.merge_base_commit.sha = OTHER;
    },
    (s) => {
      s.pr.changed_files = 5;
    },
    (s) => {
      s.files[0].status = "added";
    },
    (s) => {
      s.files[0].previous_filename = "other";
    },
    (s) => {
      s.files[0].filename = ".github/workflows/ci.yml";
    },
    (s) => {
      s.files[0].filename = s.files[1].filename;
    },
    (s) => {
      s.after["package.json"] = s.after["package.json"].replace(
        "node --test",
        "node unsafe.mjs",
      );
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f.state);
    await assert.rejects(
      coordinateRuntimeValidation({ ...f.options, approveApi: f.approveApi }),
    );
    assert.deepEqual(f.approvals, []);
    assert.deepEqual(f.writes, []);
  }
});

test("run identity and optional PR association are independently verified", async () => {
  const mutations = [
    { event: "workflow_dispatch" },
    { id: 0 },
    { path: ".github/workflows/other.yml" },
    { head_sha: OTHER },
    { head_branch: "main" },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: REPOSITORY, fork: true } },
    {
      pull_requests: [
        { number: NUMBER + 1, base: { sha: MAIN }, head: { sha: HEAD } },
      ],
    },
    {
      pull_requests: [
        { number: NUMBER, base: { sha: OTHER }, head: { sha: HEAD } },
      ],
    },
  ];
  for (const mutation of mutations) {
    const f = fixture();
    Object.assign(f.state.run, mutation);
    await assert.rejects(
      coordinateRuntimeValidation({ ...f.options, approveApi: f.approveApi }),
    );
    assert.deepEqual(f.approvals, []);
    assert.deepEqual(f.writes, []);
  }
  const f = fixture();
  f.state.run.pull_requests = [];
  assert.equal(
    (await coordinateRuntimeValidation(f.options)).status,
    "approval-required",
  );
  f.state.runOverride = { ...f.state.run, id: RUN + 1 };
  await assert.rejects(coordinateRuntimeValidation(f.options), /run-mismatch/);
});

test("refs are re-read immediately before approval and before continuation", async () => {
  for (const stage of [2, 3]) {
    const f = fixture();
    f.state.onPrRead = (count) => {
      if (count === stage) f.state.head = OTHER;
    };
    await assert.rejects(
      coordinateRuntimeValidation({ ...f.options, approveApi: f.approveApi }),
      /not-current/,
    );
    assert.equal(f.approvals.length, stage === 2 ? 0 : 1);
    assert.deepEqual(f.writes, []);
  }
});

test("failed CI and approval API failure do not dispatch a continuation", async () => {
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "skipped",
    "neutral",
  ]) {
    const f = fixture();
    f.state.run.conclusion = conclusion;
    await assert.rejects(
      coordinateRuntimeValidation({ ...f.options, approveApi: f.approveApi }),
      /not-successful-or-active/,
    );
    assert.deepEqual(f.approvals, []);
    assert.deepEqual(f.writes, []);
  }
  const f = fixture();
  await assert.rejects(
    coordinateRuntimeValidation({
      ...f.options,
      approveApi: async () => {
        throw new Error("approval-denied");
      },
    }),
    /approval-denied/,
  );
  assert.deepEqual(f.writes, []);
});

test("run discovery tolerates propagation, refuses truncation, and stops at its deadline", async () => {
  const delayed = fixture();
  delayed.state.emptyLists = 2;
  assert.equal(
    (await coordinateRuntimeValidation(delayed.options)).status,
    "approval-required",
  );
  assert.deepEqual(delayed.sleeps, [5_000, 5_000]);
  const truncated = fixture();
  truncated.state.listOverride = {
    total_count: 100,
    workflow_runs: [truncated.state.run],
  };
  await assert.rejects(
    coordinateRuntimeValidation(truncated.options),
    /list-truncated/,
  );
  assert.deepEqual(truncated.writes, []);
  const missing = fixture();
  missing.state.emptyLists = 100;
  await assert.rejects(
    coordinateRuntimeValidation({ ...missing.options, timeoutMs: 12_000 }),
    /discovery-timeout/,
  );
  assert.deepEqual(missing.sleeps, [5_000, 5_000, 2_000]);
  assert.deepEqual(missing.writes, []);
});

test("approval is never duplicated while GitHub still reports action_required", async () => {
  const f = fixture();
  let approvals = 0;
  await assert.rejects(
    coordinateRuntimeValidation({
      ...f.options,
      timeoutMs: 10_000,
      approveApi: async () => {
        approvals++;
      },
    }),
    /discovery-timeout/,
  );
  assert.equal(approvals, 1);
  assert.deepEqual(f.writes, []);
});

test("invalid coordinator and CLI inputs are rejected before reads or writes", async () => {
  for (const invalid of [
    { prNumber: "97" },
    { prNumber: 0 },
    { expectedHead: OTHER.toUpperCase().replace("3", "Z") },
    { timeoutMs: 120_001 },
    { approveApi: null },
  ]) {
    const f = fixture();
    await assert.rejects(
      coordinateRuntimeValidation({ ...f.options, ...invalid }),
      /invalid-runtime/,
    );
    assert.deepEqual(f.calls, []);
  }
  const env = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: "refs/heads/main",
    RUNTIME_PR_NUMBER: "97",
    RUNTIME_PR_HEAD_SHA: HEAD,
  };
  assert.deepEqual(runtimeValidationInput(env), {
    prNumber: NUMBER,
    expectedHead: HEAD,
  });
  for (const invalid of [
    { GITHUB_REPOSITORY: "other/repo" },
    { GITHUB_REF: "refs/heads/automation/runtime-updates" },
    { RUNTIME_PR_NUMBER: "97;exit" },
    { RUNTIME_PR_HEAD_SHA: "bad" },
  ])
    assert.throws(() => runtimeValidationInput({ ...env, ...invalid }));
});

test("external credential client sends only the permitted approval POST and accepts empty 201", async () => {
  const calls = [];
  const client = runtimeApprovalClient(
    "synthetic-external-token",
    async (url, options) => {
      calls.push({ url, ...options });
      return new Response(null, { status: 201 });
    },
  );
  assert.equal(
    await client(`${PREFIX}/actions/runs/${RUN}/approve`, { method: "POST" }),
    null,
  );
  assert.equal(
    calls[0].url,
    `https://api.github.com${PREFIX}/actions/runs/${RUN}/approve`,
  );
  assert.equal(
    calls[0].headers.Authorization,
    "Bearer synthetic-external-token",
  );
  assert.equal(calls[0].redirect, "error");
  for (const [path, options] of [
    [`${PREFIX}/actions/runs/${RUN}`, { method: "GET" }],
    [`${PREFIX}/actions/runs/${RUN}/approve`, { method: "GET" }],
    [`${PREFIX}/actions/runs/${RUN}/approve`, { method: "POST", body: {} }],
    ["/repos/other/repo/actions/runs/123/approve", { method: "POST" }],
    [`${PREFIX}/actions/runs/0/approve`, { method: "POST" }],
  ])
    await assert.rejects(client(path, options), /endpoint-not-allowed/);
  assert.equal(calls.length, 1);
  const denied = runtimeApprovalClient(
    "synthetic-external-token",
    async () => new Response(null, { status: 403 }),
  );
  await assert.rejects(
    denied(`${PREFIX}/actions/runs/${RUN}/approve`, { method: "POST" }),
    /runtime-approval-http-403/,
  );
});
