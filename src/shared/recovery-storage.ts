import {
  MARKER,
  type RecoveryStorageDescriptor,
  recoverySchemaCatalogSha256,
  recoveryStorageManifest,
  SCHEMA,
} from "./recovery-manifests";

export {
  ADMISSION_RECOVERY_STORAGE,
  GUEST_RECOVERY_STORAGE,
  OAUTH_RECOVERY_STORAGE,
  RECOVERY_MARKER_SQL,
  type RecoveryStorageDescriptor,
  TABLE_RECOVERY_STORAGE,
} from "./recovery-manifests";

import {
  type RecoveryClaims,
  type RecoveryDoBinding,
  recoveryContext,
} from "./recovery";

const RECHECK_MS = 6 * 60 * 60_000;

export interface RecoveryObjectRequest {
  operationId: string;
  objectId: string;
  requestNonce?: string;
}

export interface RecoveryInspection {
  format: "agent-table.recovery-inspection.v1";
  environment: RecoveryClaims["environment"];
  buildSha: string;
  configSha256: string;
  operationId: string;
  generation: string;
  objectId: string;
  binding: RecoveryDoBinding;
  component: string;
  schemaVersion: number;
  manifest: { name: string; columns: readonly string[] }[];
  counts: Record<string, number>;
  kvEntries: number;
  markerGeneration: string | null;
  empty: boolean;
  requestNonce: string | null;
}

function unavailable(): never {
  throw new Error("Recovery state unavailable");
}

function sqlInventory(storage: DurableObjectStorage) {
  return storage.sql
    .exec<{
      name: string;
      type: string;
      tbl_name: string;
      sql: string | null;
    }>(
      "SELECT name, type, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA') ORDER BY name",
    )
    .toArray();
}

/** Capture before application initialization; existing empty objects are not virgin. */
export function recoveryStorageWasVirgin(
  storage: DurableObjectStorage,
): boolean {
  return sqlInventory(storage).length === 0;
}

function compatibleSchema(
  storage: DurableObjectStorage,
  descriptor: RecoveryStorageDescriptor,
): boolean {
  if (!descriptor.applicationSchema) return true;
  try {
    const rows = storage.sql
      .exec<{ singleton: number; component: string; version: number }>(
        `SELECT singleton, component, version FROM ${SCHEMA}`,
      )
      .toArray();
    return (
      rows.length === 1 &&
      rows[0].singleton === 1 &&
      rows[0].component === descriptor.component &&
      rows[0].version === descriptor.schemaVersion
    );
  } catch {
    return false;
  }
}

function validateSchema(
  storage: DurableObjectStorage,
  descriptor: RecoveryStorageDescriptor,
): void {
  if (!compatibleSchema(storage, descriptor)) unavailable();
  const expected = recoveryStorageManifest(descriptor);
  const inventory = sqlInventory(storage);
  if (recoverySchemaCatalogSha256(inventory) !== descriptor.schemaSha256)
    unavailable();
  if (inventory.some((item) => item.type !== "table" && item.type !== "index"))
    unavailable();
  const names = inventory
    .filter((item) => item.type === "table")
    .map((item) => item.name)
    .sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(expected.map((item) => item.name).sort())
  )
    unavailable();
  for (const item of expected) {
    const columns = storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM pragma_table_info(?) ORDER BY cid",
        item.name,
      )
      .toArray()
      .map((column) => column.name);
    if (JSON.stringify(columns) !== JSON.stringify(item.columns)) unavailable();
  }
}

type Marker = {
  singleton: number;
  component: string;
  generation: string;
  operation_id: string;
  plan_sha256: string;
};
function marker(storage: DurableObjectStorage): Marker | null {
  const rows = storage.sql
    .exec<Marker>(
      `SELECT singleton,component,generation,operation_id,plan_sha256 FROM ${MARKER}`,
    )
    .toArray();
  if (rows.length === 0) return null;
  const found = rows[0];
  if (
    rows.length !== 1 ||
    found.singleton !== 1 ||
    typeof found.component !== "string" ||
    typeof found.generation !== "string" ||
    typeof found.operation_id !== "string" ||
    typeof found.plan_sha256 !== "string" ||
    !/^[a-z][a-z-]{0,31}$/.test(found.component) ||
    !/^[a-f0-9]{64}$/.test(found.generation) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      found.operation_id,
    ) ||
    !/^[a-f0-9]{64}$/.test(found.plan_sha256)
  )
    unavailable();
  return found;
}

function counts(
  storage: DurableObjectStorage,
  descriptor: RecoveryStorageDescriptor,
): Record<string, number> {
  return Object.fromEntries(
    descriptor.tables.map(({ name }) => [
      name,
      storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`).one()
        .n,
    ]),
  );
}

function emptySql(
  storage: DurableObjectStorage,
  descriptor: RecoveryStorageDescriptor,
  observed = counts(storage, descriptor),
): boolean {
  return descriptor.tables.every(({ name }) => {
    if (
      name === "table_transcript_usage" &&
      descriptor.component === "table" &&
      observed[name] === 1
    ) {
      const row = storage.sql
        .exec<{ singleton: number; body_bytes: number }>(
          "SELECT singleton,body_bytes FROM table_transcript_usage",
        )
        .one();
      return row.singleton === 1 && row.body_bytes === 0;
    }
    return observed[name] === 0;
  });
}

function writeMarker(
  storage: DurableObjectStorage,
  descriptor: RecoveryStorageDescriptor,
  claims: RecoveryClaims,
): void {
  storage.sql.exec(
    `INSERT INTO ${MARKER} (singleton,component,generation,operation_id,plan_sha256) VALUES (1,?,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET component=excluded.component,generation=excluded.generation,operation_id=excluded.operation_id,plan_sha256=excluded.plan_sha256`,
    descriptor.component,
    claims.generation,
    claims.operationId,
    claims.planSha256,
  );
}

export function recoveryObjectDenied(
  storage: DurableObjectStorage,
  env: Env,
  descriptor: RecoveryStorageDescriptor,
): boolean {
  try {
    const context = recoveryContext(env);
    const stored = marker(storage);
    if (context.kind === "legacy") return stored !== null;
    if (
      context.kind !== "authorized" ||
      context.claims.phase !== "serve" ||
      !compatibleSchema(storage, descriptor)
    )
      return true;
    return (
      !stored ||
      stored.component !== descriptor.component ||
      stored.generation !== context.claims.generation ||
      stored.operation_id !== context.claims.operationId ||
      stored.plan_sha256 !== context.claims.planSha256
    );
  } catch {
    return true;
  }
}

/** Called under constructor blockConcurrencyWhile, before any ordinary RPC runs. */
export async function initializeRecoveryFence(
  ctx: DurableObjectState,
  env: Env,
  descriptor: RecoveryStorageDescriptor,
  virginSqlBeforeSchema: boolean,
): Promise<void> {
  const context = recoveryContext(env);
  if (context.kind === "legacy") return;
  if (
    context.kind === "authorized" &&
    context.claims.phase === "serve" &&
    virginSqlBeforeSchema
  ) {
    validateSchema(ctx.storage, descriptor);
    if ((await ctx.storage.list({ limit: 1 })).size === 0) {
      ctx.storage.transactionSync(() => {
        const current = recoveryContext(env);
        if (
          current.kind !== "authorized" ||
          current.claims.phase !== "serve" ||
          current.claims.generation !== context.claims.generation ||
          marker(ctx.storage) !== null ||
          !emptySql(ctx.storage, descriptor)
        )
          unavailable();
        writeMarker(ctx.storage, descriptor, current.claims);
      });
    }
  }
}

function resetClaims(
  ctx: DurableObjectState,
  env: Env,
  input: RecoveryObjectRequest,
): RecoveryClaims {
  const context = recoveryContext(env);
  const keys =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.keys(input)
      : [];
  if (
    context.kind !== "authorized" ||
    context.claims.phase !== "reset" ||
    env.RESTORE_QUARANTINE !== "true" ||
    [
      env.ALLOW_NEW_GUESTS,
      env.ALLOW_NEW_TABLES,
      env.ENABLE_MCP_SUBSCRIPTIONS,
      env.ENABLE_OPENAI_EVENTS,
      env.ALLOW_OUTBOUND_NOTIFICATIONS,
    ].some((flag) => flag !== "false") ||
    keys.some(
      (key) => !["operationId", "objectId", "requestNonce"].includes(key),
    ) ||
    input?.operationId !== context.claims.operationId ||
    typeof input?.objectId !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.objectId) ||
    input.objectId !== ctx.id.toString() ||
    (input.requestNonce !== undefined &&
      (typeof input.requestNonce !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(input.requestNonce)))
  )
    unavailable();
  return context.claims;
}

async function kvCount(storage: DurableObjectStorage): Promise<number> {
  let total = 0;
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list({
      limit: 128,
      ...(startAfter === undefined ? {} : { startAfter }),
    });
    total += page.size;
    if (page.size < 128) return total;
    startAfter = [...page.keys()].at(-1);
    if (startAfter === undefined) unavailable();
  }
}

async function inspection(
  ctx: DurableObjectState,
  env: Env,
  descriptor: RecoveryStorageDescriptor,
  input: RecoveryObjectRequest,
): Promise<RecoveryInspection> {
  const claims = resetClaims(ctx, env, input);
  validateSchema(ctx.storage, descriptor);
  const kvEntries = await kvCount(ctx.storage);
  const current = resetClaims(ctx, env, input);
  if (current.generation !== claims.generation) unavailable();
  validateSchema(ctx.storage, descriptor);
  const observed = counts(ctx.storage, descriptor);
  const stored = marker(ctx.storage);
  return {
    format: "agent-table.recovery-inspection.v1",
    environment: claims.environment,
    buildSha: claims.buildSha,
    configSha256: claims.configSha256,
    operationId: claims.operationId,
    generation: claims.generation,
    objectId: ctx.id.toString(),
    binding: descriptor.binding,
    component: descriptor.component,
    schemaVersion: descriptor.schemaVersion,
    manifest: recoveryStorageManifest(descriptor),
    counts: observed,
    kvEntries,
    markerGeneration: stored?.generation ?? null,
    empty: kvEntries === 0 && emptySql(ctx.storage, descriptor, observed),
    requestNonce: input.requestNonce ?? null,
  };
}

export function inspectRecoveryObject(
  ctx: DurableObjectState,
  env: Env,
  descriptor: RecoveryStorageDescriptor,
  input: RecoveryObjectRequest,
): Promise<RecoveryInspection> {
  return recoveryLock(ctx, () => inspection(ctx, env, descriptor, input));
}

/** A refused operator request must not break the Durable Object input gate. */
async function recoveryLock<T>(
  ctx: DurableObjectState,
  operation: () => Promise<T>,
): Promise<T> {
  const result = await ctx.blockConcurrencyWhile(async () => {
    try {
      return { ok: true as const, value: await operation() };
    } catch {
      return { ok: false as const };
    }
  });
  if (!result.ok) unavailable();
  return result.value;
}

export function resetRecoveryObject(
  ctx: DurableObjectState,
  env: Env,
  descriptor: RecoveryStorageDescriptor,
  input: RecoveryObjectRequest,
): Promise<RecoveryInspection> {
  return recoveryLock(ctx, async () => {
    const claims = resetClaims(ctx, env, input);
    validateSchema(ctx.storage, descriptor);
    const prior = marker(ctx.storage);
    // Repeating this exact reset is idempotent only while its canonical state
    // remains empty. It cannot erase data added under a cleared generation.
    if (prior?.generation === claims.generation) {
      if (
        prior.component !== descriptor.component ||
        prior.operation_id !== claims.operationId ||
        prior.plan_sha256 !== claims.planSha256
      )
        unavailable();
      const observed = await inspection(ctx, env, descriptor, input);
      if (!observed.empty) unavailable();
      return observed;
    }
    await ctx.storage.transaction(async (txn) => {
      resetClaims(ctx, env, input);
      validateSchema(ctx.storage, descriptor);
      for (;;) {
        const page = await txn.list({ limit: 128 });
        if (page.size === 0) break;
        await txn.delete([...page.keys()]);
        resetClaims(ctx, env, input);
      }
      ctx.storage.transactionSync(() => {
        const current = resetClaims(ctx, env, input);
        if (current.generation !== claims.generation) unavailable();
        validateSchema(ctx.storage, descriptor);
        for (const { name } of descriptor.tables)
          ctx.storage.sql.exec(`DELETE FROM ${name}`);
        if (descriptor.component === "table")
          ctx.storage.sql.exec(
            "INSERT INTO table_transcript_usage(singleton,body_bytes) VALUES(1,0)",
          );
        writeMarker(ctx.storage, descriptor, current);
      });
      if (
        descriptor.component === "guest" ||
        descriptor.component === "table"
      ) {
        await txn.setAlarm(Date.now() + RECHECK_MS);
      } else {
        await txn.deleteAlarm();
      }
    });
    const observed = await inspection(ctx, env, descriptor, input);
    if (!observed.empty || observed.markerGeneration !== claims.generation)
      unavailable();
    return observed;
  });
}
