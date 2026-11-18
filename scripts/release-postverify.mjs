import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  PRIVATE_PILOT_PROFILE,
  privatePilotConfiguration,
} from "../src/shared/private-pilot.ts";
import {
  PRODUCTION_RELAY_EVENTS_PROFILE,
  productionRelayConfiguration,
} from "../src/shared/production-relay-events.ts";
import {
  TEST_NATIVE_EVENTS_PROFILE,
  TEST_NATIVE_EVENTS_RISK,
  testNativeEventsAllowed,
} from "../src/shared/test-native-events.ts";
import {
  cloudflareReader,
  ProviderVerificationError,
  readCloudflareDeployment,
  verifyDeployedConfiguration,
} from "./release-provider.mjs";

import {
  isPendingProductionRelayAcceptance,
  pendingProductionRelayAcceptance,
} from "./release-relay-decision.mjs";

function requirePost(value, code) {
  if (!value) throw new ProviderVerificationError(code);
}

const HEALTH_CONVERGENCE_MS = 30_000;
const HEALTH_RECHECK_MS = 2_000;

async function readPublishedHealth(origin, httpFetch, signal, remainingMs) {
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(10_000, remainingMs)))),
  ]);
  let response;
  try {
    response = await httpFetch(`${origin}/health`, {
      method: "GET",
      redirect: "error",
      signal: requestSignal,
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
    const cancel = () => {
      reader.cancel().catch(() => {});
    };
    requestSignal.addEventListener("abort", cancel, { once: true });
    if (requestSignal.aborted) cancel();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        requestSignal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        requirePost(size < 2048, "post-deploy-health-oversized");
        chunks.push(value);
      }
    } finally {
      requestSignal.removeEventListener("abort", cancel);
      cancel();
    }
    requestSignal.throwIfAborted();
    health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof ProviderVerificationError) throw error;
    throw new ProviderVerificationError("post-deploy-health-invalid");
  }
  requirePost(
    health &&
      typeof health === "object" &&
      !Array.isArray(health) &&
      health.status === "ok" &&
      health.release &&
      typeof health.release === "object" &&
      !Array.isArray(health.release) &&
      typeof health.release.environment === "string" &&
      typeof health.release.profile === "string" &&
      typeof health.release.buildSha === "string" &&
      /^[a-f0-9]{40}$/.test(health.release.buildSha),
    "post-deploy-health-invalid",
  );
  return health;
}

function healthMismatches(health, vars) {
  return [
    ["status", health?.status, "ok"],
    [
      "release.environment",
      health?.release?.environment,
      vars.RELEASE_ENVIRONMENT,
    ],
    ["release.profile", health?.release?.profile, vars.RELEASE_PROFILE],
    ["release.buildSha", health?.release?.buildSha, vars.RELEASE_BUILD_SHA],
  ]
    .filter(([, observed, expected]) => observed !== expected)
    .map(([field]) => field);
}

export async function verifyPublishedRelease({
  configText,
  peer,
  approval,
  cloudflareRead,
  httpFetch = fetch,
  healthNow = () => performance.now(),
  waitForHealth = (ms, signal) => delay(ms, undefined, { signal }),
  onHealthMismatch = () => {},
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
    profile === "manual" ||
      productionRelayConfiguration(config.vars) !== null ||
      privatePolicy ||
      testNativeEventsAllowed(config.vars),
    "post-deploy-profile-unverified",
  );
  if (
    profile === PRODUCTION_RELAY_EVENTS_PROFILE ||
    (profile === PRIVATE_PILOT_PROFILE &&
      config.vars.RELEASE_ENVIRONMENT === "production")
  ) {
    const relay = productionRelayConfiguration(config.vars);
    requirePost(
      relay &&
        isPendingProductionRelayAcceptance(approval.productionAcceptance) &&
        approval.productionRelay?.reviewAuthority ===
          "operator-reviewed-under-protected-environment" &&
        approval.productionRelay.machineVerifiedTransportEvidence === false &&
        approval.productionRelay.configurationSha256 ===
          createHash("sha256")
            .update(config.vars.EVENTS_RELAY_CONFIGURATION)
            .digest("hex") &&
        approval.productionRelay.callbackTargetsSha256 ===
          createHash("sha256")
            .update(config.vars.EVENTS_REVIEWED_CALLBACK_TARGETS)
            .digest("hex") &&
        approval.productionRelay.signingPublicKeySha256 ===
          relay.signingPublicKeySha256 &&
        /^[a-f0-9]{64}$/.test(approval.productionRelay.decisionSha256),
      "post-deploy-production-relay-approval-mismatch",
    );
  }
  if (profile === TEST_NATIVE_EVENTS_PROFILE) {
    requirePost(
      approval.testNativeEvents?.risk === TEST_NATIVE_EVENTS_RISK &&
        approval.testNativeEvents.targetsSha256 ===
          createHash("sha256")
            .update(config.vars.EVENTS_REVIEWED_CALLBACK_TARGETS)
            .digest("hex"),
      "post-deploy-test-native-events-approval-mismatch",
    );
  }
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
  const before = approval.providerReceipt;
  const verifySnapshot = ({ targetState }) => {
    verifyDeployedConfiguration(targetState, config);
    requirePost(
      before?.accountId === targetState.accountId &&
        before.workerName === targetState.workerName &&
        before.kvId === targetState.kvId &&
        Object.keys(targetState.doNamespaces).every(
          (name) =>
            before.doNamespaces?.[name] === targetState.doNamespaces[name],
        ),
      "post-deploy-resource-identity-changed",
    );
  };
  const state = await readCloudflareDeployment(config, peer, cloudflareRead);
  verifySnapshot(state);
  const startedAt = healthNow();
  const deadline = startedAt + HEALTH_CONVERGENCE_MS;
  const window = new AbortController();
  const inWindow = () =>
    requirePost(
      !window.signal.aborted && healthNow() < deadline,
      "post-deploy-build-not-observed",
    );
  let timer;
  try {
    await Promise.race([
      (async () => {
        for (let attempt = 1; ; attempt++) {
          inWindow();
          const health = await readPublishedHealth(
            config.vars.PUBLIC_ORIGIN,
            httpFetch,
            window.signal,
            deadline - healthNow(),
          );
          inWindow();
          const mismatches = healthMismatches(health, config.vars);
          if (mismatches.length === 0) {
            if (attempt > 1) {
              // A delayed health response cannot authorize a different deployment.
              const settled = await readCloudflareDeployment(
                config,
                peer,
                async (path) => {
                  inWindow();
                  const value = await cloudflareRead(path);
                  inWindow();
                  return value;
                },
              );
              verifySnapshot(settled);
              requirePost(
                settled.targetState.versionId === state.targetState.versionId &&
                  settled.targetState.deploymentId ===
                    state.targetState.deploymentId,
                "post-deploy-version-changed",
              );
            }
            inWindow();
            return;
          }
          // Field names only: never log the remote body or observed values.
          onHealthMismatch({
            attempt,
            elapsedMs: Math.max(0, Math.floor(healthNow() - startedAt)),
            mismatches,
          });
          inWindow();
          await waitForHealth(
            Math.min(HEALTH_RECHECK_MS, deadline - healthNow()),
            window.signal,
          );
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ProviderVerificationError("post-deploy-build-not-observed"),
          );
          window.abort();
        }, HEALTH_CONVERGENCE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    window.abort();
  }
  return {
    verified: true,
    ...(profile === PRODUCTION_RELAY_EVENTS_PROFILE ||
    (profile === PRIVATE_PILOT_PROFILE &&
      config.vars.RELEASE_ENVIRONMENT === "production")
      ? {
          verificationScope: "serving-configuration",
          configSha256: approval.configSha256,
          productionAcceptance: pendingProductionRelayAcceptance(),
        }
      : {}),
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
      onHealthMismatch: (observation) => {
        process.stderr.write(
          `POST_DEPLOY_HEALTH_RECHECK ${JSON.stringify(observation)}\n`,
        );
      },
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
