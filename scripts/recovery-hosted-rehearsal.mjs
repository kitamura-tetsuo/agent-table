import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
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
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  RECOVERY_DO_BINDINGS,
  validateRecoveryNamespaceIdentity,
} from "../src/shared/recovery.ts";
import {
  canonicalJson,
  RecoveryVerificationError,
  recoveryDigest,
  signedRecoveryConfiguration,
  verifyRecoveryConfiguration,
} from "./recovery-configuration.mjs";
import {
  deleteInventoriedOAuthKeys,
  inventoryRecoveryResources,
  RecoveryProviderError,
  recoveryCloudflareClient,
  recoveryInventoryDigest,
  verifyObjectInspectionReceipts,
  verifyObjectResetReceipts,
} from "./recovery-provider.mjs";
import { verifyRecoveryIngress } from "./recovery-run.mjs";

// This is a manually approved, isolated synthetic rehearsal, not a producer of
// production recovery approval or a replacement for the protected workflow.
const OPERATOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let ROOT = OPERATOR_ROOT;
let operatorSha;
const ACCOUNT = "0fbaae27d3ff021bc17109f1493d0b2d";
const SUBDOMAIN = "kitamura-tetsuo";
const WORKERS = {
  recovery: "agent-table-pr51-recovery-staging",
  schema: "agent-table-pr51-schema-staging",
};
const APPROVAL =
  "https://github.com/kitamura-tetsuo/agent-table/pull/69#issuecomment-6868721873";
const FORMAT = "agent-table.synthetic-recovery-rehearsal.v1";
const FLAGS = [
  "ALLOW_NEW_GUESTS",
  "ALLOW_NEW_TABLES",
  "ENABLE_MCP_SUBSCRIPTIONS",
  "ENABLE_OPENAI_EVENTS",
  "ALLOW_OUTBOUND_NOTIFICATIONS",
];
const CLASSES = {
  TABLES: "TableDO",
  GUESTS: "GuestDO",
  OAUTH_SERIALIZER: "OAuthTokenDO",
  ADMISSION: "AdmissionDO",
};
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PHASES = [
  "plan",
  "provision",
  "snapshot",
  "restore",
  "discard",
  "future",
  "finalize",
];
const execFileAsync = promisify(execFile);

class RehearsalError extends Error {}
function ensure(value, code) {
  if (!value) throw new RehearsalError(code);
}
function now() {
  return new Date().toISOString();
}
export function plainRecoveryMetadata(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function scenario(runId) {
  return {
    runId,
    ...Object.fromEntries(
      [
        "guestId",
        "tableId",
        "sessionId",
        "connectionId",
        "expiringConnectionId",
        "requestId",
      ].map((name) => [name, randomUUID()]),
    ),
    secret: randomBytes(32).toString("base64url"),
  };
}

export function rehearsalPlan(sourceSha, runId) {
  ensure(SHA.test(sourceSha) && UUID.test(runId), "invalid-rehearsal-identity");
  return {
    format: FORMAT,
    sourceSha,
    runId,
    accountId: ACCOUNT,
    workersSubdomain: SUBDOMAIN,
    approval: { kind: "manual-isolated-synthetic", reference: APPROVAL },
    workers: Object.fromEntries(
      Object.entries(WORKERS).map(([role, workerName]) => [
        role,
        {
          workerName,
          kvTitle: `${workerName}-oauth-${runId}`,
          schemaVersion: 12,
        },
      ]),
    ),
    publicRoutes: false,
    certificatePhase: "reset",
    finalState: "verified-quarantine",
    retainedFutureSchemaVersion: 13,
    productionJournal: false,
    permitsClearance: false,
  };
}

// A provider-client correction may run from its own reviewed checkout while
// the exact previously reviewed application/fixture stays pinned. Every other
// tracked input must be byte-identical; neither the plan nor its authority moves.
const OPERATOR_ONLY_PATHS = new Set([
  "scripts/recovery-hosted-rehearsal.mjs",
  "scripts/recovery-hosted-rehearsal.test.mjs",
  "scripts/recovery-provider.mjs",
  "scripts/recovery-provider.test.mjs",
]);
export async function verifyRehearsalCheckouts({
  sourceRoot,
  operatorRoot,
  sourceSha,
  expectedOperatorSha,
}) {
  ensure(
    SHA.test(sourceSha) && SHA.test(expectedOperatorSha),
    "explicit-source-and-operator-shas-required",
  );
  const check = async (root, expectedSha) => {
    ensure(
      isAbsolute(root) &&
        root === resolve(root) &&
        (await realpath(root)) === root,
      "canonical-checkout-path-required",
    );
    const [head, top, dirty, tree] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
      execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root }),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: root,
      }),
      execFileAsync(
        "git",
        ["ls-tree", "-r", "-z", "--full-tree", expectedSha],
        {
          cwd: root,
        },
      ),
    ]);
    ensure(head.stdout.trim() === expectedSha, "checkout-head-mismatch");
    ensure(top.stdout.trim() === root, "checkout-root-mismatch");
    ensure(dirty.stdout.trim() === "", "checkout-is-dirty");
    await execFileAsync(
      "git",
      [
        "ls-files",
        "--error-unmatch",
        "scripts/recovery-hosted-rehearsal.mjs",
        "test/recovery-hosted/worker.ts",
        "src/index.ts",
      ],
      { cwd: root },
    );
    return tree.stdout
      .split("\0")
      .filter(Boolean)
      .filter(
        (entry) =>
          !OPERATOR_ONLY_PATHS.has(entry.slice(entry.indexOf("\t") + 1)),
      )
      .sort()
      .join("\0");
  };
  const [sourceInputs, operatorInputs] = await Promise.all([
    check(sourceRoot, sourceSha),
    check(operatorRoot, expectedOperatorSha),
  ]);
  ensure(sourceInputs === operatorInputs, "pinned-runtime-inputs-changed");
  return {
    sourceSha,
    operatorSha: expectedOperatorSha,
    comparedInputsSha256: recoveryDigest(sourceInputs),
  };
}
async function assertSource(sourceSha) {
  return verifyRehearsalCheckouts({
    sourceRoot: ROOT,
    operatorRoot: OPERATOR_ROOT,
    sourceSha,
    expectedOperatorSha: operatorSha ?? sourceSha,
  });
}

async function privateDirectory(path) {
  ensure(
    isAbsolute(path) && path === resolve(path),
    "absolute-private-state-path-required",
  );
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  ensure(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      (directory.mode & 0o077) === 0 &&
      (process.getuid === undefined || directory.uid === process.getuid()),
    "private-state-directory-required",
  );
  ensure((await realpath(parent)) === parent, "private-state-symlink-refused");
  for (const root of new Set([ROOT, OPERATOR_ROOT])) {
    const fromRoot = relative(root, parent);
    ensure(
      fromRoot === ".." ||
        fromRoot.startsWith(`..${sep}`) ||
        isAbsolute(fromRoot),
      "state-must-be-outside-repository",
    );
  }
}
async function readState(path, sourceSha) {
  const stat = await lstat(path);
  ensure(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      (process.getuid === undefined || stat.uid === process.getuid()),
    "private-state-file-required",
  );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let state;
  try {
    state = JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
  ensure(
    state?.format === FORMAT &&
      state.sourceSha === sourceSha &&
      canonicalJson(state.plan) ===
        canonicalJson(rehearsalPlan(sourceSha, state.runId)),
    "state-plan-substitution",
  );
  for (const [role, target] of Object.entries(state.targets)) {
    ensure(
      Object.hasOwn(WORKERS, role) &&
        target.workerName === WORKERS[role] &&
        target.scenario.runId === state.runId,
      "state-target-substitution",
    );
    if (target.identity)
      ensure(
        validateRecoveryNamespaceIdentity(target.identity) &&
          target.identity.accountId === ACCOUNT &&
          target.identity.workerName === target.workerName &&
          target.identity.namespaces.OAUTH_KV === target.kvId,
        "state-namespace-substitution",
      );
  }
  ensure(
    Object.keys(state.targets).sort().join(",") === "recovery,schema",
    "state-targets-incomplete",
  );
  return state;
}
async function saveState(path, state, initial = false) {
  const bytes = `${JSON.stringify(state, null, 2)}\n`;
  if (initial) return writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
function record(state, action, metadata) {
  const item = {
    action,
    observedAt: now(),
    previousSha256: state.records.at(-1)?.sha256 ?? "0".repeat(64),
    metadata,
  };
  state.records.push({ ...item, sha256: recoveryDigest(item) });
}

// Creation is limited to the two exact fresh KV titles. Worker creation/update
// is delegated to Wrangler using the reviewed configuration and pinned source.
function metadataClient(token, state) {
  ensure(
    typeof token === "string" && token.length > 10,
    "cloudflare-token-required",
  );
  return async (suffix, { method = "GET", body, allowAbsent = false } = {}) => {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${suffix}`,
    );
    const lists = [
      "/workers/durable_objects/namespaces",
      "/storage/kv/namespaces",
      "/workers/domains",
    ];
    const bare = suffix.split("?")[0];
    const paged =
      lists.includes(bare) &&
      /^\?page=[1-9]\d?&per_page=100$/.test(suffix.slice(bare.length));
    const workerRead = Object.values(WORKERS).some((worker) =>
      new RegExp(
        `^/workers/scripts/${worker}/(?:settings|subdomain|deployments|versions/[a-f0-9-]{36})$`,
      ).test(suffix),
    );
    const creation =
      method === "POST" &&
      suffix === "/storage/kv/namespaces" &&
      body &&
      Object.keys(body).join(",") === "title" &&
      Object.values(state.plan.workers).some(
        (target) => target.kvTitle === body.title,
      );
    ensure(
      url.origin === "https://api.cloudflare.com" &&
        !url.hash &&
        ((method === "GET" &&
          body === undefined &&
          (paged || workerRead || suffix === "/workers/subdomain")) ||
          creation),
      "provider-path-refused",
    );
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Cache-Control": "no-cache",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RehearsalError("provider-unreachable");
    }
    if (allowAbsent && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    ensure(response.ok, "provider-request-refused");
    const reader = response.body?.getReader();
    ensure(reader, "provider-response-missing");
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        ensure(size <= 2 * 1024 * 1024, "provider-response-too-large");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    let envelope;
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RehearsalError("provider-json-invalid");
    }
    ensure(
      envelope?.success === true &&
        Object.hasOwn(envelope, "result") &&
        (!envelope.errors || envelope.errors.length === 0),
      "provider-response-unverified",
    );
    return { result: envelope.result, info: envelope.result_info };
  };
}
async function allPages(client, suffix) {
  const values = [];
  let pages = 1;
  let total;
  for (let page = 1; page <= pages; page++) {
    const { result, info } = await client(
      `${suffix}?page=${page}&per_page=100`,
    );
    ensure(
      Array.isArray(result) &&
        Number.isSafeInteger(info?.total_count) &&
        info.total_count >= 0 &&
        info.total_count <= 2000 &&
        info.page === page &&
        info.per_page === 100 &&
        info.count === result.length &&
        (total === undefined || total === info.total_count),
      "provider-pagination-incomplete",
    );
    total = info.total_count;
    pages = Math.max(1, Math.ceil(total / 100));
    ensure(
      result.length === Math.min(100, Math.max(0, total - (page - 1) * 100)) &&
        (info.total_pages === undefined || info.total_pages === pages),
      "provider-pagination-incomplete",
    );
    values.push(...result);
  }
  ensure(
    new Set(values.map((item) => item.id)).size === values.length,
    "provider-pagination-duplicate",
  );
  return values;
}
function plainBindings(bindings) {
  ensure(
    Array.isArray(bindings) &&
      new Set(bindings.map((b) => b.name)).size === bindings.length,
    "provider-bindings-invalid",
  );
  return Object.fromEntries(
    bindings
      .filter((b) => b.type === "plain_text")
      .map((b) => [b.name, b.text]),
  );
}

async function connect(statePath, target) {
  const path = resolve(dirname(statePath), `client-${randomUUID()}.json`);
  await writeFile(
    path,
    JSON.stringify({
      name: `agent-table-rehearsal-client-${randomUUID().slice(0, 8)}`,
      account_id: ACCOUNT,
      compatibility_date: "2026-11-07",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
      services: [
        {
          binding: "CONTROL",
          service: target.workerName,
          entrypoint: "RecoveryControl",
          remote: true,
        },
        ...(target.deployment?.kind === "application"
          ? []
          : [
              {
                binding: "REHEARSAL",
                service: target.workerName,
                entrypoint: "RecoveryRehearsal",
                remote: true,
              },
            ]),
        { binding: "APPLICATION", service: target.workerName, remote: true },
      ],
    }),
    { flag: "wx", mode: 0o600 },
  );
  let proxy;
  try {
    const sourceRequire = createRequire(resolve(ROOT, "package.json"));
    const { getPlatformProxy } = await import(
      pathToFileURL(sourceRequire.resolve("wrangler")).href
    );
    proxy = await getPlatformProxy({
      configPath: path,
      envFiles: [],
      persist: false,
      remoteBindings: true,
    });
    return {
      ...proxy.env,
      dispose: async () => {
        await proxy.dispose();
        await unlink(path);
      },
    };
  } catch {
    await proxy?.dispose();
    await unlink(path);
    throw new RehearsalError("private-service-connection-failed");
  }
}
async function withServices(path, target, operation) {
  const services = await connect(path, target);
  try {
    const result = await operation(services);
    // Service RPC metadata can contain live proxies; retain only detached JSON.
    return plainRecoveryMetadata(result);
  } finally {
    await services.dispose();
  }
}
function assertIdentity(state, target, current) {
  ensure(
    current?.buildSha === state.sourceSha &&
      current.environment === "staging" &&
      current.schemaVersion === 12 &&
      Object.keys(current.commitments ?? {})
        .sort()
        .join(",") === [...RECOVERY_DO_BINDINGS].sort().join(",") &&
      Object.values(current.commitments).every((value) => DIGEST.test(value)),
    "runtime-identity-unverified",
  );
  if (target.identity)
    ensure(
      canonicalJson(current.commitments) ===
        canonicalJson(target.identity.commitments),
      "runtime-namespace-changed",
    );
}
async function discoverIdentity(state, target, path, client) {
  const namespaces = await allPages(
    client,
    "/workers/durable_objects/namespaces",
  );
  const owned = namespaces.filter((item) => item.script === target.workerName);
  ensure(owned.length === 4, "namespace-ownership-unverified");
  const ids = { OAUTH_KV: target.kvId };
  for (const [binding, className] of Object.entries(CLASSES)) {
    const matches = owned.filter((item) => item.class === className);
    ensure(
      matches.length === 1 &&
        ID.test(matches[0].id) &&
        matches[0].use_sqlite === true,
      "namespace-ownership-unverified",
    );
    ids[binding] = matches[0].id;
  }
  const identity = await withServices(path, target, ({ CONTROL }) =>
    CONTROL.identity(),
  );
  assertIdentity(state, target, identity);
  const subject = {
    accountId: ACCOUNT,
    workerName: target.workerName,
    namespaces: ids,
    commitments: identity.commitments,
  };
  ensure(
    validateRecoveryNamespaceIdentity(subject),
    "namespace-identity-invalid",
  );
  return subject;
}
async function verifyDeployment(state, target, config, client) {
  const prefix = `/workers/scripts/${target.workerName}`;
  const [settings, subdomain, deployments, domains] = await Promise.all([
    client(`${prefix}/settings`),
    client(`${prefix}/subdomain`),
    client(`${prefix}/deployments`),
    allPages(client, "/workers/domains"),
  ]);
  ensure(
    subdomain.result?.enabled === false &&
      subdomain.result?.previews_enabled === false &&
      !domains.some((item) => item.service === target.workerName),
    "public-exposure-not-disabled",
  );
  const active = deployments.result?.deployments?.[0];
  ensure(
    active?.versions?.length === 1 &&
      active.versions[0].percentage === 100 &&
      /^[a-f0-9-]{36}$/.test(active.versions[0].version_id),
    "active-version-unverified",
  );
  const versionId = active.versions[0].version_id;
  const version = (await client(`${prefix}/versions/${versionId}`)).result;
  ensure(
    version?.resources?.script_runtime?.migration_tag ===
      config.migrations.at(-1).tag,
    "active-migrations-changed",
  );
  for (const bindings of [
    settings.result?.bindings,
    version?.resources?.bindings,
  ]) {
    const vars = plainBindings(bindings);
    ensure(
      canonicalJson(vars) === canonicalJson(config.vars),
      "active-text-bindings-changed",
    );
    ensure(
      bindings.length === Object.keys(vars).length + 5,
      "unexpected-provider-binding",
    );
    for (const [binding, className] of Object.entries(CLASSES)) {
      const bound = bindings.find((b) => b.name === binding);
      ensure(
        bound?.type === "durable_object_namespace" &&
          bound.class_name === className &&
          !bound.script_name &&
          !bound.environment &&
          !bound.dispatch_namespace &&
          (!target.identity ||
            !bound.namespace_id ||
            bound.namespace_id === target.identity.namespaces[binding]),
        "active-do-binding-changed",
      );
    }
    const kv = bindings.find((b) => b.name === "OAUTH_KV");
    ensure(
      kv?.type === "kv_namespace" && kv.namespace_id === target.kvId,
      "active-kv-binding-changed",
    );
  }
  return {
    versionId,
    observedAt: now(),
    configSha256: recoveryDigest(config),
    sourceSha: state.sourceSha,
    workersDevDisabled: true,
    previewUrlsDisabled: true,
    customDomains: 0,
    configuredRoutes: 0,
  };
}

async function configuration(state, target, main, signed = false) {
  const base = JSON.parse(
    await readFile(resolve(ROOT, "wrangler.jsonc"), "utf8"),
  );
  const config = {
    ...base,
    name: target.workerName,
    account_id: ACCOUNT,
    main,
    workers_dev: false,
    preview_urls: false,
    routes: [],
    observability: { enabled: false },
    durable_objects: {
      ...base.durable_objects,
      code_update_strategy: { mode: "immediate" },
    },
    kv_namespaces: [{ binding: "OAUTH_KV", id: target.kvId }],
    vars: {
      PUBLIC_ORIGIN: `https://${target.workerName}.${SUBDOMAIN}.workers.dev`,
      RELEASE_ENVIRONMENT: "staging",
      RELEASE_BUILD_SHA: state.sourceSha,
      RESTORE_QUARANTINE: "true",
      HOSTED_RECOVERY_FIXTURE: "issue51-synthetic-only",
      HOSTED_RECOVERY_FIXTURE_WORKER: target.workerName,
      HOSTED_RECOVERY_FIXTURE_RUN_ID: state.runId,
      ...Object.fromEntries(FLAGS.map((name) => [name, "false"])),
    },
  };
  delete config.$schema;
  delete config.env;
  if (!signed) return config;
  ensure(
    target.identity &&
      UUID.test(target.operationId) &&
      DIGEST.test(target.generation),
    "reset-authority-not-planned",
  );
  config.vars.RECOVERY_VERIFICATION_KEY = state.publicKey;
  return signedRecoveryConfiguration(
    config,
    {
      format: "agent-table.fresh-start.v1",
      phase: "reset",
      operationId: target.operationId,
      generation: target.generation,
      environment: "staging",
      buildSha: state.sourceSha,
      configSha256: "0".repeat(64),
      schemaVersion: 12,
      namespaceIdentity: target.identity,
      planSha256: recoveryDigest({
        plan: state.plan,
        role: target.workerName,
        identity: target.identity,
        operationId: target.operationId,
        generation: target.generation,
      }),
      evidenceSha256: null,
      previousRecordSha256: state.records.at(-1)?.sha256 ?? "0".repeat(64),
      issuedAt: now(),
      expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
      approvalRef: APPROVAL,
    },
    state.privateKey,
  );
}
async function deploy(statePath, state, target, kind, client) {
  await assertSource(state.sourceSha);
  if (target.pendingDeployment) {
    // Recover a lost deploy response only by matching the complete intended
    // configuration against the active provider version, never by its name.
    let recovered;
    try {
      recovered = await verifyDeployment(
        state,
        target,
        target.pendingDeployment.config,
        client,
      );
    } catch {
      // The previously verified version must still match before any retry.
    }
    if (recovered) {
      target.deployment = { ...target.pendingDeployment, receipt: recovered };
      delete target.pendingDeployment;
      await saveState(statePath, state);
    }
  }
  if (target.deployment) {
    await verifyDeployment(state, target, target.deployment.config, client);
  } else {
    ensure(
      (await client(`/workers/scripts/${target.workerName}/settings`, {
        allowAbsent: true,
      })) === null,
      "fresh-worker-creation-no-longer-absent",
    );
  }
  let main = resolve(
    ROOT,
    kind === "application" ? "src/index.ts" : "test/recovery-hosted/worker.ts",
  );
  let shim;
  if (kind === "forensic") {
    shim = resolve(dirname(statePath), `forensic-${randomUUID()}.ts`);
    const source = `export { FutureSchemaReadback as TableDO, GuestDO, OAuthTokenDO, AdmissionDO, RecoveryControl, RecoveryRehearsal, default } from ${JSON.stringify(main)};\n`;
    await writeFile(shim, source, { flag: "wx", mode: 0o600 });
    main = shim;
  }
  const config = await configuration(
    state,
    target,
    main,
    Boolean(target.operationId),
  );
  const path = resolve(dirname(statePath), `deploy-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  target.pendingDeployment = { kind, config };
  await saveState(statePath, state);
  try {
    await execFileAsync(
      process.execPath,
      [
        resolve(ROOT, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        path,
        "--durable-objects-code-update-mode",
        "immediate",
      ],
      {
        cwd: ROOT,
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
    const receipt = await verifyDeployment(state, target, config, client);
    target.deployment = { kind, config, receipt };
    delete target.pendingDeployment;
    record(state, "deployed", {
      workerName: target.workerName,
      kind,
      ...receipt,
    });
    await saveState(statePath, state);
    return config;
  } catch {
    throw new RehearsalError("deployment-not-verified-state-retained");
  } finally {
    await unlink(path);
    if (shim) await unlink(shim);
  }
}
async function checkPrivateIngress(statePath, state, target) {
  return withServices(statePath, target, async ({ CONTROL, APPLICATION }) => {
    assertIdentity(
      state,
      target,
      plainRecoveryMetadata(await CONTROL.identity()),
    );
    ensure(
      await verifyRecoveryIngress(target.deployment.config, (url, init) =>
        APPLICATION.fetch(url, init),
      ),
      "private-ingress-denial-unverified",
    );
    return {
      pathsChecked: 9,
      all503: true,
      allNoStore: true,
      transport: "authenticated-service-binding",
    };
  });
}

async function provision(path, state, client) {
  if (!state.freshnessVerifiedAt) {
    const [workers, namespaces, kvs, subdomain] = await Promise.all([
      Promise.all(
        Object.values(WORKERS).map((name) =>
          client(`/workers/scripts/${name}/settings`, { allowAbsent: true }),
        ),
      ),
      allPages(client, "/workers/durable_objects/namespaces"),
      allPages(client, "/storage/kv/namespaces"),
      client("/workers/subdomain"),
    ]);
    ensure(
      workers.every((worker) => worker === null) &&
        !namespaces.some((item) =>
          Object.values(WORKERS).includes(item.script),
        ) &&
        !kvs.some((item) =>
          Object.values(state.plan.workers).some(
            (target) => target.kvTitle === item.title,
          ),
        ),
      "fresh-resources-not-absent",
    );
    ensure(
      subdomain.result?.subdomain === SUBDOMAIN,
      "workers-subdomain-mismatch",
    );
    state.freshnessVerifiedAt = now();
    record(state, "fresh-resource-absence-verified", {
      workers: Object.values(WORKERS),
      namespaces: 0,
      matchingKvTitles: 0,
    });
    await saveState(path, state);
  }
  for (const [role, target] of Object.entries(state.targets)) {
    if (!target.kvId) {
      // A lost creation response is not permission to adopt or recreate a namespace.
      ensure(
        !target.kvCreationAttempted,
        "kv-creation-outcome-unknown-inspect-manually",
      );
      ensure(
        (await client(`/workers/scripts/${target.workerName}/settings`, {
          allowAbsent: true,
        })) === null,
        "worker-appeared-before-provision",
      );
      target.kvCreationAttempted = true;
      await saveState(path, state);
      const created = (
        await client("/storage/kv/namespaces", {
          method: "POST",
          body: { title: state.plan.workers[role].kvTitle },
        })
      ).result;
      ensure(
        ID.test(created?.id) &&
          created.title === state.plan.workers[role].kvTitle,
        "kv-creation-unverified",
      );
      target.kvId = created.id;
      record(state, "synthetic-kv-created", {
        workerName: target.workerName,
        kvId: target.kvId,
      });
      await saveState(path, state);
    }
    if (!target.deployment) {
      const existing = await client(
        `/workers/scripts/${target.workerName}/settings`,
        { allowAbsent: true },
      );
      if (existing !== null) {
        ensure(
          target.pendingDeployment?.kind === "fixture",
          "existing-worker-adoption-refused",
        );
        const receipt = await verifyDeployment(
          state,
          target,
          target.pendingDeployment.config,
          client,
        );
        target.deployment = { ...target.pendingDeployment, receipt };
        delete target.pendingDeployment;
      } else await deploy(path, state, target, "fixture", client);
    }
    if (!target.identity)
      target.identity = await discoverIdentity(state, target, path, client);
    await verifyDeployment(state, target, target.deployment.config, client);
    target.ingress = await checkPrivateIngress(path, state, target);
    await saveState(path, state);
  }
  const ids = Object.values(state.targets).flatMap((target) =>
    Object.values(target.identity.namespaces),
  );
  ensure(new Set(ids).size === 10, "synthetic-namespaces-not-isolated");
  state.provisioned = true;
}
function assertPrepared(value) {
  ensure(
    value?.guest?.authorized?.session === true &&
      value.guest.authorized.revocable === true &&
      value.guest.authorized.expiring === true &&
      value.table?.readable === true &&
      value.oauthKeysWritten === 2 &&
      Number.isSafeInteger(value.guest.capturedAt) &&
      value.guest.capturedAt < value.guest.expiresAt,
    "positive-snapshot-oracle-failed",
  );
  for (const item of [value.guest, value.table])
    ensure(
      DIGEST.test(item.objectId) &&
        DIGEST.test(item.canonicalSha256) &&
        typeof item.bookmark === "string" &&
        /^[A-Za-z0-9-]{1,256}$/.test(item.bookmark),
      "snapshot-bookmark-unverified",
    );
}
async function prepare(path, state, target) {
  if (target.prepared) return;
  ensure(
    !target.prepareAttempted,
    "snapshot-prepare-outcome-unknown-inspect-manually",
  );
  target.prepareAttempted = true;
  await saveState(path, state);
  target.prepared = await withServices(path, target, ({ REHEARSAL }) =>
    REHEARSAL.prepare(target.scenario),
  );
  assertPrepared(target.prepared);
  await saveState(path, state);
}
async function snapshot(path, state) {
  ensure(state.provisioned, "provision-first");
  const target = state.targets.recovery;
  ensure(!target.operationId, "snapshot-after-reset-refused");
  await prepare(path, state, target);
  if (!target.postSnapshot) {
    ensure(
      !target.postSnapshotAttempted,
      "post-snapshot-outcome-unknown-inspect-manually",
    );
    target.postSnapshotAttempted = true;
    await saveState(path, state);
    target.postSnapshot = await withServices(path, target, ({ REHEARSAL }) =>
      REHEARSAL.performPostSnapshotEvents(target.scenario),
    );
    const { deletion, revocation } = target.postSnapshot;
    ensure(
      deletion.confirmationRequired &&
        deletion.pending &&
        deletion.deleted &&
        deletion.privateReadsDenied &&
        revocation.revoked &&
        revocation.denied &&
        revocation.oldSessionDenied &&
        deletion.observedAt > target.prepared.table.capturedAt &&
        revocation.observedAt > target.prepared.guest.capturedAt &&
        deletion.canonicalSha256 !== target.prepared.table.canonicalSha256 &&
        revocation.canonicalSha256 !== target.prepared.guest.canonicalSha256,
      "post-snapshot-negative-oracle-failed",
    );
    await saveState(path, state);
  }
  const wait = Math.max(0, target.prepared.guest.expiresAt - Date.now()) + 50;
  ensure(wait < 60_000, "unexpected-expiry-deadline");
  await delay(wait);
  target.expiry = await withServices(path, target, ({ REHEARSAL }) =>
    REHEARSAL.observeExpiry(target.scenario),
  );
  ensure(
    target.expiry?.expired === true &&
      target.expiry.expiresAt === target.prepared.guest.expiresAt &&
      target.expiry.observedAt > target.expiry.expiresAt,
    "expiry-oracle-failed",
  );
  record(state, "snapshot-and-later-events-verified", {
    workerName: target.workerName,
    guestObjectId: target.prepared.guest.objectId,
    tableObjectId: target.prepared.table.objectId,
    snapshotBeforeRevocation: true,
    snapshotBeforeDeletion: true,
    snapshotBeforeExpiry: true,
  });
}
function alarmNearSixHours(deadline, startedAt, completedAt) {
  return (
    Number.isSafeInteger(deadline) &&
    deadline >= startedAt + 6 * 60 * 60_000 - 5_000 &&
    deadline <= completedAt + 6 * 60 * 60_000 + 5_000
  );
}
async function restore(path, state, client) {
  const target = state.targets.recovery;
  ensure(
    target.expiry?.expired && !target.resetStartedAt,
    "snapshot-events-required-before-restore",
  );
  // Retain the independent operation and fresh generation before restoring any
  // object. The older bookmark cannot manufacture or erase this authority.
  beginReset(state, target);
  await saveState(path, state);
  await deploy(path, state, target, "fixture", client);
  target.restoreRequests ??= {};
  for (const [name, binding] of [
    ["guest", "GUESTS"],
    ["table", "TABLES"],
  ]) {
    if (target.restoreRequests[binding]) continue;
    const item = target.prepared[name];
    target.restoreRequests[binding] = {
      requestedAt: now(),
      outcome: "pending-readback",
    };
    await saveState(path, state);
    // abort() deliberately disconnects this RPC. Only the subsequent state and
    // bookmark-era canonical digest oracles establish that PITR took effect.
    await withServices(path, target, async ({ REHEARSAL }) => {
      try {
        await REHEARSAL.restoreSnapshot({
          runId: state.runId,
          binding,
          objectId: item.objectId,
          bookmark: item.bookmark,
        });
      } catch {
        /* The exact restored state is checked below. */
      }
    });
  }
  const started = Date.now();
  target.historical = await withServices(path, target, ({ REHEARSAL }) =>
    REHEARSAL.inspectHistorical(target.scenario),
  );
  const completed = Date.now();
  for (const name of ["guest", "table"]) {
    const observed = target.historical[name];
    ensure(
      observed.objectId === target.prepared[name].objectId &&
        observed.restoredSnapshotMarker === true &&
        observed.privateAccessDenied === true &&
        observed.alarmInvoked === true &&
        observed.canonicalSha256 === target.prepared[name].canonicalSha256 &&
        alarmNearSixHours(observed.alarmScheduledAt, started, completed),
      "restored-state-oracle-failed",
    );
  }
  ensure(
    target.historical.guest.rawRevocationRolledBack &&
      target.historical.guest.rawSessionInvalidationRolledBack &&
      target.historical.guest.creationDenied &&
      target.historical.guest.writeDenied &&
      target.historical.table.rawDeletionRolledBack,
    "historical-event-rollback-unverified",
  );
  target.ingress = await checkPrivateIngress(path, state, target);
  record(state, "hosted-pitr-and-quarantine-verified", {
    workerName: target.workerName,
    guestSha256: target.historical.guest.canonicalSha256,
    tableSha256: target.historical.table.canonicalSha256,
    realPitr: true,
    privateAccessDenied: true,
    realAlarmsInvoked: true,
    sixHourParking: true,
  });
}
function beginReset(state, target) {
  if (target.operationId) return;
  target.operationId = randomUUID();
  target.generation = randomBytes(32).toString("hex");
  record(state, "synthetic-reset-planned", {
    workerName: target.workerName,
    operationId: target.operationId,
    generation: target.generation,
    namespaceIdentity: target.identity,
    approvalRef: APPROVAL,
  });
}
async function receipts(services, inventory, claims, method) {
  const requestNonce = randomBytes(32).toString("hex");
  const values = [];
  for (const binding of RECOVERY_DO_BINDINGS)
    for (const object of inventory.objects[binding]) {
      values.push(
        plainRecoveryMetadata(
          await services.CONTROL[method]({
            binding,
            operationId: claims.operationId,
            objectId: object.id,
            requestNonce,
          }),
        ),
      );
    }
  const expected = { ...claims, requestNonce };
  return {
    values,
    expected,
    summary:
      method === "reset"
        ? verifyObjectResetReceipts(inventory, values, expected)
        : verifyObjectInspectionReceipts(inventory, values, expected),
  };
}
function assertSeededInventory(target, inventory) {
  ensure(
    inventory.objects.GUESTS.some(
      (item) => item.id === target.prepared.guest.objectId,
    ) &&
      inventory.objects.TABLES.some(
        (item) => item.id === target.prepared.table.objectId,
      ),
    "seeded-objects-missing-from-inventory",
  );
  const allowed = new Set([
    `grant:issue51-synthetic:${target.scenario.runId}`,
    `client:issue51-synthetic:${target.scenario.runId}`,
  ]);
  ensure(
    inventory.oauthKeys.every((key) => allowed.has(key.name)),
    "foreign-kv-state-refused",
  );
}
async function discard(path, state, client, provider) {
  const target = state.targets.recovery;
  ensure(
    target.historical?.guest?.rawRevocationRolledBack &&
      target.historical?.table?.rawDeletionRolledBack,
    "hosted-restore-evidence-required",
  );
  beginReset(state, target);
  await saveState(path, state);
  const config = await deploy(path, state, target, "application", client);
  const claims = verifyRecoveryConfiguration(config);
  const inventory = await inventoryRecoveryResources(target.identity, provider);
  assertSeededInventory(target, inventory);
  ensure(
    target.kvCleanup || inventory.oauthKeys.length === 2,
    "synthetic-oauth-positive-inventory-required",
  );
  target.resetStartedAt ??= now();
  await saveState(path, state);
  const result = await withServices(path, target, async (services) => {
    assertIdentity(
      state,
      target,
      plainRecoveryMetadata(await services.CONTROL.identity()),
    );
    const before = await receipts(services, inventory, claims, "inspect");
    const reset = await receipts(services, inventory, claims, "reset");
    return { inspection: before.summary, reset: reset.summary };
  });
  target.reset = result;
  await saveState(path, state);
  target.kvCleanup = await deleteInventoriedOAuthKeys(
    target.identity,
    inventory,
    provider,
  );
  await saveState(path, state);
  const after = await inventoryRecoveryResources(target.identity, provider);
  assertSeededInventory(target, after);
  ensure(after.oauthKeys.length === 0, "observed-kv-cleanup-not-yet-empty");
  const confirmed = await withServices(path, target, (services) =>
    receipts(services, after, claims, "inspect"),
  );
  target.resetReadback = verifyObjectResetReceipts(
    after,
    confirmed.values,
    confirmed.expected,
  );
  target.observedInventory = {
    sha256: recoveryInventoryDigest(after),
    counts: after.counts,
    observedAt: after.completedAt,
  };
  // KV's eventual consistency cannot prove global deletion. The complete reset
  // fence and unconditional quarantine remain active, including after expiry.
  const fixtureConfig = await deploy(path, state, target, "fixture", client);
  const fixtureClaims = verifyRecoveryConfiguration(fixtureConfig);
  const requestNonce = randomBytes(32).toString("hex");
  const started = Date.now();
  target.resetOracles = await withServices(path, target, ({ REHEARSAL }) =>
    REHEARSAL.inspectReset(target.scenario, {
      operationId: target.operationId,
      requestNonce,
    }),
  );
  const completed = Date.now();
  const pairInventory = {
    ...after,
    objects: {
      TABLES: [{ id: target.prepared.table.objectId, hasStoredData: true }],
      GUESTS: [{ id: target.prepared.guest.objectId, hasStoredData: true }],
      OAUTH_SERIALIZER: [],
      ADMISSION: [],
    },
    counts: {
      TABLES: 1,
      GUESTS: 1,
      OAUTH_SERIALIZER: 0,
      ADMISSION: 0,
      OAUTH_KV: 0,
    },
  };
  verifyObjectResetReceipts(
    pairInventory,
    [
      target.resetOracles.guest.inspection,
      target.resetOracles.table.inspection,
    ],
    { ...fixtureClaims, requestNonce },
  );
  for (const item of [target.resetOracles.guest, target.resetOracles.table])
    ensure(
      item.privateAccessDenied === true &&
        item.alarmInvoked === true &&
        alarmNearSixHours(
          item.alarmBeforeInvocation,
          Date.parse(target.resetStartedAt),
          completed,
        ) &&
        alarmNearSixHours(item.alarmScheduledAt, started, completed) &&
        DIGEST.test(item.canonicalSha256),
      "reset-alarm-oracle-failed",
    );
  await deploy(path, state, target, "application", client);
  target.ingress = await checkPrivateIngress(path, state, target);
  target.verifiedQuarantine = true;
  record(state, "synthetic-discard-verified-quarantined", {
    workerName: target.workerName,
    operationId: target.operationId,
    generation: target.generation,
    reset: target.resetReadback,
    observedInventory: target.observedInventory,
    kvCleanup: target.kvCleanup,
    sixHourParking: true,
    cleared: false,
  });
}
async function schemaRefused(call) {
  try {
    await call();
  } catch (error) {
    ensure(
      error?.name === "UnsupportedApplicationSchemaError" ||
        /Application schema version 13 is newer than supported 12/.test(
          String(error?.message ?? ""),
        ),
      "future-schema-refusal-cause-unverified",
    );
    return true;
  }
  throw new RehearsalError("future-schema-request-unexpectedly-succeeded");
}
async function future(path, state, client) {
  ensure(state.provisioned, "provision-first");
  const target = state.targets.schema;
  if (!target.prepared) await prepare(path, state, target);
  beginReset(state, target);
  await saveState(path, state);
  if (!target.future) {
    await deploy(path, state, target, "fixture", client);
    ensure(
      !target.futureAttempted,
      "future-schema-write-outcome-unknown-inspect-manually",
    );
    target.futureAttempted = true;
    await saveState(path, state);
    target.future = await withServices(path, target, ({ REHEARSAL }) =>
      REHEARSAL.prepareFutureSchema(target.scenario, {
        operationId: target.operationId,
        objectId: target.prepared.table.objectId,
        requestNonce: randomBytes(32).toString("hex"),
      }),
    );
    ensure(
      target.future?.schemaVersion === 13 &&
        target.future.constructorValidatorRefused &&
        target.future.inspectionRefused &&
        target.future.resetRefused &&
        target.future.objectId === target.prepared.table.objectId &&
        DIGEST.test(target.future.canonicalSha256),
      "future-schema-oracle-failed",
    );
    await saveState(path, state);
    await withServices(path, target, async ({ REHEARSAL }) => {
      try {
        await REHEARSAL.restartFutureSchema({
          runId: state.runId,
          objectId: target.future.objectId,
        });
      } catch {
        /* The production constructor and forensic readback are checked below. */
      }
    });
  }
  await deploy(path, state, target, "application", client);
  target.productionFutureRefusals = await withServices(
    path,
    target,
    async ({ CONTROL }) => {
      assertIdentity(
        state,
        target,
        plainRecoveryMetadata(await CONTROL.identity()),
      );
      const request = {
        binding: "TABLES",
        operationId: target.operationId,
        objectId: target.future.objectId,
        requestNonce: randomBytes(32).toString("hex"),
      };
      const inspection = await schemaRefused(() => CONTROL.inspect(request));
      const reset = await schemaRefused(() => CONTROL.reset(request));
      assertIdentity(
        state,
        target,
        plainRecoveryMetadata(await CONTROL.identity()),
      );
      return { inspection, reset, schemaVersion: 13 };
    },
  );
  await saveState(path, state);
  await deploy(path, state, target, "forensic", client);
  target.forensic = await withServices(path, target, ({ REHEARSAL }) =>
    REHEARSAL.inspectFutureSchema({
      runId: state.runId,
      objectId: target.future.objectId,
    }),
  );
  ensure(
    target.forensic?.schemaVersion === 13 &&
      target.forensic.objectId === target.future.objectId &&
      target.forensic.canonicalSha256 === target.future.canonicalSha256 &&
      canonicalJson(target.forensic.counts) ===
        canonicalJson(target.future.counts) &&
      target.forensic.kvEntries === target.future.kvEntries,
    "future-schema-state-changed",
  );
  await deploy(path, state, target, "application", client);
  target.ingress = await checkPrivateIngress(path, state, target);
  target.verifiedQuarantine = true;
  record(state, "future-schema-retained-quarantined", {
    workerName: target.workerName,
    objectId: target.future.objectId,
    schemaVersion: 13,
    canonicalSha256: target.forensic.canonicalSha256,
    constructorRefused: true,
    inspectionRefused: true,
    resetRefused: true,
    unchanged: true,
    cleared: false,
  });
}

export function publicRehearsalEvidence(state) {
  return {
    ...state.plan,
    finalizedAt: state.finalizedAt ?? null,
    signatureKeySha256: recoveryDigest(state.publicKey),
    workers: Object.fromEntries(
      Object.entries(state.targets).map(([role, target]) => [
        role,
        {
          workerName: target.workerName,
          namespaceIdentity: target.identity ?? null,
          operationId: target.operationId ?? null,
          generation: target.generation ?? null,
          deployment: target.deployment
            ? { kind: target.deployment.kind, ...target.deployment.receipt }
            : null,
          ingress: target.ingress ?? null,
          verifiedQuarantine: target.verifiedQuarantine === true,
        },
      ]),
    ),
    records: state.records,
    limitations: [
      "Manual isolated synthetic approval; no protected workflow approval is asserted.",
      "KV deletion is observed inventory coverage, not a global cache-empty proof.",
      "Only reset certificates are issued; quarantine stays active after expiry.",
      "The schema13 namespace is retained, never reset, renamed, or deleted.",
      "This synthetic record is separate from the production recovery journal.",
    ],
  };
}
async function finalize(path, state, client, provider) {
  if (state.finalizedAt) return saveEvidence(path, state);
  ensure(
    Object.values(state.targets).every(
      (target) => target.verifiedQuarantine === true,
    ),
    "both-synthetic-scenarios-required",
  );
  for (const target of Object.values(state.targets)) {
    // Renew only the expiring reset authority; this cannot enable private service.
    await deploy(path, state, target, "application", client);
    ensure(
      verifyRecoveryConfiguration(target.deployment.config)?.phase === "reset",
      "serve-authorization-refused",
    );
    const currentIdentity = await discoverIdentity(state, target, path, client);
    ensure(
      canonicalJson(currentIdentity) === canonicalJson(target.identity),
      "final-resource-identity-changed",
    );
    target.ingress = await checkPrivateIngress(path, state, target);
    await verifyDeployment(state, target, target.deployment.config, client);
  }
  const target = state.targets.recovery;
  const inventory = await inventoryRecoveryResources(target.identity, provider);
  assertSeededInventory(target, inventory);
  ensure(
    inventory.oauthKeys.length === 0,
    "final-observed-kv-cleanup-not-empty",
  );
  const claims = verifyRecoveryConfiguration(target.deployment.config);
  const result = await withServices(path, target, (services) =>
    receipts(services, inventory, claims, "inspect"),
  );
  verifyObjectResetReceipts(inventory, result.values, result.expected);
  state.finalizedAt = now();
  record(state, "rehearsal-complete-quarantine-retained", {
    workers: Object.values(WORKERS),
    resetSummary: result.summary,
    productionDataTouched: false,
    hostedClearancePerformed: false,
  });
  await saveState(path, state);
  return saveEvidence(path, state);
}

async function saveEvidence(path, state) {
  const evidence = publicRehearsalEvidence(state);
  const destination = `${path}.evidence.json`;
  try {
    await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stat = await lstat(destination);
    ensure(
      stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
      "private-evidence-file-required",
    );
    ensure(
      canonicalJson(JSON.parse(await readFile(destination, "utf8"))) ===
        canonicalJson(evidence),
      "existing-evidence-file-differs",
    );
  }
  return recoveryDigest(evidence);
}

function argumentsFor(argv) {
  ensure(
    argv.length === 6 || argv.length === 10,
    "usage-phase-state-source-sha-required",
  );
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    ensure(
      [
        "--phase",
        "--state",
        "--source-sha",
        "--source-root",
        "--operator-sha",
      ].includes(argv[i]) && !Object.hasOwn(args, argv[i]),
      "unknown-cli-argument",
    );
    args[argv[i]] = argv[i + 1];
  }
  ensure(
    PHASES.includes(args["--phase"]) &&
      SHA.test(args["--source-sha"]) &&
      typeof args["--state"] === "string" &&
      ((args["--source-root"] === undefined &&
        args["--operator-sha"] === undefined) ||
        (isAbsolute(args["--source-root"] ?? "") &&
          SHA.test(args["--operator-sha"]))),
    "invalid-cli-argument",
  );
  return {
    phase: args["--phase"],
    path: args["--state"],
    sourceSha: args["--source-sha"],
    sourceRoot: args["--source-root"] ?? OPERATOR_ROOT,
    operatorSha: args["--operator-sha"] ?? args["--source-sha"],
  };
}
async function main() {
  let phase;
  try {
    const args = argumentsFor(process.argv.slice(2));
    phase = args.phase;
    ROOT = args.sourceRoot;
    operatorSha = args.operatorSha;
    const provenance = await assertSource(args.sourceSha);
    await privateDirectory(args.path);
    if (phase === "plan") {
      const runId = randomUUID();
      const key = generateKeyPairSync("ed25519");
      const state = {
        format: FORMAT,
        sourceSha: args.sourceSha,
        runId,
        createdAt: now(),
        plan: rehearsalPlan(args.sourceSha, runId),
        privateKey: key.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
        publicKey: key.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
        targets: Object.fromEntries(
          Object.entries(WORKERS).map(([role, workerName]) => [
            role,
            { workerName, scenario: scenario(runId) },
          ]),
        ),
        records: [],
      };
      record(state, "plan-created-no-cloud-resources", {
        ...provenance,
        planSha256: recoveryDigest(state.plan),
      });
      await saveState(args.path, state, true);
      process.stdout.write(
        `${JSON.stringify({ ok: true, phase, plan: state.plan, planSha256: recoveryDigest(state.plan) })}\n`,
      );
      return;
    }
    const state = await readState(args.path, args.sourceSha);
    ensure(
      !state.finalizedAt || phase === "finalize",
      "rehearsal-already-finalized",
    );
    if (!state.finalizedAt) {
      record(state, "operator-source-verified", { ...provenance, phase });
      await saveState(args.path, state);
    }
    ensure(
      process.env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT,
      "explicit-account-binding-required",
    );
    // CLI/library debug logs can include remote proxy details. Only this
    // driver's allowlisted metadata is emitted or retained as public evidence.
    process.env.WRANGLER_LOG = "none";
    process.env.WRANGLER_WRITE_LOGS = "false";
    process.env.WRANGLER_LOG_SANITIZE = "true";
    process.env.WRANGLER_SEND_METRICS = "false";
    const client = metadataClient(process.env.CLOUDFLARE_API_TOKEN, state);
    const provider = recoveryCloudflareClient(process.env.CLOUDFLARE_API_TOKEN);
    let evidenceSha256;
    if (phase === "provision") await provision(args.path, state, client);
    else if (phase === "snapshot") await snapshot(args.path, state);
    else if (phase === "restore") await restore(args.path, state, client);
    else if (phase === "discard")
      await discard(args.path, state, client, provider);
    else if (phase === "future") await future(args.path, state, client);
    else evidenceSha256 = await finalize(args.path, state, client, provider);
    await saveState(args.path, state);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        phase,
        runId: state.runId,
        recordSha256: state.records.at(-1)?.sha256,
        ...(evidenceSha256 ? { evidenceSha256 } : {}),
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        phase: phase ?? "arguments",
        code:
          (error instanceof RehearsalError ||
            error instanceof RecoveryProviderError ||
            error instanceof RecoveryVerificationError) &&
          /^[a-z0-9-]{1,120}$/.test(error.message)
            ? error.message
            : "hosted-rehearsal-failed",
        note: "Private state is retained. A failed command does not establish verified quarantine or authorize clearance.",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
