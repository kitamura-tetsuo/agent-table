import { readFileSync } from "node:fs";
import {
  PRIVATE_PILOT_MAX_WINDOW_MS,
  PRIVATE_PILOT_PROFILE,
} from "../src/shared/private-pilot.ts";

// A successful offline preflight is not an independently approved deployment.
// This gate consumes only the output of the live verifier in the protected job.
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
        "protected-environment-and-live-provider-readback" &&
      manifest.environment === environment &&
      manifest.buildSha === buildSha &&
      manifest.configSha256 === configSha256 &&
      manifest.profile === profile &&
      (profile === "manual" ||
        (profile === PRIVATE_PILOT_PROFILE &&
          environment === "staging" &&
          manifest.privatePilot?.mode === "a-only" &&
          /^[a-f0-9]{64}$/.test(manifest.privatePilot.policySha256) &&
          Date.parse(manifest.privatePilot.notBefore) <
            Date.parse(manifest.privatePilot.expiresAt) &&
          Date.parse(manifest.privatePilot.expiresAt) -
            Date.parse(manifest.privatePilot.notBefore) <=
            PRIVATE_PILOT_MAX_WINDOW_MS &&
          (manifest.privatePilot.deliveryEnabled === false ||
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
