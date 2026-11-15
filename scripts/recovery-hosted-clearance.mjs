import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { verifyPrivateClearance } from "./recovery-hosted-clearance-checks.mjs";

// This one-operation helper continues a manually approved synthetic rehearsal.
// It never invokes reset, deletion, PITR, namespace creation or public exposure.
const SOURCE = "3d65b9ace98720afd2ef48275a3bb76a8638f76e";
const OPERATOR = "5f41a40f22fa1fe6dcc28c0238100ed944d18107";
const SOURCE_ROOT = "/home/ubuntu/src/agent-table-issue51-recovery-20261114";
const OPERATOR_ROOT = "/home/ubuntu/src/agent-table-issue51-operator-20261114";
const ORIGINAL_ROOT = "/home/ubuntu/agent-table-issue51-rehearsal-20261114";
const ACCOUNT = "0fbaae27d3ff021bc17109f1493d0b2d";
const WORKER = "agent-table-pr51-recovery-staging";
const SCHEMA_WORKER = "agent-table-pr51-schema-staging";
const PROPOSAL =
  "020534bdd708a01c501d27829ff80d01f8ebb2b48336ac49d29196f9959046c9";
const SERVING =
  "58aaf16f7cacf06c3b0b568b4e3858c9c399d86b826348630c99a99f0a2330fa";
const QUARANTINE =
  "56be00421e272f3415e9ee8a694998cfb95243c25462c4ac0b123f0bfdfceb07";
const APPROVAL =
  "https://github.com/kitamura-tetsuo/agent-table/issues/51#issuecomment-6886616675";
const PARENT_DIRECTORY = `${ORIGINAL_ROOT}/clearance-v2`;
const DIRECTORY = `${ORIGINAL_ROOT}/clearance-v2-retry`;
const PARENT_CHECKPOINT_SHA256 =
  "48260bbaf4e7f25ff577465ea7d204ee2b6bf2d52cb8d2adbf313fe776b3161f";
const PARENT_EVIDENCE_SHA256 =
  "16d15e1ccacb2f7786787fa81b8d6d54d4d3ba9ae05d3bd59180ceda92f2be1f";
const PARENT_RECORD_HEAD =
  "7a142579d74b589b7abf611116ec9701b457b1221642ed66767669aa1fd60fe0";
const PARENT_HELPER_SHA256 =
  "e0c42b91c253935d8f1ea49e0e857f0cd0eee538359240b105482fbbf40ba142";
const PARENT_CHECKS_SHA256 =
  "36c359e7a4c2a3ab1d31066fa44ddbfc252e797a5c105aab780b8f0f897daf88";
const STATE = `${DIRECTORY}/continuation.json`;
const DOS = ["TABLES", "GUESTS", "OAUTH_SERIALIZER", "ADMISSION"];
const CLASSES = {
  TABLES: "TableDO",
  GUESTS: "GuestDO",
  OAUTH_SERIALIZER: "OAuthTokenDO",
  ADMISSION: "AdmissionDO",
};
const FLAGS = [
  "ALLOW_NEW_GUESTS",
  "ALLOW_NEW_TABLES",
  "ENABLE_MCP_SUBSCRIPTIONS",
  "ENABLE_OPENAI_EVENTS",
  "ALLOW_OUTBOUND_NOTIFICATIONS",
];
const execFileAsync = promisify(execFile);
const plain = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
class ClearanceError extends Error {}
function safeError(error) {
  const trusted =
    error instanceof ClearanceError ||
    [
      "RecoveryVerificationError",
      "RecoveryProviderError",
      "PrivateClearanceCheckError",
      "PrivateClearanceTransportError",
    ].includes(error?.constructor?.name);
  return trusted && /^[a-z][a-z0-9:-]{1,119}$/.test(error.message)
    ? error.message
    : "clearance-operation-failed";
}
async function boundedRpc(operation, code, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ClearanceError(code)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function ensure(value, code) {
  if (!value) throw new ClearanceError(code);
}
function equal(left, right, code, canonical) {
  ensure(canonical(left) === canonical(right), code);
}

export function assertClearanceProposal(proposal, digest) {
  ensure(digest(proposal) === PROPOSAL, "unapproved-proposal");
  ensure(
    proposal.subject.sourceSha === SOURCE &&
      proposal.subject.namespaceIdentity.workerName === WORKER &&
      proposal.subject.namespaceIdentity.accountId === ACCOUNT,
    "wrong-clearance-subject",
  );
  const config = proposal.intendedServingConfiguration.configuration;
  ensure(
    config.main === `${SOURCE_ROOT}/src/index.ts` &&
      config.vars.RELEASE_PROFILE === "manual" &&
      config.vars.RESTORE_QUARANTINE === "false",
    "wrong-serving-configuration",
  );
  ensure(
    FLAGS.every((key) => config.vars[key] === "false") &&
      config.workers_dev === false &&
      config.preview_urls === false &&
      config.routes.length === 0,
    "exposure-or-capability-enabled",
  );
  ensure(
    proposal.intendedServingConfiguration.configSha256 === SERVING &&
      proposal.rollback.configSha256 === QUARANTINE,
    "wrong-configuration-commitment",
  );
}

async function privateFile(path) {
  const entry = await lstat(path);
  ensure(
    entry.isFile() &&
      !entry.isSymbolicLink() &&
      (entry.mode & 0o077) === 0 &&
      entry.uid === process.getuid(),
    "private-file-required",
  );
  return readFile(path, "utf8");
}
async function durableWrite(path, value, exclusive = false) {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!exclusive) await rename(target, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function initialize() {
  const configModule = await import(
    pathToFileURL(`${OPERATOR_ROOT}/scripts/recovery-configuration.mjs`).href
  );
  const provider = await import(
    pathToFileURL(`${OPERATOR_ROOT}/scripts/recovery-provider.mjs`).href
  );
  const rehearsalModule = await import(
    pathToFileURL(`${OPERATOR_ROOT}/scripts/recovery-hosted-rehearsal.mjs`).href
  );
  const {
    canonicalJson,
    recoveryDigest: digest,
    recoveryConfigurationDigest,
  } = configModule;
  const raw = await privateFile(`${ORIGINAL_ROOT}/rehearsal.json`);
  const rehearsal = JSON.parse(raw);
  const evidence = JSON.parse(
    await privateFile(`${ORIGINAL_ROOT}/rehearsal.json.evidence.json`),
  );
  const proposal = JSON.parse(await privateFile(`${DIRECTORY}/proposal.json`));
  assertClearanceProposal(proposal, digest);
  ensure(
    rehearsal.finalizedAt && rehearsal.sourceSha === SOURCE,
    "original-rehearsal-not-finalized",
  );
  ensure(
    digest(evidence) === proposal.evidence.canonicalSha256 &&
      digest(rehearsalModule.publicRehearsalEvidence(rehearsal)) ===
        proposal.evidence.canonicalSha256,
    "original-evidence-changed",
  );
  const target = rehearsal.targets.recovery;
  equal(
    target.identity,
    proposal.subject.namespaceIdentity,
    "original-identity-changed",
    canonicalJson,
  );
  ensure(
    target.operationId === proposal.subject.operationId &&
      target.generation === proposal.subject.generation &&
      target.verifiedQuarantine === true,
    "original-operation-changed",
  );
  ensure(
    recoveryConfigurationDigest(target.deployment.config) === QUARANTINE &&
      digest(target.deployment.config) ===
        proposal.observedCurrentDeployment.completeResetConfigurationSha256,
    "original-config-changed",
  );
  ensure(
    recoveryConfigurationDigest(
      proposal.intendedServingConfiguration.configuration,
    ) === SERVING,
    "serving-config-changed",
  );
  const historicalClaims = configModule.verifyRecoveryConfiguration(
    target.deployment.config,
    Date.parse(proposal.observedCurrentDeployment.resetAuthorizationExpiresAt) -
      1,
  );
  ensure(
    historicalClaims.phase === "reset" &&
      historicalClaims.planSha256 ===
        digest({
          plan: rehearsal.plan,
          role: target.workerName,
          identity: target.identity,
          operationId: target.operationId,
          generation: target.generation,
        }),
    "original-plan-changed",
  );
  const provenance = await rehearsalModule.verifyRehearsalCheckouts({
    sourceRoot: SOURCE_ROOT,
    operatorRoot: OPERATOR_ROOT,
    sourceSha: SOURCE,
    expectedOperatorSha: OPERATOR,
  });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const client = provider.recoveryCloudflareClient(token);
  const inventory = () =>
    provider.inventoryRecoveryResources(
      target.identity,
      (path, options = {}) => {
        ensure(
          options.method === undefined || options.method === "GET",
          "read-only-inventory-required",
        );
        return client(path, options);
      },
    );
  const ctx = {
    ...configModule,
    ...provider,
    digest,
    canonicalJson,
    rehearsal,
    proposal,
    target,
    historicalClaims,
    provenance,
    oldCheckpointSha256: digest(raw),
    inventory,
    token,
  };
  ctx.parent = await verifiedParent(ctx);
  return ctx;
}

// Preserve the failed attempt byte-for-byte and lease its proven rollback only.
async function verifiedParent(ctx) {
  const raw = await privateFile(`${PARENT_DIRECTORY}/continuation.json`);
  const state = JSON.parse(raw);
  const evidence = JSON.parse(
    await privateFile(`${PARENT_DIRECTORY}/evidence.json`),
  );
  ensure(
    ctx.digest(raw) === PARENT_CHECKPOINT_SHA256 &&
      ctx.digest(evidence) === PARENT_EVIDENCE_SHA256 &&
      state.format === "agent-table.synthetic-clearance-continuation.v1" &&
      state.proposalSha256 === PROPOSAL &&
      state.approvalRef === APPROVAL &&
      state.oldCheckpointSha256 === ctx.oldCheckpointSha256 &&
      state.phase === "rolled-back" &&
      state.pending === null &&
      state.records.length === 12 &&
      state.records.at(-1).sha256 === PARENT_RECORD_HEAD,
    "retry-parent-identity-changed",
  );
  let previous = ctx.proposal.evidence.localRecordHeadSha256;
  for (let index = 0; index < state.records.length; index++) {
    const record = state.records[index];
    const { sha256, ...value } = record;
    ensure(
      value.previousSha256 === previous && ctx.digest(value) === sha256,
      "retry-parent-chain-invalid",
    );
    equal(
      record,
      JSON.parse(
        await privateFile(
          `${PARENT_DIRECTORY}/event-${String(index + 1).padStart(4, "0")}.json`,
        ),
      ),
      "retry-parent-record-file-changed",
      ctx.canonicalJson,
    );
    previous = sha256;
  }
  equal(
    evidence.records,
    state.records,
    "retry-parent-evidence-records-changed",
    ctx.canonicalJson,
  );
  equal(
    evidence.currentDeployment,
    state.active.receipt,
    "retry-parent-evidence-deployment-changed",
    ctx.canonicalJson,
  );
  ensure(
    ctx.digest(
      await privateFile(`${PARENT_DIRECTORY}/recovery-hosted-clearance.mjs`),
    ) === PARENT_HELPER_SHA256 &&
      ctx.digest(
        await privateFile(
          `${PARENT_DIRECTORY}/recovery-hosted-clearance-checks.mjs`,
        ),
      ) === PARENT_CHECKS_SHA256,
    "retry-parent-helper-changed",
  );
  const first = state.records[0].metadata;
  const last = state.records.at(-1);
  ensure(
    first.executionHelperSha256 === PARENT_HELPER_SHA256 &&
      first.verificationHelperSha256 === PARENT_CHECKS_SHA256 &&
      first.inventory.objects.ADMISSION.length === 0 &&
      last.action === "rollback-verified" &&
      last.metadata.ingress.all503 === true &&
      last.metadata.ingress.routes === 9 &&
      state.active.receipt.versionId ===
        "c419489a-a11d-4486-bd8d-7d60cf02ae31" &&
      state.active.config.vars.RESTORE_QUARANTINE === "true" &&
      ctx.recoveryConfigurationDigest(state.active.config) === QUARANTINE,
    "retry-parent-rollback-unverified",
  );
  const claims = ctx.verifyRecoveryConfiguration(
    state.active.config,
    Date.parse(last.observedAt),
  );
  ensure(
    claims.phase === "reset" &&
      claims.operationId === ctx.target.operationId &&
      claims.generation === ctx.target.generation &&
      claims.planSha256 === ctx.historicalClaims.planSha256,
    "retry-parent-authority-changed",
  );
  return {
    state,
    anchor: {
      evidenceSha256: PARENT_EVIDENCE_SHA256,
      checkpointSha256: PARENT_CHECKPOINT_SHA256,
      recordHeadSha256: PARENT_RECORD_HEAD,
      executionHelperSha256: PARENT_HELPER_SHA256,
      verificationHelperSha256: PARENT_CHECKS_SHA256,
      immutableHelperRevision: "c9f04e4bcd573edafc8a4a46759b01af347818d1",
      rollbackVersionId: state.active.receipt.versionId,
    },
  };
}

// Read only fixed-account script/service metadata; never retain raw bindings.
async function metadata(ctx, suffix) {
  const bare = suffix.split("?")[0];
  const allowed = [WORKER, SCHEMA_WORKER].some(
    (worker) =>
      new RegExp(
        `^/workers/scripts/${worker}/(settings|subdomain|deployments|versions/[a-f0-9-]{36})$`,
      ).test(suffix) ||
      suffix === `/workers/services/${worker}` ||
      suffix ===
        `/workers/services/${worker}/environments/production/routes?show_zonename=true`,
  );
  ensure(
    allowed ||
      (bare === "/workers/domains" &&
        /^\?page=[1-9]\d?&per_page=100$/.test(suffix.slice(bare.length))),
    "metadata-path-refused",
  );
  let response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${suffix}`,
      {
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new ClearanceError("metadata-request-unavailable");
  }
  ensure(response.ok, "metadata-request-refused");
  const reader = response.body?.getReader();
  ensure(reader, "metadata-body-missing");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      ensure(size <= 2 * 1024 * 1024, "metadata-too-large");
      chunks.push(value.value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ClearanceError("metadata-json-invalid");
  }
  ensure(
    envelope?.success === true &&
      Object.hasOwn(envelope, "result") &&
      (envelope.errors == null ||
        (Array.isArray(envelope.errors) && envelope.errors.length === 0)),
    "metadata-envelope-unverified",
  );
  return envelope;
}
async function customDomains(ctx) {
  const result = [];
  let total;
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const response = await metadata(
      ctx,
      `/workers/domains?page=${page}&per_page=100`,
    );
    const info = response.result_info;
    ensure(
      Array.isArray(response.result) &&
        Number.isSafeInteger(info?.total_count) &&
        info.total_count >= 0 &&
        info.total_count <= 2000 &&
        info.page === page &&
        info.per_page === 100 &&
        info.count === response.result.length &&
        (total === undefined || total === info.total_count),
      "domain-pagination-incomplete",
    );
    total = info.total_count;
    pages = Math.max(1, Math.ceil(total / 100));
    ensure(
      response.result.length ===
        Math.min(100, Math.max(0, total - (page - 1) * 100)) &&
        (info.total_pages === undefined || info.total_pages === pages),
      "domain-pagination-incomplete",
    );
    result.push(...response.result);
  }
  ensure(
    new Set(result.map((value) => value.id)).size === result.length,
    "duplicate-domain-entry",
  );
  return result;
}
async function observedDeployment(ctx, target, config, expectedVersion) {
  const prefix = `/workers/scripts/${target.workerName}`;
  const [settings, subdomain, deployments, domains, service, routes] =
    await Promise.all([
      metadata(ctx, `${prefix}/settings`),
      metadata(ctx, `${prefix}/subdomain`),
      metadata(ctx, `${prefix}/deployments`),
      customDomains(ctx),
      metadata(ctx, `/workers/services/${target.workerName}`),
      metadata(
        ctx,
        `/workers/services/${target.workerName}/environments/production/routes?show_zonename=true`,
      ),
    ]);
  ensure(
    subdomain.result?.enabled === false &&
      subdomain.result?.previews_enabled === false &&
      !domains.some((value) => value.service === target.workerName),
    "public-exposure-enabled",
  );
  ensure(
    service.result?.id === target.workerName &&
      service.result.default_environment?.environment === "production" &&
      Array.isArray(routes.result) &&
      routes.result.length === 0,
    "live-routes-not-empty",
  );
  const versions = deployments.result?.deployments?.[0]?.versions;
  ensure(
    versions?.length === 1 &&
      versions[0].percentage === 100 &&
      /^[a-f0-9-]{36}$/.test(versions[0].version_id),
    "active-version-unverified",
  );
  const versionId = versions[0].version_id;
  ensure(
    expectedVersion === undefined || versionId === expectedVersion,
    "active-version-changed",
  );
  const version = (await metadata(ctx, `${prefix}/versions/${versionId}`))
    .result;
  ensure(
    version?.resources?.script_runtime?.migration_tag ===
      config.migrations.at(-1).tag,
    "migration-tag-changed",
  );
  for (const bindings of [
    settings.result?.bindings,
    version?.resources?.bindings,
  ]) {
    ensure(
      Array.isArray(bindings) &&
        new Set(bindings.map((value) => value.name)).size === bindings.length,
      "bindings-invalid",
    );
    const vars = Object.fromEntries(
      bindings
        .filter((value) => value.type === "plain_text")
        .map((value) => [value.name, value.text]),
    );
    equal(
      vars,
      config.vars,
      "complete-deployed-vars-changed",
      ctx.canonicalJson,
    );
    ensure(bindings.length === Object.keys(vars).length + 5, "extra-binding");
    for (const binding of DOS) {
      const value = bindings.find((item) => item.name === binding);
      ensure(
        value?.type === "durable_object_namespace" &&
          value.class_name === CLASSES[binding] &&
          !value.script_name &&
          !value.environment &&
          !value.dispatch_namespace &&
          (!value.namespace_id ||
            value.namespace_id === target.identity.namespaces[binding]),
        "namespace-binding-changed",
      );
    }
    const kv = bindings.find((value) => value.name === "OAUTH_KV");
    ensure(
      kv?.type === "kv_namespace" &&
        kv.namespace_id === target.identity.namespaces.OAUTH_KV,
      "kv-binding-changed",
    );
  }
  return {
    observedAt: now(),
    workerName: target.workerName,
    versionId,
    completeConfigurationSha256: ctx.digest(config),
    configurationCommitment: ctx.recoveryConfigurationDigest(config),
    workersDevDisabled: true,
    previewsDisabled: true,
    actualServiceRoutes: 0,
    customDomains: 0,
    serviceEnvironment: "production",
  };
}
// Local resource lifecycle must not indefinitely postpone quarantine compensation.
export async function createBoundedPlatformProxy(
  factory,
  { startupMs = 30_000, disposalMs = 10_000 } = {},
) {
  const pending = Promise.resolve().then(factory);
  let proxy;
  try {
    proxy = await boundedRpc(
      () => pending,
      "private-proxy-start-timeout",
      startupMs,
    );
  } catch (error) {
    // A startup finishing after timeout is never used and is disposed separately.
    void pending
      .then((value) =>
        boundedRpc(
          () => value.dispose(),
          "private-proxy-stop-timeout",
          disposalMs,
        ),
      )
      .catch(() => undefined);
    throw error;
  }
  return {
    env: proxy.env,
    dispose: () =>
      boundedRpc(
        () => proxy.dispose(),
        "private-proxy-stop-timeout",
        disposalMs,
      ),
  };
}

async function services(_ctx, operation, useLocalRelay = false) {
  const path = `${DIRECTORY}/client-${randomUUID()}.json`;
  await writeFile(
    path,
    JSON.stringify({
      name: `agent-table-clearance-client-${randomUUID().slice(0, 8)}`,
      account_id: ACCOUNT,
      compatibility_date: "2026-11-07",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
      services: [
        {
          binding: "CONTROL",
          service: WORKER,
          entrypoint: "RecoveryControl",
          remote: true,
        },
        { binding: "APPLICATION", service: WORKER, remote: true },
      ],
    }),
    { flag: "wx", mode: 0o600 },
  );
  let proxy;
  let relay;
  try {
    const requireSource = createRequire(`${SOURCE_ROOT}/package.json`);
    const { getPlatformProxy, unstable_dev } = await import(
      pathToFileURL(requireSource.resolve("wrangler")).href
    );
    proxy = await createBoundedPlatformProxy(() =>
      getPlatformProxy({
        configPath: path,
        envFiles: [],
        persist: false,
        remoteBindings: true,
      }),
    );
    if (useLocalRelay) {
      const { createPrivateClearanceTransport } = await import(
        "./recovery-hosted-clearance-transport.mjs"
      );
      relay = await createPrivateClearanceTransport({ unstable_dev });
    }
    return plain(
      await operation({
        CONTROL: proxy.env.CONTROL,
        APPLICATION: relay ? relay.application : proxy.env.APPLICATION,
      }),
    );
  } finally {
    try {
      if (relay) await relay.dispose();
    } finally {
      try {
        if (proxy) await proxy.dispose();
      } finally {
        await unlink(path);
      }
    }
  }
}
function identity(ctx, current) {
  ensure(
    current?.buildSha === SOURCE &&
      current.environment === "staging" &&
      current.schemaVersion === 12,
    "runtime-identity-changed",
  );
  equal(
    current.commitments,
    ctx.target.identity.commitments,
    "namespace-commitment-changed",
    ctx.canonicalJson,
  );
}
function inventoryIdentity(ctx, inventory, allowAdmission = true) {
  ensure(
    inventory.oauthKeys.length === 0 &&
      inventory.objects.OAUTH_SERIALIZER.length === 0,
    "unexpected-oauth-state",
  );
  for (const binding of ["TABLES", "GUESTS"]) {
    const expected =
      binding === "TABLES"
        ? ctx.target.prepared.table.objectId
        : ctx.target.prepared.guest.objectId;
    ensure(
      inventory.objects[binding].length === 1 &&
        inventory.objects[binding][0].id === expected,
      "historical-object-inventory-changed",
    );
  }
  ensure(
    allowAdmission || inventory.objects.ADMISSION.length === 0,
    "unexpected-admission-state",
  );
}
async function quarantineIngress(ctx, config) {
  const { verifyRecoveryIngress } = await import(
    pathToFileURL(`${SOURCE_ROOT}/scripts/recovery-run.mjs`).href
  );
  return services(ctx, async ({ CONTROL, APPLICATION }) => {
    identity(
      ctx,
      plain(
        await boundedRpc(() => CONTROL.identity(), "runtime-identity-timeout"),
      ),
    );
    ensure(
      await verifyRecoveryIngress(config, (url, init) =>
        APPLICATION.fetch(url, init),
      ),
      "quarantine-ingress-not-denied",
    );
    return {
      checkedAt: now(),
      routes: 9,
      all503: true,
      allNoStore: true,
      transport: "authenticated-private-service-binding",
    };
  });
}
async function quarantineRelayProbe(ctx, config) {
  return services(
    ctx,
    async ({ CONTROL, APPLICATION }) => {
      identity(
        ctx,
        plain(
          await boundedRpc(() => CONTROL.identity(), "relay-identity-timeout"),
        ),
      );
      const csrf = randomBytes(32).toString("base64url");
      const observed = await boundedRpc(async () => {
        const response = await APPLICATION.fetch(
          `${config.vars.PUBLIC_ORIGIN}/guest/session`,
          {
            method: "POST",
            headers: {
              Origin: config.vars.PUBLIC_ORIGIN,
              "Sec-Fetch-Site": "same-origin",
              "Content-Type": "application/x-www-form-urlencoded",
              Cookie: `__Host-agent_table_csrf=${csrf}`,
            },
            body: new URLSearchParams({ choice: "new", csrf }).toString(),
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          },
        );
        ensure(
          response.status === 503 &&
            response.headers.get("Cache-Control") === "no-store" &&
            (await response.text()) === "Service unavailable during recovery",
          "relay-quarantine-probe-failed",
        );
        return {
          status: 503,
          noStore: true,
          exactApplicationQuarantineResponse: true,
        };
      }, "relay-quarantine-probe-timeout");
      return {
        ...observed,
        checkedAt: now(),
        method: "POST",
        path: "/guest/session",
        remoteOriginIncluded: true,
        transport: "local-worker-authenticated-service-binding",
      };
    },
    true,
  );
}

async function append(ctx, state, action, details) {
  const value = {
    action,
    observedAt: now(),
    previousSha256:
      state.records.at(-1)?.sha256 ?? ctx.parent.anchor.recordHeadSha256,
    metadata: details,
  };
  const record = { ...value, sha256: ctx.digest(value) };
  await durableWrite(
    `${DIRECTORY}/event-${String(state.records.length + 1).padStart(4, "0")}.json`,
    record,
    true,
  );
  state.records.push(record);
  await durableWrite(STATE, state);
  process.stdout.write(
    `${JSON.stringify({ action, phase: state.phase, recordSha256: record.sha256 })}\n`,
  );
}
async function loadState(ctx) {
  const state = JSON.parse(await privateFile(STATE));
  ensure(
    state.format === "agent-table.synthetic-clearance-successor.v1" &&
      state.proposalSha256 === PROPOSAL &&
      state.approvalRef === APPROVAL &&
      state.oldCheckpointSha256 === ctx.oldCheckpointSha256,
    "continuation-identity-changed",
  );
  equal(
    state.parentAttempt,
    ctx.parent.anchor,
    "retry-parent-anchor-changed",
    ctx.canonicalJson,
  );
  let previous = ctx.parent.anchor.recordHeadSha256;
  for (let index = 0; index < state.records.length; index++) {
    const record = state.records[index];
    const { sha256, ...value } = record;
    ensure(
      value.previousSha256 === previous && ctx.digest(value) === sha256,
      "continuation-chain-invalid",
    );
    equal(
      record,
      JSON.parse(
        await privateFile(
          `${DIRECTORY}/event-${String(index + 1).padStart(4, "0")}.json`,
        ),
      ),
      "continuation-record-file-changed",
      ctx.canonicalJson,
    );
    previous = sha256;
  }
  const provenance = state.records[0]?.metadata;
  ensure(
    provenance?.executionHelperSha256 ===
      ctx.digest(await readFile(fileURLToPath(import.meta.url), "utf8")) &&
      provenance?.verificationHelperSha256 ===
        ctx.digest(
          await readFile(
            new URL("./recovery-hosted-clearance-checks.mjs", import.meta.url),
            "utf8",
          ),
        ),
    "continuation-helper-code-changed",
  );
  ensure(
    provenance.transportHelperSha256 ===
      ctx.digest(
        await readFile(
          new URL("./recovery-hosted-clearance-transport.mjs", import.meta.url),
          "utf8",
        ),
      ),
    "continuation-transport-code-changed",
  );
  return state;
}
function renewedConfiguration(ctx, state, phase) {
  const serving = phase === "serve";
  const config = serving
    ? ctx.proposal.intendedServingConfiguration.configuration
    : ctx.target.deployment.config;
  const issuedAt = now();
  const claims = {
    ...ctx.historicalClaims,
    phase,
    issuedAt,
    expiresAt: serving
      ? null
      : new Date(Date.parse(issuedAt) + 45 * 60_000).toISOString(),
    evidenceSha256: serving ? ctx.proposal.evidence.canonicalSha256 : null,
    previousRecordSha256: state.records.at(-1).sha256,
    approvalRef: APPROVAL,
  };
  const signed = ctx.signedRecoveryConfiguration(
    config,
    claims,
    ctx.rehearsal.privateKey,
  );
  ensure(
    ctx.recoveryConfigurationDigest(signed) ===
      (serving ? SERVING : QUARANTINE),
    "signing-changed-approved-config",
  );
  return signed;
}
async function deploy(ctx, state, config, purpose) {
  await observedDeployment(
    ctx,
    ctx.target,
    state.active.config,
    state.active.receipt.versionId,
  );
  state.pending = {
    config,
    purpose,
    priorVersionId: state.active.receipt.versionId,
  };
  await append(ctx, state, "deployment-prepared", {
    purpose,
    configurationCommitment: ctx.recoveryConfigurationDigest(config),
    completeConfigurationSha256: ctx.digest(config),
    certificateSha256: ctx.digest(config.vars.RECOVERY_AUTHORIZATION),
    claims: ctx.verifyRecoveryConfiguration(config),
  });
  const path = `${DIRECTORY}/deploy-${randomUUID()}.json`;
  await writeFile(path, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  let failed = false;
  try {
    await execFileAsync(
      process.execPath,
      [
        `${SOURCE_ROOT}/node_modules/wrangler/bin/wrangler.js`,
        "deploy",
        "--config",
        path,
        "--durable-objects-code-update-mode",
        "immediate",
      ],
      {
        cwd: SOURCE_ROOT,
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          CI: "true",
          WRANGLER_LOG: "none",
          WRANGLER_WRITE_LOGS: "false",
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
  } catch {
    failed = true;
  } finally {
    await unlink(path);
  }
  // A lost command response is recoverable only by matching complete live state.
  const receipt = await observedDeployment(ctx, ctx.target, config);
  ensure(
    receipt.versionId !== state.pending.priorVersionId,
    "deployment-version-not-changed",
  );
  state.active = { config, receipt };
  state.pending = null;
  state.phase =
    config.vars.RESTORE_QUARANTINE === "false"
      ? "serving-unverified"
      : "quarantined";
  await append(ctx, state, "deployment-verified", {
    purpose,
    recoveredCommandFailure: failed,
    ...receipt,
  });
}
/** Resolve an ambiguous upload only from exact current provider observations. */
export async function recoverPendingDeployment(
  ctx,
  state,
  {
    observe = observedDeployment,
    record = append,
    pause = (milliseconds) =>
      new Promise((done) => setTimeout(done, milliseconds)),
  } = {},
) {
  ensure(
    state.pending &&
      state.pending.priorVersionId === state.active.receipt.versionId,
    "pending-deployment-identity-invalid",
  );
  const pending = state.pending;
  for (let attempt = 0; attempt < 3; attempt++) {
    let candidate;
    try {
      candidate = await observe(ctx, ctx.target, pending.config);
    } catch {
      /* Try the exact previous state below. */
    }
    if (candidate && candidate.versionId !== pending.priorVersionId) {
      state.active = { config: pending.config, receipt: candidate };
      state.pending = null;
      state.phase =
        pending.config.vars.RESTORE_QUARANTINE === "false"
          ? "serving-unverified"
          : "quarantined";
      await record(ctx, state, "pending-deployment-independently-adopted", {
        purpose: pending.purpose,
        ...candidate,
      });
      return "candidate";
    }
    let previous;
    try {
      previous = await observe(
        ctx,
        ctx.target,
        state.active.config,
        pending.priorVersionId,
      );
    } catch {
      /* An unknown later state must never be overwritten. */
    }
    if (previous) {
      state.pending = null;
      await record(ctx, state, "pending-deployment-not-applied", {
        purpose: pending.purpose,
        ...previous,
      });
      return "previous";
    }
    if (attempt < 2) await pause(1000);
  }
  throw new ClearanceError("pending-deployment-outcome-unverified");
}
// Rate buckets created by the first private checks are retained operational state.
// They are inspected with full coverage, while historical private state stays empty.
export function verifySuccessorInspection(ctx, inventory, receipts, expected) {
  const allObjects = ctx.verifyObjectInspectionReceipts(
    inventory,
    receipts,
    expected,
  );
  const historicalInventory = {
    ...inventory,
    objects: { ...inventory.objects, ADMISSION: [] },
    counts: { ...inventory.counts, ADMISSION: 0 },
  };
  const historicalReceipts = receipts.filter(
    (value) => value.binding !== "ADMISSION",
  );
  const historicalPrivateReset = ctx.verifyObjectResetReceipts(
    historicalInventory,
    historicalReceipts,
    expected,
  );
  const admission = receipts.filter((value) => value.binding === "ADMISSION");
  for (const receipt of admission) {
    ensure(
      receipt.markerGeneration === expected.generation &&
        receipt.kvEntries === 0 &&
        Object.keys(receipt.counts).length === 1 &&
        Number.isSafeInteger(receipt.counts.admission_hits) &&
        receipt.counts.admission_hits >= 0,
      "retry-admission-state-unverified",
    );
  }
  return {
    allObjects,
    historicalPrivateReset,
    historicalResetComponents: ["TABLES", "GUESTS", "OAUTH_SERIALIZER"],
    retainedAdmissionObjects: admission.length,
    retainedAdmissionRows: admission.reduce(
      (sum, value) => sum + value.counts.admission_hits,
      0,
    ),
    admissionResetPerformed: false,
  };
}

async function inspect(ctx, state) {
  const current = await observedDeployment(
    ctx,
    ctx.target,
    state.active.config,
    state.active.receipt.versionId,
  );
  const claims = ctx.verifyRecoveryConfiguration(state.active.config);
  ensure(
    claims.phase === "reset",
    "inspection-requires-current-reset-authority",
  );
  const before = await ctx.inventory();
  inventoryIdentity(ctx, before);
  const requestNonce = randomBytes(32).toString("hex");
  const receipts = await services(ctx, async ({ CONTROL }) => {
    identity(
      ctx,
      plain(
        await boundedRpc(() => CONTROL.identity(), "runtime-identity-timeout"),
      ),
    );
    const values = [];
    for (const binding of DOS)
      for (const object of before.objects[binding])
        values.push(
          plain(
            await boundedRpc(
              () =>
                CONTROL.inspect({
                  binding,
                  objectId: object.id,
                  operationId: ctx.target.operationId,
                  requestNonce,
                }),
              "canonical-inspection-timeout",
            ),
          ),
        );
    return values;
  });
  const expected = { ...claims, requestNonce };
  const summary = verifySuccessorInspection(ctx, before, receipts, expected);
  const after = await ctx.inventory();
  inventoryIdentity(ctx, after);
  ensure(
    ctx.recoveryInventoryDigest(before) === ctx.recoveryInventoryDigest(after),
    "inventory-changed-during-inspection",
  );
  const ingress = await quarantineIngress(ctx, state.active.config);
  await observedDeployment(
    ctx,
    ctx.target,
    state.active.config,
    current.versionId,
  );
  state.phase = "verified";
  state.verified = {
    at: now(),
    inventory: after,
    expected,
    receipts,
    summary,
    ingress,
    provider: current,
  };
  await append(
    ctx,
    state,
    "fresh-canonical-reset-state-verified",
    state.verified,
  );
}
async function rollback(ctx, state) {
  ensure(
    state.active.config.vars.RESTORE_QUARANTINE === "false" &&
      state.pending === null,
    "rollback-active-state-unverified",
  );
  await observedDeployment(
    ctx,
    ctx.target,
    state.active.config,
    state.active.receipt.versionId,
  );
  const config = renewedConfiguration(ctx, state, "reset");
  await deploy(ctx, state, config, "quarantine-only-rollback");
  const ingress = await quarantineIngress(ctx, config);
  state.phase = "rolled-back";
  await append(ctx, state, "rollback-verified", {
    ...state.active.receipt,
    ingress,
    destructiveRpcCalls: false,
    namespaceChanges: false,
  });
}
function publicEvidence(ctx, state) {
  return {
    format: "agent-table.synthetic-controlled-clearance-evidence.v1",
    scope: "manual-isolated-synthetic-only",
    proposalSha256: PROPOSAL,
    approvalRef: APPROVAL,
    subject: ctx.proposal.subject,
    sourceProvenance: ctx.provenance,
    originalEvidenceSha256: ctx.proposal.evidence.canonicalSha256,
    originalRecordHeadSha256: ctx.proposal.evidence.localRecordHeadSha256,
    parentAttempt: ctx.parent.anchor,
    phase: state.phase,
    completedAt: state.completedAt ?? null,
    currentDeployment: state.active.receipt,
    records: state.records,
    protectedWorkflowAttestation: null,
    productionRecoveryJournalClaim: null,
    destructiveResetPerformed: false,
    pitrPerformed: false,
    namespaceChanges: false,
    limitations: [
      "Synthetic-only manual approval does not authorize existing staging, production or public intake.",
      "Old hosted credentials are also expired; their denial alone does not isolate revocation or reset.",
      "Admission rate metadata can be created by ordinary private HTTP checks after clearance.",
      "KV listing and canonical receipts are observations, not claims of global cache or backup erasure.",
    ],
  };
}

export async function runClearance(phase) {
  ensure(
    ["prepare", "renew", "inspect", "clear", "reconcile", "export"].includes(
      phase,
    ),
    "invalid-phase",
  );
  await mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
  const directory = await lstat(DIRECTORY);
  ensure(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      (directory.mode & 0o077) === 0 &&
      directory.uid === process.getuid() &&
      (await realpath(DIRECTORY)) === DIRECTORY,
    "private-directory-required",
  );
  const lock = await open(`${DIRECTORY}/operation.lock`, "wx", 0o600);
  try {
    const ctx = await initialize();
    if (phase === "prepare") {
      try {
        await lstat(STATE);
        throw new ClearanceError("continuation-already-exists");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const receipt = await observedDeployment(
        ctx,
        ctx.target,
        ctx.parent.state.active.config,
        ctx.parent.state.active.receipt.versionId,
      );
      const excluded = ctx.rehearsal.targets.schema;
      const excludedReceipt = await observedDeployment(
        ctx,
        excluded,
        excluded.deployment.config,
        excluded.deployment.receipt.versionId,
      );
      const inventory = await ctx.inventory();
      inventoryIdentity(ctx, inventory);
      const ingress = await quarantineIngress(
        ctx,
        ctx.parent.state.active.config,
      );
      const relayProbe = await quarantineRelayProbe(
        ctx,
        ctx.parent.state.active.config,
      );
      const state = {
        format: "agent-table.synthetic-clearance-successor.v1",
        proposalSha256: PROPOSAL,
        approvalRef: APPROVAL,
        phase: "prepared",
        oldCheckpointSha256: ctx.oldCheckpointSha256,
        parentAttempt: ctx.parent.anchor,
        active: { config: ctx.parent.state.active.config, receipt },
        pending: null,
        records: [],
      };
      await append(ctx, state, "approved-retry-preflight-recorded", {
        parentAttempt: ctx.parent.anchor,
        correction:
          "Local Worker relay preserves remote request Origin without weakening the platform proxy guard.",
        proposalSha256: PROPOSAL,
        approvalRef: APPROVAL,
        provenance: ctx.provenance,
        relayProbe,
        transportHelperSha256: ctx.digest(
          await readFile(
            new URL(
              "./recovery-hosted-clearance-transport.mjs",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
        executionHelperSha256: ctx.digest(
          await readFile(fileURLToPath(import.meta.url), "utf8"),
        ),
        verificationHelperSha256: ctx.digest(
          await readFile(
            new URL("./recovery-hosted-clearance-checks.mjs", import.meta.url),
            "utf8",
          ),
        ),
        receipt,
        excludedReceipt,
        inventory,
        ingress,
      });
      return;
    }
    const state = await loadState(ctx);
    if (phase === "reconcile") {
      ensure(state.pending !== null, "no-pending-deployment");
      const purpose = state.pending.purpose;
      await recoverPendingDeployment(ctx, state);
      if (state.active.config.vars.RESTORE_QUARANTINE === "false")
        await rollback(ctx, state);
      else {
        const ingress = await quarantineIngress(ctx, state.active.config);
        state.phase =
          purpose === "approved-synthetic-clearance" ||
          purpose === "quarantine-only-rollback"
            ? "rolled-back"
            : "quarantined";
        await append(ctx, state, "pending-outcome-quarantine-confirmed", {
          ...state.active.receipt,
          ingress,
        });
      }
      return;
    }
    ensure(
      state.pending === null,
      "pending-deployment-needs-independent-readback",
    );
    if (phase === "renew") {
      ensure(state.phase === "prepared", "renew-phase-conflict");
      await observedDeployment(
        ctx,
        ctx.target,
        state.active.config,
        state.active.receipt.versionId,
      );
      const config = renewedConfiguration(ctx, state, "reset");
      await deploy(ctx, state, config, "same-generation-inspection-renewal");
      state.phase = "quarantined";
      await append(ctx, state, "inspection-renewal-quarantined", {
        ...state.active.receipt,
        ingress: await quarantineIngress(ctx, config),
      });
    } else if (phase === "inspect") {
      ensure(
        state.phase === "quarantined" || state.phase === "verified",
        "inspect-phase-conflict",
      );
      await inspect(ctx, state);
    } else if (phase === "clear") {
      ensure(state.phase === "verified", "clear-phase-conflict");
      // Refresh actual receipts immediately before issuing the serving permit.
      await inspect(ctx, state);
      const config = renewedConfiguration(ctx, state, "serve");
      const privateResponses = [];
      try {
        await deploy(ctx, state, config, "approved-synthetic-clearance");
        const verification = await services(
          ctx,
          ({ CONTROL, APPLICATION }) =>
            verifyPrivateClearance({
              control: CONTROL,
              application: {
                fetch: async (url, init) => {
                  const response = await APPLICATION.fetch(url, init);
                  privateResponses.push({
                    path: new URL(url).pathname,
                    method: init?.method ?? "GET",
                    status: response.status,
                  });
                  return response;
                },
              },
              config,
              subject: ctx.proposal.subject,
              scenario: ctx.target.scenario,
            }),
          true,
        );
        const inventory = await ctx.inventory();
        inventoryIdentity(ctx, inventory, true);
        const receipt = await observedDeployment(
          ctx,
          ctx.target,
          config,
          state.active.receipt.versionId,
        );
        const excluded = ctx.rehearsal.targets.schema;
        const excludedReceipt = await observedDeployment(
          ctx,
          excluded,
          excluded.deployment.config,
          excluded.deployment.receipt.versionId,
        );
        state.phase = "cleared-private-synthetic";
        state.completedAt = now();
        await append(ctx, state, "controlled-clearance-verified", {
          receipt,
          excludedReceipt,
          verification,
          postServingInventory: inventory,
          noNewGuestOrTable: true,
          noOAuthCredentialsCreated: true,
        });
      } catch (error) {
        await append(ctx, state, "clearance-verification-failed", {
          errorCode: safeError(error),
          privateResponses,
        });
        if (state.pending) await recoverPendingDeployment(ctx, state);
        if (state.active.config.vars.RESTORE_QUARANTINE === "false")
          await rollback(ctx, state);
        else {
          await observedDeployment(
            ctx,
            ctx.target,
            state.active.config,
            state.active.receipt.versionId,
          );
          const ingress = await quarantineIngress(ctx, state.active.config);
          state.phase = "rolled-back";
          await append(ctx, state, "failed-clearance-quarantine-retained", {
            ...state.active.receipt,
            ingress,
          });
        }
        throw new ClearanceError("clearance-failed-quarantine-restored");
      }
    }
    if (
      phase === "export" ||
      state.phase === "cleared-private-synthetic" ||
      state.phase === "rolled-back"
    ) {
      const evidence = publicEvidence(ctx, state);
      await durableWrite(`${DIRECTORY}/evidence.json`, evidence);
      process.stdout.write(
        `${JSON.stringify({ publicEvidenceSha256: ctx.digest(evidence), phase: state.phase, recordHeadSha256: state.records.at(-1).sha256 })}\n`,
      );
    }
  } finally {
    await lock.close();
    await unlink(`${DIRECTORY}/operation.lock`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.env.WRANGLER_LOG = "none";
  process.env.WRANGLER_WRITE_LOGS = "false";
  process.env.WRANGLER_SEND_METRICS = "false";
  try {
    await runClearance(process.argv[2]);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: safeError(error), rawErrorsSuppressed: true })}\n`,
    );
    process.exitCode = 1;
  }
}
