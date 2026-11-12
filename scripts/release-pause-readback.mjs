import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  cloudflareReader,
  ProviderVerificationError,
  readCloudflareDeployment,
  verifyDeployedConfiguration,
} from "./release-provider.mjs";

const PAUSE_SWITCHES = [
  "ALLOW_NEW_GUESTS",
  "ALLOW_NEW_TABLES",
  "ENABLE_MCP_SUBSCRIPTIONS",
  "ENABLE_OPENAI_EVENTS",
  "ALLOW_OUTBOUND_NOTIFICATIONS",
];
const VERSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requirePause(value, code) {
  if (!value) throw new ProviderVerificationError(code);
}

/** Verify a normal intake pause using independent Cloudflare settings and active-version reads. */
export async function verifyNormalPause({
  config,
  peer,
  expectedVersionId,
  cloudflareRead,
}) {
  const vars = config?.vars;
  const environment = vars?.RELEASE_ENVIRONMENT;
  requirePause(
    (environment === "staging" || environment === "production") &&
      config.name === `agent-table-${environment}` &&
      peer?.name ===
        `agent-table-${environment === "staging" ? "production" : "staging"}` &&
      vars.RELEASE_PROFILE === "manual" &&
      /^[0-9a-f]{40}$/i.test(vars.RELEASE_BUILD_SHA) &&
      vars.RESTORE_QUARANTINE === "false",
    "pause-release-state-unverified",
  );
  requirePause(
    PAUSE_SWITCHES.every((name) => vars[name] === "false"),
    "pause-config-not-disabled",
  );
  requirePause(
    VERSION_ID.test(expectedVersionId ?? ""),
    "pause-expected-version-invalid",
  );
  const { targetState } = await readCloudflareDeployment(
    config,
    peer,
    cloudflareRead,
  );
  // The provider reader already compares each safety variable across service
  // settings and the 100%-traffic active version. Verify the intended values too.
  verifyDeployedConfiguration(targetState, config);
  requirePause(
    targetState.versionId === expectedVersionId,
    "pause-version-id-mismatch",
  );
  return {
    verified: true,
    environment,
    workerName: targetState.workerName,
    versionId: targetState.versionId,
    deploymentId: targetState.deploymentId,
    buildSha: vars.RELEASE_BUILD_SHA,
    admission: "paused",
  };
}

function cliOptions() {
  const argv = process.argv.slice(2);
  const names = new Set(["--config", "--peer-config", "--expected-version-id"]);
  requirePause(argv.length === names.size * 2, "pause-arguments-invalid");
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    requirePause(
      names.has(name) &&
        !options.has(name) &&
        typeof value === "string" &&
        value.length > 0 &&
        !value.startsWith("--"),
      "pause-arguments-invalid",
    );
    options.set(name, value);
  }
  return options;
}

async function main() {
  try {
    const options = cliOptions();
    const result = await verifyNormalPause({
      config: JSON.parse(readFileSync(options.get("--config"), "utf8")),
      peer: JSON.parse(readFileSync(options.get("--peer-config"), "utf8")),
      expectedVersionId: options.get("--expected-version-id"),
      cloudflareRead: cloudflareReader(process.env.CLOUDFLARE_READ_TOKEN),
    });
    process.stdout.write(`PAUSE_READBACK_VERIFIED ${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof ProviderVerificationError
        ? error.message
        : "pause-readback-unverified";
    process.stderr.write(`PAUSE_READBACK_BLOCKED ${code}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
