/**
 * SQLite admission ledger for one host's processes sharing a local filesystem.
 * NOT a multi-host/NFS database or a replacement for authenticated relay intake.
 * Stores only hashed caller/request identities, timestamps and lease state.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseRelayHttpOutcome, parseRelayChallengeOutcome } from "../src/notifications/relay-outcome.ts";

const APPLICATION_ID = 0x4154524c;
const SCHEMA_VERSION = 5;
const COMMITMENT = /^[a-f0-9]{64}$/;
const WINDOW_MS = 60000;
const IDENTIFIER = /^[A-Za-z0-9_-]{16,128}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const integer = (value, minimum, maximum) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export function openRelayAdmissionStore(path, options = {}) {
  const {
    clock = Date.now,
    operatorRecoveryPolicy,
    environment,
    serviceId,
    perMinute = 10,
    globalPerMinute = 100,
    concurrency = 2,
    leaseMs = 15000,
    maxReplayMs = 120000,
    maxRecords = 10000,
    busyTimeoutMs = 100,
  } = options;
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    !["production", "test"].includes(environment) ||
    typeof serviceId !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/.test(serviceId) ||
    typeof clock !== "function" ||
    !integer(perMinute, 1, 1000) ||
    !integer(globalPerMinute, 1, 10000) ||
    !integer(concurrency, 1, 1000) ||
    !integer(leaseMs, 1000, 60000) ||
    !integer(maxReplayMs, 1000, 300000) ||
    !integer(maxRecords, 1, 1000000) ||
    !integer(busyTimeoutMs, 0, 1000)
  )
    throw new Error("invalid-admission-configuration");
  // Refuse an already observable non-regular target. Deployment must provide a
  // dedicated trusted local directory: this is not an atomic no-symlink open.
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("invalid-admission-path");
  }
  const configuration = JSON.stringify({
    environment,
    serviceId,
    perMinute,
    globalPerMinute,
    concurrency,
    leaseMs,
    maxReplayMs,
    maxRecords,
  });
  let db;
  let closed = false;
  const transaction = (operation) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  };
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // DELETE journal uses SQLite's process-wide filesystem locking; no WAL
    // checkpoint or network-filesystem assumptions are hidden in this module.
    if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "delete")
      throw new Error("unsupported-admission-journal");
    db.exec("PRAGMA synchronous = FULL");
    transaction(() => {
      const application = db
        .prepare("PRAGMA application_id")
        .get().application_id;
      const version = db.prepare("PRAGMA user_version").get().user_version;
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        )
        .all();
      if (application === 0 && version === 0 && tables.length === 0) {
        db.exec(`
          CREATE TABLE relay_configuration (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            configuration TEXT NOT NULL,
            last_observed_ms INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE relay_admissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            caller_hash TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            admitted_ms INTEGER NOT NULL,
            replay_expires_ms INTEGER NOT NULL,
            lease_expires_ms INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('active', 'finished')),
            operation_digest TEXT,
            outcome_kind TEXT CHECK(outcome_kind IN ('http', 'not-sent', 'unknown')),
            http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
            retry_after_state TEXT NOT NULL DEFAULT 'unknown' CHECK(retry_after_state IN ('unknown','absent','known')),
            retry_after_seconds INTEGER CHECK(retry_after_seconds BETWEEN 0 AND 900),
            retry_after_observed_ms INTEGER,

            UNIQUE(caller_hash, request_hash)
          ) STRICT;
          CREATE INDEX relay_admissions_time ON relay_admissions(admitted_ms);
          CREATE INDEX relay_admissions_caller_time ON relay_admissions(caller_hash, admitted_ms);
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
        db.prepare("INSERT INTO relay_configuration VALUES (1, ?, 0)").run(
          configuration,
        );
      } else if (
        application !== APPLICATION_ID ||
        ![1, 2, 3, 4, SCHEMA_VERSION].includes(version)
      ) {
        throw new Error("unsupported-admission-schema");
      }
      const current = db
        .prepare(
          "SELECT configuration FROM relay_configuration WHERE singleton = 1",
        )
        .get();
      if (!current || current.configuration !== configuration)
        throw new Error("admission-configuration-mismatch");
      // The only supported migration preserves all reservations and identity.
      // Legacy finished rows carry no delivery evidence and remain unknown.
      if (version === 1) {
        db.exec(`
          ALTER TABLE relay_admissions ADD COLUMN operation_digest TEXT;
          ALTER TABLE relay_admissions ADD COLUMN outcome_kind TEXT CHECK(outcome_kind IN ('http', 'not-sent', 'unknown'));
          ALTER TABLE relay_admissions ADD COLUMN http_status INTEGER CHECK(http_status BETWEEN 100 AND 599);
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
      }
      if (version === 1 || version === 2) {
        db.exec(`
          ALTER TABLE relay_admissions ADD COLUMN retry_after_state TEXT NOT NULL DEFAULT 'unknown' CHECK(retry_after_state IN ('unknown','absent','known'));
          ALTER TABLE relay_admissions ADD COLUMN retry_after_seconds INTEGER CHECK(retry_after_seconds BETWEEN 0 AND 900);
          ALTER TABLE relay_admissions ADD COLUMN retry_after_observed_ms INTEGER;
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
      }
      // Atomic v4 rebuild preserves IDs, reservations and prior metadata. No
      // challenge assertion is inferred for existing rows.
      if (version < 4) {
        db.exec(`
          CREATE TABLE relay_admissions_v4 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            caller_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
            admitted_ms INTEGER NOT NULL, replay_expires_ms INTEGER NOT NULL,
            lease_expires_ms INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('active','finished')),
            operation_digest TEXT,
            outcome_kind TEXT CHECK(outcome_kind IN ('http','not-sent','unknown','challenge')),
            http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
            retry_after_state TEXT NOT NULL DEFAULT 'unknown' CHECK(retry_after_state IN ('unknown','absent','known')),
            retry_after_seconds INTEGER CHECK(retry_after_seconds BETWEEN 0 AND 900),
            retry_after_observed_ms INTEGER,
            challenge_verification TEXT CHECK(challenge_verification IN ('verified','failed')),
            CHECK ((outcome_kind = 'challenge' AND challenge_verification IS NOT NULL AND http_status IS NULL AND retry_after_state='unknown' AND retry_after_seconds IS NULL AND retry_after_observed_ms IS NULL) OR (COALESCE(outcome_kind,'unknown') != 'challenge' AND challenge_verification IS NULL)),
            UNIQUE(caller_hash,request_hash)
          ) STRICT;
          INSERT INTO relay_admissions_v4 (id,caller_hash,request_hash,admitted_ms,replay_expires_ms,lease_expires_ms,state,operation_digest,outcome_kind,http_status,retry_after_state,retry_after_seconds,retry_after_observed_ms)
          SELECT id,caller_hash,request_hash,admitted_ms,replay_expires_ms,lease_expires_ms,state,operation_digest,outcome_kind,http_status,retry_after_state,retry_after_seconds,retry_after_observed_ms FROM relay_admissions;
          UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='relay_admissions'),0)) WHERE name='relay_admissions_v4';
          DROP TABLE relay_admissions;
          ALTER TABLE relay_admissions_v4 RENAME TO relay_admissions;
          CREATE INDEX relay_admissions_time ON relay_admissions(admitted_ms);
          CREATE INDEX relay_admissions_caller_time ON relay_admissions(caller_hash,admitted_ms);
          PRAGMA user_version = 4;
        `);
      }
      // Local operator receipts are not transport evidence. Preserve admission
      // history while binding plans to this exact database instance.
      if (version < 5) {
        db.exec(`
          CREATE TABLE relay_operator_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL, policy_json TEXT) STRICT;
          CREATE TABLE relay_operator_receipts (
            operation_id TEXT PRIMARY KEY, request_sha256 TEXT NOT NULL,
            committed_ms INTEGER NOT NULL, receipt_json TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER relay_operator_receipt_immutable BEFORE UPDATE ON relay_operator_receipts
          BEGIN SELECT RAISE(ABORT,'immutable-operator-receipt'); END;
          PRAGMA user_version = 5;
        `);
        db.prepare("INSERT INTO relay_operator_identity VALUES (1,?,NULL)").run(randomUUID());
      }
      db.prepare("SELECT store_id FROM relay_operator_identity WHERE singleton=1").get();
      db.prepare("SELECT operation_id,request_sha256,committed_ms,receipt_json FROM relay_operator_receipts LIMIT 0").all();
      // Validate schema shape even when an externally edited version matches.
      db.prepare(
        "SELECT id,caller_hash,request_hash,admitted_ms,replay_expires_ms,lease_expires_ms,state,operation_digest,outcome_kind,http_status,retry_after_state,retry_after_seconds,retry_after_observed_ms,challenge_verification FROM relay_admissions LIMIT 0",
      ).all();
    });
  } catch {
    try {
      db?.close();
    } catch {}
    throw new Error("admission-store-unavailable");
  }

  const observeClock = () => {
    const now = clock();
    const last = db
      .prepare(
        "SELECT last_observed_ms FROM relay_configuration WHERE singleton = 1",
      )
      .get().last_observed_ms;
    if (
      !integer(
        now,
        0,
        Number.MAX_SAFE_INTEGER - Math.max(maxReplayMs, leaseMs),
      ) ||
      now < last
    )
      throw new Error("untrusted-admission-clock");
    db.prepare(
      "UPDATE relay_configuration SET last_observed_ms = ? WHERE singleton = 1",
    ).run(now);
    return now;
  };
  const activeSnapshot = () => db.prepare(
    "SELECT id AS leaseId,caller_hash AS callerHash,request_hash AS requestHash,operation_digest AS operationDigest,admitted_ms AS admittedAt,replay_expires_ms AS replayExpiresAt,lease_expires_ms AS leaseExpiresAt FROM relay_admissions WHERE state='active' ORDER BY id"
  ).all().map(row => ({...row}));
  const operatorIdentity = () => ({
    environment, serviceId, configurationSha256: digest(configuration),
    storeId: db.prepare("SELECT store_id FROM relay_operator_identity WHERE singleton=1").get().store_id
  });
  const policy = operatorRecoveryPolicy;
  const validPolicy = () => policy && Object.keys(policy).sort().join(",") === "maxReceipts,planFreshnessMs,receiptRetentionMs" &&
    integer(policy.planFreshnessMs,1000,300000) && integer(policy.receiptRetentionMs,86400000,30*86400000) &&
    integer(policy.maxReceipts,1,1000);
  const policyJson = () => JSON.stringify({planFreshnessMs:policy.planFreshnessMs,receiptRetentionMs:policy.receiptRetentionMs,maxReceipts:policy.maxReceipts});
  const policyMatches = () => {
    const saved = db.prepare("SELECT policy_json FROM relay_operator_identity WHERE singleton=1").get().policy_json;
    return saved === null || saved === policyJson();
  };
  const canonical = value => JSON.stringify(value);
  const fixedString = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
  const unavailable = () => ({ ok: false, reason: "unavailable" });
  return {
    acquire({ callerId, requestId, expiresAt, operationDigest } = {}) {
      if (
        closed ||
        typeof callerId !== "string" ||
        !IDENTIFIER.test(callerId) ||
        typeof requestId !== "string" ||
        !IDENTIFIER.test(requestId) ||
        !Number.isSafeInteger(expiresAt) ||
        (operationDigest !== undefined &&
          (typeof operationDigest !== "string" ||
            !COMMITMENT.test(operationDigest)))
      )
        return { ok: false, reason: "invalid" };
      try {
        return transaction(() => {
          const now = observeClock();
          if (expiresAt < now || expiresAt > now + maxReplayMs)
            return { ok: false, reason: "expired" };
          const caller = digest(callerId);
          const request = digest(requestId);
          // Retain finished rows through BOTH replay and rolling-rate horizons.
          // Never recycle active/uncertain rows just because a timer elapsed.
          db.prepare(
            "DELETE FROM relay_admissions WHERE state = 'finished' AND replay_expires_ms < ? AND admitted_ms <= ?",
          ).run(now, now - WINDOW_MS);
          if (
            db
              .prepare(
                "SELECT id FROM relay_admissions WHERE caller_hash = ? AND request_hash = ?",
              )
              .get(caller, request)
          )
            return { ok: false, reason: "duplicate" };
          const totals = db
            .prepare(`
            SELECT COUNT(*) AS records,
              SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN admitted_ms > ? THEN 1 ELSE 0 END) AS recent
            FROM relay_admissions
          `)
            .get(now - WINDOW_MS);
          const callerRecent = db
            .prepare(
              "SELECT COUNT(*) AS n FROM relay_admissions WHERE caller_hash = ? AND admitted_ms > ?",
            )
            .get(caller, now - WINDOW_MS).n;
          if (
            totals.records >= maxRecords ||
            totals.active >= concurrency ||
            totals.recent >= globalPerMinute ||
            callerRecent >= perMinute
          )
            return { ok: false, reason: "capacity" };
          const leaseExpiresAt = now + leaseMs;
          const inserted = db
            .prepare(`
            INSERT INTO relay_admissions
              (caller_hash,request_hash,admitted_ms,replay_expires_ms,lease_expires_ms,state,operation_digest)
            VALUES (?,?,?,?,?,'active',?)
          `)
            .run(
              caller,
              request,
              now,
              expiresAt,
              leaseExpiresAt,
              operationDigest ?? null,
            );
          return {
            ok: true,
            leaseId: Number(inserted.lastInsertRowid),
            leaseExpiresAt,
          };
        });
      } catch {
        return unavailable();
      }
    },
    /**
     * Call only after the owned transport has completed or is confirmed stopped.
     * Deadline expiry alone does not prove a live/hung process stopped sending.
     * Never release a recovered lease using a new generation's receipt.
     */
    finish(leaseId, outcome) {
      const http =
        outcome?.kind === "http" ? parseRelayHttpOutcome(outcome, true) : null;
      const challenge = parseRelayChallengeOutcome(outcome);
      const verification = challenge?.verification ?? null;
      const kind = outcome === undefined ? "unknown" : outcome?.kind;
      const status = http?.status ?? null;
      const delayState = http?.retryAfterState ?? "unknown";
      const delaySeconds =
        http?.retryAfterState === "known" ? http.retryAfterSeconds : null;
      const observedAt =
        http?.retryAfterState === "known" ? http.retryAfterObservedAt : null;
      if (
        outcome !== undefined &&
        !http &&
        !challenge &&
        (!outcome ||
          typeof outcome !== "object" ||
          Array.isArray(outcome) ||
          outcome.kind !== "not-sent" ||
          Object.keys(outcome).join(",") !== "kind")
      )
        return { ok: false, reason: "invalid" };
      if (closed || !integer(leaseId, 1, Number.MAX_SAFE_INTEGER))
        return { ok: false, reason: "invalid" };
      try {
        return transaction(() => {
          const now = observeClock();
          const row = db
            .prepare(
              "SELECT state,outcome_kind,http_status,admitted_ms,challenge_verification,retry_after_state,retry_after_seconds,retry_after_observed_ms FROM relay_admissions WHERE id = ?",
            )
            .get(leaseId);
          if (!row) return { ok: false, reason: "unknown" };
          if (
            observedAt !== null &&
            (observedAt < row.admitted_ms || observedAt > now)
          )
            return { ok: false, reason: "invalid" };
          if (row.state === "finished") {
            return (row.outcome_kind ?? "unknown") === kind &&
              row.http_status === status &&
              row.retry_after_state === delayState &&
              row.retry_after_seconds === delaySeconds &&
              row.retry_after_observed_ms === observedAt &&
              row.challenge_verification === verification
              ? { ok: true }
              : { ok: false, reason: "conflict" };
          }
          db.prepare(
            "UPDATE relay_admissions SET state = 'finished',outcome_kind = ?,http_status = ?,retry_after_state = ?,retry_after_seconds = ?,retry_after_observed_ms = ?,challenge_verification = ? WHERE id = ? AND state = 'active'",
          ).run(kind, status, delayState, delaySeconds, observedAt, verification, leaseId);
          return { ok: true };
        });
      } catch {
        return unavailable();
      }
    },
    /**
     * Caller identity MUST come from authenticated ingress, never a query field.
     * This only reads status: it never authorizes forwarding/retry or releases
     * an uncertain lease. Missing/pruned/legacy evidence is UNKNOWN, not no-send.
     */
    readOutcome({ callerId, requestId, operationDigest } = {}) {
      if (
        closed ||
        typeof callerId !== "string" ||
        !IDENTIFIER.test(callerId) ||
        typeof requestId !== "string" ||
        !IDENTIFIER.test(requestId) ||
        typeof operationDigest !== "string" ||
        !COMMITMENT.test(operationDigest)
      )
        return { ok: false, reason: "invalid" };
      try {
        return transaction(() => {
          const now = observeClock();
          const row = db
            .prepare(
              "SELECT state,operation_digest,outcome_kind,http_status,lease_expires_ms,challenge_verification,retry_after_state,retry_after_seconds,retry_after_observed_ms FROM relay_admissions WHERE caller_hash = ? AND request_hash = ?",
            )
            .get(digest(callerId), digest(requestId));
          if (!row || row.operation_digest === null)
            return { ok: true, state: "unknown" };
          if (row.operation_digest !== operationDigest)
            return { ok: false, reason: "conflict" };
          if (row.state === "active")
            return {
              ok: true,
              state: row.lease_expires_ms > now ? "pending" : "unknown",
            };
          if (row.outcome_kind === "challenge") {
            const result = parseRelayChallengeOutcome({kind:"challenge", verification:row.challenge_verification});
            if (!result) return {ok:true,state:"unknown"};
            return {ok:true,state:"completed",outcome:result};
          }
          if (row.outcome_kind === "not-sent")
            return {
              ok: true,
              state: "completed",
              outcome: { kind: "not-sent" },
            };
          if (row.outcome_kind === "http" && integer(row.http_status, 100, 599))
            return {
              ok: true,
              state: "completed",
              outcome: {
                kind: "http",
                status: row.http_status,
                retryAfterState: row.retry_after_state,
                ...(row.retry_after_state === "known"
                  ? {
                      retryAfterSeconds: row.retry_after_seconds,
                      retryAfterObservedAt: row.retry_after_observed_ms,
                    }
                  : {}),
              },
            };
          return { ok: true, state: "unknown" };
        });
      } catch {
        return unavailable();
      }
    },
    /** Safe operator metadata; NOT permission to discard uncertain reservations. */
    listUncertainLeases() {
      if (closed) return unavailable();
      try {
        return transaction(() => {
          const now = observeClock();
          const leases = db
            .prepare(
              "SELECT id AS leaseId, admitted_ms AS admittedAt, lease_expires_ms AS leaseExpiresAt FROM relay_admissions WHERE state = 'active' AND lease_expires_ms <= ? ORDER BY id",
            )
            .all(now);
          return { ok: true, leases: leases.map((row) => ({ ...row })) };
        });
      } catch {
        return unavailable();
      }
    },
    /** Read-only snapshot once store opening/migration has completed. No expiry releases. */
    planOperatorRecovery() {
      if (closed) return unavailable();
      if (!validPolicy()) return {ok:false,reason:"operator-policy-required"};
      try {
        if (!policyMatches()) return {ok:false,reason:"operator-policy-mismatch"};
        const now = clock();
        const last = db.prepare("SELECT last_observed_ms FROM relay_configuration WHERE singleton=1").get().last_observed_ms;
        if (!integer(now, 0, Number.MAX_SAFE_INTEGER-policy.planFreshnessMs) || now < last) return unavailable();
        // One SQLite read transaction gives a consistent identity and full active set.
        db.exec("BEGIN");
        try {
          const leases = activeSnapshot();
          const plan = {version:1, ...operatorIdentity(), policySha256:digest(policyJson()), createdAt:now, expiresAt:now+policy.planFreshnessMs, leases};
          db.exec("COMMIT");
          return {ok:true, plan, planSha256:digest(canonical(plan))};
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      } catch { return unavailable(); }
    },
    /** Human-approved local recovery; no remote endpoint or machine stop attestation. */
    reconcileOperatorRecovery({operationId, plan, ownerRecord} = {}) {
      if (closed || !fixedString(operationId) || !plan || !ownerRecord) return {ok:false,reason:"invalid"};
      try {
        // Canonical field order makes the same exact request replayable after response loss.
        const request = {operationId,plan,ownerRecord};
        const requestSha256 = digest(canonical(request));
        return transaction(() => {
          const previous = db.prepare("SELECT request_sha256,receipt_json FROM relay_operator_receipts WHERE operation_id=?").get(operationId);
          if (previous) return previous.request_sha256 === requestSha256
            ? {ok:true,receipt:JSON.parse(previous.receipt_json)}
            : {ok:false,reason:"conflict"};
          if (!validPolicy() || !policyMatches()) return {ok:false,reason:"operator-policy-required"};
          const now = observeClock();
          const expectedIdentity = operatorIdentity();
          if (Object.keys(plan).sort().join(",") !== "configurationSha256,createdAt,environment,expiresAt,leases,policySha256,serviceId,storeId,version" ||
              plan.version !== 1 || !integer(plan.createdAt,0,now) || !new RegExp("^opr_"+plan.createdAt+"_[a-f0-9]{32}$").test(operationId) || Object.entries(expectedIdentity).some(([k,v])=>plan[k]!==v) ||
              !integer(plan.createdAt,0,now) || plan.policySha256 !== digest(policyJson()) || plan.expiresAt !== plan.createdAt+policy.planFreshnessMs || now > plan.expiresAt ||
              !Array.isArray(plan.leases) || !plan.leases.length ||
              canonical(plan.leases) !== canonical(activeSnapshot()) ||
              plan.leases.some(lease=>lease.leaseExpiresAt>now)) return {ok:false,reason:"stale-plan"};
          if (Object.keys(ownerRecord).sort().join(",") !== "admissionsPaused,evidenceSha256,observedAt,ownerId,planSha256,processGeneration,transportState" ||
              ownerRecord.planSha256 !== digest(canonical(plan)) ||
              !fixedString(ownerRecord.ownerId) || !fixedString(ownerRecord.processGeneration) ||
              !COMMITMENT.test(ownerRecord.evidenceSha256) ||
              !integer(ownerRecord.observedAt,plan.createdAt,now) ||
              ownerRecord.admissionsPaused !== true ||
              !["stopped","completed"].includes(ownerRecord.transportState)) return {ok:false,reason:"stop-evidence-required"};
          db.prepare("DELETE FROM relay_operator_receipts WHERE committed_ms < ?").run(now-policy.receiptRetentionMs);
          if (db.prepare("SELECT COUNT(*) AS n FROM relay_operator_receipts").get().n >= policy.maxReceipts) return {ok:false,reason:"capacity"};
          db.prepare("UPDATE relay_operator_identity SET policy_json=? WHERE singleton=1 AND policy_json IS NULL").run(policyJson());
          const receipt = {version:1,operationId,...expectedIdentity,planSha256:digest(canonical(plan)),
            ownerRecordSha256:digest(canonical(ownerRecord)),committedAt:now,
            leaseIds:plan.leases.map(lease=>lease.leaseId),outcome:"unknown",
            reviewAuthority:"human-confirmed-transport-stop",machineVerifiedTransportStop:false};
          // One transaction: exact full active set compared above, unknown-only finish
          // and receipt commit together. Original admission IDs/hashes/digests survive.
          for (const lease of plan.leases) db.prepare(
            "UPDATE relay_admissions SET state='finished',outcome_kind='unknown' WHERE id=? AND state='active'"
          ).run(lease.leaseId);
          db.prepare("INSERT INTO relay_operator_receipts VALUES (?,?,?,?)").run(
            operationId,requestSha256,now,canonical(receipt));
          return {ok:true,receipt};
        });
      } catch { return unavailable(); }
    },
    /** No cleanup or clock writes. Missing receipt is unknown, never permission to retry. */
    readOperatorRecovery(operationId) {
      if (closed || !fixedString(operationId)) return {ok:false,reason:"invalid"};
      try {
        const row = db.prepare("SELECT receipt_json FROM relay_operator_receipts WHERE operation_id=?").get(operationId);
        return row ? {ok:true,state:"committed",receipt:JSON.parse(row.receipt_json)}
          : {ok:true,state:"unknown"};
      } catch { return unavailable(); }
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
