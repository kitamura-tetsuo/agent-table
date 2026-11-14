import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { requireRecovery } from "./recovery-configuration.mjs";
import { runFreshStartRecovery } from "./recovery-execution.mjs";
import {
  deleteInventoriedOAuthKeys,
  inventoryRecoveryResources,
  recoveryCloudflareClient,
} from "./recovery-provider.mjs";
import {
  githubRecoveryClient,
  readRecoveryJournal,
  writeRecoveryJournalCAS,
} from "./recovery-record.mjs";
import {
  githubReader,
  verifyCiEvidence,
  verifyCurrentMainHead,
  verifyProtectedEnvironmentApproval,
} from "./release-authorization.mjs";
import {
  cloudflareReader,
  readCloudflareDeployment,
  verifyDeployedConfiguration,
} from "./release-provider.mjs";

const execFileAsync = promisify(execFile);

/** Detach RPC metadata while its live platform proxy is still available. */
export function recoveryControlAdapter(control) {
  const detached = async (result) => JSON.parse(JSON.stringify(await result));
  return {
    identity: () => detached(control.identity()),
    inspect: (request) => detached(control.inspect(request)),
    reset: (request) => detached(control.reset(request)),
  };
}

/** Authenticated remote Service binding: no public operator HTTP endpoint. */
export async function connectRecoveryControl(
  namespaceIdentity,
  operationId,
  directory = process.cwd(),
) {
  const path = resolve(directory, `.recovery-client-${operationId}.json`);
  const config = {
    name: `agent-table-recovery-client-${operationId.slice(0, 8)}`,
    account_id: namespaceIdentity.accountId,
    compatibility_date: "2026-11-07",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    services: [
      {
        binding: "RECOVERY",
        service: namespaceIdentity.workerName,
        entrypoint: "RecoveryControl",
        remote: true,
      },
    ],
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: "wx" });
  let platform;
  try {
    const { getPlatformProxy } = await import("wrangler");
    platform = await getPlatformProxy({
      configPath: path,
      envFiles: [],
      persist: false,
      remoteBindings: true,
    });
    return {
      ...recoveryControlAdapter(platform.env.RECOVERY),
      dispose: async () => {
        await platform.dispose();
        await unlink(path);
      },
    };
  } catch (error) {
    if (platform) await platform.dispose();
    await unlink(path);
    throw error;
  }
}

export async function deployRecoveryConfiguration(
  config,
  operationId,
  directory = process.cwd(),
) {
  requireRecovery(
    /^[a-f0-9-]{36}$/.test(operationId),
    "recovery-operation-id-invalid",
  );
  const path = resolve(directory, `.recovery-deploy-${operationId}.json`);
  await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: "wx" });
  try {
    // Preserve the explicit immediate-update argument in reviewed workflow code.
    // Provider GET does not return this write-only deployment option.
    await execFileAsync(
      process.execPath,
      [
        resolve(directory, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        path,
        "--durable-objects-code-update-mode",
        "immediate",
      ],
      {
        cwd: directory,
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      },
    );
  } catch {
    throw new Error("recovery-deployment-failed");
  } finally {
    await unlink(path);
  }
}

export async function verifyRecoveryIngress(config, fetchImpl = fetch) {
  const routes = [
    ["/health", "GET"],
    ["/guest/me", "GET"],
    ["/guest/connections", "GET"],
    ["/guest/table", "GET"],
    ["/join", "POST"],
    ["/mcp", "POST"],
    ["/oauth/register", "POST"],
    ["/oauth/token", "POST"],
    ["/oauth/revoke", "POST"],
  ];
  try {
    for (const [path, method] of routes) {
      const response = await fetchImpl(`${config.vars.PUBLIC_ORIGIN}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (
        response.status !== 503 ||
        response.headers.get("Cache-Control") !== "no-store"
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function health(config) {
  try {
    const response = await fetch(`${config.vars.PUBLIC_ORIGIN}/health`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (
      response.headers.get("Cache-Control") !== "no-store" ||
      response.status !== 200
    )
      return false;
    const text = await response.text();
    if (Buffer.byteLength(text) > 2048) return false;
    const value = JSON.parse(text);
    return (
      value.status === "ok" &&
      value.release?.buildSha === config.vars.RELEASE_BUILD_SHA &&
      value.release?.environment === config.vars.RELEASE_ENVIRONMENT &&
      value.release?.profile === "manual"
    );
  } catch {
    return false;
  }
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  requireRecovery(
    index >= 2 && typeof process.argv[index + 1] === "string",
    "recovery-cli-argument-missing",
  );
  return process.argv[index + 1];
}

async function main() {
  try {
    const plan = JSON.parse(await readFile(arg("plan"), "utf8"));
    const environment = arg("environment");
    const event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const workflow = {
      kind: "recovery",
      repository: process.env.GITHUB_REPOSITORY,
      environment,
      ref: process.env.GITHUB_REF,
      eventName: process.env.GITHUB_EVENT_NAME,
      sha: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    };
    requireRecovery(
      workflow.repository === "kitamura-tetsuo/agent-table" &&
        workflow.ref === "refs/heads/main" &&
        workflow.eventName === "workflow_dispatch" &&
        workflow.sha === arg("build-sha") &&
        event.inputs?.expected_sha === workflow.sha &&
        environment === plan.environment &&
        event.inputs?.expected_plan_sha256 === arg("plan-sha256") &&
        event.inputs?.phase === arg("phase") &&
        event.inputs?.expected_active_version_id ===
          arg("expected-active-version-id") &&
        (event.inputs?.expected_record_sha256 ?? "") ===
          arg("expected-record-sha256"),
      "recovery-dispatch-not-verified",
    );
    const githubRead = githubReader(process.env.GITHUB_TOKEN);
    const journalClient = githubRecoveryClient(process.env.GITHUB_TOKEN);
    const cloudflareRead = cloudflareReader(process.env.CLOUDFLARE_READ_TOKEN);
    const providerClient = recoveryCloudflareClient(
      process.env.CLOUDFLARE_API_TOKEN,
    );
    requireRecovery(
      plan.namespaceIdentity.accountId === process.env.CLOUDFLARE_ACCOUNT_ID,
      "recovery-account-mismatch",
    );
    const result = await runFreshStartRecovery({
      plan,
      planSha256: arg("plan-sha256"),
      phase: arg("phase"),
      workflow,
      privateKey: process.env.RECOVERY_SIGNING_KEY,
      expectedActiveVersionId: arg("expected-active-version-id"),
      expectedRecordSha256: arg("expected-record-sha256") || null,
      dependencies: {
        authorize: async (current) => {
          await Promise.all([
            verifyCiEvidence(current.ciEvidence, current.buildSha, githubRead),
            verifyCurrentMainHead(current.buildSha, githubRead),
            verifyProtectedEnvironmentApproval(workflow, githubRead),
          ]);
        },
        authorizeSource: (sha) => verifyCurrentMainHead(sha, githubRead),
        readJournal: () => readRecoveryJournal(environment, journalClient),
        writeJournal: (record, expected) =>
          writeRecoveryJournalCAS(record, expected, journalClient),
        readProvider: (config, peer) =>
          readCloudflareDeployment(config, peer, cloudflareRead),
        verifyDeployed: verifyDeployedConfiguration,
        deploy: (config) =>
          deployRecoveryConfiguration(config, plan.operationId),
        connectControl: (identity) =>
          connectRecoveryControl(identity, plan.operationId),
        inventory: (identity) =>
          inventoryRecoveryResources(identity, providerClient),
        deleteOAuthKeys: (identity, inventory) =>
          deleteInventoriedOAuthKeys(identity, inventory, providerClient),
        verifyIngressDenied: verifyRecoveryIngress,
        verifyServing: health,
      },
    });
    await writeFile(arg("result"), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    process.stdout.write(
      `RECOVERY_RESULT ${JSON.stringify({ phase: result.phase, journalSha256: result.journalSha256, clearanceExecuted: result.clearanceExecuted })}\n`,
    );
  } catch {
    // The caller must inspect protected evidence, never raw API/CLI exception
    // text that can contain a credential, identifier or response body.
    process.stderr.write(
      "RECOVERY_BLOCKED: verification or execution failed; inspect actual provider and journal state before proceeding. Quarantine restoration is not confirmed by this error.\n",
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
