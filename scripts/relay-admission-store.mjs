/**
 * SQLite admission ledger for one host's processes sharing a local filesystem.
 * NOT a multi-host/NFS database or a replacement for authenticated relay intake.
 * Stores only hashed caller/request identities, timestamps and lease state.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

const APPLICATION_ID = 0x4154524c;
const SCHEMA_VERSION = 1;
const WINDOW_MS = 60000;
const IDENTIFIER = /^[A-Za-z0-9_-]{16,128}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const integer = (value, minimum, maximum) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export function openRelayAdmissionStore(path, options = {}) {
  const {
    clock = Date.now,
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
      } else if (application !== APPLICATION_ID || version !== SCHEMA_VERSION) {
        throw new Error("unsupported-admission-schema");
      }
      const current = db
        .prepare(
          "SELECT configuration FROM relay_configuration WHERE singleton = 1",
        )
        .get();
      if (!current || current.configuration !== configuration)
        throw new Error("admission-configuration-mismatch");
      // Validate schema shape even when an externally edited version matches.
      db.prepare(
        "SELECT id,caller_hash,request_hash,admitted_ms,replay_expires_ms,lease_expires_ms,state FROM relay_admissions LIMIT 0",
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
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER - Math.max(maxReplayMs, leaseMs)) || now < last)
      throw new Error("untrusted-admission-clock");
    db.prepare(
      "UPDATE relay_configuration SET last_observed_ms = ? WHERE singleton = 1",
    ).run(now);
    return now;
  };
  const unavailable = () => ({ ok: false, reason: "unavailable" });
  return {
    acquire({ callerId, requestId, expiresAt } = {}) {
      if (
        closed ||
        typeof callerId !== "string" ||
        !IDENTIFIER.test(callerId) ||
        typeof requestId !== "string" ||
        !IDENTIFIER.test(requestId) ||
        !Number.isSafeInteger(expiresAt)
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
              (caller_hash,request_hash,admitted_ms,replay_expires_ms,lease_expires_ms,state)
            VALUES (?,?,?,?,?,'active')
          `)
            .run(caller, request, now, expiresAt, leaseExpiresAt);
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
    finish(leaseId) {
      if (closed || !integer(leaseId, 1, Number.MAX_SAFE_INTEGER))
        return { ok: false, reason: "invalid" };
      try {
        return transaction(() => {
          observeClock();
          const row = db
            .prepare("SELECT state FROM relay_admissions WHERE id = ?")
            .get(leaseId);
          if (!row) return { ok: false, reason: "unknown" };
          db.prepare(
            "UPDATE relay_admissions SET state = 'finished' WHERE id = ? AND state = 'active'",
          ).run(leaseId);
          return { ok: true };
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
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
