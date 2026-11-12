import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  PRIVATE_PILOT_PROFILE,
  privatePilotConfiguration,
} from "../src/shared/private-pilot.ts";
import {
  cloudflareReader,
  ProviderVerificationError,
  readCloudflareDeployment,
  verifyDeployedConfiguration,
} from "./release-provider.mjs";

function requirePost(value, code) {
  if (!value) throw new ProviderVerificationError(code);
}

export async function verifyPublishedRelease({
  configText,
  peer,
  approval,
  cloudflareRead,
  httpFetch = fetch,
}) {
  let config;
  try {
    requirePost(typeof configText === "string", "post-deploy-config-invalid");
    config = JSON.parse(configText);
  } catch {
    throw new ProviderVerificationError("post-deploy-config-invalid");
  }
  requirePost(
    config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      config.vars &&
      typeof config.vars === "object" &&
      !Array.isArray(config.vars),
    "post-deploy-config-invalid",
  );
  requirePost(
    approval?.deploymentApproved === true &&
      approval.environment === config?.vars?.RELEASE_ENVIRONMENT &&
      approval.buildSha === config?.vars?.RELEASE_BUILD_SHA &&
      approval.profile === config?.vars?.RELEASE_PROFILE &&
      approval.configSha256 ===
        createHash("sha256").update(configText).digest("hex"),
    "post-deploy-approval-target-mismatch",
  );
  const profile = config.vars.RELEASE_PROFILE;
  const privatePolicy =
    profile === PRIVATE_PILOT_PROFILE
      ? privatePilotConfiguration(config.vars)
      : null;
  requirePost(
    profile === "manual" || privatePolicy,
    "post-deploy-profile-unverified",
  );
  if (privatePolicy) {
    requirePost(
      approval.privatePilot?.mode === privatePolicy.mode &&
        approval.privatePilot.observationMode ===
          privatePolicy.observationMode &&
        approval.privatePilot.policySha256 ===
          createHash("sha256")
            .update(config.vars.PRIVATE_PILOT_POLICY)
            .digest("hex") &&
        approval.privatePilot.notBefore === privatePolicy.notBefore &&
        approval.privatePilot.expiresAt === privatePolicy.expiresAt &&
        approval.privatePilot.deliveryEnabled ===
          (config.vars.ALLOW_OUTBOUND_NOTIFICATIONS === "true"),
      "post-deploy-private-pilot-approval-mismatch",
    );
  }
  const state = await readCloudflareDeployment(config, peer, cloudflareRead);
  verifyDeployedConfiguration(state.targetState, config);
  const before = approval.providerReceipt;
  requirePost(
    before?.accountId === state.targetState.accountId &&
      before.workerName === state.targetState.workerName &&
      before.kvId === state.targetState.kvId &&
      Object.keys(state.targetState.doNamespaces).every(
        (name) =>
          before.doNamespaces?.[name] === state.targetState.doNamespaces[name],
      ),
    "post-deploy-resource-identity-changed",
  );
  let response;
  try {
    response = await httpFetch(`${config.vars.PUBLIC_ORIGIN}/health`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ProviderVerificationError("post-deploy-origin-unreachable");
  }
  requirePost(
    response.status === 200 &&
      response.headers.get("Cache-Control") === "no-store" &&
      Number(response.headers.get("Content-Length") || 0) < 2048,
    "post-deploy-health-unverified",
  );
  let health;
  try {
    const reader = response.body?.getReader();
    requirePost(reader, "post-deploy-health-invalid");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        requirePost(size < 2048, "post-deploy-health-oversized");
        chunks.push(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof ProviderVerificationError) throw error;
    throw new ProviderVerificationError("post-deploy-health-invalid");
  }
  requirePost(
    health?.status === "ok" &&
      health.release?.environment === config.vars.RELEASE_ENVIRONMENT &&
      health.release?.profile === config.vars.RELEASE_PROFILE &&
      health.release?.buildSha === config.vars.RELEASE_BUILD_SHA,
    "post-deploy-build-not-observed",
  );
  return {
    verified: true,
    environment: config.vars.RELEASE_ENVIRONMENT,
    buildSha: config.vars.RELEASE_BUILD_SHA,
    profile: config.vars.RELEASE_PROFILE,
    oldVersionId: before.versionId,
    newVersionId: state.targetState.versionId,
  };
}

function cliArg(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  requirePost(index >= 0 && args[index + 1], `missing-argument:${name}`);
  return args[index + 1];
}

async function main() {
  try {
    const approvalText = readFileSync(cliArg("approval"), "utf8").trim();
    requirePost(
      approvalText.startsWith("RELEASE_APPROVAL_VALID "),
      "post-deploy-approval-missing",
    );
    const approval = JSON.parse(
      approvalText.slice("RELEASE_APPROVAL_VALID ".length),
    );
    const configText = readFileSync(cliArg("config"), "utf8");
    const peer = JSON.parse(readFileSync(cliArg("peer-config"), "utf8"));
    const result = await verifyPublishedRelease({
      configText,
      peer,
      approval,
      cloudflareRead: cloudflareReader(process.env.CLOUDFLARE_READ_TOKEN),
    });
    process.stdout.write(`POST_DEPLOY_VERIFIED ${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof ProviderVerificationError
        ? error.message
        : "post-deploy-state-unverified";
    process.stderr.write(`POST_DEPLOY_BLOCKED ${code}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
