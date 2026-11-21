/** Poll one trusted Validation run without checking out candidate code. */
const REPOSITORY = "kitamura-tetsuo/agent-table";
const WORKFLOW = ".github/workflows/ci.yml";
const RUNTIME_BRANCH = "automation/runtime-updates";
const ACTIVE_STATUSES = new Set([
  "requested",
  "queued",
  "in_progress",
  "waiting",
  "pending",
]);
const DEFAULT_TIMEOUT = 25 * 60 * 1000;

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function requireSource(run, target) {
  const dependencyPullRequest =
    run.event === "pull_request" &&
    typeof run.head_branch === "string" &&
    /^dependabot\/[^\s]+$/.test(run.head_branch);
  const runtimeDispatch =
    run.event === "workflow_dispatch" && run.head_branch === RUNTIME_BRANCH;
  const mainValidation =
    ["push", "workflow_dispatch"].includes(run.event) &&
    run.head_branch === "main";
  requireCondition(
    target === "update"
      ? dependencyPullRequest || runtimeDispatch
      : mainValidation,
    "validation-run-source-mismatch",
  );
}

export async function waitForValidation({
  api,
  runId,
  expectedHead,
  target,
  timeoutMs = DEFAULT_TIMEOUT,
  pollIntervalMs = 15_000,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => performance.now(),
}) {
  requireCondition(
    Number.isSafeInteger(runId) && runId > 0,
    "invalid-validation-run-id",
  );
  requireCondition(
    typeof expectedHead === "string" && /^[a-f0-9]{40}$/.test(expectedHead),
    "invalid-validation-head",
  );
  requireCondition(
    target === "update" || target === "main",
    "invalid-validation-target",
  );
  requireCondition(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= DEFAULT_TIMEOUT,
    "invalid-validation-timeout",
  );
  requireCondition(
    Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0,
    "invalid-validation-poll-interval",
  );
  requireCondition(
    typeof api === "function" &&
      typeof sleep === "function" &&
      typeof now === "function",
    "invalid-validation-poll-functions",
  );
  let previousTime = now();
  requireCondition(Number.isFinite(previousTime), "invalid-validation-clock");
  const deadline = previousTime + timeoutMs;
  requireCondition(Number.isFinite(deadline), "invalid-validation-clock");
  const remaining = () => {
    const currentTime = now();
    requireCondition(
      Number.isFinite(currentTime) && currentTime >= previousTime,
      "invalid-validation-clock",
    );
    previousTime = currentTime;
    const available = deadline - currentTime;
    requireCondition(available > 0, "validation-wait-timeout");
    return available;
  };
  const path = `/repos/${REPOSITORY}/actions/runs/${runId}`;
  for (;;) {
    remaining();
    const run = await api(path);
    requireCondition(
      run?.id === runId &&
        run.repository?.full_name === REPOSITORY &&
        run.head_repository?.full_name === REPOSITORY &&
        run.repository.fork !== true &&
        run.head_repository.fork !== true &&
        run.path === WORKFLOW &&
        run.head_sha === expectedHead,
      "validation-run-identity-mismatch",
    );
    requireSource(run, target);
    const available = remaining();
    if (run.status === "completed") {
      requireCondition(
        run.conclusion === "success",
        "validation-run-not-successful",
      );
      return run;
    }
    requireCondition(
      ACTIVE_STATUSES.has(run.status) && run.conclusion === null,
      "invalid-validation-run-state",
    );
    await sleep(Math.min(pollIntervalMs, available));
  }
}
