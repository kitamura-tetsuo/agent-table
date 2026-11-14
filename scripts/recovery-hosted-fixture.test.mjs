import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { signRecoveryAuthorization } from "./recovery-configuration.mjs";
import { verifyObjectResetReceipts } from "./recovery-provider.mjs";
import { recoveryControlAdapter } from "./recovery-run.mjs";

// This check exercises the hosted fixture's actual application operations and
// isolation guards. It never substitutes a local restore for hosted PITR evidence.
const workerName = "agent-table-pr51-recovery-staging";
const plain = (value) => JSON.parse(JSON.stringify(value));
let directory;
let bundle;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-table-hosted-fixture-"));
  bundle = join(directory, "worker.mjs");
  await build({
    entryPoints: ["test/recovery-hosted/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    outfile: bundle,
    logLevel: "silent",
  });
  await build({
    stdin: {
      contents:
        'export {default, RecoveryRehearsal, RecoveryControl, GuestDO, OAuthTokenDO, AdmissionDO, FutureSchemaReadback as TableDO} from "./test/recovery-hosted/worker.ts";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    outfile: join(directory, "forensic.mjs"),
    logLevel: "silent",
  });
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});
function input() {
  return {
    runId: randomUUID(),
    guestId: randomUUID(),
    tableId: randomUUID(),
    sessionId: randomUUID(),
    secret: randomBytes(32).toString("base64url"),
    connectionId: randomUUID(),
    expiringConnectionId: randomUUID(),
    requestId: randomUUID(),
  };
}
function runtime(scenario, overrides = {}) {
  const outbound = [];
  const name = overrides.HOSTED_RECOVERY_FIXTURE_WORKER ?? workerName;
  const settings = {
    rootPath: directory,
    resourcePersistencePath: join(directory, scenario.runId),
    workers: [
      {
        name,
        scriptPath: "worker.mjs",
        modules: true,
        compatibilityDate: "2026-11-07",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        durableObjects: Object.fromEntries(
          [
            ["TABLES", "TableDO"],
            ["GUESTS", "GuestDO"],
            ["OAUTH_SERIALIZER", "OAuthTokenDO"],
            ["ADMISSION", "AdmissionDO"],
          ].map(([name, className]) => [name, { className, useSQLite: true }]),
        ),
        kvNamespaces: { OAUTH_KV: "hosted-fixture-synthetic-only" },
        bindings: {
          PUBLIC_ORIGIN: `https://${name}.synthetic-only.workers.dev`,
          RELEASE_ENVIRONMENT: "staging",
          RELEASE_BUILD_SHA: "a".repeat(40),
          RESTORE_QUARANTINE: "true",
          HOSTED_RECOVERY_FIXTURE: "issue51-synthetic-only",
          HOSTED_RECOVERY_FIXTURE_WORKER: name,
          HOSTED_RECOVERY_FIXTURE_RUN_ID: scenario.runId,
          ENABLE_MCP_SUBSCRIPTIONS: "false",
          ENABLE_OPENAI_EVENTS: "false",
          ALLOW_NEW_GUESTS: "false",
          ALLOW_NEW_TABLES: "false",
          ALLOW_OUTBOUND_NOTIFICATIONS: "false",
          ...overrides,
        },
        outboundService: () => {
          outbound.push("unexpected-egress");
          return new Response(null, { status: 503 });
        },
      },
      {
        name: "driver",
        script:
          "export default {fetch() {return new Response(null,{status:503})}}",
        modules: true,
        compatibilityDate: "2026-11-07",
        serviceBindings: {
          FIXTURE: { name, entrypoint: "RecoveryRehearsal" },
          RECOVERY: { name, entrypoint: "RecoveryControl" },
        },
      },
    ],
    log: new Log(LogLevel.ERROR),
  };
  const mf = new Miniflare(convertV4MiniflareOptions(settings));
  return { mf, outbound, settings, name };
}
test("hosted fixture uses real revoke, browser approval, expiry and alarm guards without simulated PITR", {
  timeout: 30_000,
}, async () => {
  const scenario = input();
  const { mf, outbound } = runtime(scenario);
  try {
    const bindings = await mf.getBindings(workerName);
    const service = (await mf.getBindings("driver")).FIXTURE;
    const guest = bindings.GUESTS.get(
      bindings.GUESTS.idFromName(scenario.guestId),
    );
    const table = bindings.TABLES.get(
      bindings.TABLES.idFromName(scenario.tableId),
    );
    const capturedGuest = await guest.fixtureSeed(scenario);
    await table.fixtureSeed(scenario);
    assert.ok(capturedGuest.capturedAt < capturedGuest.expiresAt);
    const held = await service.inspectHistorical(scenario);
    assert.equal(held.guest.privateAccessDenied, true);
    assert.equal(held.table.privateAccessDenied, true);
    assert.equal(held.table.counts.table_event_outbox, 1);
    assert.equal(held.guest.alarmInvoked, true);
    assert.equal(held.table.alarmInvoked, true);
    const event = await service.performPostSnapshotEvents(scenario);
    assert.equal(event.deletion.confirmationRequired, true);
    assert.equal(event.deletion.pending, true);
    assert.equal(event.deletion.deleted, true);
    assert.equal(event.revocation.denied, true);
    assert.equal(event.revocation.oldSessionDenied, true);
    const deadline = capturedGuest.expiresAt;
    await delay(Math.max(0, deadline - Date.now()) + 30);
    assert.equal((await service.observeExpiry(scenario)).expired, true);
    for (const path of ["/guest", "/guest/table", "/mcp", "/oauth/token"]) {
      const response = await service.fetch(`http://localhost${path}`, {
        method: path === "/oauth/token" ? "POST" : "GET",
      });
      assert.equal(response.status, 503);
    }
    assert.deepEqual(outbound, []);
  } finally {
    await mf.dispose();
  }
});

test("fixture refuses a foreign run or a production environment before creating synthetic state", {
  timeout: 15_000,
}, async () => {
  const scenario = input();
  const { mf } = runtime(scenario, { RELEASE_ENVIRONMENT: "production" });
  try {
    const service = (await mf.getBindings("driver")).FIXTURE;
    await assert.rejects(
      async () => await service.prepare(scenario),
      /fixture unavailable/,
    );
  } finally {
    await mf.dispose();
  }
  const other = runtime(scenario);
  try {
    const service = (await other.mf.getBindings("driver")).FIXTURE;
    await assert.rejects(
      async () => await service.prepare({ ...scenario, runId: randomUUID() }),
      /fixture unavailable/,
    );
  } finally {
    await other.mf.dispose();
  }
});

async function authorizeReset(fixture) {
  const bindings = await fixture.mf.getBindings(fixture.name);
  const names = ["TABLES", "GUESTS", "OAUTH_SERIALIZER", "ADMISSION"];
  const identity = {
    accountId: "1".repeat(32),
    workerName: fixture.name,
    namespaces: Object.fromEntries(
      [...names, "OAUTH_KV"].map((name, index) => [
        name,
        String(index + 2).repeat(32),
      ]),
    ),
    commitments: Object.fromEntries(
      names.map((name) => [
        name,
        bindings[name]
          .idFromName("agent-table/recovery-namespace/v1")
          .toString(),
      ]),
    ),
  };
  const pair = generateKeyPairSync("ed25519");
  const claims = {
    format: "agent-table.fresh-start.v1",
    phase: "reset",
    operationId: randomUUID(),
    generation: randomBytes(32).toString("hex"),
    environment: "staging",
    buildSha: "a".repeat(40),
    configSha256: "b".repeat(64),
    schemaVersion: 12,
    namespaceIdentity: identity,
    planSha256: "c".repeat(64),
    evidenceSha256: null,
    previousRecordSha256: "0".repeat(64),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvalRef: "synthetic-local-fixture-only",
  };
  Object.assign(fixture.settings.workers[0].bindings, {
    RECOVERY_VERIFICATION_KEY: pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    RECOVERY_NAMESPACE_IDENTITY: JSON.stringify(identity),
    RECOVERY_CONFIG_SHA256: claims.configSha256,
    RECOVERY_AUTHORIZATION: signRecoveryAuthorization(
      claims,
      pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ),
  });
  await fixture.mf.dispose();
  fixture.mf = new Miniflare(convertV4MiniflareOptions(fixture.settings));
  return claims;
}

test("production RPC adapter detaches canonical reset receipts and verifies post-reset alarm parking", {
  timeout: 45_000,
}, async () => {
  const scenario = input();
  const fixture = runtime(scenario);
  try {
    const prepared = plain(
      await (await fixture.mf.getBindings("driver")).FIXTURE.prepare(scenario),
    );
    const claims = await authorizeReset(fixture);
    const driver = await fixture.mf.getBindings("driver");
    const rawIdentity = await driver.RECOVERY.identity();
    assert.equal(Object.getPrototypeOf(rawIdentity), null);
    const control = recoveryControlAdapter(driver.RECOVERY);
    const identity = await control.identity();
    assert.equal(Object.getPrototypeOf(identity), Object.prototype);
    assert.deepEqual(
      identity.commitments,
      claims.namespaceIdentity.commitments,
    );
    const authority = {
      operationId: claims.operationId,
      requestNonce: "d".repeat(64),
    };
    const receipts = [];
    for (const captured of [prepared.guest, prepared.table]) {
      const request = {
        ...authority,
        binding: captured.binding,
        objectId: captured.objectId,
      };
      const receipt = await control.reset(request);
      receipts.push(await control.inspect(request));
      assert.equal(Object.getPrototypeOf(receipt), Object.prototype);
      assert.equal(Object.getPrototypeOf(receipt.counts), Object.prototype);
      assert.equal(receipt.empty, true);
      assert.equal(receipt.markerGeneration, claims.generation);
      assert.equal(receipt.kvEntries, 0);
    }
    const observedAt = new Date().toISOString();
    const inventory = {
      format: "agent-table.recovery-inventory.v1",
      namespaceIdentity: claims.namespaceIdentity,
      startedAt: observedAt,
      completedAt: observedAt,
      objects: {
        TABLES: [{ id: prepared.table.objectId, hasStoredData: true }],
        GUESTS: [{ id: prepared.guest.objectId, hasStoredData: true }],
        OAUTH_SERIALIZER: [],
        ADMISSION: [],
      },
      oauthKeys: [],
      counts: {
        TABLES: 1,
        GUESTS: 1,
        OAUTH_SERIALIZER: 0,
        ADMISSION: 0,
        OAUTH_KV: 0,
      },
    };
    assert.equal(
      verifyObjectResetReceipts(inventory, receipts, {
        ...claims,
        requestNonce: authority.requestNonce,
      }).totalObjects,
      2,
    );
    const observed = await driver.FIXTURE.inspectReset(scenario, authority);
    for (const value of [observed.guest, observed.table]) {
      assert.equal(value.privateAccessDenied, true);
      assert.equal(value.alarmInvoked, true);
      assert.equal(value.inspection.empty, true);
      assert.ok(value.alarmBeforeInvocation > Date.now() + 5 * 60 * 60_000);
      assert.ok(value.alarmScheduledAt > Date.now() + 5 * 60 * 60_000);
    }
    assert.deepEqual(fixture.outbound, []);
    await fixture.mf.dispose();
    // Evidence remains usable after every live RPC proxy has been invalidated.
    assert.deepEqual(
      identity.commitments,
      claims.namespaceIdentity.commitments,
    );
    assert.equal(
      verifyObjectResetReceipts(inventory, receipts, {
        ...claims,
        requestNonce: authority.requestNonce,
      }).totalObjects,
      2,
    );
  } finally {
    await fixture.mf.dispose();
  }
});

test("future-schema fixture refuses real reset and preserves SQL across constructor refusal and forensic restart", {
  timeout: 20_000,
}, async () => {
  const scenario = input();
  const fixture = runtime(scenario, {
    HOSTED_RECOVERY_FIXTURE_WORKER: "agent-table-pr51-schema-staging",
  });
  try {
    const prepared = plain(
      await (await fixture.mf.getBindings("driver")).FIXTURE.prepare(scenario),
    );
    const claims = await authorizeReset(fixture);
    let service = (await fixture.mf.getBindings("driver")).FIXTURE;
    const future = plain(
      await service.prepareFutureSchema(scenario, {
        operationId: claims.operationId,
        objectId: prepared.table.objectId,
        requestNonce: "d".repeat(64),
      }),
    );
    assert.equal(future.schemaVersion, 13);
    assert.equal(future.constructorValidatorRefused, true);
    assert.equal(future.inspectionRefused, true);
    assert.equal(future.resetRefused, true);
    await assert.rejects(
      async () =>
        await service.restartFutureSchema({
          runId: scenario.runId,
          objectId: prepared.table.objectId,
        }),
    );
    await assert.rejects(
      async () => await service.inspectHistorical(scenario),
      (error) => {
        assert.equal(error.name, "UnsupportedApplicationSchemaError");
        assert.match(
          error.message,
          /Application schema version 13 is newer than supported 12/,
        );
        return true;
      },
    );
    await fixture.mf.dispose();
    fixture.settings.workers[0].scriptPath = "forensic.mjs";
    fixture.mf = new Miniflare(convertV4MiniflareOptions(fixture.settings));
    service = (await fixture.mf.getBindings("driver")).FIXTURE;
    const retained = await service.inspectFutureSchema({
      runId: scenario.runId,
      objectId: prepared.table.objectId,
    });
    assert.equal(retained.objectId, future.objectId);
    assert.equal(retained.schemaVersion, 13);
    assert.equal(retained.canonicalSha256, future.canonicalSha256);
    assert.deepEqual(retained.counts, future.counts);
    assert.equal(retained.kvEntries, future.kvEntries);
    assert.deepEqual(fixture.outbound, []);
  } finally {
    await fixture.mf.dispose();
  }
});
