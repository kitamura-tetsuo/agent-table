import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  recoveryConfigurationDigest,
  recoveryDigest,
  signedRecoveryConfiguration,
} from "./recovery-configuration.mjs";

// Exercise the real application gate without Workerd, network, or hosted keys.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      'export { isRestoreQuarantined } from "./src/shared/release-quarantine.ts";',
      'export { recoveryContext } from "./src/shared/recovery.ts";',
    ].join("\n"),
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
});
const { isRestoreQuarantined, recoveryContext } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const readProposal = async (name) =>
  JSON.parse(await readFile(resolve(root, "docs", name), "utf8"));
const original = await readProposal(
  "issue51-synthetic-clearance-proposal.json",
);
const corrected = await readProposal(
  "issue51-synthetic-clearance-proposal-v2.json",
);
const FLAGS = [
  "ALLOW_NEW_GUESTS",
  "ALLOW_NEW_TABLES",
  "ENABLE_MCP_SUBSCRIPTIONS",
  "ENABLE_OPENAI_EVENTS",
  "ALLOW_OUTBOUND_NOTIFICATIONS",
];
const SOURCE = "3d65b9ace98720afd2ef48275a3bb76a8638f76e";
const ORIGINAL_DIGEST =
  "18d29f9b18e0fe67802427c2e18cf5a98ec8d1b4b9b7e7358a99adf851f82e0e";
const CORRECTED_DIGEST =
  "58aaf16f7cacf06c3b0b568b4e3858c9c399d86b826348630c99a99f0a2330fa";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function testEnvironment(proposal) {
  const config = structuredClone(
    proposal.intendedServingConfiguration.configuration,
  );
  // Only this in-memory copy uses the ephemeral key. Neither proposal is signed.
  // The schema-14 claims below are new synthetic gate fixtures, not historical
  // schema-12 proposal approval or proof that its pinned old build supports 14.
  config.vars.RECOVERY_VERIFICATION_KEY = publicPem;
  const signed = signedRecoveryConfiguration(
    config,
    {
      format: "agent-table.fresh-start.v1",
      phase: "serve",
      operationId: proposal.subject.operationId,
      generation: proposal.subject.generation,
      environment: "staging",
      buildSha: SOURCE,
      configSha256: "0".repeat(64),
      schemaVersion: 14,
      namespaceIdentity: proposal.subject.namespaceIdentity,
      planSha256: "a".repeat(64),
      evidenceSha256: proposal.evidence.canonicalSha256,
      previousRecordSha256: proposal.evidence.localRecordHeadSha256,
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: null,
      approvalRef: "local-only-regression-no-deployment-authority",
    },
    privatePem,
  );
  return {
    ...signed.vars,
    ...Object.fromEntries(
      Object.entries(proposal.subject.namespaceIdentity.commitments).map(
        ([binding, commitment]) => [
          binding,
          { idFromName: () => ({ toString: () => commitment }) },
        ],
      ),
    ),
  };
}

test("the replacement proposal changes only the serving profile and its configuration commitment", () => {
  assert.equal(
    recoveryDigest(original),
    "06ae66192aaa4d2cd6345447a70bb519c38c287c3b59eb2e89f4030102b60cfb",
  );
  assert.deepEqual(corrected.subject, original.subject);
  assert.deepEqual(corrected.executionCode, original.executionCode);
  assert.deepEqual(corrected.rollback, original.rollback);
  assert.equal(corrected.scope, "manual-isolated-synthetic-only");
  assert.equal(corrected.subject.sourceSha, SOURCE);
  assert.equal(
    corrected.subject.namespaceIdentity.workerName,
    "agent-table-pr51-recovery-staging",
  );
  const before = structuredClone(
    original.intendedServingConfiguration.configuration,
  );
  const after = structuredClone(
    corrected.intendedServingConfiguration.configuration,
  );
  assert.equal(recoveryConfigurationDigest(before), ORIGINAL_DIGEST);
  assert.equal(recoveryConfigurationDigest(after), CORRECTED_DIGEST);
  assert.equal(
    corrected.intendedServingConfiguration.configSha256,
    CORRECTED_DIGEST,
  );
  assert.equal(after.vars.RECOVERY_CONFIG_SHA256, CORRECTED_DIGEST);
  assert.equal(after.vars.RELEASE_PROFILE, "manual");
  assert.equal(before.vars.RELEASE_PROFILE, undefined);
  for (const flag of FLAGS) assert.equal(after.vars[flag], "false");
  assert.equal(after.workers_dev, false);
  assert.equal(after.preview_urls, false);
  assert.deepEqual(after.routes, []);
  assert.equal(corrected.authorizationIssued, false);
  assert.equal(corrected.deploymentPerformed, false);
  assert.equal(
    corrected.intendedServingConfiguration.authorizationAbsent,
    true,
  );
  assert.equal(corrected.intendedServingConfiguration.deployable, false);
  assert.equal(after.vars.RECOVERY_AUTHORIZATION, undefined);
  delete before.vars.RECOVERY_CONFIG_SHA256;
  delete after.vars.RECOVERY_CONFIG_SHA256;
  delete after.vars.RELEASE_PROFILE;
  assert.deepEqual(after, before);
});

test("the original proposal remains quarantined despite a valid serving authorization", () => {
  const env = testEnvironment(original);
  assert.equal(recoveryContext(env).kind, "authorized");
  assert.equal(recoveryContext(env).claims.phase, "serve");
  assert.equal(env.RELEASE_PROFILE, undefined);
  assert.equal(isRestoreQuarantined(env), true);
});

test("the corrected manual proposal passes the actual application gate with valid serving authority", () => {
  const env = testEnvironment(corrected);
  assert.equal(recoveryContext(env).kind, "authorized");
  assert.equal(recoveryContext(env).claims.phase, "serve");
  assert.equal(isRestoreQuarantined(env), false);
});

test("the manual profile cannot bypass missing or invalid recovery authorization", () => {
  const env = testEnvironment(corrected);
  const missing = { ...env };
  delete missing.RECOVERY_AUTHORIZATION;
  assert.equal(recoveryContext(missing).kind, "denied");
  assert.equal(isRestoreQuarantined(missing), true);
  const invalid = { ...env, RECOVERY_AUTHORIZATION: "invalid.signature" };
  assert.equal(recoveryContext(invalid).kind, "denied");
  assert.equal(isRestoreQuarantined(invalid), true);
});

test("the manual profile cannot enable subscriptions, events or outbound notifications", () => {
  const env = testEnvironment(corrected);
  for (const flag of [
    "ENABLE_MCP_SUBSCRIPTIONS",
    "ENABLE_OPENAI_EVENTS",
    "ALLOW_OUTBOUND_NOTIFICATIONS",
  ]) {
    assert.equal(isRestoreQuarantined({ ...env, [flag]: "true" }), true);
  }
});
