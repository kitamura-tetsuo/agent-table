import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  ADMISSION_RECOVERY_STORAGE,
  GUEST_RECOVERY_STORAGE,
  OAUTH_RECOVERY_STORAGE,
  recoveryStorageManifest,
  TABLE_RECOVERY_STORAGE,
} from "../src/shared/recovery-manifests.ts";
import { makeConfig } from "../test/helpers/release-fixtures.mjs";
import {
  recoveryDigest,
  verifyRecoveryConfiguration,
} from "./recovery-configuration.mjs";
import { runFreshStartRecovery } from "./recovery-execution.mjs";
import {
  recoveryRecordDigest,
  validateRecoveryTransition,
} from "./recovery-record.mjs";

const descriptors = {
  TABLES: TABLE_RECOVERY_STORAGE,
  GUESTS: GUEST_RECOVERY_STORAGE,
  OAUTH_SERIALIZER: OAUTH_RECOVERY_STORAGE,
  ADMISSION: ADMISSION_RECOVERY_STORAGE,
};
function harness() {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const config = makeConfig("staging");
  config.vars.RESTORE_QUARANTINE = "true";
  config.vars.ALLOW_NEW_TABLES = "false";
  config.vars.RECOVERY_VERIFICATION_KEY = pair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  config.durable_objects.code_update_strategy = { mode: "immediate" };
  const namespaceIdentity = {
    accountId: config.account_id,
    workerName: config.name,
    namespaces: {
      TABLES: "3".repeat(32),
      GUESTS: "4".repeat(32),
      OAUTH_SERIALIZER: "5".repeat(32),
      ADMISSION: "6".repeat(32),
      OAUTH_KV: "1".repeat(32),
    },
    commitments: Object.fromEntries(
      Object.keys(descriptors).map((name, index) => [
        name,
        String(index + 1).repeat(64),
      ]),
    ),
  };
  const plan = {
    format: "agent-table.fresh-start-plan.v1",
    environment: "staging",
    operationId: randomUUID(),
    generation: randomBytes(32).toString("hex"),
    buildSha: config.vars.RELEASE_BUILD_SHA,
    namespaceIdentity,
    quarantineConfig: config,
    servingConfig: {
      ...structuredClone(config),
      vars: { ...config.vars, RESTORE_QUARANTINE: "false" },
    },
    peerConfig: makeConfig("production"),
    ciEvidence: {},
  };
  let journal = { headSha: null, record: null, recordSha256: null };
  let version = randomUUID();
  let currentConfig = makeConfig("staging");
  let oauthPresent = true;
  const empty = new Set();
  const events = [];
  const effects = { deploys: 0, resets: 0 };
  const initialId = Object.fromEntries(
    Object.keys(descriptors).map((name, index) => [
      name,
      String(index + 4).repeat(64),
    ]),
  );
  const provider = () => ({
    targetState: {
      accountId: config.account_id,
      workerName: config.name,
      kvId: "1".repeat(32),
      doNamespaces: Object.fromEntries(
        Object.keys(descriptors).map((name) => [
          name,
          namespaceIdentity.namespaces[name],
        ]),
      ),
      versionId: version,
      textBindings: { ...currentConfig.vars },
    },
  });
  const inventory = () => ({
    format: "agent-table.recovery-inventory.v1",
    namespaceIdentity,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    objects: Object.fromEntries(
      Object.keys(descriptors).map((name) => [
        name,
        [{ id: initialId[name], hasStoredData: true }],
      ]),
    ),
    oauthKeys: oauthPresent
      ? [{ name: "grant:old-synthetic", expiration: null }]
      : [],
    counts: {
      TABLES: 1,
      GUESTS: 1,
      OAUTH_SERIALIZER: 1,
      ADMISSION: 1,
      OAUTH_KV: oauthPresent ? 1 : 0,
    },
  });
  const receipt = (request) => {
    const claims = verifyRecoveryConfiguration(currentConfig);
    const descriptor = descriptors[request.binding];
    return {
      format: "agent-table.recovery-inspection.v1",
      environment: "staging",
      buildSha: plan.buildSha,
      configSha256: claims.configSha256,
      operationId: plan.operationId,
      generation: plan.generation,
      objectId: request.objectId,
      binding: request.binding,
      component: descriptor.component,
      schemaVersion: descriptor.schemaVersion,
      manifest: recoveryStorageManifest(descriptor),
      counts: Object.fromEntries(
        descriptor.tables.map((table) => [
          table.name,
          table.name === "table_transcript_usage"
            ? 1
            : empty.has(request.binding)
              ? 0
              : 1,
        ]),
      ),
      kvEntries: empty.has(request.binding) ? 0 : 1,
      markerGeneration: empty.has(request.binding) ? plan.generation : null,
      empty: empty.has(request.binding),
      requestNonce: request.requestNonce,
    };
  };
  const control = {
    identity: async () => ({
      buildSha: plan.buildSha,
      environment: "staging",
      schemaVersion: 12,
      commitments: namespaceIdentity.commitments,
    }),
    inspect: async (request) => receipt(request),
    reset: async (request) => {
      events.push(`reset:${request.binding}`);
      effects.resets++;
      empty.add(request.binding);
      return receipt(request);
    },
    dispose: async () => {},
  };
  const dependencies = {
    authorize: async () => {
      events.push("approved");
    },
    authorizeSource: async () => {},
    readJournal: async () => structuredClone(journal),
    writeJournal: async (next, expected) => {
      assert.equal(journal.recordSha256, expected.recordSha256);
      validateRecoveryTransition(journal.record, next);
      journal = {
        headSha: randomBytes(20).toString("hex"),
        record: structuredClone(next),
        recordSha256: recoveryRecordDigest(next),
      };
      events.push(next.state);
      return structuredClone(journal);
    },
    readProvider: async () => provider(),
    deploy: async (next) => {
      currentConfig = structuredClone(next);
      version = randomUUID();
      effects.deploys++;
      events.push(
        next.vars.RESTORE_QUARANTINE === "true"
          ? "deploy:quarantine"
          : "deploy:serve",
      );
    },
    verifyDeployed: async (observed, next) =>
      assert.deepEqual(observed.textBindings, next.vars),
    connectControl: async () => control,
    inventory: async () => inventory(),
    deleteOAuthKeys: async () => {
      oauthPresent = false;
      events.push("delete:oauth");
      return { requested: 1, deleted: 1, batches: 1 };
    },
    verifyIngressDenied: async () =>
      currentConfig.vars.RESTORE_QUARANTINE === "true",
    verifyServing: async () => true,
  };
  const run = (phase) =>
    runFreshStartRecovery({
      plan,
      planSha256: recoveryDigest(plan),
      phase,
      workflow: {
        kind: "recovery",
        repository: "kitamura-tetsuo/agent-table",
        environment: "staging",
        sha: plan.buildSha,
        runId: "1234",
        runAttempt: "1",
      },
      privateKey,
      dependencies,
      expectedActiveVersionId: version,
      expectedRecordSha256: journal.recordSha256,
    });
  return {
    plan,
    dependencies,
    control,
    effects,
    events,
    run,
    get journal() {
      return journal;
    },
    get config() {
      return currentConfig;
    },
  };
}

test("verified discard keeps quarantine until a separate clearance run", async () => {
  const h = harness();
  const result = await h.run("discard");
  assert.equal(result.phase, "verified");
  assert.equal(result.clearanceExecuted, false);
  assert.equal(h.config.vars.RESTORE_QUARANTINE, "true");
  assert.equal(h.journal.record.state, "verified");
  assert.equal(h.effects.resets, 4);
  assert.equal(h.events.includes("deploy:serve"), false);
  const cleared = await h.run("clear");
  assert.equal(cleared.phase, "cleared");
  assert.equal(h.journal.record.state, "cleared");
  assert.equal(h.effects.resets, 4);
  assert.equal(verifyRecoveryConfiguration(h.config).phase, "serve");
  await assert.rejects(h.run("clear"), /recovery-new-generation-required/);
});

test("unknown schema before any reset leaves every object intact and quarantined", async () => {
  const h = harness();
  const inspect = h.control.inspect;
  h.control.inspect = async (request) =>
    request.binding === "GUESTS"
      ? Promise.reject(new Error("unsupported schema"))
      : inspect(request);
  await assert.rejects(h.run("discard"), /unsupported schema/);
  assert.equal(h.effects.resets, 0);
  assert.equal(h.journal.record.state, "prepared");
  assert.equal(h.config.vars.RESTORE_QUARANTINE, "true");
});

test("interrupted reset resumes the same operation and cannot implicitly clear", async () => {
  const h = harness();
  const reset = h.control.reset;
  h.control.reset = async (request) => {
    if (request.binding === "GUESTS") throw new Error("interrupted");
    return reset(request);
  };
  await assert.rejects(h.run("discard"), /interrupted/);
  assert.equal(h.journal.record.state, "resetting");
  assert.equal(h.config.vars.RESTORE_QUARANTINE, "true");
  h.control.reset = reset;
  await h.run("discard");
  assert.equal(h.journal.record.state, "verified");
  assert.equal(h.events.includes("deploy:serve"), false);
});

test("residual state or readback failure never produces a completed receipt", async () => {
  for (const mode of ["residual", "ingress", "postclear"]) {
    const h = harness();
    if (mode === "residual")
      h.dependencies.deleteOAuthKeys = async () => ({
        requested: 1,
        deleted: 1,
        batches: 1,
      });
    if (mode === "ingress")
      h.dependencies.verifyIngressDenied = async () => false;
    if (mode === "postclear") {
      await h.run("discard");
      h.dependencies.verifyServing = async () => false;
      await assert.rejects(h.run("clear"), /recovery-serving-readback-failed/);
      assert.equal(h.journal.record.state, "verified");
    } else {
      await assert.rejects(
        h.run("discard"),
        /recovery-residual-state-observed|recovery-private-ingress-not-denied/,
      );
      assert.equal(h.journal.record.state, "resetting");
    }
    assert.equal(h.config.vars.RESTORE_QUARANTINE, "true");
  }
});

test("approval rejection happens before journal or provider mutations", async () => {
  const h = harness();
  h.dependencies.authorize = async () => {
    throw new Error("not approved");
  };
  await assert.rejects(h.run("discard"), /not approved/);
  assert.equal(h.effects.deploys, 0);
  assert.equal(h.journal.record, null);
});

test("a newly approved generation can supersede interrupted recovery after main advances", async () => {
  const h = harness();
  const reset = h.control.reset;
  h.control.reset = async (request) => {
    if (request.binding === "GUESTS") throw new Error("interrupted");
    return reset(request);
  };
  await assert.rejects(h.run("discard"), /interrupted/);
  const oldGeneration = h.plan.generation;
  h.plan.operationId = randomUUID();
  h.plan.generation = randomBytes(32).toString("hex");
  h.plan.buildSha = "b".repeat(40);
  h.plan.quarantineConfig.vars.RELEASE_BUILD_SHA = h.plan.buildSha;
  h.plan.servingConfig.vars.RELEASE_BUILD_SHA = h.plan.buildSha;
  h.control.reset = reset;
  await h.run("discard");
  assert.equal(h.journal.record.state, "verified");
  assert.notEqual(h.journal.record.generation, oldGeneration);
  assert.equal(h.config.vars.RESTORE_QUARANTINE, "true");
});

test("a cleared generation can endorse a separately approved future intake configuration", async () => {
  const h = harness();
  await h.run("discard");
  await h.run("clear");
  h.plan.buildSha = "c".repeat(40);
  for (const config of [h.plan.quarantineConfig, h.plan.servingConfig]) {
    config.vars.RELEASE_BUILD_SHA = h.plan.buildSha;
    config.vars.GUEST_CHALLENGE_MODE = "required";
    config.vars.TURNSTILE_SITE_KEY = "synthetic-reviewed-turnstile-site-key";
  }
  h.plan.servingConfig.vars.ALLOW_NEW_GUESTS = "true";
  h.plan.servingConfig.vars.ALLOW_NEW_TABLES = "true";
  const count = h.effects.deploys;
  const result = await h.run("endorse");
  assert.equal(result.phase, "endorsed");
  assert.equal(result.clearanceExecuted, false);
  assert.equal(h.effects.deploys, count);
  assert.equal(h.config.vars.ALLOW_NEW_GUESTS, "false");
});

test("a preflight clearance race never triggers a compensating overwrite", async () => {
  const h = harness();
  await h.run("discard");
  let sourceChecks = 0;
  const readProvider = h.dependencies.readProvider;
  h.dependencies.authorizeSource = async () => {
    if (++sourceChecks === 2)
      h.dependencies.readProvider = async () => {
        const value = await readProvider();
        value.targetState.versionId = randomUUID();
        return value;
      };
  };
  const deploys = h.effects.deploys;
  await assert.rejects(h.run("clear"), /recovery-deployment-raced/);
  assert.equal(h.effects.deploys, deploys + 1);
  assert.equal(h.config.vars.RESTORE_QUARANTINE, "true");
});

test("an interrupted successful clearance CAS is authenticated instead of undone", async () => {
  const h = harness();
  await h.run("discard");
  const writeJournal = h.dependencies.writeJournal;
  h.dependencies.writeJournal = async (record, expected) => {
    const result = await writeJournal(record, expected);
    if (record.state === "cleared") throw new Error("reply interrupted");
    return result;
  };
  const result = await h.run("clear");
  assert.equal(result.phase, "cleared");
  assert.equal(h.config.vars.RESTORE_QUARANTINE, "false");
  assert.equal(h.journal.record.state, "cleared");
});

test("a discard plan cannot hide an intake opening that later clearance would refuse", async () => {
  const h = harness();
  h.plan.servingConfig.vars.ALLOW_NEW_TABLES = "true";
  await assert.rejects(
    h.run("discard"),
    /recovery-clearance-cannot-open-public-intake/,
  );
  assert.equal(h.effects.deploys, 0);
  assert.equal(h.journal.record, null);
});
