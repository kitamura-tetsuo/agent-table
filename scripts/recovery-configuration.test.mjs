import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { makeConfig } from "../test/helpers/release-fixtures.mjs";
import {
  canonicalJson,
  recoveryConfigurationDigest,
  signedRecoveryConfiguration,
  verifyRecoveryConfiguration,
  verifyRecoveryContinuity,
} from "./recovery-configuration.mjs";

function configurationFixture(phase = "serve") {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const config = makeConfig("staging");
  config.vars.RECOVERY_VERIFICATION_KEY = pair.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  config.vars.ALLOW_NEW_TABLES = "false";
  config.vars.RESTORE_QUARANTINE = phase === "reset" ? "true" : "false";
  config.durable_objects.code_update_strategy = { mode: "immediate" };
  const identity = {
    accountId: config.account_id,
    workerName: config.name,
    namespaces: {
      TABLES: "3".repeat(32),
      GUESTS: "4".repeat(32),
      OAUTH_SERIALIZER: "5".repeat(32),
      ADMISSION: "6".repeat(32),
      OAUTH_KV: config.kv_namespaces[0].id,
    },
    commitments: {
      TABLES: "a".repeat(64),
      GUESTS: "b".repeat(64),
      OAUTH_SERIALIZER: "c".repeat(64),
      ADMISSION: "d".repeat(64),
    },
  };
  const claims = {
    format: "agent-table.fresh-start.v1",
    phase,
    operationId: randomUUID(),
    generation: randomBytes(32).toString("hex"),
    environment: "staging",
    buildSha: config.vars.RELEASE_BUILD_SHA,
    configSha256: "0".repeat(64),
    schemaVersion: 12,
    namespaceIdentity: identity,
    planSha256: "e".repeat(64),
    evidenceSha256: phase === "serve" ? "f".repeat(64) : null,
    previousRecordSha256: "0".repeat(64),
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt:
      phase === "reset" ? new Date(Date.now() + 600_000).toISOString() : null,
    approvalRef:
      "https://github.com/kitamura-tetsuo/agent-table/actions/runs/1234",
  };
  const signed = signedRecoveryConfiguration(config, claims, privateKey);
  const bound = verifyRecoveryConfiguration(signed);
  const observed = {
    accountId: identity.accountId,
    workerName: identity.workerName,
    kvId: identity.namespaces.OAUTH_KV,
    doNamespaces: Object.fromEntries(
      Object.keys(identity.commitments).map((name) => [
        name,
        identity.namespaces[name],
      ]),
    ),
    textBindings: { ...signed.vars },
  };
  const record = {
    ...bound,
    state: "cleared",
    certificateSha256: "9".repeat(64),
  };
  return {
    config: signed,
    claims: bound,
    privateKey,
    observed,
    journal: { headSha: "a".repeat(40), record, recordSha256: "b".repeat(64) },
  };
}

test("configuration commits all fields except its own certificate and digest", () => {
  const { config } = configurationFixture();
  assert.equal(verifyRecoveryConfiguration(config).phase, "serve");
  const digest = recoveryConfigurationDigest(config);
  const reordered = JSON.parse(canonicalJson(config));
  assert.equal(recoveryConfigurationDigest(reordered), digest);
  reordered.vars.RECOVERY_AUTHORIZATION = "a new signature";
  reordered.vars.RECOVERY_CONFIG_SHA256 = "self hash";
  assert.equal(recoveryConfigurationDigest(reordered), digest);
  for (const mutate of [
    (c) => {
      c.vars.PUBLIC_ORIGIN = "https://other.invalid";
    },
    (c) => {
      c.main = "other.ts";
    },
    (c) => {
      c.vars.RECOVERY_VERIFICATION_KEY += "\n";
    },
    (c) => {
      c.kv_namespaces[0].id = "9".repeat(32);
    },
    (c) => {
      c.vars.ALLOW_NEW_GUESTS = "true";
    },
    (c) => {
      c.durable_objects.bindings[0].script_name = "other";
    },
  ]) {
    const changed = structuredClone(config);
    mutate(changed);
    assert.notEqual(recoveryConfigurationDigest(changed), digest);
    assert.throws(() => verifyRecoveryConfiguration(changed));
  }
});

test("reset authorization requires a bounded validity, quarantine and immediate updates", () => {
  const { config } = configurationFixture("reset");
  assert.equal(verifyRecoveryConfiguration(config).phase, "reset");
  const claims = verifyRecoveryConfiguration(config);
  assert.throws(() =>
    verifyRecoveryConfiguration(config, Date.parse(claims.expiresAt)),
  );
  const changed = structuredClone(config);
  changed.vars.RESTORE_QUARANTINE = "false";
  assert.throws(() => verifyRecoveryConfiguration(changed));
});

test("normal deployments preserve current independent generation and pinned key", () => {
  const fixture = configurationFixture();
  verifyRecoveryContinuity(fixture);
  const next = structuredClone(fixture.config);
  next.vars.RELEASE_BUILD_SHA = "b".repeat(40);
  const signed = signedRecoveryConfiguration(
    next,
    { ...fixture.claims, buildSha: next.vars.RELEASE_BUILD_SHA },
    fixture.privateKey,
  );
  verifyRecoveryContinuity({ ...fixture, config: signed });
  for (const mutate of [
    (f) => {
      f.journal.record.state = "verified";
    },
    (f) => {
      f.journal.record.generation = "7".repeat(64);
    },
    (f) => {
      f.journal.record.operationId = randomUUID();
    },
    (f) => {
      f.journal.record.evidenceSha256 = "8".repeat(64);
    },
    (f) => {
      f.journal.record = null;
    },
    (f) => {
      f.observed.kvId = "9".repeat(32);
    },
    (f) => {
      delete f.config.vars.RECOVERY_AUTHORIZATION;
    },
    (f) => {
      f.observed.textBindings.RECOVERY_VERIFICATION_KEY = "wrong";
    },
    (f) => {
      f.observed.textBindings.RESTORE_QUARANTINE = "true";
    },
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => verifyRecoveryContinuity(changed));
  }
});

test("legacy compatibility requires authenticated absence of recovery history", () => {
  const config = makeConfig("staging");
  const input = {
    config,
    observed: { textBindings: { ...config.vars } },
    journal: { headSha: null, record: null },
  };
  verifyRecoveryContinuity(input);
  assert.throws(() =>
    verifyRecoveryContinuity({ ...input, journal: undefined }),
  );
  assert.throws(() =>
    verifyRecoveryContinuity({
      ...input,
      journal: { headSha: "a".repeat(40), record: { state: "cleared" } },
    }),
  );
});
