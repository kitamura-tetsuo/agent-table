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
  // Report all rejected GETs in a phase using only fixed endpoint labels.
  // Never include provider error bodies or token values in diagnostics.
  const readBatch = async (entries) => {
    const outcomes = await Promise.allSettled(
      entries.map(([label, path, paged]) => read(label, path, paged)),
    );
    const refusedLabels = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "fulfilled") continue;
      const label = entries[index][0];
      if (
        !(outcome.reason instanceof ProviderVerificationError) ||
        outcome.reason.message !== `credential-read-refused:${label}`
      ) {
        throw outcome.reason;
      }
      refusedLabels.push(label);
    }
    if (refusedLabels.length > 0) {
      throw new ProviderVerificationError(
        `credential-read-refused:${refusedLabels.join(",")}`,
      );
    }
    return outcomes.map((outcome) => outcome.value);
  };

  const [domains, namespaces, ...initialResults] = await readBatch([
    ["domains", `${base}/workers/domains?page=1&per_page=100`, true],
    [
      "durable-objects",
      `${base}/workers/durable_objects/namespaces?page=1&per_page=100`,
      true,
    ],
    ...WORKERS.flatMap((worker) => {
      const prefix = `${base}/workers/scripts/${worker}`;
      return [
        [`${worker}-settings`, `${prefix}/settings`],
        [`${worker}-subdomain`, `${prefix}/subdomain`],
        [`${worker}-secrets`, `${prefix}/secrets`],
        [`${worker}-deployments`, `${prefix}/deployments`],
      ];
    }),
  ]);
  requireRead(Array.isArray(domains?.result), "credential-domains-unreadable");
  requireRead(
    Array.isArray(namespaces?.result),
    "credential-durable-objects-unreadable",
  );

  const workerResources = [];
  for (const [index, worker] of WORKERS.entries()) {
    const prefix = `${base}/workers/scripts/${worker}`;
    const [settings, subdomain, secrets, deployments] = initialResults.slice(
      index * 4,
      index * 4 + 4,
    );
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
    workerResources.push({
      worker,
      prefix,
      versionId,
      namespaceId: kvBindings[0].namespace_id,
    });
  }

  const dependentResults = await readBatch(
    workerResources.flatMap(({ worker, prefix, versionId, namespaceId }) => [
      [`${worker}-version`, `${prefix}/versions/${versionId}`],
      [`${worker}-kv`, `${base}/storage/kv/namespaces/${namespaceId}`],
    ]),
  );
  for (const [index, { namespaceId }] of workerResources.entries()) {
    const [version, kv] = dependentResults.slice(index * 2, index * 2 + 2);
    requireRead(
      Array.isArray(version?.resources?.bindings) &&
        Array.isArray(version?.resources?.script?.named_handlers) &&
        typeof version?.resources?.script_runtime?.migration_tag === "string",
      "credential-worker-version-unreadable",
    );
    requireRead(
      kv?.id?.toLowerCase() === namespaceId.toLowerCase(),
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
