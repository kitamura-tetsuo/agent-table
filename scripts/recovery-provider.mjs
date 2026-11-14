import { createHash } from "node:crypto";
import {
  RECOVERY_DO_BINDINGS,
  validateRecoveryNamespaceIdentity,
} from "../src/shared/recovery.ts";
import {
  ADMISSION_RECOVERY_STORAGE,
  GUEST_RECOVERY_STORAGE,
  OAUTH_RECOVERY_STORAGE,
  recoveryStorageManifest,
  TABLE_RECOVERY_STORAGE,
} from "../src/shared/recovery-manifests.ts";
import { canonicalRecoveryJson } from "./recovery-record.mjs";

const API_ORIGIN = "https://api.cloudflare.com";
const RESOURCE = /^[a-f0-9]{32}$/;
const OBJECT = /^[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CLASSES = {
  TABLES: "TableDO",
  GUESTS: "GuestDO",
  OAUTH_SERIALIZER: "OAuthTokenDO",
  ADMISSION: "AdmissionDO",
};
const DESCRIPTORS = {
  TABLES: TABLE_RECOVERY_STORAGE,
  GUESTS: GUEST_RECOVERY_STORAGE,
  OAUTH_SERIALIZER: OAUTH_RECOVERY_STORAGE,
  ADMISSION: ADMISSION_RECOVERY_STORAGE,
};
const MAX_PAGES = 100;
const MAX_ITEMS = 50_000;
const PAGE_SIZE = 1_000;
const INSPECTION_FIELDS = [
  "format",
  "environment",
  "buildSha",
  "configSha256",
  "operationId",
  "generation",
  "objectId",
  "binding",
  "component",
  "schemaVersion",
  "manifest",
  "counts",
  "kvEntries",
  "markerGeneration",
  "empty",
  "requestNonce",
];

export class RecoveryProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "RecoveryProviderError";
  }
}
function ensure(value, code) {
  if (!value) throw new RecoveryProviderError(code);
}
function exact(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
function matches(value, expression) {
  return typeof value === "string" && expression.test(value);
}
function instant(value) {
  if (typeof value !== "string" || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function identity(value) {
  ensure(
    validateRecoveryNamespaceIdentity(value) &&
      Object.values(value.namespaces).every((id) => RESOURCE.test(id)),
    "recovery-provider-identity-invalid",
  );
  return value;
}
function keyName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 512
  );
}
function digest(value) {
  return createHash("sha256")
    .update(canonicalRecoveryJson(value))
    .digest("hex");
}

/** Fixed API origin and a narrow endpoint allowlist; raw responses never enter errors. */
export function recoveryCloudflareClient(token, fetchImpl = fetch) {
  ensure(
    typeof token === "string" && token.length > 10,
    "recovery-provider-token-missing",
  );
  return async (path, { method = "GET", body, withPageInfo = false } = {}) => {
    ensure(typeof path === "string", "recovery-provider-path-invalid");
    let url;
    try {
      url = new URL(path, API_ORIGIN);
    } catch {
      throw new RecoveryProviderError("recovery-provider-path-invalid");
    }
    ensure(
      url.origin === API_ORIGIN &&
        url.pathname + url.search === path &&
        !url.hash,
      "recovery-provider-path-invalid",
    );
    const account = /^\/client\/v4\/accounts\/[a-f0-9]{32}/.exec(
      url.pathname,
    )?.[0];
    const relative = account ? url.pathname.slice(account.length) : "";
    const query = [...url.searchParams.keys()];
    ensure(
      new Set(query).size === query.length,
      "recovery-provider-query-invalid",
    );
    const namespaceList =
      method === "GET" &&
      relative === "/workers/durable_objects/namespaces" &&
      query.length === 2 &&
      url.searchParams.get("per_page") === "100" &&
      /^[1-9]\d?$/.test(url.searchParams.get("page") ?? "");
    const detail =
      method === "GET" &&
      !url.search &&
      (/^\/storage\/kv\/namespaces\/[a-f0-9]{32}$/.test(relative) ||
        /^\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,62}\/settings$/.test(
          relative,
        ));
    const cursorPage =
      method === "GET" &&
      (/^\/workers\/durable_objects\/namespaces\/[a-f0-9]{32}\/objects$/.test(
        relative,
      ) ||
        /^\/storage\/kv\/namespaces\/[a-f0-9]{32}\/keys$/.test(relative)) &&
      query.every((name) => name === "limit" || name === "cursor") &&
      url.searchParams.get("limit") === String(PAGE_SIZE) &&
      (!url.searchParams.has("cursor") ||
        (url.searchParams.get("cursor").length > 0 &&
          url.searchParams.get("cursor").length <= 2048));
    const deletion =
      method === "POST" &&
      !url.search &&
      /^\/storage\/kv\/namespaces\/[a-f0-9]{32}\/bulk\/delete$/.test(
        relative,
      ) &&
      Array.isArray(body) &&
      body.length > 0 &&
      body.length <= 100 &&
      body.every(keyName) &&
      new Set(body).size === body.length;
    ensure(
      account &&
        (namespaceList || detail || cursorPage || deletion) &&
        (method !== "GET" || body === undefined) &&
        typeof withPageInfo === "boolean",
      "recovery-provider-path-invalid",
    );
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    ensure(
      serialized === undefined || Buffer.byteLength(serialized) <= 128 * 1024,
      "recovery-provider-request-oversized",
    );
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Cache-Control": "no-cache",
          ...(serialized === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new RecoveryProviderError("recovery-provider-unreachable");
    }
    ensure(response.ok, "recovery-provider-request-refused");
    const reader = response.body?.getReader();
    ensure(reader, "recovery-provider-body-missing");
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        ensure(size <= 1024 * 1024, "recovery-provider-body-oversized");
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof RecoveryProviderError) throw error;
      throw new RecoveryProviderError("recovery-provider-body-unavailable");
    } finally {
      reader.cancel().catch(() => {});
    }
    let envelope;
    try {
      envelope = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new RecoveryProviderError("recovery-provider-json-invalid");
    }
    ensure(
      envelope?.success === true &&
        Object.hasOwn(envelope, "result") &&
        (envelope.errors === undefined ||
          (Array.isArray(envelope.errors) && envelope.errors.length === 0)),
      "recovery-provider-result-unverified",
    );
    return withPageInfo
      ? { result: envelope.result, resultInfo: envelope.result_info }
      : envelope.result;
  };
}

async function namespaceInventory(subject, client) {
  const result = [];
  const ids = new Set();
  let total;
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const response = await client(
      `/client/v4/accounts/${subject.accountId}/workers/durable_objects/namespaces?page=${page}&per_page=100`,
      { withPageInfo: true },
    );
    const info = response?.resultInfo;
    const reported = info?.total_count;
    const currentPages = Math.max(1, Math.ceil(reported / 100));
    ensure(
      Array.isArray(response?.result) &&
        Number.isSafeInteger(reported) &&
        reported >= 0 &&
        reported <= 2_000 &&
        info.page === page &&
        info.per_page === 100 &&
        info.count === response.result.length &&
        (info.total_pages === undefined || info.total_pages === currentPages) &&
        response.result.length ===
          Math.min(100, Math.max(0, reported - (page - 1) * 100)) &&
        (page === 1 || reported === total),
      "recovery-namespace-inventory-incomplete",
    );
    total = reported;
    pages = currentPages;
    for (const namespace of response.result) {
      ensure(
        matches(namespace?.id, RESOURCE) && !ids.has(namespace.id),
        "recovery-namespace-inventory-duplicate",
      );
      ids.add(namespace.id);
      result.push(namespace);
    }
  }
  const owned = result.filter(
    (namespace) => namespace.script === subject.workerName,
  );
  ensure(
    owned.length === RECOVERY_DO_BINDINGS.length,
    "recovery-namespace-ownership-unverified",
  );
  for (const binding of RECOVERY_DO_BINDINGS) {
    const found = owned.filter(
      (namespace) => namespace.class === CLASSES[binding],
    );
    ensure(
      found.length === 1 &&
        found[0].id === subject.namespaces[binding] &&
        found[0].use_sqlite === true,
      "recovery-namespace-ownership-unverified",
    );
  }
}

async function verifyBindings(subject, client) {
  const prefix = `/client/v4/accounts/${subject.accountId}`;
  const [settings, namespace] = await Promise.all([
    client(`${prefix}/workers/scripts/${subject.workerName}/settings`),
    client(`${prefix}/storage/kv/namespaces/${subject.namespaces.OAUTH_KV}`),
  ]);
  ensure(
    namespace?.id === subject.namespaces.OAUTH_KV &&
      Array.isArray(settings?.bindings),
    "recovery-provider-bindings-unverified",
  );
  const all = settings.bindings;
  ensure(
    all.filter((binding) => binding?.type === "durable_object_namespace")
      .length === RECOVERY_DO_BINDINGS.length &&
      all.filter((binding) => binding?.type === "kv_namespace").length === 1,
    "recovery-provider-bindings-unverified",
  );
  for (const binding of [...RECOVERY_DO_BINDINGS, "OAUTH_KV"]) {
    const found = all.filter((item) => item?.name === binding);
    ensure(found.length === 1, "recovery-provider-bindings-unverified");
    const item = found[0];
    if (binding === "OAUTH_KV") {
      ensure(
        item.type === "kv_namespace" &&
          item.namespace_id === subject.namespaces[binding],
        "recovery-provider-bindings-unverified",
      );
    } else {
      ensure(
        item.type === "durable_object_namespace" &&
          item.class_name === CLASSES[binding] &&
          (!item.namespace_id ||
            item.namespace_id === subject.namespaces[binding]) &&
          !item.script_name &&
          !item.environment &&
          !item.dispatch_namespace,
        "recovery-provider-bindings-unverified",
      );
    }
  }
}

async function cursorInventory(path, client, parse, itemKey) {
  const result = [];
  const cursors = new Set();
  const keys = new Set();
  let cursor;
  let reportedTotal;
  for (let page = 0; page < MAX_PAGES; page++) {
    const suffix =
      cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await client(`${path}?limit=${PAGE_SIZE}${suffix}`, {
      withPageInfo: true,
    });
    const info = response?.resultInfo;
    ensure(
      Array.isArray(response?.result) &&
        response.result.length <= PAGE_SIZE &&
        info &&
        typeof info === "object" &&
        info.count === response.result.length,
      "recovery-cursor-inventory-incomplete",
    );
    if (info.total_count !== undefined) {
      ensure(
        Number.isSafeInteger(info.total_count) &&
          info.total_count >= 0 &&
          info.total_count <= MAX_ITEMS &&
          (reportedTotal === undefined || reportedTotal === info.total_count),
        "recovery-cursor-total-changed",
      );
      reportedTotal = info.total_count;
    }
    for (const raw of response.result) {
      const item = parse(raw);
      const key = itemKey(item);
      ensure(!keys.has(key), "recovery-inventory-duplicate");
      keys.add(key);
      result.push(item);
      ensure(result.length <= MAX_ITEMS, "recovery-inventory-limit-exceeded");
    }
    const next = info.cursor;
    if (next === undefined || next === null || next === "") {
      ensure(
        reportedTotal === undefined || reportedTotal === result.length,
        "recovery-cursor-inventory-incomplete",
      );
      return result.sort((left, right) =>
        itemKey(left) < itemKey(right)
          ? -1
          : itemKey(left) > itemKey(right)
            ? 1
            : 0,
      );
    }
    ensure(
      typeof next === "string" && next.length <= 2048 && !cursors.has(next),
      "recovery-cursor-loop",
    );
    cursors.add(next);
    cursor = next;
  }
  throw new RecoveryProviderError("recovery-inventory-page-limit");
}
function objectItem(raw) {
  ensure(
    matches(raw?.id, OBJECT) && typeof raw.hasStoredData === "boolean",
    "recovery-object-entry-invalid",
  );
  return { id: raw.id, hasStoredData: raw.hasStoredData };
}
function oauthItem(raw) {
  ensure(
    keyName(raw?.name) &&
      (raw.expiration === undefined ||
        (Number.isSafeInteger(raw.expiration) && raw.expiration > 0)),
    "recovery-oauth-key-invalid",
  );
  return { name: raw.name, expiration: raw.expiration ?? null };
}

/** Include every object, even hasStoredData:false; do not persist this raw key inventory. */
export async function inventoryRecoveryResources(namespaceIdentity, client) {
  const subject = structuredClone(identity(namespaceIdentity));
  const startedAt = new Date().toISOString();
  await Promise.all([
    namespaceInventory(subject, client),
    verifyBindings(subject, client),
  ]);
  const objects = {};
  for (const binding of RECOVERY_DO_BINDINGS) {
    objects[binding] = await cursorInventory(
      `/client/v4/accounts/${subject.accountId}/workers/durable_objects/namespaces/${subject.namespaces[binding]}/objects`,
      client,
      objectItem,
      (item) => item.id,
    );
  }
  const oauthKeys = await cursorInventory(
    `/client/v4/accounts/${subject.accountId}/storage/kv/namespaces/${subject.namespaces.OAUTH_KV}/keys`,
    client,
    oauthItem,
    (item) => item.name,
  );
  return {
    format: "agent-table.recovery-inventory.v1",
    namespaceIdentity: subject,
    startedAt,
    completedAt: new Date().toISOString(),
    objects,
    oauthKeys,
    counts: {
      ...Object.fromEntries(
        RECOVERY_DO_BINDINGS.map((binding) => [
          binding,
          objects[binding].length,
        ]),
      ),
      OAUTH_KV: oauthKeys.length,
    },
  };
}

export function validateRecoveryInventory(value) {
  ensure(
    exact(value, [
      "format",
      "namespaceIdentity",
      "startedAt",
      "completedAt",
      "objects",
      "oauthKeys",
      "counts",
    ]) &&
      value.format === "agent-table.recovery-inventory.v1" &&
      instant(value.startedAt) &&
      instant(value.completedAt) &&
      Date.parse(value.completedAt) >= Date.parse(value.startedAt),
    "recovery-inventory-invalid",
  );
  identity(value.namespaceIdentity);
  ensure(
    exact(value.objects, RECOVERY_DO_BINDINGS) &&
      exact(value.counts, [...RECOVERY_DO_BINDINGS, "OAUTH_KV"]) &&
      Array.isArray(value.oauthKeys),
    "recovery-inventory-invalid",
  );
  for (const binding of RECOVERY_DO_BINDINGS) {
    const items = value.objects[binding];
    ensure(
      Array.isArray(items) &&
        items.length <= MAX_ITEMS &&
        value.counts[binding] === items.length,
      "recovery-inventory-count-invalid",
    );
    for (let index = 0; index < items.length; index++) {
      ensure(
        exact(items[index], ["id", "hasStoredData"]),
        "recovery-object-entry-invalid",
      );
      objectItem(items[index]);
      ensure(
        index === 0 || items[index - 1].id < items[index].id,
        "recovery-inventory-duplicate",
      );
    }
  }
  ensure(
    value.oauthKeys.length <= MAX_ITEMS &&
      value.counts.OAUTH_KV === value.oauthKeys.length,
    "recovery-inventory-count-invalid",
  );
  for (let index = 0; index < value.oauthKeys.length; index++) {
    const item = value.oauthKeys[index];
    ensure(
      exact(item, ["name", "expiration"]) &&
        keyName(item.name) &&
        (item.expiration === null ||
          (Number.isSafeInteger(item.expiration) && item.expiration > 0)),
      "recovery-oauth-key-invalid",
    );
    ensure(
      index === 0 || value.oauthKeys[index - 1].name < item.name,
      "recovery-inventory-duplicate",
    );
  }
  return value;
}

/** Content digest omits observation time so two complete listings can be compared. */
export function recoveryInventoryDigest(inventory) {
  validateRecoveryInventory(inventory);
  const { startedAt: _start, completedAt: _end, ...content } = inventory;
  return digest(content);
}

/** Count acknowledgement is separate from subsequent listing and generation fencing. */
export async function deleteInventoriedOAuthKeys(
  namespaceIdentity,
  inventory,
  client,
) {
  identity(namespaceIdentity);
  validateRecoveryInventory(inventory);
  ensure(
    canonicalRecoveryJson(namespaceIdentity) ===
      canonicalRecoveryJson(inventory.namespaceIdentity),
    "recovery-inventory-substitution",
  );
  let deleted = 0;
  let batches = 0;
  for (let offset = 0; offset < inventory.oauthKeys.length; offset += 100) {
    const keys = inventory.oauthKeys
      .slice(offset, offset + 100)
      .map((key) => key.name);
    const result = await client(
      `/client/v4/accounts/${namespaceIdentity.accountId}/storage/kv/namespaces/${namespaceIdentity.namespaces.OAUTH_KV}/bulk/delete`,
      { method: "POST", body: keys },
    );
    ensure(
      result?.successful_key_count === keys.length &&
        Array.isArray(result.unsuccessful_keys) &&
        result.unsuccessful_keys.length === 0,
      "recovery-oauth-delete-incomplete",
    );
    deleted += result.successful_key_count;
    batches++;
  }
  return { requested: inventory.oauthKeys.length, deleted, batches };
}

/** Receipts bind the actual object, build, generation, schema, and request challenge. */
export function verifyObjectInspectionReceipts(
  inventory,
  receipts,
  expected,
  { requireEmpty = false } = {},
) {
  validateRecoveryInventory(inventory);
  ensure(
    expected &&
      ["local", "staging", "production"].includes(expected.environment) &&
      matches(expected.buildSha, SHA) &&
      matches(expected.configSha256, DIGEST) &&
      matches(expected.operationId, UUID) &&
      matches(expected.generation, DIGEST) &&
      matches(expected.requestNonce, DIGEST) &&
      expected.schemaVersion === 12 &&
      canonicalRecoveryJson(expected.namespaceIdentity) ===
        canonicalRecoveryJson(inventory.namespaceIdentity),
    "recovery-inspection-subject-invalid",
  );
  const count = RECOVERY_DO_BINDINGS.reduce(
    (sum, binding) => sum + inventory.objects[binding].length,
    0,
  );
  ensure(
    Array.isArray(receipts) && receipts.length === count,
    "recovery-inspection-coverage-incomplete",
  );
  const expectedIds = new Set(
    RECOVERY_DO_BINDINGS.flatMap((binding) =>
      inventory.objects[binding].map((item) => `${binding}:${item.id}`),
    ),
  );
  for (const receipt of receipts) {
    ensure(
      exact(receipt, INSPECTION_FIELDS),
      "recovery-inspection-shape-invalid",
    );
    const descriptor = DESCRIPTORS[receipt.binding];
    ensure(
      descriptor &&
        expectedIds.delete(`${receipt.binding}:${receipt.objectId}`) &&
        receipt.format === "agent-table.recovery-inspection.v1" &&
        [
          "environment",
          "buildSha",
          "configSha256",
          "operationId",
          "generation",
          "requestNonce",
        ].every((key) => receipt[key] === expected[key]) &&
        receipt.component === descriptor.component &&
        receipt.schemaVersion === descriptor.schemaVersion,
      "recovery-inspection-identity-mismatch",
    );
    ensure(
      canonicalRecoveryJson(receipt.manifest) ===
        canonicalRecoveryJson(recoveryStorageManifest(descriptor)) &&
        exact(
          receipt.counts,
          descriptor.tables.map((table) => table.name),
        ) &&
        Object.values(receipt.counts).every(
          (count) => Number.isSafeInteger(count) && count >= 0,
        ) &&
        Number.isSafeInteger(receipt.kvEntries) &&
        receipt.kvEntries >= 0 &&
        typeof receipt.empty === "boolean" &&
        (receipt.markerGeneration === null ||
          matches(receipt.markerGeneration, DIGEST)),
      "recovery-inspection-schema-mismatch",
    );
    if (requireEmpty) {
      ensure(
        receipt.empty === true &&
          receipt.kvEntries === 0 &&
          receipt.markerGeneration === expected.generation &&
          descriptor.tables.every(
            (table) =>
              receipt.counts[table.name] ===
              (table.name === "table_transcript_usage" ? 1 : 0),
          ),
        "recovery-inspection-private-state-remains",
      );
    }
  }
  ensure(expectedIds.size === 0, "recovery-inspection-coverage-incomplete");
  const ordered = [...receipts].sort((left, right) =>
    `${left.binding}:${left.objectId}` < `${right.binding}:${right.objectId}`
      ? -1
      : 1,
  );
  return {
    format: requireEmpty
      ? "agent-table.recovery-reset-summary.v1"
      : "agent-table.recovery-inspection-summary.v1",
    inventorySha256: recoveryInventoryDigest(inventory),
    receiptSha256: digest(ordered),
    objectCounts: Object.fromEntries(
      RECOVERY_DO_BINDINGS.map((binding) => [
        binding,
        inventory.objects[binding].length,
      ]),
    ),
    totalObjects: count,
  };
}
export function verifyObjectResetReceipts(inventory, receipts, expected) {
  return verifyObjectInspectionReceipts(inventory, receipts, expected, {
    requireEmpty: true,
  });
}
