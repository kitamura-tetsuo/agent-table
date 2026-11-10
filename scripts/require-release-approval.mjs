import { readFileSync } from "node:fs";

// A successful offline preflight is not an independently approved deployment.
// This gate consumes only the output of the in-job preflight command.
const [environment, buildSha] = process.argv.slice(2);
let approved = false;
try {
  const line = readFileSync(0, "utf8").trim();
  if (line.startsWith("PREFLIGHT_MANIFEST_VALID ")) {
    const manifest = JSON.parse(line.slice("PREFLIGHT_MANIFEST_VALID ".length));
    approved =
      manifest.preflightValid === true &&
      manifest.deploymentApproved === true &&
      manifest.environment === environment &&
      manifest.buildSha === buildSha &&
      manifest.profile === "manual" &&
      /^[a-f0-9]{40}$/.test(buildSha);
  }
} catch {
  // Invalid or incomplete evidence never unlocks a deployment.
}
if (!approved) {
  process.stderr.write("DEPLOYMENT_BLOCKED independent-approval-unavailable\n");
  process.exitCode = 1;
}
