/** Approve and continue only the real PR validation for a verified runtime update. */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { githubClient, validateChanges } from "./dependency-automerge.mjs";

const REPOSITORY = "kitamura-tetsuo/agent-table";
const PREFIX = `/repos/${REPOSITORY}`;
const BRANCH = "automation/runtime-updates";
const WORKFLOW = ".github/workflows/ci.yml";
const FILES = [
  ".node-version",
  "package.json",
  "package-lock.json",
  "deploy/relay/node-image.txt",
];
const SHA = /^[a-f0-9]{40}$/;
const ACTIVE = new Set(["requested", "queued", "in_progress", "pending"]);

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sameRepository(repository) {
  return repository?.full_name === REPOSITORY && repository.fork !== true;
}

async function readCandidate(api, prNumber, expectedHead) {
  const [pr, mainRef, headRef] = await Promise.all([
    api(`${PREFIX}/pulls/${prNumber}`),
    api(`${PREFIX}/git/ref/heads/main`),
    api(`${PREFIX}/git/ref/heads/${BRANCH}`),
  ]);
  const main = mainRef.object?.sha;
  requireCondition(
    typeof main === "string" && SHA.test(main),
    "invalid-main-sha",
  );
  requireCondition(
    pr.number === prNumber &&
      pr.user?.id === 41898282 &&
      pr.user.login === "github-actions[bot]" &&
      pr.user.type === "Bot" &&
      pr.state === "open" &&
      pr.draft === false &&
      pr.merged === false &&
      pr.base?.ref === "main" &&
      pr.base.sha === main &&
      sameRepository(pr.base.repo) &&
      pr.head?.ref === BRANCH &&
      pr.head.sha === expectedHead &&
      sameRepository(pr.head.repo) &&
      headRef.object?.sha === expectedHead &&
      Array.isArray(pr.labels),
    "runtime-pull-request-not-current",
  );
  return {
    pr,
    main,
    optedOut: pr.labels.some(({ name }) =>
      ["no-automerge", "manual-review"].includes(name),
    ),
  };
}

async function validateRuntimeDiff(api, pr, main, head) {
  const [comparison, files] = await Promise.all([
    api(`${PREFIX}/compare/${main}...${head}`),
    api(`${PREFIX}/pulls/${pr.number}/files?per_page=100`),
  ]);
  requireCondition(
    comparison.status === "ahead" &&
      comparison.behind_by === 0 &&
      positiveInteger(comparison.ahead_by) &&
      comparison.merge_base_commit?.sha === main,
    "runtime-candidate-needs-rebase",
  );
  requireCondition(
    Array.isArray(files) &&
      positiveInteger(pr.changed_files) &&
      files.length === pr.changed_files &&
      files.length <= FILES.length &&
      new Set(files.map((file) => file.filename)).size === files.length &&
      files.every(
        (file) =>
          FILES.includes(file.filename) &&
          file.status === "modified" &&
          !file.previous_filename,
      ),
    "runtime-changed-files-not-verified",
  );
  const contents = await Promise.all(
    [main, head].map(async (ref) =>
      Object.fromEntries(
        await Promise.all(
          FILES.map(async (name) => {
            const data = await api(`${PREFIX}/contents/${name}?ref=${ref}`);
            requireCondition(
              data.type === "file" &&
                data.encoding === "base64" &&
                Number.isSafeInteger(data.size) &&
                data.size >= 0 &&
                data.size <= 1_000_000 &&
                typeof data.content === "string",
              "runtime-file-not-readable",
            );
            const bytes = Buffer.from(data.content, "base64");
            requireCondition(
              bytes.length === data.size,
              "runtime-file-truncated",
            );
            return [name, bytes.toString("utf8")];
          }),
        ),
      ),
    ),
  );
  validateChanges(
    "runtime",
    files.map((file) => file.filename),
    ...contents,
  );
}

function validateRun(run, prNumber, main, head, runId = run?.id) {
  requireCondition(
    positiveInteger(runId) &&
      run?.id === runId &&
      sameRepository(run.repository) &&
      sameRepository(run.head_repository) &&
      run.path === WORKFLOW &&
      run.event === "pull_request" &&
      run.head_branch === BRANCH &&
      run.head_sha === head,
    "runtime-validation-run-mismatch",
  );
  if (run.pull_requests !== undefined) {
    requireCondition(
      Array.isArray(run.pull_requests),
      "invalid-run-pr-association",
    );
    if (run.pull_requests.length > 0) {
      const association = run.pull_requests.find(
        (pr) => pr.number === prNumber,
      );
      requireCondition(
        association?.base?.sha === main && association.head?.sha === head,
        "runtime-validation-pr-association-mismatch",
      );
    }
  }
}

function needsApproval(run) {
  return (
    (run.status === "completed" && run.conclusion === "action_required") ||
    (run.status === "waiting" && run.conclusion === null)
  );
}

function requireRunnable(run) {
  requireCondition(
    (run.status === "completed" && run.conclusion === "success") ||
      (ACTIVE.has(run.status) && run.conclusion === null),
    "runtime-validation-not-successful-or-active",
  );
}

export function runtimeApprovalClient(token, fetcher = fetch) {
  requireCondition(
    typeof token === "string" && token.length > 0,
    "runtime-approval-token-missing",
  );
  return async (path, { method, body } = {}) => {
    const match =
      /^\/repos\/kitamura-tetsuo\/agent-table\/actions\/runs\/([1-9]\d*)\/approve$/.exec(
        path,
      );
    requireCondition(
      match &&
        positiveInteger(Number(match[1])) &&
        method === "POST" &&
        body === undefined,
      "runtime-approval-endpoint-not-allowed",
    );
    const response = await fetcher(`https://api.github.com${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    requireCondition(response.ok, `runtime-approval-http-${response.status}`);
    // GitHub's 201 response can have an empty body; no JSON is required.
    return null;
  };
}

export async function coordinateRuntimeValidation({
  api,
  approveApi,
  prNumber,
  expectedHead,
  timeoutMs = 120_000,
  pollIntervalMs = 5_000,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => performance.now(),
}) {
  requireCondition(positiveInteger(prNumber), "invalid-runtime-pr-number");
  requireCondition(
    typeof expectedHead === "string" && SHA.test(expectedHead),
    "invalid-runtime-head",
  );
  requireCondition(
    typeof api === "function" &&
      (approveApi === undefined || typeof approveApi === "function") &&
      typeof sleep === "function" &&
      typeof now === "function" &&
      positiveInteger(timeoutMs) &&
      timeoutMs <= 120_000 &&
      positiveInteger(pollIntervalMs),
    "invalid-runtime-validation-options",
  );
  let previousTime = now();
  requireCondition(
    Number.isFinite(previousTime),
    "invalid-runtime-validation-clock",
  );
  const deadline = previousTime + timeoutMs;
  const remaining = () => {
    const time = now();
    requireCondition(
      Number.isFinite(time) && time >= previousTime,
      "invalid-runtime-validation-clock",
    );
    previousTime = time;
    requireCondition(time < deadline, "runtime-validation-discovery-timeout");
    return deadline - time;
  };
  const candidate = await readCandidate(api, prNumber, expectedHead);
  const skipped = {
    status: "skipped",
    reason: "manual-review-requested",
    prNumber,
    head: expectedHead,
  };
  if (candidate.optedOut) return skipped;
  const { pr, main } = candidate;
  await validateRuntimeDiff(api, pr, main, expectedHead);
  const refresh = async () => {
    remaining();
    const current = await readCandidate(api, prNumber, expectedHead);
    requireCondition(current.main === main, "runtime-main-changed");
    return !current.optedOut;
  };
  let selected;
  while (!selected) {
    remaining();
    const list = await api(
      `${PREFIX}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(BRANCH)}&event=pull_request&head_sha=${expectedHead}&per_page=100`,
    );
    requireCondition(
      Number.isSafeInteger(list.total_count) &&
        list.total_count >= 0 &&
        list.total_count < 100 &&
        Array.isArray(list.workflow_runs) &&
        list.total_count === list.workflow_runs.length,
      "runtime-validation-run-list-truncated",
    );
    for (const item of list.workflow_runs)
      validateRun(item, prNumber, main, expectedHead);
    selected = list.workflow_runs.sort((a, b) => b.id - a.id)[0];
    if (!selected) await sleep(Math.min(pollIntervalMs, remaining()));
  }
  const runId = selected.id;
  const readRun = async () => {
    remaining();
    const result = await api(`${PREFIX}/actions/runs/${runId}`);
    validateRun(result, prNumber, main, expectedHead, runId);
    remaining();
    return result;
  };
  let run = await readRun();
  const details = {
    prNumber,
    runId,
    head: expectedHead,
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
  };
  let approvalGranted = false;
  if (needsApproval(run)) {
    if (!approveApi) return { status: "approval-required", ...details };
    if (!(await refresh())) return skipped;
    run = await readRun();
    if (needsApproval(run)) {
      await approveApi(`${PREFIX}/actions/runs/${runId}/approve`, {
        method: "POST",
      });
      approvalGranted = true;
      do {
        await sleep(Math.min(pollIntervalMs, remaining()));
        run = await readRun();
      } while (needsApproval(run));
    }
  }
  requireRunnable(run);
  if (!(await refresh())) return skipped;
  run = await readRun();
  requireRunnable(run);
  await api(`${PREFIX}/actions/workflows/dependency-automerge.yml/dispatches`, {
    method: "POST",
    body: {
      ref: "main",
      inputs: { validation_run_id: String(runId), expected_sha: expectedHead },
    },
  });
  return { status: "continuation-dispatched", ...details, approvalGranted };
}

export function runtimeValidationInput(env) {
  requireCondition(
    env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_REF === "refs/heads/main",
    "runtime-validation-workflow-not-main",
  );
  requireCondition(
    typeof env.RUNTIME_PR_NUMBER === "string" &&
      /^[1-9]\d*$/.test(env.RUNTIME_PR_NUMBER) &&
      positiveInteger(Number(env.RUNTIME_PR_NUMBER)),
    "invalid-runtime-pr-number",
  );
  requireCondition(
    typeof env.RUNTIME_PR_HEAD_SHA === "string" &&
      SHA.test(env.RUNTIME_PR_HEAD_SHA),
    "invalid-runtime-head",
  );
  return {
    prNumber: Number(env.RUNTIME_PR_NUMBER),
    expectedHead: env.RUNTIME_PR_HEAD_SHA,
  };
}

export function runtimeValidationSummary(result) {
  if (result.status === "approval-required")
    return `## Runtime validation needs approval\n\nOpen [runtime PR #${result.prNumber}](https://github.com/${REPOSITORY}/pull/${result.prNumber}) and click **Approve workflows** on the approval banner. Follow [Validation run ${result.runId}](${result.url}) for the result.\n\nAfter approval, rerun **Runtime updates** if the merge continuation did not start.\n\nFor unattended future updates, configure the repository secret \`RUNTIME_WORKFLOW_TOKEN\` with an external token allowed to approve Actions runs. The default \`GITHUB_TOKEN\` cannot approve this run.\n`;
  return `## Runtime validation\n\n\`${JSON.stringify(result)}\`\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const input = runtimeValidationInput(process.env);
    const result = await coordinateRuntimeValidation({
      ...input,
      api: githubClient(process.env.GITHUB_TOKEN),
      ...(process.env.RUNTIME_WORKFLOW_TOKEN
        ? {
            approveApi: runtimeApprovalClient(
              process.env.RUNTIME_WORKFLOW_TOKEN,
            ),
          }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        runtimeValidationSummary(result),
      );
  } catch (error) {
    process.stderr.write(`RUNTIME_VALIDATION_BLOCKED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
