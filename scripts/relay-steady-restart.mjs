import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Local single-host startup coordinator. The deployment owner supplies an
 * exclusive lock and trusted host observations; none are available over HTTP.
 * No sender, replay, admission recovery or retry logic lives here.
 */
export async function resumeAuthorizedSteadyRelay({
  withOwnerLock,
  observe,
  markGenerationAttempted,
  enable,
  inspect,
  resolveGenerationAttempt,
}) {
  return withOwnerLock(async () => {
    let current;
    try {
      current = await observe();
    } catch {
      return { state: "unknown", enabled: false };
    }
    const { authorization: a, host: h, operator: o } = current ?? {};
    const refused = {
      state: h?.state === "paused" ? "paused" : "unknown",
      enabled: false,
    };
    if (
      a?.mode !== "steady" ||
      a.environment !== "production" ||
      o?.inhibit !== "clear" ||
      h?.state !== "paused" ||
      h.sequence !== 0 ||
      h.priorTransportsStopped !== true ||
      h.namespaceVerified !== true ||
      h.tlsVerified !== true ||
      h.activeAdmissions !== 0 ||
      h.unresolvedOutcomes !== 0 ||
      ![
        "environment",
        "serviceId",
        "imageDigest",
        "configurationSha256",
        "storeId",
      ].every(
        (key) =>
          typeof a[key] === "string" && a[key] !== "" && h[key] === a[key],
      ) ||
      typeof h.generation !== "string" ||
      h.generation === ""
    )
      return refused;

    // Persist a generation-scoped one-shot claim before calling the existing
    // controller. A lost response is never retried, even after supervisor loss.
    try {
      if (!(await markGenerationAttempted(h.generation))) return refused;
    } catch {
      return refused;
    }
    const command = {
      version: 1,
      generation: h.generation,
      configurationSha256: h.configurationSha256,
      sequence: 1,
      action: "enable",
      payload: null,
    };
    const isEnabled = (r) =>
      r?.ok === true &&
      r.state === "enabled" &&
      r.generation === h.generation &&
      r.configurationSha256 === h.configurationSha256 &&
      r.sequence === command.sequence;
    async function confirmed() {
      if (resolveGenerationAttempt)
        await resolveGenerationAttempt(h.generation);
      return { state: "enabled", enabled: true };
    }
    try {
      if (isEnabled(await enable(command))) return await confirmed();
    } catch {
      // The bytes may have reached the controller. Inspect, never repeat.
    }
    try {
      if (isEnabled(await inspect())) return await confirmed();
    } catch {
      // Remain unknown. A different generation is not proof of the result.
    }
    return { state: "unknown", enabled: false };
  });
}

/** Read existing local schema only; never create, migrate or reconcile a store. */
export function inspectSteadyRestartLedger(path) {
  if (
    !isAbsolute(path) ||
    realpathSync(path) !== path ||
    !lstatSync(path).isFile()
  )
    throw Error("restart-ledger-unavailable");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(`
      SELECT store_id AS storeId,
        (SELECT count(*) FROM relay_admissions WHERE state = 'active') AS activeAdmissions,
        (SELECT count(*) FROM relay_admissions
          WHERE state = 'finished' AND COALESCE(outcome_kind, 'unknown') = 'unknown')
          AS unresolvedOutcomes
      FROM relay_operator_identity WHERE singleton = 1
    `)
      .get();
  } finally {
    db.close();
  }
}
