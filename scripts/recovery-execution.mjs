import { randomBytes } from "node:crypto";
import { validateRecoveryNamespaceIdentity } from "../src/shared/recovery.ts";
import {
  canonicalJson,
  recoveryDigest,
  requireRecovery,
  signedRecoveryConfiguration,
  verifyRecoveryConfiguration,
  verifyRecoveryContinuity,
  verifyRecoveryProviderIdentity,
} from "./recovery-configuration.mjs";
import {
  recoveryInventoryDigest,
  verifyObjectInspectionReceipts,
  verifyObjectResetReceipts,
} from "./recovery-provider.mjs";

const FLAGS = [
  "ENABLE_MCP_SUBSCRIPTIONS",
  "ENABLE_OPENAI_EVENTS",
  "ALLOW_OUTBOUND_NOTIFICATIONS",
  "ALLOW_NEW_GUESTS",
  "ALLOW_NEW_TABLES",
];
const DOS = ["TABLES", "GUESTS", "OAUTH_SERIALIZER", "ADMISSION"];
const EMPTY = "0".repeat(64);
const FIELDS = [
  "format",
  "environment",
  "operationId",
  "generation",
  "buildSha",
  "namespaceIdentity",
  "quarantineConfig",
  "servingConfig",
  "peerConfig",
  "ciEvidence",
];

export function validateRecoveryPlan(plan, expectedSha256) {
  requireRecovery(
    plan &&
      Object.keys(plan).sort().join(",") === [...FIELDS].sort().join(",") &&
      plan.format === "agent-table.fresh-start-plan.v1",
    "recovery-plan-shape-invalid",
  );
  requireRecovery(
    ["staging", "production"].includes(plan.environment) &&
      /^[a-f0-9]{40}$/.test(plan.buildSha) &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        plan.operationId,
      ) &&
      /^[a-f0-9]{64}$/.test(plan.generation) &&
      validateRecoveryNamespaceIdentity(plan.namespaceIdentity),
    "recovery-plan-identity-invalid",
  );
  requireRecovery(
    recoveryDigest(plan) === expectedSha256,
    "recovery-plan-approval-mismatch",
  );
  const config = plan.quarantineConfig;
  requireRecovery(
    config &&
      config.main === "src/index.ts" &&
      config.workers_dev === false &&
      config.preview_urls === false &&
      config.account_id === plan.namespaceIdentity.accountId &&
      config.name === plan.namespaceIdentity.workerName &&
      config.vars?.RELEASE_ENVIRONMENT === plan.environment &&
      config.vars.RELEASE_BUILD_SHA === plan.buildSha &&
      config.vars.RELEASE_PROFILE === "manual" &&
      config.vars.RESTORE_QUARANTINE === "true" &&
      FLAGS.every((name) => config.vars[name] === "false") &&
      config.durable_objects?.code_update_strategy?.mode === "immediate" &&
      typeof config.vars.RECOVERY_VERIFICATION_KEY === "string",
    "recovery-plan-config-invalid",
  );
  for (const field of [
    "env",
    "build",
    "unsafe",
    "assets",
    "site",
    "route",
    "routes",
    "triggers",
    "services",
  ]) {
    requireRecovery(
      !Object.hasOwn(config, field),
      "recovery-plan-config-ambiguous",
    );
  }
  const history = [
    { tag: "v1", new_sqlite_classes: ["TableDO", "GuestDO"] },
    { tag: "v2", new_sqlite_classes: ["OAuthTokenDO"] },
    { tag: "v3", new_sqlite_classes: ["AdmissionDO"] },
  ];
  requireRecovery(
    canonicalJson(config.migrations) === canonicalJson(history),
    "recovery-migration-replacement-refused",
  );
  requireRecovery(
    config.compatibility_flags?.includes("nodejs_compat") &&
      config.compatibility_flags.includes("global_fetch_strictly_public"),
    "recovery-runtime-flags-missing",
  );
  const serving = structuredClone(plan.servingConfig);
  requireRecovery(
    serving?.vars?.RESTORE_QUARANTINE === "false" &&
      ["false", "true"].includes(serving.vars.ALLOW_NEW_GUESTS) &&
      ["false", "true"].includes(serving.vars.ALLOW_NEW_TABLES),
    "recovery-serving-config-invalid",
  );
  if (serving.vars.ALLOW_NEW_GUESTS === "true") {
    requireRecovery(
      serving.vars.GUEST_CHALLENGE_MODE === "required" &&
        typeof serving.vars.TURNSTILE_SITE_KEY === "string" &&
        serving.vars.TURNSTILE_SITE_KEY.length > 10,
      "recovery-public-guest-challenge-missing",
    );
  }
  serving.vars.RESTORE_QUARANTINE = "true";
  serving.vars.ALLOW_NEW_GUESTS = "false";
  serving.vars.ALLOW_NEW_TABLES = "false";
  requireRecovery(
    canonicalJson(serving) === canonicalJson(config),
    "recovery-serving-config-substitution",
  );
  return plan;
}

function objectIds(inventory) {
  return canonicalJson(
    Object.fromEntries(
      DOS.map((name) => [name, inventory.objects[name].map((item) => item.id)]),
    ),
  );
}
function verifyIdentityObservation(actual, plan) {
  requireRecovery(
    actual?.buildSha === plan.buildSha &&
      actual.environment === plan.environment &&
      actual.schemaVersion === 12 &&
      canonicalJson(actual.commitments) ===
        canonicalJson(plan.namespaceIdentity.commitments),
    "recovery-runtime-identity-unverified",
  );
}
function recordWorkflow(workflow) {
  return {
    repository: workflow.repository,
    path: `.github/workflows/recover-${workflow.environment}.yml`,
    runId: workflow.runId,
    runAttempt: workflow.runAttempt,
  };
}
function claimsFor(
  plan,
  planSha256,
  workflow,
  phase,
  evidenceSha256,
  previousRecordSha256,
  now,
) {
  return {
    format: "agent-table.fresh-start.v1",
    phase,
    operationId: plan.operationId,
    generation: plan.generation,
    environment: plan.environment,
    buildSha: plan.buildSha,
    configSha256: EMPTY,
    schemaVersion: 12,
    namespaceIdentity: plan.namespaceIdentity,
    planSha256,
    evidenceSha256,
    previousRecordSha256: previousRecordSha256 ?? EMPTY,
    issuedAt: new Date(now).toISOString(),
    expiresAt:
      phase === "reset" ? new Date(now + 60 * 60_000).toISOString() : null,
    approvalRef: `https://github.com/kitamura-tetsuo/agent-table/actions/runs/${workflow.runId}`,
  };
}

/**
 * The caller supplies authenticated provider/Workflow adapters, not a list of
 * owner-authored reset assertions. Positive evidence comes only from inspected
 * canonical object state after the controlled mutations below.
 */
export async function runFreshStartRecovery({
  plan,
  planSha256,
  phase,
  workflow,
  privateKey,
  dependencies,
  expectedActiveVersionId,
  expectedRecordSha256,
  now = () => Date.now(),
}) {
  validateRecoveryPlan(plan, planSha256);
  requireRecovery(
    ["discard", "clear", "endorse"].includes(phase),
    "recovery-phase-invalid",
  );
  if (phase !== "endorse")
    requireRecovery(
      FLAGS.every((name) => plan.servingConfig.vars[name] === "false"),
      "recovery-clearance-cannot-open-public-intake",
    );
  requireRecovery(
    /^[a-f0-9-]{36}$/.test(expectedActiveVersionId) &&
      (expectedRecordSha256 === null ||
        /^[a-f0-9]{64}$/.test(expectedRecordSha256)),
    "recovery-dispatch-precondition-invalid",
  );
  requireRecovery(
    workflow?.kind === "recovery" &&
      workflow.environment === plan.environment &&
      workflow.sha === plan.buildSha,
    "recovery-workflow-mismatch",
  );
  await dependencies.authorize(plan, workflow);
  let journal = await dependencies.readJournal();
  const initial = await dependencies.readProvider(
    plan.quarantineConfig,
    plan.peerConfig,
  );
  verifyRecoveryProviderIdentity(plan.namespaceIdentity, initial.targetState);
  requireRecovery(
    initial.targetState.versionId === expectedActiveVersionId,
    "recovery-active-version-changed",
  );
  requireRecovery(
    journal.recordSha256 === expectedRecordSha256,
    "recovery-journal-approval-stale",
  );
  let lastProvider = initial;
  const persist = async (state, extra = {}) => {
    const previous = journal.record;
    const next = {
      format: "agent-table.recovery-record.v1",
      environment: plan.environment,
      revision: (previous?.revision ?? 0) + 1,
      state,
      operationId: plan.operationId,
      generation: plan.generation,
      buildSha: plan.buildSha,
      configSha256:
        previous?.operationId === plan.operationId
          ? previous.configSha256
          : resetConfig.vars.RECOVERY_CONFIG_SHA256,
      schemaVersion: 12,
      namespaceIdentity: plan.namespaceIdentity,
      planSha256,
      inventorySha256:
        previous?.operationId === plan.operationId
          ? previous.inventorySha256
          : null,
      evidenceSha256:
        previous?.operationId === plan.operationId
          ? previous.evidenceSha256
          : null,
      certificateSha256: null,
      previousRecordSha256: journal.recordSha256 ?? EMPTY,
      approvalRef: `https://github.com/kitamura-tetsuo/agent-table/actions/runs/${workflow.runId}`,
      workflow: recordWorkflow(workflow),
      updatedAt: new Date(now()).toISOString(),
      ...extra,
    };
    journal = await dependencies.writeJournal(next, {
      headSha: journal.headSha,
      recordSha256: journal.recordSha256,
    });
  };
  const safeDeploy = async (config, beforeWrite = () => {}) => {
    await dependencies.authorizeSource(plan.buildSha);
    const current = await dependencies.readProvider(
      plan.quarantineConfig,
      plan.peerConfig,
    );
    verifyRecoveryProviderIdentity(plan.namespaceIdentity, current.targetState);
    requireRecovery(
      current.targetState.versionId === lastProvider.targetState.versionId,
      "recovery-deployment-raced",
    );
    const latest = await dependencies.readJournal();
    requireRecovery(
      latest.recordSha256 === journal.recordSha256 &&
        latest.headSha === journal.headSha,
      "recovery-journal-raced",
    );
    beforeWrite();
    await dependencies.deploy(config);
    lastProvider = await dependencies.readProvider(config, plan.peerConfig);
    verifyRecoveryProviderIdentity(
      plan.namespaceIdentity,
      lastProvider.targetState,
    );
    await dependencies.verifyDeployed(lastProvider.targetState, config);
  };
  if (phase === "endorse") {
    const record = journal.record;
    requireRecovery(
      record?.state === "cleared" &&
        record.operationId === plan.operationId &&
        record.generation === plan.generation &&
        canonicalJson(record.namespaceIdentity) ===
          canonicalJson(plan.namespaceIdentity),
      "recovery-endorsement-without-clearance",
    );
    const proposed = structuredClone(plan.servingConfig);
    const claims = claimsFor(
      plan,
      record.planSha256,
      workflow,
      "serve",
      record.evidenceSha256,
      journal.recordSha256,
      now(),
    );
    const candidate = signedRecoveryConfiguration(proposed, claims, privateKey);
    verifyRecoveryContinuity({
      config: candidate,
      observed: initial.targetState,
      journal,
      now: now(),
    });
    return {
      phase: "endorsed",
      generation: record.generation,
      authorization: candidate.vars.RECOVERY_AUTHORIZATION,
      recoveryConfigSha256: candidate.vars.RECOVERY_CONFIG_SHA256,
      fullConfigSha256: recoveryDigest(JSON.stringify(candidate)),
      journalSha256: journal.recordSha256,
      clearanceExecuted: false,
    };
  }
  const previous = journal.record;
  const pending = previous && previous.state !== "cleared";
  const superseding = pending && previous.operationId !== plan.operationId;
  const continuing = pending && !superseding;
  if (superseding) {
    requireRecovery(
      phase === "discard" &&
        previous.generation !== plan.generation &&
        canonicalJson(previous.namespaceIdentity) ===
          canonicalJson(plan.namespaceIdentity) &&
        (previous.state === "prepared" ||
          (initial.targetState.textBindings.RESTORE_QUARANTINE === "true" &&
            FLAGS.every(
              (name) => initial.targetState.textBindings[name] === "false",
            ))),
      "recovery-supersede-not-quarantined",
    );
    // A changed main SHA needs a new reviewed destructive plan and generation.
    // Old receipts cannot carry forward to the replacement operation.
  }
  if (continuing) {
    requireRecovery(
      previous.operationId === plan.operationId &&
        previous.generation === plan.generation &&
        previous.planSha256 === planSha256 &&
        previous.buildSha === plan.buildSha &&
        canonicalJson(previous.namespaceIdentity) ===
          canonicalJson(plan.namespaceIdentity),
      "recovery-resume-identity-mismatch",
    );
  } else {
    requireRecovery(
      phase === "discard" &&
        (!previous || previous.generation !== plan.generation),
      "recovery-new-generation-required",
    );
  }
  const resetClaims = claimsFor(
    plan,
    planSha256,
    workflow,
    "reset",
    null,
    journal.recordSha256,
    now(),
  );
  const resetConfig = signedRecoveryConfiguration(
    plan.quarantineConfig,
    resetClaims,
    privateKey,
  );
  if (continuing)
    requireRecovery(
      resetConfig.vars.RECOVERY_CONFIG_SHA256 === previous.configSha256,
      "recovery-resume-config-changed",
    );
  if (!continuing) await persist("prepared");
  if (phase === "clear")
    requireRecovery(
      journal.record.state === "verified",
      "recovery-unverified-clearance",
    );
  if (phase === "discard")
    requireRecovery(
      ["prepared", "quarantined", "resetting"].includes(journal.record.state),
      "recovery-discard-phase-conflict",
    );
  // Reissuing an expired reset permit is a separately approved, same-operation
  // resume. It cannot grant serving authority or change the generation/plan.
  await safeDeploy(resetConfig);
  const control = await dependencies.connectControl(plan.namespaceIdentity);
  try {
    verifyIdentityObservation(await control.identity(), plan);
    const inventory = await dependencies.inventory(plan.namespaceIdentity);
    const nonce = randomBytes(32).toString("hex");
    const request = (binding, id) => ({
      binding,
      objectId: id,
      operationId: plan.operationId,
      requestNonce: nonce,
    });
    const inspectAll = async () => {
      const receipts = [];
      for (const binding of DOS)
        for (const object of inventory.objects[binding])
          receipts.push(await control.inspect(request(binding, object.id)));
      return receipts;
    };
    // Before any reset, every inventoried object must run the approved build,
    // accept the exact operation and pass schema inspection. Unknown schema
    // aborts the whole operation without partially deleting other objects.
    const before = await inspectAll();
    verifyObjectInspectionReceipts(
      inventory,
      before,
      { ...verifyRecoveryConfiguration(resetConfig), requestNonce: nonce },
      { requireEmpty: false },
    );
    const frozen = await dependencies.inventory(plan.namespaceIdentity);
    requireRecovery(
      objectIds(frozen) === objectIds(inventory) &&
        canonicalJson(frozen.oauthKeys) === canonicalJson(inventory.oauthKeys),
      "recovery-inventory-changed-during-freeze",
    );
    if (phase === "discard") {
      if (journal.record.state === "prepared") await persist("quarantined");
      if (journal.record.state === "quarantined")
        await persist("resetting", {
          inventorySha256: recoveryInventoryDigest(inventory),
        });
      for (const binding of DOS)
        for (const object of inventory.objects[binding])
          await control.reset(request(binding, object.id));
      await dependencies.deleteOAuthKeys(plan.namespaceIdentity, inventory);
    }
    const after = await inspectAll();
    const summary = verifyObjectResetReceipts(inventory, after, {
      ...verifyRecoveryConfiguration(resetConfig),
      requestNonce: nonce,
    });
    const observed = await dependencies.inventory(plan.namespaceIdentity);
    requireRecovery(
      objectIds(observed) === objectIds(inventory) &&
        observed.oauthKeys.length === 0,
      "recovery-residual-state-observed",
    );
    const denied = await dependencies.verifyIngressDenied(
      plan.quarantineConfig,
    );
    requireRecovery(denied === true, "recovery-private-ingress-not-denied");
    const finalProvider = await dependencies.readProvider(
      resetConfig,
      plan.peerConfig,
    );
    verifyRecoveryProviderIdentity(
      plan.namespaceIdentity,
      finalProvider.targetState,
    );
    requireRecovery(
      finalProvider.targetState.versionId ===
        lastProvider.targetState.versionId,
      "recovery-provider-changed-during-verification",
    );
    await dependencies.verifyDeployed(finalProvider.targetState, resetConfig);
    if (phase === "discard") {
      const evidence = {
        format: "agent-table.fresh-start-evidence.v1",
        planSha256,
        operationId: plan.operationId,
        generation: plan.generation,
        buildSha: plan.buildSha,
        configSha256: resetConfig.vars.RECOVERY_CONFIG_SHA256,
        fullConfigSha256: recoveryDigest(JSON.stringify(resetConfig)),
        namespaceIdentity: plan.namespaceIdentity,
        summary,
        oauthDeletionObserved: true,
        privateIngressDenied: true,
        immediateCodeUpdateRequested: true,
        providerVersionId: finalProvider.targetState.versionId,
        observedAt: new Date(now()).toISOString(),
        limitations: [
          "Inventory is discovery, not a globally atomic snapshot.",
          "KV cleanup observation does not prove erasure of cached or retained provider copies.",
          "Every supported future restore must allocate a new generation before restoration.",
          "Previously admitted Worker calls may settle into an inaccessible old OAuth prefix after cleanup; this is not a global physical-erasure claim.",
        ],
      };
      await persist("verified", { evidenceSha256: recoveryDigest(evidence) });
      return {
        phase: "verified",
        evidence,
        journalSha256: journal.recordSha256,
        clearanceExecuted: false,
      };
    }
    const serve = structuredClone(plan.servingConfig);
    const certificate = claimsFor(
      plan,
      planSha256,
      workflow,
      "serve",
      journal.record.evidenceSha256,
      journal.recordSha256,
      now(),
    );
    const serveConfig = signedRecoveryConfiguration(
      serve,
      certificate,
      privateKey,
    );
    const verifiedJournal = journal.recordSha256;
    let servingAttempted = false;
    let servingVerified = false;
    try {
      await safeDeploy(serveConfig, () => {
        servingAttempted = true;
      });
      requireRecovery(
        (await dependencies.verifyServing(serveConfig)) === true,
        "recovery-serving-readback-failed",
      );
      servingVerified = true;
      await persist("cleared", {
        configSha256: serveConfig.vars.RECOVERY_CONFIG_SHA256,
        certificateSha256: recoveryDigest(
          serveConfig.vars.RECOVERY_AUTHORIZATION,
        ),
      });
    } catch (error) {
      if (!servingAttempted) throw error;
      const live = await dependencies.readProvider(
        serveConfig,
        plan.peerConfig,
      );
      const current = await dependencies.readJournal();
      verifyRecoveryProviderIdentity(plan.namespaceIdentity, live.targetState);
      const ours =
        live.targetState.textBindings.RECOVERY_AUTHORIZATION ===
          serveConfig.vars.RECOVERY_AUTHORIZATION &&
        live.targetState.textBindings.RESTORE_QUARANTINE === "false";
      if (
        servingVerified &&
        ours &&
        current.record?.state === "cleared" &&
        current.record.operationId === plan.operationId &&
        current.record.generation === plan.generation &&
        current.record.previousRecordSha256 === verifiedJournal &&
        current.record.certificateSha256 ===
          recoveryDigest(serveConfig.vars.RECOVERY_AUTHORIZATION)
      ) {
        // A successful CAS with an interrupted reply can be recovered by an
        // authenticated read of our exact already-verified completion.
        await dependencies.verifyDeployed(live.targetState, serveConfig);
        journal = current;
      } else {
        if (ours && current.recordSha256 === verifiedJournal) {
          // Compensate only this run's own serving attempt. A race refusal must
          // never overwrite a later operation or an unrelated deployment.
          await dependencies.verifyDeployed(live.targetState, serveConfig);
          await dependencies.deploy(resetConfig);
          const quarantined = await dependencies.readProvider(
            resetConfig,
            plan.peerConfig,
          );
          verifyRecoveryProviderIdentity(
            plan.namespaceIdentity,
            quarantined.targetState,
          );
          await dependencies.verifyDeployed(
            quarantined.targetState,
            resetConfig,
          );
        }
        throw error;
      }
    }
    return {
      phase: "cleared",
      generation: plan.generation,
      journalSha256: journal.recordSha256,
      clearanceExecuted: true,
      authorization: serveConfig.vars.RECOVERY_AUTHORIZATION,
      recoveryConfigSha256: serveConfig.vars.RECOVERY_CONFIG_SHA256,
      fullConfigSha256: recoveryDigest(JSON.stringify(serveConfig)),
    };
  } finally {
    await control.dispose();
  }
}
