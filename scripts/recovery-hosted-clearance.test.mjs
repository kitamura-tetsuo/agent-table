import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { recoveryDigest } from "./recovery-configuration.mjs";
import {
  assertClearanceProposal,
  recoverPendingDeployment,
} from "./recovery-hosted-clearance.mjs";

const proposal = JSON.parse(
  await readFile(
    new URL(
      "../docs/issue51-synthetic-clearance-proposal-v2.json",
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
