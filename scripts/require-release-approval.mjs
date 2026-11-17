import { readFileSync } from "node:fs";
import {
  PRIVATE_PILOT_MAX_WINDOW_MS,
  PRIVATE_PILOT_PROFILE,
} from "../src/shared/private-pilot.ts";
import { PRODUCTION_RELAY_EVENTS_PROFILE } from "../src/shared/production-relay-events.ts";
import {
  TEST_NATIVE_EVENTS_PROFILE,
  TEST_NATIVE_EVENTS_RISK,
} from "../src/shared/test-native-events.ts";
import { isPendingProductionRelayAcceptance } from "./release-relay-decision.mjs";

// A successful offline preflight is not deployment authorization.
// This gate consumes only the output of the environment-bound live verifier.
const [environment, buildSha, configSha256, profile = "manual"] =
  process.argv.slice(2);
let approved = false;
try {
  const line = readFileSync(0, "utf8").trim();
  if (line.startsWith("RELEASE_APPROVAL_VALID ")) {
    const manifest = JSON.parse(line.slice("RELEASE_APPROVAL_VALID ".length));
    approved =
      manifest.preflightValid === true &&
      manifest.deploymentApproved === true &&
      manifest.approvalSource ===
        (environment === "staging"
          ? "reviewer-free-staging-and-live-provider-readback"
          : "protected-environment-and-live-provider-readback") &&
      manifest.environment === environment &&
      manifest.buildSha === buildSha &&
      manifest.configSha256 === configSha256 &&
      manifest.profile === profile &&
      (profile === "manual" ||
        (profile === PRODUCTION_RELAY_EVENTS_PROFILE &&
          environment === "production" &&
          isPendingProductionRelayAcceptance(manifest.productionAcceptance) &&
          manifest.productionRelay?.reviewAuthority ===
            "operator-reviewed-under-protected-environment" &&
          manifest.productionRelay.machineVerifiedTransportEvidence === false &&
          [
            "configurationSha256",
            "callbackTargetsSha256",
            "signingPublicKeySha256",
            "decisionSha256",
          ].every((k) => /^[a-f0-9]{64}$/.test(manifest.productionRelay[k]))) ||
        (profile === TEST_NATIVE_EVENTS_PROFILE &&
          environment === "staging" &&
          manifest.testNativeEvents?.risk === TEST_NATIVE_EVENTS_RISK &&
          /^[a-f0-9]{64}$/.test(manifest.testNativeEvents.targetsSha256)) ||
        (profile === PRIVATE_PILOT_PROFILE &&
          (environment === "staging" ||
            (environment === "production" &&
              manifest.privatePilot?.mode === "a-only" &&
              isPendingProductionRelayAcceptance(
                manifest.productionAcceptance,
              ) &&
              manifest.productionRelay?.reviewAuthority ===
                "operator-reviewed-under-protected-environment" &&
              manifest.productionRelay.machineVerifiedTransportEvidence ===
                false &&
              [
                "configurationSha256",
                "callbackTargetsSha256",
                "signingPublicKeySha256",
                "decisionSha256",
              ].every((k) =>
                /^[a-f0-9]{64}$/.test(manifest.productionRelay[k]),
              ))) &&
          ["a-only", "a-only-discovery"].includes(
            manifest.privatePilot?.mode,
          ) &&
          (manifest.privatePilot.observationMode === undefined ||
            manifest.privatePilot.observationMode === "private-redacted") &&
          /^[a-f0-9]{64}$/.test(manifest.privatePilot.policySha256) &&
          Date.parse(manifest.privatePilot.notBefore) <
            Date.parse(manifest.privatePilot.expiresAt) &&
          Date.parse(manifest.privatePilot.expiresAt) -
            Date.parse(manifest.privatePilot.notBefore) <=
            PRIVATE_PILOT_MAX_WINDOW_MS &&
          (manifest.privatePilot.mode === "a-only-discovery"
            ? manifest.privatePilot.observationMode === "private-redacted" &&
              manifest.privatePilot.deliveryEnabled === false &&
              Date.parse(manifest.privatePilot.notBefore) <= Date.now() &&
              Date.parse(manifest.privatePilot.expiresAt) > Date.now()
            : manifest.privatePilot.deliveryEnabled === false ||
              (manifest.privatePilot.deliveryEnabled === true &&
                Date.parse(manifest.privatePilot.notBefore) <= Date.now() &&
                Date.parse(manifest.privatePilot.expiresAt) > Date.now())))) &&
      /^[1-9]\d*$/.test(manifest.workflowRunId) &&
      /^[1-9]\d*$/.test(manifest.workflowRunAttempt) &&
      /^[1-9]\d*$/.test(manifest.ciRunId) &&
      /^[a-f0-9]{64}$/.test(manifest.providerReceiptSha256) &&
      manifest.providerReceipt?.environment === environment &&
      manifest.providerReceipt?.workerName === `agent-table-${environment}` &&
      /^[a-f0-9]{40}$/.test(buildSha) &&
      /^[a-f0-9]{64}$/.test(configSha256);
  }
} catch {
  // Invalid or incomplete evidence never unlocks a deployment.
}
if (!approved) {
  process.stderr.write("DEPLOYMENT_BLOCKED independent-approval-unavailable\n");
  process.exitCode = 1;
}
