import { createHash } from "node:crypto";
import { PRIVATE_PILOT_PROFILE } from "../src/shared/private-pilot.ts";

// All provider calls are GETs to the fixed Cloudflare API origin. The raw
// responses, which may include secrets, never enter logs or persisted receipts.
const API_ORIGIN = "https://api.cloudflare.com";
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAMESPACE_ID = /^[a-f0-9]{32}$/i;
const REQUIRED_DOS = new Map([
  ["TABLES", "TableDO"],
  ["GUESTS", "GuestDO"],
  ["OAUTH_SERIALIZER", "OAuthTokenDO"],
  ["ADMISSION", "AdmissionDO"],
]);
const REQUIRED_SECRETS = [
  "INVITATION_RESPONSE_KEYRING",
  "CALLBACK_CREDENTIAL_KEYRING",
];
const RELEASE_VARS = [
  "PUBLIC_ORIGIN",
  "RELEASE_ENVIRONMENT",
  "RELEASE_BUILD_SHA",
  "RELEASE_PROFILE",
  "RESTORE_QUARANTINE",
  "ENABLE_MCP_SUBSCRIPTIONS",
  "ENABLE_OPENAI_EVENTS",
  "ALLOW_OUTBOUND_NOTIFICATIONS",
  "ALLOW_NEW_GUESTS",
  "ALLOW_NEW_TABLES",
];
// The only initial staging exception is four absent identity bindings.
// Never permit missing data-resource, exposure, or safety bindings.
const LEGACY_STAGING_ABSENT = [
  "RELEASE_ENVIRONMENT",
  "RELEASE_BUILD_SHA",
  "RELEASE_PROFILE",
  "RESTORE_QUARANTINE",
];

export class ProviderVerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProviderVerificationError";
  }
}

function ensure(value, code) {
  if (!value) throw new ProviderVerificationError(code);
}

function readBinding(bindings, name, type) {
  const matches = bindings.filter((item) => item?.name === name);
  ensure(matches.length === 1 && matches[0].type === type, "binding-mismatch");
  return matches[0];
}

function validateAccountWorker(config) {
  ensure(ACCOUNT_ID.test(config?.account_id), "invalid-provider-account");
  ensure(WORKER_NAME.test(config?.name), "invalid-provider-worker");
}

/**
 * Inspect one existing deployment, including the currently deployed version.
 * It is deliberately not a bootstrap path for an unknown production Worker.
 */
export async function inspectWorker(
  config,
  request,
  domains,
  namespaces,
  { bootstrapStaging = false } = {},
) {
  validateAccountWorker(config);
  const prefix = `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}`;
  const kvId = config.kv_namespaces[0].id.toLowerCase();
  const [settings, subdomain, secretList, namespace, deployments] =
    await Promise.all([
      request(`${prefix}/settings`),
      request(`${prefix}/subdomain`),
      request(`${prefix}/secrets`),
      request(
        `/client/v4/accounts/${config.account_id}/storage/kv/namespaces/${kvId}`,
      ),
      request(`${prefix}/deployments`),
    ]);

  ensure(Array.isArray(settings?.bindings), "provider-bindings-unavailable");
  ensure(Array.isArray(namespaces), "provider-do-list-unavailable");
  const doNamespaces = {};
  for (const [name, className] of REQUIRED_DOS) {
    const binding = readBinding(
      settings.bindings,
      name,
      "durable_object_namespace",
    );
    const owned = namespaces.filter(
      (item) => item?.script === config.name && item?.class === className,
    );
    ensure(
      binding.class_name === className &&
        !binding.script_name &&
        !binding.environment &&
        !binding.dispatch_namespace &&
        owned.length === 1 &&
        NAMESPACE_ID.test(owned[0].id) &&
        owned[0].use_sqlite === true &&
        (!binding.namespace_id ||
          binding.namespace_id.toLowerCase() === owned[0].id.toLowerCase()),
      "provider-do-ownership-unverified",
    );
    doNamespaces[name] = owned[0].id.toLowerCase();
  }
  ensure(
    new Set(Object.values(doNamespaces)).size === REQUIRED_DOS.size,
    "provider-do-namespace-reused",
  );
  const kv = readBinding(settings.bindings, "OAUTH_KV", "kv_namespace");
  ensure(
    kv.namespace_id?.toLowerCase() === kvId &&
      namespace?.id?.toLowerCase() === kvId,
    "provider-kv-ownership-unverified",
  );

  // Check the deployed version, not an uploaded-but-never-deployed candidate.
  ensure(
    Array.isArray(deployments?.deployments) &&
      deployments.deployments.length > 0,
    "provider-deployment-unavailable",
  );
  const latest = deployments.deployments[0];
  const activeVersions = latest?.versions;
  ensure(
    Array.isArray(activeVersions) &&
      activeVersions.length === 1 &&
      activeVersions[0]?.percentage === 100 &&
      /^[0-9a-f-]{36}$/i.test(activeVersions[0].version_id),
    "provider-traffic-split-unverified",
  );
  const versionId = activeVersions[0].version_id;
  const version = await request(`${prefix}/versions/${versionId}`);
  const runtime = version?.resources?.script_runtime;
  const versionBindings = version?.resources?.bindings;
  const namedHandlers = version?.resources?.script?.named_handlers;
  ensure(
    Array.isArray(versionBindings) && Array.isArray(namedHandlers),
    "provider-version-schema-unverified",
  );
  ensure(
    typeof config.migrations?.at(-1)?.tag === "string" &&
      runtime?.migration_tag === config.migrations.at(-1).tag,
    "provider-migration-tag-unverified",
  );
  // Cloudflare's declarative script_runtime.exports is optional in its version
  // API. Verify named class handlers and the active version's DO bindings
  // independently, then use the account namespace list for SQLite ownership.
  const exports = runtime.exports;
  ensure(
    exports === undefined || (exports && typeof exports === "object"),
    "provider-schema-unverified",
  );
  ensure(
    versionBindings.filter((item) => item?.type === "durable_object_namespace")
      .length === REQUIRED_DOS.size,
    "provider-version-extra-do-binding",
  );
  for (const [name, className] of REQUIRED_DOS) {
    const bound = readBinding(
      versionBindings,
      name,
      "durable_object_namespace",
    );
    ensure(
      bound.class_name === className &&
        bound.namespace_id?.toLowerCase() === doNamespaces[name] &&
        !bound.script_name &&
        !bound.environment &&
        !bound.dispatch_namespace,
      "provider-version-do-binding-mismatch",
    );
    ensure(
      namedHandlers.filter(
        (item) =>
          item?.name === className &&
          Array.isArray(item.handlers) &&
          item.handlers.includes("class"),
      ).length === 1,
      "provider-class-export-unverified",
    );
    if (exports !== undefined) {
      ensure(
        exports[className]?.type === "durable-object" &&
          exports[className]?.storage === "sqlite" &&
          exports[className]?.state !== "expecting-transfer",
        "provider-sqlite-class-unverified",
      );
    }
  }
  const versionKv = readBinding(versionBindings, "OAUTH_KV", "kv_namespace");
  ensure(
    versionKv.namespace_id?.toLowerCase() === kvId,
    "provider-version-kv-binding-mismatch",
  );

  ensure(
    subdomain?.enabled === false && subdomain?.previews_enabled === false,
    "provider-public-subdomain-enabled",
  );
  ensure(Array.isArray(secretList), "provider-secret-list-unavailable");
  const secretNames = new Set(secretList.map((item) => item?.name));
  for (const secret of REQUIRED_SECRETS) {
    ensure(secretNames.has(secret), "provider-required-secret-missing");
  }
  if (config.vars.GUEST_CHALLENGE_MODE === "required") {
    ensure(
      secretNames.has("TURNSTILE_SECRET"),
      "provider-challenge-secret-missing",
    );
  }
  ensure(Array.isArray(domains), "provider-domains-unavailable");
  const hostname = new URL(config.vars.PUBLIC_ORIGIN).hostname;
  const claimed = domains.filter((item) => item?.service === config.name);
  ensure(
    claimed.length === 1 &&
      domains.filter((item) => item?.hostname === hostname).length === 1 &&
      claimed[0].hostname === hostname &&
      claimed[0].enabled === true &&
      claimed[0].previews_enabled === false,
    "provider-origin-not-exclusive",
  );

  // Read back safe text binding values only; never retain text from secrets.
  const textBindings = Object.fromEntries(
    settings.bindings
      .filter((binding) => binding?.type === "plain_text")
      .map((binding) => [binding.name, binding.text]),
  );
  const versionText = Object.fromEntries(
    versionBindings
      .filter((binding) => binding?.type === "plain_text")
      .map((binding) => [binding.name, binding.text]),
  );
  const missingIdentity = [];
  for (const name of RELEASE_VARS) {
    if (
      bootstrapStaging &&
      config.name === "agent-table-staging" &&
      LEGACY_STAGING_ABSENT.includes(name) &&
      textBindings[name] === undefined &&
      versionText[name] === undefined
    ) {
      missingIdentity.push(name);
      continue;
    }
    ensure(
      typeof textBindings[name] === "string" &&
        versionText[name] === textBindings[name],
      "provider-version-config-unverified",
    );
  }
  // Older manual deployments legitimately omit the private policy. If either
  // surface retains it, verify its exact bytes and unique nonsecret type on both.
  // Do not require the new candidate's policy during a pre-deploy manual readback.
  const policyName = "PRIVATE_PILOT_POLICY";
  const policyPresent =
    settings.bindings.some((binding) => binding?.name === policyName) ||
    versionBindings.some((binding) => binding?.name === policyName);
  if (policyPresent) {
    const settingsPolicy = readBinding(
      settings.bindings,
      policyName,
      "plain_text",
    );
    const versionPolicy = readBinding(
      versionBindings,
      policyName,
      "plain_text",
    );
    ensure(
      typeof settingsPolicy.text === "string" &&
        settingsPolicy.text === versionPolicy.text,
      "provider-private-pilot-policy-unverified",
    );
  }
  ensure(
    textBindings.RELEASE_PROFILE !== PRIVATE_PILOT_PROFILE || policyPresent,
    "provider-private-pilot-policy-unverified",
  );
  if (bootstrapStaging) {
    ensure(
      config.name === "agent-table-staging" &&
        missingIdentity.length === LEGACY_STAGING_ABSENT.length &&
        LEGACY_STAGING_ABSENT.every((name) => missingIdentity.includes(name)),
      "staging-bootstrap-identity-state-unverified",
    );
  }
  return {
    missingIdentity,
    accountId: config.account_id.toLowerCase(),
    workerName: config.name,
    origin: config.vars.PUBLIC_ORIGIN,
    kvId,
    doNamespaces,
    deploymentId: latest.id,
    versionId,
    secretNames: [...secretNames].sort(),
    textBindings,
  };
}

export function verifyProviderIsolation(
  target,
  peer,
  targetConfig,
  peerConfig,
) {
  ensure(
    target.accountId === targetConfig.account_id.toLowerCase() &&
      peer.accountId === peerConfig.account_id.toLowerCase() &&
      target.workerName !== peer.workerName &&
      target.origin !== peer.origin &&
      target.kvId !== peer.kvId,
    "provider-environment-mixing",
  );
  const own = new Set(Object.values(target.doNamespaces));
  ensure(
    Object.values(peer.doNamespaces).every((id) => !own.has(id)),
    "provider-environment-shared-do",
  );
}

export function verifyDeployedConfiguration(observed, config) {
  for (const name of RELEASE_VARS) {
    ensure(
      observed.textBindings[name] === config.vars[name],
      "provider-deployed-config-mismatch",
    );
  }
  const policy = config.vars.PRIVATE_PILOT_POLICY;
  ensure(
    (policy === undefined || typeof policy === "string") &&
      observed.textBindings.PRIVATE_PILOT_POLICY === policy &&
      (config.vars.RELEASE_PROFILE !== PRIVATE_PILOT_PROFILE ||
        typeof policy === "string"),
    "provider-deployed-private-pilot-policy-mismatch",
  );
}

export function redactedProviderReceipt(observed, environment, timestamp) {
  return {
    environment,
    accountId: observed.accountId,
    workerName: observed.workerName,
    origin: observed.origin,
    kvId: observed.kvId,
    doNamespaces: observed.doNamespaces,
    deploymentId: observed.deploymentId,
    versionId: observed.versionId,
    observedAt: timestamp,
  };
}

export function receiptDigest(receipt) {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

// The network helper caps bodies before JSON parsing and never reports API
// response content, request headers, tokens or the original exception text.
export function cloudflareReader(token, fetchImpl = fetch) {
  ensure(
    typeof token === "string" && token.length > 10,
    "provider-token-missing",
  );
  return async (path, withPageInfo = false) => {
    ensure(
      path.startsWith("/client/v4/accounts/") && !path.includes(".."),
      "provider-path-invalid",
    );
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ProviderVerificationError("provider-unreachable");
    }
    ensure(response.ok, "provider-read-refused");
    const reader = response.body?.getReader();
    ensure(reader, "provider-body-unavailable");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        ensure(size <= 128 * 1024, "provider-body-oversized");
        chunks.push(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    let envelope;
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ProviderVerificationError("provider-json-invalid");
    }
    ensure(envelope?.success === true, "provider-result-unverified");
    return withPageInfo
      ? { result: envelope.result, resultInfo: envelope.result_info }
      : envelope.result;
  };
}

export async function readCloudflareDeployment(
  config,
  peer,
  reader,
  { bootstrapStaging = false } = {},
) {
  const accounts = new Map();
  for (const value of [config, peer]) {
    if (accounts.has(value.account_id)) continue;
    const prefix = `/client/v4/accounts/${value.account_id}`;
    const [domains, namespaces] = await Promise.all([
      readAllPages(
        reader,
        `${prefix}/workers/domains`,
        "provider-domain-pagination-unverified",
      ),
      readAllPages(
        reader,
        `${prefix}/workers/durable_objects/namespaces`,
        "provider-do-pagination-unverified",
      ),
    ]);
    accounts.set(value.account_id, { domains, namespaces });
  }
  const [targetState, peerState] = await Promise.all([
    inspectWorker(
      config,
      reader,
      accounts.get(config.account_id).domains,
      accounts.get(config.account_id).namespaces,
      { bootstrapStaging },
    ),
    inspectWorker(
      peer,
      reader,
      accounts.get(peer.account_id).domains,
      accounts.get(peer.account_id).namespaces,
    ),
  ]);
  verifyProviderIsolation(targetState, peerState, config, peer);
  return { targetState, peerState };
}

async function readAllPages(reader, path, code) {
  const items = [];
  const perPage = 100;
  let totalPages = 1;
  let totalCount;
  for (let page = 1; page <= totalPages; page++) {
    const response = await reader(
      `${path}?page=${page}&per_page=${perPage}`,
      true,
    );
    const info = response?.resultInfo;
    const count = response?.result?.length;
    const reportedTotal = info?.total_count;
    // Cloudflare uses total_count rather than total_pages on these endpoints.
    // Validate every returned page and refuse incomplete or shifting listings.
    const pages = Math.max(1, Math.ceil(reportedTotal / perPage));
    const expectedCount = Math.min(
      perPage,
      Math.max(0, reportedTotal - (page - 1) * perPage),
    );
    ensure(
      Array.isArray(response?.result) &&
        info?.page === page &&
        info.per_page === perPage &&
        info.count === count &&
        Number.isSafeInteger(reportedTotal) &&
        reportedTotal >= 0 &&
        pages <= 20 &&
        (info.total_pages === undefined || info.total_pages === pages) &&
        (page === 1 ||
          (pages === totalPages && reportedTotal === totalCount)) &&
        count === expectedCount,
      code,
    );
    totalPages = pages;
    totalCount = reportedTotal;
    items.push(...response.result);
  }
  ensure(items.length === totalCount, code);
  return items;
}
