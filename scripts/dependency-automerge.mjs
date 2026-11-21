import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const REPOSITORY = "kitamura-tetsuo/agent-table";
const PREFIX = `/repos/${REPOSITORY}`;
const WORKFLOW = ".github/workflows/ci.yml";
const RUNTIME_BRANCH = "automation/runtime-updates";
const SHA = /^[a-f0-9]{40}$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const RUNTIME_FILES = new Set([
  ".node-version",
  "package.json",
  "package-lock.json",
  "deploy/relay/node-image.txt",
]);
const REQUIRED_STEPS = [
  "Typecheck",
  "Lint",
  "Application unit tests",
  "Worker integration tests",
  "Restore runtime tests",
  "Browser E2E tests",
  "Wrangler dry-run",
  "Isolated Docker relay restart",
];

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(text) {
  const value = JSON.parse(text);
  requireCondition(object(value), "invalid-json-object");
  return value;
}

function omit(value, keys) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}

function versionParts(value) {
  const parts = typeof value === "string" && VERSION.exec(value);
  requireCondition(parts, "invalid-version");
  return parts.slice(1, 4).map(Number);
}

function forwardVersion(before, after, sameMajor = false) {
  const previous = versionParts(before);
  const next = versionParts(after);
  requireCondition(
    !sameMajor || (previous[0] === next[0] && !after.includes("-")),
    "runtime-major-or-prerelease-update",
  );
  requireCondition(
    before.includes("-") || !after.includes("-"),
    "stable-to-prerelease-update",
  );
  for (let index = 0; index < 3; index++) {
    if (next[index] > previous[index]) return;
    requireCondition(next[index] === previous[index], "version-downgrade");
  }
  if (before === after || !after.includes("-")) return;
  const previousPre = VERSION.exec(before)[4].split(".");
  const nextPre = VERSION.exec(after)[4].split(".");
  for (
    let index = 0;
    index < Math.max(previousPre.length, nextPre.length);
    index++
  ) {
    if (previousPre[index] === nextPre[index]) continue;
    if (previousPre[index] === undefined) return;
    requireCondition(nextPre[index] !== undefined, "version-downgrade");
    const previousNumber = /^\d+$/.test(previousPre[index]);
    const nextNumber = /^\d+$/.test(nextPre[index]);
    const increasing =
      previousNumber && nextNumber
        ? Number(nextPre[index]) > Number(previousPre[index])
        : previousNumber !== nextNumber
          ? previousNumber
          : nextPre[index] > previousPre[index];
    requireCondition(increasing, "version-downgrade");
    return;
  }
}

function dependencyMap(before = {}, after = {}) {
  requireCondition(object(before) && object(after), "invalid-dependency-map");
  requireCondition(
    isDeepStrictEqual(Object.keys(before).sort(), Object.keys(after).sort()),
    "dependency-names-changed",
  );
  for (const name of Object.keys(before))
    forwardVersion(before[name], after[name]);
}

function dependencyManifest(before, after) {
  requireCondition(
    isDeepStrictEqual(
      omit(before, ["dependencies", "devDependencies"]),
      omit(after, ["dependencies", "devDependencies"]),
    ),
    "package-metadata-changed",
  );
  dependencyMap(before.dependencies, after.dependencies);
  dependencyMap(before.devDependencies, after.devDependencies);
}

function validateLock(manifest, lock) {
  requireCondition(
    lock.lockfileVersion === 3 &&
      object(lock.packages) &&
      object(lock.packages[""]) &&
      lock.name === manifest.name &&
      lock.version === manifest.version,
    "invalid-lockfile",
  );
  const root = lock.packages[""];
  for (const key of [
    "name",
    "version",
    "dependencies",
    "devDependencies",
    "engines",
  ])
    requireCondition(
      isDeepStrictEqual(root[key], manifest[key]),
      "lockfile-manifest-mismatch",
    );
}

function requirements(text) {
  const result = Object.create(null);
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([a-zA-Z0-9_.-]+)==(\d+\.\d+\.\d+)\s*$/.exec(line);
    requireCondition(
      match && !(match[1] in result),
      "invalid-python-requirement",
    );
    result[match[1]] = match[2];
  }
  return result;
}

export function normalizeActionVersions(text) {
  // Only action refs and their version annotations may change in privileged YAML.
  return text.replace(
    /^(\s*(?:-\s*)?uses:\s*)(["']?)([\w.-]+\/[\w./-]+)@([\w.+-]+)\2([ \t]*(?:#[^\r\n]*)?)$/gm,
    (line, prefix, quote, name, ref, suffix) => {
      if (!/^(?:[a-f0-9]{40}|v?\d[\w.+-]*)$/.test(ref)) return line;
      const comment = suffix.trim();
      const normalizedComment = /^#\s*v?\d[\w.+-]*$/.test(comment)
        ? " # <version>"
        : suffix;
      return `${prefix}${quote}${name}@<version>${quote}${normalizedComment}`;
    },
  );
}

function requireAllowedFiles(kind, filenames) {
  requireCondition(
    filenames.length > 0 &&
      filenames.length <= 40 &&
      new Set(filenames).size === filenames.length,
    "unexpected-file-count",
  );
  requireCondition(
    filenames.every((name) =>
      kind === "runtime"
        ? RUNTIME_FILES.has(name)
        : ["package.json", "package-lock.json", "requirements-ci.txt"].includes(
            name,
          ) || /^\.github\/workflows\/[^/.][^/]*\.ya?ml$/.test(name),
    ),
    "dependency-files-not-allowed",
  );
}

export function validateChanges(kind, filenames, before, after) {
  requireAllowedFiles(kind, filenames);
  requireCondition(
    filenames.length > 0 && filenames.length <= 40,
    "unexpected-file-count",
  );
  if (kind === "runtime") {
    requireCondition(
      filenames.every((name) => RUNTIME_FILES.has(name)),
      "runtime-files-not-allowed",
    );
    const previous = json(before["package.json"]);
    const next = json(after["package.json"]);
    const previousNode = before[".node-version"].trim();
    const nextNode = after[".node-version"].trim();
    forwardVersion(previousNode, nextNode, true);
    requireCondition(
      /^npm@\d+\.\d+\.\d+$/.test(previous.packageManager) &&
        /^npm@\d+\.\d+\.\d+$/.test(next.packageManager),
      "invalid-npm-runtime",
    );
    forwardVersion(
      previous.packageManager.slice(4),
      next.packageManager.slice(4),
      true,
    );
    requireCondition(
      previous.engines?.node === previousNode &&
        next.engines?.node === nextNode,
      "node-pin-mismatch",
    );
    const expected = structuredClone(previous);
    expected.engines.node = nextNode;
    expected.packageManager = next.packageManager;
    requireCondition(
      isDeepStrictEqual(expected, next),
      "runtime-package-fields-changed",
    );
    const previousLock = json(before["package-lock.json"]);
    const nextLock = json(after["package-lock.json"]);
    validateLock(previous, previousLock);
    validateLock(next, nextLock);
    previousLock.packages[""].engines.node = nextNode;
    requireCondition(
      isDeepStrictEqual(previousLock, nextLock),
      "runtime-lock-fields-changed",
    );
    for (const [files, node] of [
      [before, previousNode],
      [after, nextNode],
    ]) {
      const image = files["deploy/relay/node-image.txt"].trim();
      requireCondition(
        image.startsWith(
          `docker.io/library/node:${node}-bookworm-slim@sha256:`,
        ) && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image),
        "node-image-pin-mismatch",
      );
    }
    return;
  }
  requireCondition(kind === "dependabot", "unknown-update-kind");
  for (const filename of filenames) {
    requireCondition(
      ["package.json", "package-lock.json", "requirements-ci.txt"].includes(
        filename,
      ) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(filename),
      "dependency-files-not-allowed",
    );
    if (filename === "requirements-ci.txt")
      dependencyMap(
        requirements(before[filename]),
        requirements(after[filename]),
      );
    if (filename.startsWith(".github/workflows/"))
      requireCondition(
        normalizeActionVersions(before[filename]) ===
          normalizeActionVersions(after[filename]),
        "workflow-logic-changed",
      );
  }
  if (
    filenames.some(
      (name) => name === "package.json" || name === "package-lock.json",
    )
  ) {
    const previous = json(before["package.json"]);
    const next = json(after["package.json"]);
    dependencyManifest(previous, next);
    const previousLock = json(before["package-lock.json"]);
    const nextLock = json(after["package-lock.json"]);
    validateLock(previous, previousLock);
    validateLock(next, nextLock);
    requireCondition(
      isDeepStrictEqual(
        omit(previousLock, ["packages"]),
        omit(nextLock, ["packages"]),
      ) &&
        isDeepStrictEqual(
          omit(previousLock.packages[""], ["dependencies", "devDependencies"]),
          omit(nextLock.packages[""], ["dependencies", "devDependencies"]),
        ),
      "lockfile-root-metadata-changed",
    );
  }
}

export function githubClient(token, fetcher = fetch) {
  requireCondition(
    typeof token === "string" && token.length > 0,
    "github-token-missing",
  );
  return async (path, { method = "GET", body } = {}) => {
    requireCondition(
      path.startsWith(`${PREFIX}/`) || path === "/graphql",
      "api-path-not-allowed",
    );
    const response = await fetcher(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    requireCondition(response.ok, `github-http-${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

function candidateKind(pr) {
  if (pr.user?.type !== "Bot") return null;
  if (
    pr.user.login === "dependabot[bot]" &&
    pr.user.id === 49699333 &&
    pr.head.ref.startsWith("dependabot/")
  )
    return "dependabot";
  if (
    pr.user.login === "github-actions[bot]" &&
    pr.user.id === 41898282 &&
    pr.head.ref === RUNTIME_BRANCH
  )
    return "runtime";
  return null;
}

function requireCandidate(pr, head, main) {
  requireCondition(
    pr.state === "open" &&
      !pr.draft &&
      !pr.merged &&
      pr.base?.ref === "main" &&
      pr.base.repo?.full_name === REPOSITORY &&
      pr.head?.repo?.full_name === REPOSITORY &&
      pr.head.sha === head &&
      pr.base.sha === main &&
      pr.mergeable === true &&
      pr.mergeable_state === "clean",
    "pull-request-not-mergeable-at-tested-sha",
  );
}

async function readFiles(api, refs, names) {
  const result = [];
  for (const ref of refs) {
    const entries = await Promise.all(
      names.map(async (name) => {
        const path = name.split("/").map(encodeURIComponent).join("/");
        const data = await api(`${PREFIX}/contents/${path}?ref=${ref}`);
        requireCondition(
          data.type === "file" &&
            data.encoding === "base64" &&
            data.size <= 1_000_000,
          "file-not-readable",
        );
        return [name, Buffer.from(data.content, "base64").toString("utf8")];
      }),
    );
    result.push(Object.fromEntries(entries));
  }
  return result;
}

async function requireReviews(api, number) {
  const [reviews, threads] = await Promise.all([
    api(`${PREFIX}/pulls/${number}/reviews?per_page=100`),
    api("/graphql", {
      method: "POST",
      body: {
        query:
          'query($number:Int!){repository(owner:"kitamura-tetsuo",name:"agent-table"){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved}}}}}',
        variables: { number },
      },
    }),
  ]);
  requireCondition(
    Array.isArray(reviews) && reviews.length < 100,
    "review-list-truncated",
  );
  const latest = new Map();
  for (const review of reviews) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
      latest.set(review.user?.id, review.state);
  }
  requireCondition(
    ![...latest.values()].includes("CHANGES_REQUESTED"),
    "changes-requested",
  );
  const data = threads?.data?.repository?.pullRequest?.reviewThreads;
  requireCondition(
    !threads.errors &&
      data &&
      !data.pageInfo.hasNextPage &&
      data.nodes.every((thread) => thread.isResolved),
    "unresolved-review-threads",
  );
}

async function requireChecks(api, run, pr, kind) {
  const head = pr.head.sha;
  const [jobs, runs, checks, status] = await Promise.all([
    api(`${PREFIX}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`),
    api(
      `${PREFIX}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(pr.head.ref)}&head_sha=${head}&per_page=100`,
    ),
    api(`${PREFIX}/commits/${head}/check-runs?filter=latest&per_page=100`),
    api(`${PREFIX}/commits/${head}/status?per_page=100`),
  ]);
  requireCondition(
    jobs.total_count === 1 &&
      jobs.jobs?.length === 1 &&
      jobs.jobs[0].name === "verify" &&
      jobs.jobs[0].conclusion === "success" &&
      REQUIRED_STEPS.every((name) =>
        jobs.jobs[0].steps?.some(
          (step) => step.name === name && step.conclusion === "success",
        ),
      ),
    "validation-jobs-incomplete",
  );
  const candidates = runs.workflow_runs?.filter(
    (candidate) =>
      candidate.head_sha === head &&
      candidate.path === WORKFLOW &&
      candidate.head_branch === pr.head.ref &&
      ["pull_request", "workflow_dispatch"].includes(candidate.event),
  );
  const relevant = candidates?.filter(
    (candidate) =>
      kind !== "runtime" || candidate.event === "workflow_dispatch",
  );
  requireCondition(relevant?.length > 0, "validation-run-not-found");
  relevant.sort((a, b) => b.id - a.id);
  requireCondition(
    relevant[0].id === run.id &&
      relevant[0].run_attempt === run.run_attempt &&
      relevant[0].conclusion === "success",
    "validation-run-superseded",
  );
  // GITHUB_TOKEN can leave a duplicate PR-triggered run awaiting approval.
  // The explicit dispatch is authoritative only for this exact runtime head.
  const approvalBlockedSuites = new Set(
    kind === "runtime"
      ? candidates
          .filter(
            (candidate) =>
              candidate.event === "pull_request" &&
              (candidate.conclusion === "action_required" ||
                (candidate.status === "waiting" &&
                  candidate.conclusion === null)),
          )
          .map((candidate) => candidate.check_suite_id)
          .filter(Number.isSafeInteger)
      : [],
  );
  requireCondition(
    checks.total_count === checks.check_runs?.length &&
      checks.check_runs.every(
        (check) =>
          (check.status === "completed" &&
            ["success", "neutral", "skipped"].includes(check.conclusion)) ||
          (check.name === "verify" &&
            check.app?.slug === "github-actions" &&
            approvalBlockedSuites.has(check.check_suite?.id) &&
            (check.conclusion === "action_required" ||
              check.conclusion === null)),
      ),
    "checks-not-successful",
  );
  requireCondition(
    status.total_count === status.statuses?.length &&
      status.statuses.every((entry) => entry.state === "success"),
    "commit-status-not-successful",
  );
}

async function ensureMainValidation(api) {
  const head = (await api(`${PREFIX}/git/ref/heads/main`)).object?.sha;
  requireCondition(SHA.test(head), "invalid-main-sha");
  const runs = await api(
    `${PREFIX}/actions/workflows/ci.yml/runs?branch=main&event=workflow_dispatch&head_sha=${head}&per_page=100`,
  );
  const existing = runs.workflow_runs?.filter(
    (run) =>
      run.head_sha === head &&
      run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      run.path === WORKFLOW,
  );
  requireCondition(Array.isArray(existing), "main-validation-runs-missing");
  existing.sort((a, b) => b.id - a.id);
  if (
    existing[0] &&
    (existing[0].status !== "completed" || existing[0].conclusion === "success")
  )
    return false;
  await api(`${PREFIX}/actions/workflows/ci.yml/dispatches`, {
    method: "POST",
    body: { ref: "main" },
  });
  return true;
}

export async function runAutoMerge({ event, repository, api }) {
  requireCondition(
    repository === REPOSITORY && event.repository?.full_name === REPOSITORY,
    "repository-mismatch",
  );
  const announced = event.workflow_run;
  if (
    announced?.status !== "completed" ||
    announced.conclusion !== "success" ||
    announced.path !== WORKFLOW
  )
    return { status: "skipped", reason: "not-successful-validation" };
  requireCondition(
    Number.isSafeInteger(announced.id) && announced.id > 0,
    "invalid-run-id",
  );
  const run = await api(`${PREFIX}/actions/runs/${announced.id}`);
  requireCondition(
    run.repository?.full_name === REPOSITORY &&
      run.head_repository?.full_name === REPOSITORY &&
      run.path === WORKFLOW &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      SHA.test(run.head_sha) &&
      run.head_sha === announced.head_sha &&
      run.run_attempt === announced.run_attempt,
    "validation-run-mismatch",
  );
  if (
    !(
      run.event === "pull_request" ||
      (run.event === "workflow_dispatch" && run.head_branch === RUNTIME_BRANCH)
    )
  )
    return { status: "skipped", reason: "not-update-validation" };
  // GitHub can omit workflow_run.pull_requests, including after a merge.
  const associated = await api(
    `${PREFIX}/commits/${run.head_sha}/pulls?per_page=100`,
  );
  requireCondition(
    Array.isArray(associated) && associated.length < 100,
    "pull-request-list-truncated",
  );
  const matching = associated.filter(
    (pr) =>
      pr.base?.ref === "main" &&
      pr.base.repo?.full_name === REPOSITORY &&
      pr.head?.repo?.full_name === REPOSITORY &&
      pr.head.ref === run.head_branch &&
      pr.head.sha === run.head_sha,
  );
  if (matching.length !== 1)
    return { status: "skipped", reason: "no-single-update-pull-request" };
  const number = matching[0].number;
  requireCondition(
    Number.isSafeInteger(number) && number > 0,
    "invalid-pull-request-number",
  );
  const pr = await api(`${PREFIX}/pulls/${number}`);
  const kind = candidateKind(pr);
  if (!kind) return { status: "skipped", reason: "not-authorized-update-bot" };
  if (
    pr.labels?.some(({ name }) =>
      ["no-automerge", "manual-review"].includes(name),
    )
  )
    return { status: "skipped", reason: "manual-review-requested" };
  requireCondition(
    (kind === "dependabot" && run.event === "pull_request") ||
      (kind === "runtime" && run.event === "workflow_dispatch"),
    "update-kind-event-mismatch",
  );
  const main = (await api(`${PREFIX}/git/ref/heads/main`)).object?.sha;
  requireCondition(SHA.test(main), "invalid-main-sha");
  if (pr.merged) {
    requireCondition(
      pr.head.sha === run.head_sha && SHA.test(pr.merge_commit_sha),
      "merged-pull-request-mismatch",
    );
    const mergedComparison = await api(
      `${PREFIX}/compare/${pr.merge_commit_sha}...${main}`,
    );
    requireCondition(
      ["ahead", "identical"].includes(mergedComparison.status) &&
        mergedComparison.merge_base_commit?.sha === pr.merge_commit_sha,
      "merged-commit-not-on-main",
    );
    const dispatched = await ensureMainValidation(api);
    return {
      status: "already-merged",
      number,
      mergeSha: pr.merge_commit_sha,
      mainValidationDispatched: dispatched,
    };
  }
  requireCandidate(pr, run.head_sha, main);
  const association = run.pull_requests?.find((item) => item.number === number);
  if (kind === "dependabot" && association)
    requireCondition(
      association.base?.sha === main && association.head?.sha === pr.head.sha,
      "tested-base-changed",
    );
  const comparison = await api(`${PREFIX}/compare/${main}...${pr.head.sha}`);
  requireCondition(
    comparison.status === "ahead" &&
      comparison.behind_by === 0 &&
      comparison.ahead_by > 0 &&
      comparison.merge_base_commit?.sha === main,
    "candidate-needs-rebase",
  );
  await requireChecks(api, run, pr, kind);
  await requireReviews(api, number);
  const files = await api(`${PREFIX}/pulls/${number}/files?per_page=100`);
  requireCondition(
    Array.isArray(files) &&
      files.length === pr.changed_files &&
      files.length > 0 &&
      files.length <= 40 &&
      files.every(
        (file) => file.status === "modified" && !file.previous_filename,
      ),
    "changed-files-not-verified",
  );
  const filenames = files.map((file) => file.filename);
  requireAllowedFiles(kind, filenames);
  const names = new Set(filenames);
  if (kind === "runtime") for (const name of RUNTIME_FILES) names.add(name);
  if (names.has("package.json") || names.has("package-lock.json")) {
    names.add("package.json");
    names.add("package-lock.json");
  }
  const [before, after] = await readFiles(api, [main, pr.head.sha], [...names]);
  validateChanges(kind, filenames, before, after);
  // Re-read both refs immediately before the SHA-bound merge; never bypass rules.
  const [freshPr, freshMain] = await Promise.all([
    api(`${PREFIX}/pulls/${number}`),
    api(`${PREFIX}/git/ref/heads/main`),
  ]);
  requireCondition(
    freshMain.object?.sha === main &&
      candidateKind(freshPr) === kind &&
      !freshPr.labels?.some(({ name }) =>
        ["no-automerge", "manual-review"].includes(name),
      ),
    "pull-request-changed",
  );
  requireCandidate(freshPr, pr.head.sha, main);
  const merged = await api(`${PREFIX}/pulls/${number}/merge`, {
    method: "PUT",
    body: { sha: pr.head.sha, merge_method: "squash" },
  });
  requireCondition(
    merged.merged === true && SHA.test(merged.sha),
    "merge-not-confirmed",
  );
  // GITHUB_TOKEN merges do not trigger push workflows. Dispatch the main gate.
  const dispatched = await ensureMainValidation(api);
  return {
    status: "merged",
    number,
    head: pr.head.sha,
    mergeSha: merged.sha,
    mainValidationDispatched: dispatched,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await runAutoMerge({
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      repository: process.env.GITHUB_REPOSITORY,
      api: githubClient(process.env.GITHUB_TOKEN),
    });
    const text = JSON.stringify(result);
    process.stdout.write(`${text}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Dependency update result\n\n\`${text}\`\n`,
      );
  } catch (error) {
    process.stderr.write(`DEPENDENCY_AUTOMERGE_BLOCKED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
