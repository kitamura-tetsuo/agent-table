import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  activePrivatePilotDiscoveryPolicy,
  activePrivatePilotPolicy,
  PRIVATE_PILOT_PROFILE,
  privatePilotConfiguration,
} from "../src/shared/private-pilot.ts";
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

/**
 * A protected Environment name does not prove that the owner approved this
 * exact run. GitHub's approval history is not attempt-scoped, so a rerun
 * cannot inherit an earlier approval.
 */
export async function verifyProtectedEnvironmentApproval(workflow, githubRead) {
  requireDecision(
    workflow.runAttempt === "1",
    "deployment-review-attempt-unverifiable",
  );
  const prefix = `/repos/${REPOSITORY}/actions/runs/${workflow.runId}`;
  const [run, approvals] = await Promise.all([
    githubRead(prefix),
    githubRead(`${prefix}/approvals`),
  ]);
  requireDecision(
    run?.id === Number(workflow.runId) &&
      run?.repository?.full_name === REPOSITORY &&
      run?.head_sha === workflow.sha &&
      run?.head_branch === "main" &&
      run?.event === "workflow_dispatch" &&
      run?.path === `.github/workflows/deploy-${workflow.environment}.yml` &&
      run?.run_attempt === 1 &&
      run?.status === "in_progress",
    "deployment-run-not-verified",
  );
  requireDecision(
    Array.isArray(approvals) &&
      approvals.length === 1 &&
      approvals[0]?.state === "approved" &&
      approvals[0]?.user?.type === "User" &&
      approvals[0]?.user?.login === "kitamura-tetsuo" &&
      Array.isArray(approvals[0]?.environments) &&
      approvals[0].environments.length === 1 &&
      approvals[0].environments[0]?.name === workflow.environment,
    "independent-deployment-review-unverified",
  );
}

export function verifyOperationalDecision(
  record,
  {
    environment,
    profile,
    buildSha,
    configSha256,
    origin,
    now,
    bootstrapStaging = false,
  },
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
      record.schema.nonDestructiveRollback === !bootstrapStaging &&
      (!bootstrapStaging ||
        (environment === "staging" &&
          record.bootstrap?.mode === "staging-legacy-identity" &&
          /^[0-9a-f-]{36}$/i.test(record.bootstrap.expectedActiveVersionId) &&
          record.bootstrap.retainedStateImpactReviewed === true)) &&
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

/** Bind private verification to a separately reviewed, finite policy. */
export function verifyPrivatePilotDecision(record, vars, now) {
  const policy = privatePilotConfiguration(vars);
  const deliveryEnabled = vars.ALLOW_OUTBOUND_NOTIFICATIONS === "true";
  requireDecision(
    policy &&
      (policy.mode === "a-only-discovery"
        ? activePrivatePilotDiscoveryPolicy(vars, now)
        : !deliveryEnabled || activePrivatePilotPolicy(vars, now)),
    "private-pilot-not-active",
  );
  const policySha256 = createHash("sha256")
    .update(vars.PRIVATE_PILOT_POLICY)
    .digest("hex");
  const decision = record?.privatePilot;
  requireDecision(
    decision?.mode === policy.mode &&
      decision.policySha256 === policySha256 &&
      decision.approvalRef === policy.approvalRef &&
      decision.independentOwnerConsentsReviewed === true &&
      (policy.mode === "a-only-discovery"
        ? decision.callbackDiscoveryReviewed === true &&
          decision.noOutboundReviewed === true
        : decision.callbackControlReviewed === true &&
          decision.nativeFetchRiskAccepted === true) &&
      (policy.observationMode === undefined ||
        decision.privateObservationReviewed === true) &&
      decision.boundedCanaryReviewed === true &&
      decision.stopPlanReviewed === true,
    "private-pilot-scope-not-approved",
  );
  return {
    mode: policy.mode,
    ...(policy.observationMode === undefined
      ? {}
      : { observationMode: policy.observationMode }),
    policySha256,
    notBefore: policy.notBefore,
    expiresAt: policy.expiresAt,
    deliveryEnabled,
  };
}

/**
 * Only the protected exact-main workflow can consume this approval. Private
 * A-only staging verification gathers missing host evidence; public capability
 * profiles remain blocked until their independently observed evidence exists.
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
  bootstrapStaging = false,
  requestedActiveVersionId = "",
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
    profile === "manual" ||
      (profile === PRIVATE_PILOT_PROFILE && environment === "staging"),
    "profile-real-host-evidence-not-verified",
  );
  requireDecision(
    profile !== PRIVATE_PILOT_PROFILE || !bootstrapStaging,
    "private-pilot-cannot-bootstrap",
  );
  requireDecision(
    !bootstrapStaging ||
      (environment === "staging" &&
        workflow.bootstrapStaging === true &&
        workflow.eventSender === "kitamura-tetsuo" &&
        workflow.expectedActiveVersionId === requestedActiveVersionId &&
        workflow.expectedActiveVersionId ===
          operations?.bootstrap?.expectedActiveVersionId),
    "staging-bootstrap-unapproved",
  );
  requireDecision(
    bootstrapStaging || workflow.bootstrapStaging !== true,
    "bootstrap-dispatch-mismatch",
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
      (profile === PRIVATE_PILOT_PROFILE ||
        config.vars.ALLOW_OUTBOUND_NOTIFICATIONS === "false"),
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
    bootstrapStaging,
  });
  const privatePilot =
    profile === PRIVATE_PILOT_PROFILE
      ? verifyPrivatePilotDecision(operations, config.vars, now)
      : undefined;
  const [ciRunId, observed] = await Promise.all([
    verifyCiEvidence(evidence, buildSha, githubRead),
    readCloudflareDeployment(config, peer, cloudflareRead, {
      bootstrapStaging,
    }),
    verifyCurrentMainHead(buildSha, githubRead),
    verifyProtectedEnvironmentApproval(workflow, githubRead),
  ]);
  if (bootstrapStaging) {
    const active = observed.targetState.textBindings;
    requireDecision(
      observed.targetState.versionId === workflow.expectedActiveVersionId &&
        active.PUBLIC_ORIGIN === config.vars.PUBLIC_ORIGIN &&
        active.GUEST_CHALLENGE_MODE === config.vars.GUEST_CHALLENGE_MODE &&
        active.TURNSTILE_SITE_KEY === config.vars.TURNSTILE_SITE_KEY &&
        active.OAUTH_AUDIT_MODE === config.vars.OAUTH_AUDIT_MODE &&
        active.STAGING_EVIDENCE_MODE === config.vars.STAGING_EVIDENCE_MODE &&
        [
          "ENABLE_MCP_SUBSCRIPTIONS",
          "ENABLE_OPENAI_EVENTS",
          "ALLOW_OUTBOUND_NOTIFICATIONS",
        ].every(
          (name) => active[name] === "false" && config.vars[name] === "false",
        ) &&
        active.ALLOW_NEW_GUESTS === "true" &&
        active.ALLOW_NEW_TABLES === "true" &&
        config.vars.ALLOW_NEW_GUESTS === "false" &&
        config.vars.ALLOW_NEW_TABLES === "false",
      "staging-bootstrap-live-state-changed",
    );
  }
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
    ...(privatePilot ? { privatePilot } : {}),
    bootstrapStaging,
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
      /^\/repos\/kitamura-tetsuo\/agent-table\/(?:git\/ref\/heads\/main|actions\/runs\/[1-9]\d*(?:\/jobs\?per_page=100|\/approvals)?)$/.test(
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

function cliOptionalArgument(args, name) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const environment = cliArgument(args, "environment");
    const profile = cliArgument(args, "profile");
    const buildSha = cliArgument(args, "build-sha");
    const bootstrapFlag = cliOptionalArgument(args, "bootstrap-staging");
    requireDecision(
      bootstrapFlag === undefined ||
        bootstrapFlag === "true" ||
        bootstrapFlag === "false",
      "invalid-staging-bootstrap-flag",
    );
    const bootstrapStaging = bootstrapFlag === "true";
    const expectedVersion =
      cliOptionalArgument(args, "expected-active-version-id") ?? "";
    const dispatch = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
      : {};
    const result = await authorizeRelease({
      bootstrapStaging,
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
        bootstrapStaging:
          String(dispatch?.inputs?.bootstrap_staging) === "true",
        expectedActiveVersionId: String(
          dispatch?.inputs?.expected_active_version_id ?? "",
        ),
        eventSender: dispatch?.sender?.login,
      },
      requestedActiveVersionId: expectedVersion,
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
