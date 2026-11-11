import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateRelease } from "./release-preflight.mjs";
import {
  cloudflareReader,
  ProviderVerificationError,
  readCloudflareDeployment,
  receiptDigest,
  redactedProviderReceipt,
} from "./release-provider.mjs";

const REPOSITORY = "kitamura-tetsuo/agent-table";
const CI_STEPS = [
  "Typecheck",
  "Lint",
  "Application unit tests",
  "Worker integration tests",
  "Restore runtime tests",
  "Browser E2E tests",
  "Wrangler dry-run",
];

export class ReleaseAuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseAuthorizationError";
  }
}

function requireDecision(value, code) {
  if (!value) throw new ReleaseAuthorizationError(code);
}

function freshReview(record, now) {
  const timestamp = Date.parse(record?.reviewedAt);
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now &&
    now - timestamp < 24 * 60 * 60_000
  );
}

function exactEvidenceRun(evidence) {
  const ids = new Set();
  for (const name of ["application", "security", "browser"]) {
    const refs = evidence?.checks?.[name]?.refs;
    requireDecision(
      Array.isArray(refs) && refs.length === 1,
      "unattributable-ci-evidence",
    );
    const match =
      /^https:\/\/github\.com\/kitamura-tetsuo\/agent-table\/actions\/runs\/([1-9]\d*)$/.exec(
        refs[0],
      );
    requireDecision(match, "unattributable-ci-evidence");
    ids.add(match[1]);
  }
  requireDecision(ids.size === 1, "ci-evidence-run-mismatch");
  return [...ids][0];
}

export async function verifyCiEvidence(evidence, sha, githubRead) {
  const runId = exactEvidenceRun(evidence);
  const [run, jobs] = await Promise.all([
    githubRead(`/repos/${REPOSITORY}/actions/runs/${runId}`),
    githubRead(`/repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`),
  ]);
  requireDecision(
    run?.repository?.full_name === REPOSITORY &&
      run.head_sha === sha &&
      run.head_branch === "main" &&
      run.path === ".github/workflows/ci.yml" &&
      run.event === "workflow_dispatch" &&
      run.status === "completed" &&
      run.conclusion === "success",
    "ci-source-not-verified",
  );
  requireDecision(
    Array.isArray(jobs?.jobs) &&
      jobs.total_count === jobs.jobs.length &&
      jobs.jobs.length === 1 &&
      jobs.jobs[0]?.name === "verify" &&
      jobs.jobs[0]?.conclusion === "success",
    "ci-jobs-not-verified",
  );
  const succeeded = new Set(
    jobs.jobs[0].steps
      .filter(
        (step) => step?.status === "completed" && step.conclusion === "success",
      )
      .map((step) => step.name),
  );
  requireDecision(
    CI_STEPS.every((step) => succeeded.has(step)),
    "ci-required-step-missing",
  );
  return runId;
}

export async function verifyCurrentMainHead(sha, githubRead) {
  const branch = await githubRead(`/repos/${REPOSITORY}/git/ref/heads/main`);
  requireDecision(
    branch?.ref === "refs/heads/main" &&
      branch?.object?.type === "commit" &&
      branch.object.sha === sha,
    "main-head-changed",
  );
}

export function verifyOperationalDecision(
  record,
  { environment, profile, buildSha, configSha256, origin, now },
) {
  requireDecision(
    record?.environment === environment &&
      record?.profile === profile &&
      record?.buildSha === buildSha &&
      record?.configSha256 === configSha256 &&
      record?.origin === origin,
    "operator-record-target-mismatch",
  );
  requireDecision(
    record?.review?.operator === "kitamura-tetsuo" &&
      record.review.decision === "approve" &&
      freshReview(record.review, now),
    "operator-approval-unavailable",
  );
  // The independent protected GitHub Environment reviewer owns the decision.
  // These are disclosures, not an assertion that the code verifies CF backups.
  for (const name of ["backup", "logs"]) {
    const disclosure = record?.retention?.[name];
    requireDecision(
      disclosure?.status === "operator-verified" &&
        freshReview(disclosure, now) &&
        typeof disclosure.policy === "string" &&
        disclosure.policy.length >= 8 &&
        /^https:\/\//.test(disclosure.source),
      `retention-disclosure-unverified:${name}`,
    );
  }
  requireDecision(
    record?.schema?.testedVersion === 11 &&
      record.schema.nonDestructiveRollback === true &&
      record.schema.rollbackRunbook ===
        `https://github.com/${REPOSITORY}/blob/${buildSha}/docs/operations.md`,
    "schema-rollback-approval-unavailable",
  );
  requireDecision(
    record?.restore?.type === "no-restore" &&
      record.restore.independentlyReviewed === true,
    "restore-reconciliation-required",
  );
  requireDecision(
    record?.cost?.usageObserved === true &&
      /^https:\/\//.test(record.cost.measurementSource) &&
      /^https:\/\/developers\.cloudflare\.com\/workers\/platform\/pricing/.test(
        record.cost.currentPricingSource,
      ),
    "cost-disclosure-unverified",
  );
}

/**
 * Only the protected, manual, exact-main GitHub workflow can consume the
 * resulting in-job approval. Other profiles stay blocked until real-host
 * evidence can be independently checked, not merely flagged as passing.
 */
export async function authorizeRelease({
  environment,
  profile,
  buildSha,
  configText,
  peerText,
  inventory,
  evidence,
  operations,
  workflow,
  cloudflareRead,
  githubRead,
  now = Date.now(),
}) {
  const offline = validateRelease({
    environment,
    profile,
    buildSha,
    configText,
    peerText,
    secrets: inventory,
    evidence,
  });
  requireDecision(
    workflow?.repository === REPOSITORY &&
      workflow.ref === "refs/heads/main" &&
      workflow.eventName === "workflow_dispatch" &&
      workflow.sha === buildSha &&
      workflow.environment === environment &&
      /^[1-9]\d*$/.test(workflow.runId) &&
      /^[1-9]\d*$/.test(workflow.runAttempt),
    "unprotected-release-context",
  );
  requireDecision(
    profile === "manual",
    "profile-real-host-evidence-not-verified",
  );
  const config = JSON.parse(configText);
  const peer = JSON.parse(peerText);
  requireDecision(
    config.account_id.toLowerCase() ===
      workflow.cloudflareAccountId?.toLowerCase(),
    "cloudflare-account-mismatch",
  );
  requireDecision(
    config.vars.RESTORE_QUARANTINE === "false" &&
      config.vars.ENABLE_MCP_SUBSCRIPTIONS === "false" &&
      config.vars.ENABLE_OPENAI_EVENTS === "false" &&
      config.vars.ALLOW_OUTBOUND_NOTIFICATIONS === "false",
    "unsupported-capability-or-quarantine-clearance",
  );
  if (config.vars.ALLOW_NEW_GUESTS === "true") {
    requireDecision(
      config.vars.GUEST_CHALLENGE_MODE === "required" &&
        typeof config.vars.TURNSTILE_SITE_KEY === "string" &&
        config.vars.TURNSTILE_SITE_KEY.length > 10,
      "public-guest-challenge-unverified",
    );
  }
  verifyOperationalDecision(operations, {
    environment,
    profile,
    buildSha,
    configSha256: offline.configSha256,
    origin: config.vars.PUBLIC_ORIGIN,
    now,
  });
  const [ciRunId, observed] = await Promise.all([
    verifyCiEvidence(evidence, buildSha, githubRead),
    readCloudflareDeployment(config, peer, cloudflareRead),
    verifyCurrentMainHead(buildSha, githubRead),
  ]);
  requireDecision(
    observed.targetState.textBindings.RESTORE_QUARANTINE !== "true" &&
      observed.peerState.textBindings.RESTORE_QUARANTINE !== "true",
    "restore-reconciliation-required",
  );
  requireDecision(
    inventory.bindings.every((name) =>
      observed.targetState.secretNames.includes(name),
    ),
    "unverified-secret-inventory",
  );
  const providerReceipt = redactedProviderReceipt(
    observed.targetState,
    environment,
    new Date(now).toISOString(),
  );
  return {
    ...offline,
    deploymentApproved: true,
    approvalSource: "protected-environment-and-live-provider-readback",
    workflowRunId: workflow.runId,
    workflowRunAttempt: workflow.runAttempt,
    ciRunId,
    providerReceipt,
    providerReceiptSha256: receiptDigest(providerReceipt),
  };
}

export function githubReader(token, fetchImpl = fetch) {
  requireDecision(token?.length > 10, "github-read-token-missing");
  return async (path) => {
    requireDecision(
      /^\/repos\/kitamura-tetsuo\/agent-table\/(?:git\/ref\/heads\/main|actions\/runs\/[1-9]\d*(?:\/jobs\?per_page=100)?)$/.test(
        path,
      ),
      "github-evidence-path-invalid",
    );
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ReleaseAuthorizationError("github-evidence-unreachable");
    }
    requireDecision(response.ok, "github-evidence-read-refused");
    const length = Number(response.headers.get("Content-Length"));
    requireDecision(
      !Number.isFinite(length) || length < 256 * 1024,
      "github-evidence-oversized",
    );
    let payload;
    try {
      const reader = response.body?.getReader();
      requireDecision(reader, "github-evidence-invalid");
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          requireDecision(size < 256 * 1024, "github-evidence-oversized");
          chunks.push(value);
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof ReleaseAuthorizationError) throw error;
      throw new ReleaseAuthorizationError("github-evidence-invalid");
    }
    return payload;
  };
}

function cliArgument(args, name) {
  const index = args.indexOf(`--${name}`);
  requireDecision(index >= 0 && args[index + 1], `missing-argument:${name}`);
  return args[index + 1];
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const environment = cliArgument(args, "environment");
    const profile = cliArgument(args, "profile");
    const buildSha = cliArgument(args, "build-sha");
    const result = await authorizeRelease({
      environment,
      profile,
      buildSha,
      configText: readFileSync(cliArgument(args, "config"), "utf8"),
      peerText: readFileSync(cliArgument(args, "peer-config"), "utf8"),
      inventory: JSON.parse(
        readFileSync(cliArgument(args, "secret-inventory"), "utf8"),
      ),
      evidence: JSON.parse(readFileSync(cliArgument(args, "evidence"), "utf8")),
      operations: JSON.parse(
        readFileSync(cliArgument(args, "operations"), "utf8"),
      ),
      workflow: {
        repository: process.env.GITHUB_REPOSITORY,
        ref: process.env.GITHUB_REF,
        eventName: process.env.GITHUB_EVENT_NAME,
        sha: process.env.GITHUB_SHA,
        environment,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      },
      cloudflareRead: cloudflareReader(process.env.CLOUDFLARE_READ_TOKEN),
      githubRead: githubReader(process.env.GITHUB_TOKEN),
    });
    process.stdout.write(`RELEASE_APPROVAL_VALID ${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof ReleaseAuthorizationError ||
      error instanceof ProviderVerificationError
        ? error.message
        : "unverified-release-input";
    // Never print raw input, provider bodies, tokens, callbacks or error stacks.
    process.stderr.write(`RELEASE_BLOCKED ${code}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
