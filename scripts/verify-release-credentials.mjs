import { pathToFileURL } from "node:url";
import {
  cloudflareReader,
  ProviderVerificationError,
} from "./release-provider.mjs";

const WORKERS = ["agent-table-staging", "agent-table-production"];
const LIVE_ACCOUNT_ID = "0fbaae27d3ff021bc17109f1493d0b2d";
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const NAMESPACE_ID = /^[a-f0-9]{32}$/i;
const VERSION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function requireRead(value, code) {
  if (!value) throw new ProviderVerificationError(code);
}

// A successful GET proves read access, not the absence of write permissions.
// Release readiness and exclusive domain ownership are checked separately.
export async function verifyReleaseReadAccess(accountId, request) {
  requireRead(ACCOUNT_ID.test(accountId), "credential-account-invalid");
  const base = `/client/v4/accounts/${accountId}`;
  const read = async (label, path, withPageInfo = false) => {
    try {
      return await request(path, withPageInfo);
    } catch (error) {
      if (
        error instanceof ProviderVerificationError &&
        ["provider-read-refused", "provider-result-unverified"].includes(
          error.message,
        )
      ) {
        throw new ProviderVerificationError(`credential-read-refused:${label}`);
      }
      throw error;
    }
  };
  const [domains, namespaces] = await Promise.all([
    read("domains", `${base}/workers/domains?page=1&per_page=100`, true),
    read(
      "durable-objects",
      `${base}/workers/durable_objects/namespaces?page=1&per_page=100`,
      true,
    ),
  ]);
  requireRead(Array.isArray(domains?.result), "credential-domains-unreadable");
  requireRead(
    Array.isArray(namespaces?.result),
    "credential-durable-objects-unreadable",
  );

  for (const worker of WORKERS) {
    const prefix = `${base}/workers/scripts/${worker}`;
    const [settings, subdomain, secrets, deployments] = await Promise.all([
      read(`${worker}-settings`, `${prefix}/settings`),
      read(`${worker}-subdomain`, `${prefix}/subdomain`),
      read(`${worker}-secrets`, `${prefix}/secrets`),
      read(`${worker}-deployments`, `${prefix}/deployments`),
    ]);
    requireRead(
      Array.isArray(settings?.bindings),
      "credential-worker-settings-unreadable",
    );
    requireRead(
      typeof subdomain?.enabled === "boolean" &&
        typeof subdomain?.previews_enabled === "boolean",
      "credential-worker-subdomain-unreadable",
    );
    requireRead(Array.isArray(secrets), "credential-secret-names-unreadable");
    requireRead(
      Array.isArray(deployments?.deployments) &&
        deployments.deployments.length > 0,
      "credential-deployments-unreadable",
    );
    const versionId = deployments.deployments[0]?.versions?.[0]?.version_id;
    requireRead(
      VERSION_ID.test(versionId),
      "credential-version-id-unavailable",
    );
    const kvBindings = settings.bindings.filter(
      (binding) =>
        binding?.type === "kv_namespace" && binding.name === "OAUTH_KV",
    );
    requireRead(
      kvBindings.length === 1 && NAMESPACE_ID.test(kvBindings[0].namespace_id),
      "credential-kv-id-unavailable",
    );
    const [version, kv] = await Promise.all([
      read(`${worker}-version`, `${prefix}/versions/${versionId}`),
      read(
        `${worker}-kv`,
        `${base}/storage/kv/namespaces/${kvBindings[0].namespace_id}`,
      ),
    ]);
    requireRead(
      Array.isArray(version?.resources?.bindings) &&
        Array.isArray(version?.resources?.script?.named_handlers) &&
        typeof version?.resources?.script_runtime?.migration_tag === "string",
      "credential-worker-version-unreadable",
    );
    requireRead(
      kv?.id?.toLowerCase() === kvBindings[0].namespace_id.toLowerCase(),
      "credential-kv-metadata-unreadable",
    );
  }
  return { verified: true, workersInspected: WORKERS.length };
}

async function main() {
  try {
    requireRead(
      process.env.CLOUDFLARE_ACCOUNT_ID === LIVE_ACCOUNT_ID,
      "credential-account-mismatch",
    );
    const result = await verifyReleaseReadAccess(
      process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareReader(process.env.CLOUDFLARE_READ_TOKEN),
    );
    process.stdout.write(
      `READ_CREDENTIAL_VERIFIED workers=${result.workersInspected}\n`,
    );
  } catch (error) {
    const code =
      error instanceof ProviderVerificationError
        ? error.message
        : "credential-verification-failed";
    process.stderr.write(`READ_CREDENTIAL_BLOCKED ${code}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
