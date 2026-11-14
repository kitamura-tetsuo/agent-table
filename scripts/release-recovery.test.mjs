import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  makeFixture,
  makeGithubMock,
  makeProviderMock,
  now,
} from "../test/helpers/release-fixtures.mjs";
import {
  RECOVERY_BINDINGS,
  recoveryDigest,
  signedRecoveryConfiguration,
  verifyRecoveryConfiguration,
} from "./recovery-configuration.mjs";
import { recoveryRecordDigest } from "./recovery-record.mjs";
import { authorizeRelease } from "./release-authorization.mjs";

function recoveredRelease() {
  const fixture = makeFixture();
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const unsigned = JSON.parse(fixture.configText);
  unsigned.kv_namespaces[0].id = "9".repeat(32);
  unsigned.vars.RECOVERY_VERIFICATION_KEY = pair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  unsigned.durable_objects.code_update_strategy = { mode: "immediate" };
  const peer = JSON.parse(fixture.peerText);
  const initialProvider = makeProviderMock(unsigned, peer);
  const base = `/client/v4/accounts/${unsigned.account_id}/workers/scripts/${unsigned.name}`;
  const bindings = initialProvider.routes.get(`${base}/settings`).bindings;
  const names = ["TABLES", "GUESTS", "OAUTH_SERIALIZER", "ADMISSION"];
  const namespaceIdentity = {
    accountId: unsigned.account_id,
    workerName: unsigned.name,
    namespaces: {
      ...Object.fromEntries(
        names.map((name) => [
          name,
          bindings.find((entry) => entry.name === name).namespace_id,
        ]),
      ),
      OAUTH_KV: unsigned.kv_namespaces[0].id,
    },
    commitments: Object.fromEntries(
      names.map((name) => [name, randomBytes(32).toString("hex")]),
    ),
  };
  const claims = {
    format: "agent-table.fresh-start.v1",
    phase: "serve",
    operationId: randomUUID(),
    generation: randomBytes(32).toString("hex"),
    environment: "staging",
    buildSha: "b".repeat(40),
    configSha256: "0".repeat(64),
    schemaVersion: 12,
    namespaceIdentity,
    planSha256: "c".repeat(64),
    evidenceSha256: "d".repeat(64),
    previousRecordSha256: "e".repeat(64),
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: null,
    approvalRef:
      "https://github.com/kitamura-tetsuo/agent-table/actions/runs/3456",
  };
  const activeBase = structuredClone(unsigned);
  activeBase.vars.RELEASE_BUILD_SHA = claims.buildSha;
  activeBase.vars.ALLOW_NEW_TABLES = "false";
  let active = signedRecoveryConfiguration(activeBase, claims, privateKey);
  const activeClaims = verifyRecoveryConfiguration(active, now);
  const record = {
    format: "agent-table.recovery-record.v1",
    environment: "staging",
    revision: 5,
    state: "cleared",
    operationId: claims.operationId,
    generation: claims.generation,
    buildSha: activeClaims.buildSha,
    configSha256: activeClaims.configSha256,
    schemaVersion: 12,
    namespaceIdentity,
    planSha256: claims.planSha256,
    inventorySha256: "f".repeat(64),
    evidenceSha256: claims.evidenceSha256,
    certificateSha256: recoveryDigest(active.vars.RECOVERY_AUTHORIZATION),
    previousRecordSha256: claims.previousRecordSha256,
    approvalRef: claims.approvalRef,
    workflow: {
      repository: "kitamura-tetsuo/agent-table",
      path: ".github/workflows/recover-staging.yml",
      runId: "3456",
      runAttempt: "1",
    },
    updatedAt: new Date(now - 500).toISOString(),
  };
  fixture.recoveryJournal = {
    headSha: "7".repeat(40),
    record,
    recordSha256: recoveryRecordDigest(record),
  };
  const endorse = (patch = {}, key = privateKey, config = unsigned) =>
    signedRecoveryConfiguration(
      config,
      {
        ...claims,
        buildSha: fixture.buildSha,
        previousRecordSha256: fixture.recoveryJournal.recordSha256,
        ...patch,
      },
      key,
    );
  let candidate = endorse();
  function setCandidate(next) {
    candidate = next;
    fixture.configText = JSON.stringify(next);
    const digest = recoveryDigest(fixture.configText);
    fixture.evidence.configSha256 = digest;
    fixture.operations.configSha256 = digest;
  }
  setCandidate(candidate);
  return {
    fixture,
    claims,
    unsigned,
    privateKey,
    endorse,
    get candidate() {
      return candidate;
    },
    setCandidate,
    setActive(next) {
      active = next;
    },
    run: () =>
      authorizeRelease({
        ...fixture,
        cloudflareRead: makeProviderMock(active, peer).read,
        githubRead: makeGithubMock().read,
        now,
      }),
  };
}

test("ordinary release accepts a new approved build while preserving independently cleared recovery authority", async () => {
  const h = recoveredRelease();
  const result = await h.run();
  assert.equal(result.deploymentApproved, true);
  assert.equal(result.buildSha, h.fixture.buildSha);
  assert.equal(
    result.providerReceipt.kvId,
    h.claims.namespaceIdentity.namespaces.OAUTH_KV,
  );
  assert.equal(h.candidate.vars.ALLOW_NEW_TABLES, "true");
  assert.equal(
    verifyRecoveryConfiguration(h.candidate, now).generation,
    h.claims.generation,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /RECOVERY_AUTHORIZATION|RECOVERY_VERIFICATION_KEY|NEVER_ECHO_ME/,
  );
});

test("ordinary release requires the independent recovery journal even when all normal approval gates pass", async () => {
  for (const journal of [
    undefined,
    { headSha: null, record: null, recordSha256: null },
  ]) {
    const h = recoveredRelease();
    h.fixture.recoveryJournal = journal;
    await assert.rejects(
      h.run(),
      /recovery-journal-unavailable|recovery-history-missing/,
    );
  }
});

test("ordinary release refuses a correctly signed old generation in either candidate or live deployment", async () => {
  for (const subject of ["candidate", "active"]) {
    const h = recoveredRelease();
    const replay = h.endorse({ generation: randomBytes(32).toString("hex") });
    if (subject === "candidate") h.setCandidate(replay);
    else h.setActive(replay);
    await assert.rejects(h.run(), /recovery-generation-replay/);
  }
});

test("ordinary release cannot remove the runtime fence or clear a pending recovery", async () => {
  const removed = recoveredRelease();
  const raw = structuredClone(removed.candidate);
  for (const name of RECOVERY_BINDINGS) delete raw.vars[name];
  removed.setCandidate(raw);
  await assert.rejects(removed.run(), /recovery-fence-removal-refused/);

  const pending = recoveredRelease();
  pending.fixture.recoveryJournal.record.state = "verified";
  pending.fixture.recoveryJournal.record.certificateSha256 = null;
  pending.fixture.recoveryJournal.recordSha256 = recoveryRecordDigest(
    pending.fixture.recoveryJournal.record,
  );
  await assert.rejects(pending.run(), /recovery-in-progress/);
});

test("ordinary release rejects a signature from an unpinned recovery issuer", async () => {
  const h = recoveredRelease();
  const replacement = generateKeyPairSync("ed25519");
  const config = structuredClone(h.unsigned);
  config.vars.RECOVERY_VERIFICATION_KEY = replacement.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const key = replacement.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  h.setCandidate(h.endorse({}, key, config));
  await assert.rejects(h.run(), /recovery-live-authority-unverified/);
});
