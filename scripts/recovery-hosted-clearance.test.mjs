import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  ADMISSION_RECOVERY_STORAGE,
  GUEST_RECOVERY_STORAGE,
  OAUTH_RECOVERY_STORAGE,
  recoveryStorageManifest,
  TABLE_RECOVERY_STORAGE,
} from "../src/shared/recovery-manifests.ts";
import { recoveryDigest } from "./recovery-configuration.mjs";
import {
  assertClearanceProposal,
  createBoundedPlatformProxy,
  recoverPendingDeployment,
  verifySuccessorInspection,
} from "./recovery-hosted-clearance.mjs";
import {
  verifyObjectInspectionReceipts,
  verifyObjectResetReceipts,
} from "./recovery-provider.mjs";

const proposal = JSON.parse(
  await readFile(
    new URL(
      "../docs/issue51-synthetic-clearance-proposal-v2.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const canonicalInspection = JSON.parse(
  await readFile(
    new URL(
      "../docs/issue51-cloudflare-recovery-inspection.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function fixture({ rollback = false } = {}) {
  const prior = structuredClone(
    proposal.intendedServingConfiguration.configuration,
  );
  prior.vars.RESTORE_QUARANTINE = rollback ? "false" : "true";
  prior.vars.RECOVERY_AUTHORIZATION = "test-prior-certificate";
  const candidate = structuredClone(
    proposal.intendedServingConfiguration.configuration,
  );
  candidate.vars.RESTORE_QUARANTINE = rollback ? "true" : "false";
  candidate.vars.RECOVERY_AUTHORIZATION = "test-candidate-certificate";
  const ctx = { target: { name: prior.name } };
  const state = {
    phase: rollback ? "serving-unverified" : "verified",
    active: { config: prior, receipt: { versionId: "prior-version" } },
    pending: {
      config: candidate,
      purpose: rollback
        ? "quarantine-only-rollback"
        : "approved-synthetic-clearance",
      priorVersionId: "prior-version",
    },
    records: [],
  };
  const records = [];
  const pauses = [];
  return {
    ctx,
    state,
    candidate,
    prior,
    records,
    pauses,
    hooks: {
      record: async (actualCtx, actualState, action, details) => {
        assert.equal(actualCtx, ctx);
        assert.equal(actualState, state);
        records.push({ action, details, state: structuredClone(state) });
      },
      pause: async (milliseconds) => pauses.push(milliseconds),
    },
  };
}

test("only the exact approved v2 proposal passes the real canonical digest", () => {
  assert.doesNotThrow(() => assertClearanceProposal(proposal, recoveryDigest));
  const changes = [
    (value) => {
      value.subject.generation = "0".repeat(64);
    },
    (value) => {
      value.subject.namespaceIdentity.workerName = "agent-table-staging";
    },
    (value) => {
      delete value.intendedServingConfiguration.configuration.vars
        .RELEASE_PROFILE;
    },
    (value) => {
      value.intendedServingConfiguration.configuration.vars.ALLOW_NEW_GUESTS =
        "true";
    },
    (value) => {
      value.intendedServingConfiguration.configuration.routes.push({
        pattern: "example.test/*",
      });
    },
    (value) => {
      value.rollback.configSha256 = "0".repeat(64);
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(proposal);
    change(changed);
    assert.throws(
      () => assertClearanceProposal(changed, recoveryDigest),
      /unapproved-proposal/,
    );
  }
});

test("a matched candidate is adopted as unverified and recorded", async () => {
  const input = fixture();
  const receipt = { versionId: "candidate-version", routes: 0 };
  let observations = 0;
  const result = await recoverPendingDeployment(input.ctx, input.state, {
    ...input.hooks,
    observe: async (ctx, target, config, expectedVersion) => {
      observations++;
      assert.equal(ctx, input.ctx);
      assert.equal(target, input.ctx.target);
      assert.equal(config, input.candidate);
      assert.equal(expectedVersion, undefined);
      return receipt;
    },
  });
  assert.equal(result, "candidate");
  assert.equal(observations, 1);
  assert.equal(input.state.pending, null);
  assert.equal(input.state.active.config, input.candidate);
  assert.equal(input.state.active.receipt, receipt);
  assert.equal(input.state.phase, "serving-unverified");
  assert.deepEqual(input.pauses, []);
  assert.deepEqual(input.records, [
    {
      action: "pending-deployment-independently-adopted",
      details: { purpose: "approved-synthetic-clearance", ...receipt },
      state: structuredClone(input.state),
    },
  ]);
});

test("a matched rollback candidate remains quarantined after pending recovery", async () => {
  const input = fixture({ rollback: true });
  const result = await recoverPendingDeployment(input.ctx, input.state, {
    ...input.hooks,
    observe: async (_ctx, _target, config) => {
      assert.equal(config, input.candidate);
      return { versionId: "rollback-version" };
    },
  });
  assert.equal(result, "candidate");
  assert.equal(input.state.phase, "quarantined");
  assert.equal(input.state.pending, null);
  assert.equal(input.state.active.config, input.candidate);
  assert.equal(input.records.length, 1);
  assert.equal(input.records[0].details.purpose, "quarantine-only-rollback");
});

test("the exact previous version is retained when the upload did not apply", async () => {
  const input = fixture();
  const previous = structuredClone(input.state.active);
  const phase = input.state.phase;
  const observations = [];
  const result = await recoverPendingDeployment(input.ctx, input.state, {
    ...input.hooks,
    observe: async (_ctx, _target, config, expectedVersion) => {
      observations.push({ config, expectedVersion });
      if (config === input.candidate) throw new Error("Candidate not active");
      assert.equal(config, input.prior);
      assert.equal(expectedVersion, "prior-version");
      return previous.receipt;
    },
  });
  assert.equal(result, "previous");
  assert.deepEqual(observations, [
    { config: input.candidate, expectedVersion: undefined },
    { config: input.prior, expectedVersion: "prior-version" },
  ]);
  assert.deepEqual(input.state.active, previous);
  assert.equal(input.state.phase, phase);
  assert.equal(input.state.pending, null);
  assert.deepEqual(input.pauses, []);
  assert.equal(input.records.length, 1);
  assert.equal(input.records[0].action, "pending-deployment-not-applied");
});

test("an unknown later deployment preserves pending state without mutations or records", async () => {
  const input = fixture();
  const before = structuredClone(input.state);
  const observations = [];
  await assert.rejects(
    recoverPendingDeployment(input.ctx, input.state, {
      ...input.hooks,
      observe: async (_ctx, _target, config, expectedVersion) => {
        observations.push({ config, expectedVersion });
        throw new Error("An unrelated later deployment is active");
      },
    }),
    /pending-deployment-outcome-unverified/,
  );
  assert.deepEqual(input.state, before);
  assert.deepEqual(input.records, []);
  assert.deepEqual(input.pauses, [1000, 1000]);
  assert.deepEqual(
    observations,
    Array.from({ length: 3 }, () => [
      { config: input.candidate, expectedVersion: undefined },
      { config: input.prior, expectedVersion: "prior-version" },
    ]).flat(),
  );
});

test("a stale prior-version lease is refused before any observation or write", async () => {
  const input = fixture();
  input.state.pending.priorVersionId = "another-version";
  const before = structuredClone(input.state);
  await assert.rejects(
    recoverPendingDeployment(input.ctx, input.state, {
      ...input.hooks,
      observe: async () =>
        assert.fail("A stale lease must not contact a provider"),
    }),
    /pending-deployment-identity-invalid/,
  );
  assert.deepEqual(input.state, before);
  assert.deepEqual(input.records, []);
  assert.deepEqual(input.pauses, []);
});

test("a candidate reported at the previous version is never adopted", async () => {
  const input = fixture();
  const before = structuredClone(input.state);
  await assert.rejects(
    recoverPendingDeployment(input.ctx, input.state, {
      ...input.hooks,
      observe: async (_ctx, _target, config) => {
        if (config === input.candidate) return { versionId: "prior-version" };
        throw new Error("Previous complete configuration no longer matches");
      },
    }),
    /pending-deployment-outcome-unverified/,
  );
  assert.deepEqual(input.state, before);
  assert.deepEqual(input.records, []);
  assert.deepEqual(input.pauses, [1000, 1000]);
});

test("transient read failures recover within the bounded observation attempts", async () => {
  const input = fixture();
  let observations = 0;
  let candidates = 0;
  const result = await recoverPendingDeployment(input.ctx, input.state, {
    ...input.hooks,
    observe: async (_ctx, _target, config) => {
      observations++;
      if (config === input.candidate && ++candidates === 3)
        return { versionId: "eventually-observed-candidate" };
      throw new Error("Temporary read failure");
    },
  });
  assert.equal(result, "candidate");
  assert.equal(observations, 5);
  assert.equal(candidates, 3);
  assert.deepEqual(input.pauses, [1000, 1000]);
  assert.equal(input.state.pending, null);
  assert.equal(input.state.phase, "serving-unverified");
  assert.equal(input.records.length, 1);
});

function successorInspectionFixture() {
  const { inventory, receipts, expected } =
    structuredClone(canonicalInspection);
  // Fresh in-memory current-schema fixture; never rewrite the historical JSON
  // or represent its schema-12 inspection as evidence for schema 13.
  expected.schemaVersion = 14;
  const descriptors = {
    TABLES: TABLE_RECOVERY_STORAGE,
    GUESTS: GUEST_RECOVERY_STORAGE,
    OAUTH_SERIALIZER: OAUTH_RECOVERY_STORAGE,
    ADMISSION: ADMISSION_RECOVERY_STORAGE,
  };
  for (const receipt of receipts) {
    const descriptor = descriptors[receipt.binding];
    receipt.schemaVersion = descriptor.schemaVersion;
    receipt.manifest = structuredClone(recoveryStorageManifest(descriptor));
    for (const table of descriptor.tables) receipt.counts[table.name] ??= 0;
  }
  const objectId = "a".repeat(64);
  inventory.objects.ADMISSION = [{ id: objectId, hasStoredData: true }];
  inventory.counts.ADMISSION = 1;
  const admission = {
    format: "agent-table.recovery-inspection.v1",
    environment: expected.environment,
    buildSha: expected.buildSha,
    configSha256: expected.configSha256,
    operationId: expected.operationId,
    generation: expected.generation,
    objectId,
    binding: "ADMISSION",
    component: "admission",
    schemaVersion: ADMISSION_RECOVERY_STORAGE.schemaVersion,
    manifest: structuredClone(
      recoveryStorageManifest(ADMISSION_RECOVERY_STORAGE),
    ),
    counts: { admission_hits: 3 },
    kvEntries: 0,
    markerGeneration: expected.generation,
    empty: false,
    requestNonce: expected.requestNonce,
  };
  receipts.push(admission);
  return {
    ctx: { verifyObjectInspectionReceipts, verifyObjectResetReceipts },
    inventory,
    receipts,
    expected,
    admission,
  };
}

function inspectSuccessor(input) {
  return verifySuccessorInspection(
    input.ctx,
    input.inventory,
    input.receipts,
    input.expected,
  );
}

test("successor inspection retains current-generation Admission rows without weakening historical empty-state checks", () => {
  const input = successorInspectionFixture();
  const before = structuredClone({
    inventory: input.inventory,
    receipts: input.receipts,
  });
  const result = inspectSuccessor(input);
  assert.equal(result.allObjects.totalObjects, 3);
  assert.deepEqual(result.allObjects.objectCounts, {
    TABLES: 1,
    GUESTS: 1,
    OAUTH_SERIALIZER: 0,
    ADMISSION: 1,
  });
  assert.equal(result.historicalPrivateReset.totalObjects, 2);
  assert.deepEqual(result.historicalPrivateReset.objectCounts, {
    TABLES: 1,
    GUESTS: 1,
    OAUTH_SERIALIZER: 0,
    ADMISSION: 0,
  });
  assert.equal(result.retainedAdmissionObjects, 1);
  assert.equal(result.retainedAdmissionRows, 3);
  assert.equal(result.admissionResetPerformed, false);
  assert.deepEqual(input.inventory, before.inventory);
  assert.deepEqual(input.receipts, before.receipts);
});

test("successor inspection still refuses historical guest or transcript rows", () => {
  for (const [binding, table] of [
    ["GUESTS", "guest_sessions"],
    ["TABLES", "table_messages"],
  ]) {
    const input = successorInspectionFixture();
    const historical = input.receipts.find(
      (value) => value.binding === binding,
    );
    historical.counts[table] = 1;
    historical.empty = false;
    assert.throws(
      () => inspectSuccessor(input),
      /recovery-inspection-private-state-remains/,
    );
  }
});

test("successor inspection requires complete Admission coverage including objects reported without stored data", () => {
  const input = successorInspectionFixture();
  input.inventory.objects.ADMISSION[0].hasStoredData = false;
  assert.equal(inspectSuccessor(input).retainedAdmissionObjects, 1);
  input.receipts.pop();
  assert.throws(
    () => inspectSuccessor(input),
    /recovery-inspection-coverage-incomplete/,
  );
});

test("successor inspection refuses stale or absent Admission markers and any Admission KV", () => {
  for (const change of [
    (value) => {
      value.markerGeneration = "0".repeat(64);
    },
    (value) => {
      value.markerGeneration = null;
    },
    (value) => {
      value.kvEntries = 1;
    },
  ]) {
    const input = successorInspectionFixture();
    change(input.admission);
    assert.throws(
      () => inspectSuccessor(input),
      /retry-admission-state-unverified/,
    );
  }
});

test("successor Admission exception retains the real provider schema and nonce validation", () => {
  const cases = [
    [
      (value) => {
        value.counts.unknown_private_table = 1;
      },
      /recovery-inspection-schema-mismatch/,
    ],
    [
      (value) => {
        value.counts.admission_hits = -1;
      },
      /recovery-inspection-schema-mismatch/,
    ],
    [
      (value) => {
        value.manifest.at(-1).columns.push("unexpected_payload");
      },
      /recovery-inspection-schema-mismatch/,
    ],
    [
      (value) => {
        value.requestNonce = "0".repeat(64);
      },
      /recovery-inspection-identity-mismatch/,
    ],
  ];
  for (const [change, error] of cases) {
    const input = successorInspectionFixture();
    change(input.admission);
    assert.throws(() => inspectSuccessor(input), error);
  }
});

test("successor inspection also accepts a fully empty Admission inventory", () => {
  const input = successorInspectionFixture();
  input.inventory.objects.ADMISSION = [];
  input.inventory.counts.ADMISSION = 0;
  input.receipts.pop();
  const result = inspectSuccessor(input);
  assert.equal(result.allObjects.totalObjects, 2);
  assert.equal(result.historicalPrivateReset.totalObjects, 2);
  assert.equal(result.retainedAdmissionObjects, 0);
  assert.equal(result.retainedAdmissionRows, 0);
  assert.equal(result.admissionResetPerformed, false);
});

test("platform proxy startup times out and disposes a late result without adopting it", {
  timeout: 5_000,
}, async () => {
  let finishStartup;
  const pending = new Promise((resolve) => {
    finishStartup = resolve;
  });
  await assert.rejects(
    createBoundedPlatformProxy(() => pending, { startupMs: 5, disposalMs: 5 }),
    /private-proxy-start-timeout/,
  );
  let disposalCalls = 0;
  let observeDisposal;
  const disposed = new Promise((resolve) => {
    observeDisposal = resolve;
  });
  finishStartup({
    get env() {
      return assert.fail(
        "A proxy that arrives after startup timeout must never be adopted",
      );
    },
    dispose: async () => {
      disposalCalls++;
      observeDisposal();
    },
  });
  await disposed;
  assert.equal(disposalCalls, 1);
});

test("a stalled platform proxy disposal cannot indefinitely postpone compensation", {
  timeout: 5_000,
}, async () => {
  const env = { CONTROL: {} };
  const proxy = await createBoundedPlatformProxy(
    async () => ({
      env,
      dispose: () => new Promise(() => undefined),
    }),
    { startupMs: 5, disposalMs: 5 },
  );
  assert.equal(proxy.env, env);
  await assert.rejects(proxy.dispose(), /private-proxy-stop-timeout/);
});

test("historical schema-12 inspection is not current schema-14 serving evidence", () => {
  const { inventory, receipts, expected } = canonicalInspection;
  assert.equal(expected.schemaVersion, 12);
  assert.throws(
    () => verifyObjectInspectionReceipts(inventory, receipts, expected),
    /recovery-inspection-subject-invalid/,
  );
});
