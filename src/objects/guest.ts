import { DurableObject } from "cloudflare:workers";
import {
  requestFingerprint,
  stagingEvidenceEnabled,
} from "../evidence/staging";
import {
  type ConnectionDecision,
  type ConnectionScope,
  isConnectionScope,
  type VerifiedConnectionActor,
} from "../shared/auth";
import {
  type CreationActor,
  creationRequestDigest,
  InvalidCreationRequestError,
  parseCreationRequest,
  validCreationRequestId,
} from "../shared/creation";
import { DurableDeadlineScheduler } from "../shared/deadlines";
import { CREATION_LIMITS } from "../shared/limits";
import { digestSessionSecret, randomBase64Url } from "../shared/random";
import { deferQuarantinedAlarm } from "../shared/release-quarantine";
import {
  initializeApplicationSchema,
  readApplicationSchemaVersion,
} from "../shared/schema";
import { emitOperationalEvent } from "../shared/telemetry";

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLEANUP_BATCH = 100;
const MAX_CONNECTION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_SECRET = /^[A-Za-z0-9_-]{43}$/;

type SessionRow = {
  session_id: string;
  secret_digest: string;
  created_at: number;
  expires_at: number;
  invalidated_at: number | null;
};

export type GuestSessionPrincipal = {
  guestId: string;
  createdAt: number;
  expiresAt: number;
};

export type NewGuestSession = GuestSessionPrincipal & {
  sessionId: string;
  secret: string;
};

type ConnectionRow = {
  connection_id: string;
  guest_id: string;
  scopes_json: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};

export type ConnectionSummary = {
  connectionId: string;
  scopes: ConnectionScope[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

export type NewConnectionGrant = ConnectionSummary & {
  guestId: string;
};

export type ConnectionRevocation =
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "revoked"; session: NewGuestSession };

type CreationRow = {
  request_id: string;
  guest_id: string;
  request_digest: string;
  table_id: string;
  created_at: number;
  expires_at: number;
  retention_until: number;
  charged_at: number;
  outcome: "reserved" | "initialized" | "failed";
};

export type CreationReservation = {
  requestId: string;
  tableId: string;
  requestDigest: string;
  createdAt: number;
  expiresAt: number;
  retentionUntil: number;
  chargedAt: number;
  outcome: CreationRow["outcome"];
};

export type CreationFailureCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "IDEMPOTENCY_CONFLICT"
  | "LIMIT_REACHED"
  | "TABLE_EXPIRED"
  | "NOT_FOUND"
  | "OUTCOME_CONFLICT";

export type CreationFailure = {
  ok: false;
  code: CreationFailureCode;
  retryAfterMs?: number;
};

export type CreationResult =
  | { ok: true; reservation: CreationReservation }
  | CreationFailure;

export type CreationLookupResult =
  | {
      ok: true;
      reservation: CreationReservation;
      initializationAllowed: boolean;
    }
  | CreationFailure;

export type CreationOutcome = "initialized" | "failed";

function validCredential(sessionId: string, secret: string): boolean {
  return UUID_V4.test(sessionId) && SESSION_SECRET.test(secret);
}

// Compare fixed-size SHA-256 digests without a prefix-dependent early return.
function digestMatches(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export class GuestDO extends DurableObject<Env> {
  private readonly deadlines: DurableDeadlineScheduler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeApplicationSchema(ctx.storage, "guest");
    this.deadlines = new DurableDeadlineScheduler(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await this.deadlines.ensureExistingWakeup(() => this.earliestDeadline());
    });
  }

  schemaVersion(): number {
    return readApplicationSchemaVersion(this.ctx.storage);
  }

  /**
   * Internal DO-RPC only: independent read of the exact guest SQLite rows.
   * No guest ID, connection ID, table ID, or request ID leaves this method.
   */
  async readStagingEvidence(
    guestId: string,
    tableId?: string,
    connectionId?: string,
  ) {
    if (
      !stagingEvidenceEnabled(this.env) ||
      this.ctx.id.toString() !== this.env.GUESTS.idFromName(guestId).toString()
    ) {
      throw new Error("Staging evidence is disabled");
    }
    const identityMatches = this.guestId() === guestId;
    const connection = connectionId
      ? this.connectionRow(connectionId)
      : undefined;
    const ownedConnection =
      identityMatches && connection?.guest_id === guestId
        ? connection
        : undefined;
    const creation = tableId
      ? this.ctx.storage.sql
          .exec<CreationRow>(
            `SELECT request_id, guest_id, request_digest, table_id, created_at,
                  expires_at, retention_until, charged_at, outcome
           FROM guest_creation_reservations WHERE table_id = ?`,
            tableId,
          )
          .toArray()[0]
      : undefined;
    const ownedCreation =
      identityMatches && creation?.guest_id === guestId ? creation : undefined;
    const now = Date.now();
    // Bound the read to eight newest grants; never export their raw IDs.
    const recentRows = identityMatches
      ? this.ctx.storage.sql
          .exec<ConnectionRow>(
            `SELECT connection_id, guest_id, scopes_json, created_at,
                    expires_at, revoked_at
             FROM guest_connections WHERE guest_id = ?
             ORDER BY created_at DESC LIMIT 8`,
            guestId,
          )
          .toArray()
      : [];
    const recentConnections = await Promise.all(
      recentRows.map(async (row) => {
        let scopes: ConnectionScope[] = [];
        try {
          const parsed: unknown = JSON.parse(row.scopes_json);
          if (Array.isArray(parsed))
            scopes = parsed.filter(isConnectionScope).sort();
        } catch {
          // Invalid legacy scope JSON must not leak or disrupt other rows.
        }
        return {
          connectionFingerprint: await requestFingerprint(row.connection_id),
          state:
            row.revoked_at !== null
              ? "revoked"
              : row.expires_at <= now
                ? "expired"
                : "active",
          scopes,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
        };
      }),
    );
    return {
      identityMatches,
      recentConnections,
      connection: connectionId
        ? {
            exists: Boolean(ownedConnection),
            state: !ownedConnection
              ? "missing"
              : ownedConnection.revoked_at !== null
                ? "revoked"
                : ownedConnection.expires_at <= now
                  ? "expired"
                  : "active",
            createdAt: ownedConnection?.created_at ?? null,
            expiresAt: ownedConnection?.expires_at ?? null,
            revokedAt: ownedConnection?.revoked_at ?? null,
          }
        : null,
      creationReservation: tableId
        ? {
            exists: Boolean(ownedCreation),
            outcome: ownedCreation?.outcome ?? null,
            createdAt: ownedCreation?.created_at ?? null,
            expiresAt: ownedCreation?.expires_at ?? null,
            requestFingerprint: ownedCreation
              ? await requestFingerprint(ownedCreation.request_id)
              : null,
          }
        : null,
    };
  }

  private guestId(): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ guest_id: string }>(
          "SELECT guest_id FROM guest_identity WHERE singleton = 1",
        )
        .toArray()[0]?.guest_id ?? null
    );
  }

  private sessionRow(sessionId: string): SessionRow | undefined {
    return this.ctx.storage.sql
      .exec<SessionRow>(
        `SELECT session_id, secret_digest, created_at, expires_at, invalidated_at
         FROM guest_sessions WHERE session_id = ?`,
        sessionId,
      )
      .toArray()[0];
  }

  private activeSession(
    sessionId: string,
    digest: string,
    now: number,
  ): SessionRow | null {
    const row = this.sessionRow(sessionId);
    if (
      !row ||
      row.invalidated_at !== null ||
      row.expires_at <= now ||
      row.expires_at - row.created_at > SESSION_LIFETIME_MS ||
      !digestMatches(row.secret_digest, digest)
    ) {
      return null;
    }
    return row;
  }

  /** Initialize a fresh DO exactly once; never recover from a public guest ID. */
  async createSession(guestId: string): Promise<NewGuestSession> {
    if (!UUID_V4.test(guestId)) throw new Error("Invalid guest identifier");
    const secret = randomBase64Url(32);
    const digest = await digestSessionSecret(secret);
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + SESSION_LIFETIME_MS;

    await this.deadlines.commitWithWakeup(expiresAt, () => {
      this.ctx.storage.transactionSync(() => {
        if (this.guestId() !== null) {
          throw new Error("Guest already initialized");
        }
        this.ctx.storage.sql.exec(
          "INSERT INTO guest_identity (singleton, guest_id, created_at) VALUES (1, ?, ?)",
          guestId,
          now,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO guest_sessions
         (session_id, secret_digest, created_at, expires_at, invalidated_at)
         VALUES (?, ?, ?, ?, NULL)`,
          sessionId,
          digest,
          now,
          expiresAt,
        );
      });
    });
    return { guestId, sessionId, secret, createdAt: now, expiresAt };
  }

  /** Read-only authorization: a GET never refreshes or re-creates a session. */
  async validateSession(
    sessionId: string,
    secret: string,
  ): Promise<GuestSessionPrincipal | null> {
    if (!validCredential(sessionId, secret)) return null;
    const digest = await digestSessionSecret(secret);
    const row = this.activeSession(sessionId, digest, Date.now());
    const guestId = this.guestId();
    return row && guestId
      ? { guestId, createdAt: row.created_at, expiresAt: row.expires_at }
      : null;
  }

  /** An atomic replacement preserves identity and immediately revokes the old secret. */
  async rotateSession(
    sessionId: string,
    secret: string,
  ): Promise<NewGuestSession | null> {
    if (!validCredential(sessionId, secret)) return null;
    const digest = await digestSessionSecret(secret);
    const nextSecret = randomBase64Url(32);
    const nextDigest = await digestSessionSecret(nextSecret);
    const nextSessionId = crypto.randomUUID();
    const safetyDeadline = Date.now() + SESSION_LIFETIME_MS;
    return (
      await this.deadlines.commitWithWakeup(safetyDeadline, () =>
        this.ctx.storage.transactionSync(() => {
          const now = Date.now();
          const expiresAt = now + SESSION_LIFETIME_MS;
          const prior = this.activeSession(sessionId, digest, now);
          const guestId = this.guestId();
          if (!prior || !guestId) return null;
          this.ctx.storage.sql.exec(
            "UPDATE guest_sessions SET invalidated_at = ? WHERE session_id = ?",
            now,
            sessionId,
          );
          this.ctx.storage.sql.exec(
            `INSERT INTO guest_sessions
         (session_id, secret_digest, created_at, expires_at, invalidated_at)
         VALUES (?, ?, ?, ?, NULL)`,
            nextSessionId,
            nextDigest,
            now,
            expiresAt,
          );
          return {
            guestId,
            sessionId: nextSessionId,
            secret: nextSecret,
            createdAt: now,
            expiresAt,
          };
        }),
      )
    ).value;
  }

  async invalidateSession(sessionId: string, secret: string): Promise<boolean> {
    if (!validCredential(sessionId, secret)) return false;
    const digest = await digestSessionSecret(secret);
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      if (!this.activeSession(sessionId, digest, now)) return false;
      this.ctx.storage.sql.exec(
        "UPDATE guest_sessions SET invalidated_at = ? WHERE session_id = ?",
        now,
        sessionId,
      );
      return true;
    });
  }

  /** Bounded physical cleanup; logical authorization has already expired. */
  pruneExpiredSessions(limit = MAX_CLEANUP_BATCH): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLEANUP_BATCH) {
      throw new Error("Invalid cleanup batch size");
    }
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM guest_sessions WHERE session_id IN (
          SELECT session_id FROM guest_sessions
          WHERE expires_at <= ? OR invalidated_at IS NOT NULL
          ORDER BY expires_at LIMIT ?
        )`,
        Date.now(),
        limit,
      );
      return this.ctx.storage.sql
        .exec<{ count: number }>("SELECT changes() AS count")
        .one().count;
    });
  }

  private connectionRow(connectionId: string): ConnectionRow | undefined {
    return this.ctx.storage.sql
      .exec<ConnectionRow>(
        `SELECT connection_id, guest_id, scopes_json, created_at, expires_at, revoked_at
         FROM guest_connections WHERE connection_id = ?`,
        connectionId,
      )
      .toArray()[0];
  }

  /**
   * Called only by a server-side consent flow after explicit approval.
   * Browser credential validity is rechecked in this object's transaction.
   */
  async createConnection(
    sessionId: string,
    secret: string,
    approvedScopes: ConnectionScope[],
    expiresAt: number,
  ): Promise<NewConnectionGrant | null> {
    if (
      !Array.isArray(approvedScopes) ||
      approvedScopes.length === 0 ||
      approvedScopes.length > 4 ||
      !approvedScopes.every(isConnectionScope) ||
      new Set(approvedScopes).size !== approvedScopes.length
    ) {
      throw new Error("Invalid connection scopes");
    }
    const now = Date.now();
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + MAX_CONNECTION_LIFETIME_MS
    ) {
      throw new Error("Invalid connection expiry");
    }
    if (!validCredential(sessionId, secret)) return null;
    const digest = await digestSessionSecret(secret);
    const connectionId = crypto.randomUUID();
    const scopes = [...approvedScopes].sort();
    return (
      await this.deadlines.commitWithWakeup(expiresAt, () =>
        this.ctx.storage.transactionSync(() => {
          const effectiveNow = Date.now();
          if (expiresAt <= effectiveNow) return null;
          const guestId = this.guestId();
          if (
            !guestId ||
            !this.activeSession(sessionId, digest, effectiveNow)
          ) {
            return null;
          }
          this.ctx.storage.sql.exec(
            `INSERT INTO guest_connections
         (connection_id, guest_id, scopes_json, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
            connectionId,
            guestId,
            JSON.stringify(scopes),
            effectiveNow,
            expiresAt,
          );
          return {
            connectionId,
            guestId,
            scopes,
            createdAt: effectiveNow,
            expiresAt,
            revokedAt: null,
          };
        }),
      )
    ).value;
  }

  /** Every new protected operation calls this read; there is no allow cache. */
  authorizeConnection(
    expectedGuestId: string,
    connectionId: string,
    requiredScope: ConnectionScope,
  ): ConnectionDecision {
    if (
      !UUID_V4.test(expectedGuestId) ||
      !UUID_V4.test(connectionId) ||
      !isConnectionScope(requiredScope)
    ) {
      return { allowed: false, reason: "invalid" };
    }
    const owner = this.guestId();
    if (!owner || owner !== expectedGuestId) {
      return { allowed: false, reason: "mismatched" };
    }
    const row = this.connectionRow(connectionId);
    if (!row) return { allowed: false, reason: "missing" };
    if (row.guest_id !== owner) {
      return { allowed: false, reason: "mismatched" };
    }
    if (row.revoked_at !== null) {
      return { allowed: false, reason: "revoked" };
    }
    if (row.expires_at <= Date.now()) {
      return { allowed: false, reason: "expired" };
    }
    let scopes: unknown;
    try {
      scopes = JSON.parse(row.scopes_json);
    } catch {
      return { allowed: false, reason: "invalid" };
    }
    if (
      !Array.isArray(scopes) ||
      !scopes.every(isConnectionScope) ||
      !scopes.includes(requiredScope)
    ) {
      return { allowed: false, reason: "insufficient-scope" };
    }
    return {
      allowed: true,
      actor: {
        kind: "verified-connection",
        guestId: owner,
        connectionId,
        scope: requiredScope,
        expiresAt: row.expires_at,
      },
    };
  }

  /** A browser session, not a supplied guest ID, selects the list owner. */
  async listConnections(
    sessionId: string,
    secret: string,
  ): Promise<ConnectionSummary[] | null> {
    if (!validCredential(sessionId, secret)) return null;
    const digest = await digestSessionSecret(secret);
    const owner = this.guestId();
    if (!owner || !this.activeSession(sessionId, digest, Date.now())) {
      return null;
    }
    return this.ctx.storage.sql
      .exec<ConnectionRow>(
        `SELECT connection_id, guest_id, scopes_json, created_at, expires_at, revoked_at
         FROM guest_connections WHERE guest_id = ?
         ORDER BY created_at DESC, connection_id DESC LIMIT 200`,
        owner,
      )
      .toArray()
      .map((row) => ({
        connectionId: row.connection_id,
        scopes: JSON.parse(row.scopes_json) as ConnectionScope[],
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      }));
  }

  /**
   * Revocation and browser credential rotation commit atomically. Repeating
   * against an already-revoked grant is safe with a currently valid session.
   */
  async revokeConnection(
    sessionId: string,
    secret: string,
    connectionId: string,
  ): Promise<ConnectionRevocation> {
    if (!validCredential(sessionId, secret)) {
      return { status: "unauthorized" };
    }
    if (!UUID_V4.test(connectionId)) return { status: "not-found" };
    const digest = await digestSessionSecret(secret);
    const nextSecret = randomBase64Url(32);
    const nextDigest = await digestSessionSecret(nextSecret);
    const nextSessionId = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_LIFETIME_MS;
    return (
      await this.deadlines.commitWithWakeup<ConnectionRevocation>(
        expiresAt,
        () =>
          this.ctx.storage.transactionSync(() => {
            const now = Date.now();
            const owner = this.guestId();
            const session = this.activeSession(sessionId, digest, now);
            if (!owner || !session) return { status: "unauthorized" };
            const row = this.connectionRow(connectionId);
            if (!row || row.guest_id !== owner) return { status: "not-found" };
            if (row.revoked_at === null) {
              this.ctx.storage.sql.exec(
                "UPDATE guest_connections SET revoked_at = ? WHERE connection_id = ? AND guest_id = ? AND revoked_at IS NULL",
                now,
                connectionId,
                owner,
              );
            }
            this.ctx.storage.sql.exec(
              "UPDATE guest_sessions SET invalidated_at = ? WHERE session_id = ?",
              now,
              sessionId,
            );
            this.ctx.storage.sql.exec(
              `INSERT INTO guest_sessions
         (session_id, secret_digest, created_at, expires_at, invalidated_at)
         VALUES (?, ?, ?, ?, NULL)`,
              nextSessionId,
              nextDigest,
              now,
              expiresAt,
            );
            return {
              status: "revoked",
              session: {
                guestId: owner,
                sessionId: nextSessionId,
                secret: nextSecret,
                createdAt: now,
                expiresAt,
              },
            };
          }),
      )
    ).value;
  }

  private creationAuthorized(actor: VerifiedConnectionActor): boolean {
    if (
      actor?.kind !== "verified-connection" ||
      actor.scope !== "tables:write"
    ) {
      return false;
    }
    // The actor is constructed by the server, but its grant is checked again
    // at this effect boundary, inside the guest's own Durable Object.
    return this.authorizeConnection(
      actor.guestId,
      actor.connectionId,
      "tables:write",
    ).allowed;
  }

  /** Recheck session or grant at the GuestDO transaction boundary. */
  private async creationPermission(
    actor: CreationActor,
  ): Promise<() => boolean> {
    if (!actor || typeof actor !== "object") return () => false;
    if ("kind" in actor) return () => this.creationAuthorized(actor);
    if (
      typeof actor.guestId !== "string" ||
      actor.guestId !== this.guestId() ||
      !validCredential(actor.sessionId, actor.secret)
    )
      return () => false;
    const digest = await digestSessionSecret(actor.secret);
    return () =>
      this.guestId() === actor.guestId &&
      this.activeSession(actor.sessionId, digest, Date.now()) !== null;
  }

  private creationRow(requestId: string): CreationRow | undefined {
    return this.ctx.storage.sql
      .exec<CreationRow>(
        `SELECT request_id, guest_id, request_digest, table_id, created_at,
                expires_at, retention_until, charged_at, outcome
         FROM guest_creation_reservations WHERE request_id = ?`,
        requestId,
      )
      .toArray()[0];
  }

  private toCreationReservation(row: CreationRow): CreationReservation {
    return {
      requestId: row.request_id,
      tableId: row.table_id,
      requestDigest: row.request_digest,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      retentionUntil: row.retention_until,
      chargedAt: row.charged_at,
      outcome: row.outcome,
    };
  }

  /** A private test probe at the exact pre-transaction admission boundary. */
  private async beforeReservationDecision(): Promise<void> {}

  /**
   * Reserve one identity and quota charge, not a completed table. Only the
   * later TableDO initializer can establish whether creation succeeded.
   */
  async reserveCreation(
    actor: CreationActor,
    input: unknown,
  ): Promise<CreationResult> {
    const permitted = await this.creationPermission(actor);
    let parsed: ReturnType<typeof parseCreationRequest>;
    try {
      parsed = parseCreationRequest(input);
    } catch (error) {
      if (error instanceof InvalidCreationRequestError) {
        return { ok: false, code: "INVALID_REQUEST" };
      }
      throw error;
    }

    const digest = await creationRequestDigest(parsed.arguments);
    const proposedId = crypto.randomUUID();
    await this.beforeReservationDecision();

    const retentionDeadline =
      Date.now() + CREATION_LIMITS.reservationRetentionMs;
    return (
      await this.deadlines.commitWithWakeup(retentionDeadline, () =>
        this.ctx.storage.transactionSync(() => {
          if (!permitted()) {
            return { ok: false, code: "UNAUTHORIZED" } as const;
          }
          const now = Date.now();
          const owner = this.guestId();
          if (!owner) return { ok: false, code: "UNAUTHORIZED" } as const;

          const previous = this.creationRow(parsed.requestId);
          if (previous && previous.retention_until > now) {
            if (previous.request_digest !== digest) {
              return { ok: false, code: "IDEMPOTENCY_CONFLICT" } as const;
            }
            if (previous.expires_at <= now) {
              return { ok: false, code: "TABLE_EXPIRED" } as const;
            }
            return {
              ok: true,
              reservation: this.toCreationReservation(previous),
            } as const;
          }
          // A record beyond eight days is no longer part of the dedupe contract.
          if (previous) {
            this.ctx.storage.sql.exec(
              "DELETE FROM guest_creation_reservations WHERE request_id = ?",
              parsed.requestId,
            );
          }

          const windowStart = now - CREATION_LIMITS.reservationWindowMs;
          const quota = this.ctx.storage.sql
            .exec<{ count: number; oldest: number | null }>(
              `SELECT COUNT(*) AS count, MIN(charged_at) AS oldest
           FROM guest_creation_reservations
           WHERE guest_id = ? AND charged_at > ?`,
              owner,
              windowStart,
            )
            .one();
          if (quota.count >= CREATION_LIMITS.maxReservationsPerWindow) {
            return {
              ok: false,
              code: "LIMIT_REACHED",
              retryAfterMs: Math.max(
                1,
                (quota.oldest ?? now) +
                  CREATION_LIMITS.reservationWindowMs -
                  now,
              ),
            } as const;
          }

          const expiresAt = now + parsed.arguments.ttl_seconds * 1_000;
          const retentionUntil = now + CREATION_LIMITS.reservationRetentionMs;
          this.ctx.storage.sql.exec(
            `INSERT INTO guest_creation_reservations
         (request_id, guest_id, request_digest, table_id, created_at,
          expires_at, retention_until, charged_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
            parsed.requestId,
            owner,
            digest,
            proposedId,
            now,
            expiresAt,
            retentionUntil,
            now,
          );
          return {
            ok: true,
            reservation: {
              requestId: parsed.requestId,
              tableId: proposedId,
              requestDigest: digest,
              createdAt: now,
              expiresAt,
              retentionUntil,
              chargedAt: now,
              outcome: "reserved",
            },
          } as const;
        }),
      )
    ).value;
  }

  /** Read a retained receipt without implicitly authorizing initialization. */
  async getCreationReservation(
    actor: CreationActor,
    requestId: string,
  ): Promise<CreationLookupResult> {
    if (!validCreationRequestId(requestId)) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    const permitted = await this.creationPermission(actor);
    if (!permitted()) {
      return { ok: false, code: "UNAUTHORIZED" };
    }
    const now = Date.now();
    const row = this.creationRow(requestId);
    if (!row || row.retention_until <= now) {
      return { ok: false, code: "NOT_FOUND" };
    }
    return {
      ok: true,
      reservation: this.toCreationReservation(row),
      initializationAllowed: row.expires_at > now,
    };
  }

  /** An outcome annotation never refunds quota or proves TableDO membership. */
  async recordCreationOutcome(
    actor: CreationActor,
    requestId: string,
    tableId: string,
    outcome: CreationOutcome,
  ): Promise<CreationResult> {
    if (
      !validCreationRequestId(requestId) ||
      !UUID_V4.test(tableId) ||
      (outcome !== "initialized" && outcome !== "failed")
    ) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    const permitted = await this.creationPermission(actor);
    return this.ctx.storage.transactionSync(() => {
      if (!permitted()) {
        return { ok: false, code: "UNAUTHORIZED" } as const;
      }
      const row = this.creationRow(requestId);
      const now = Date.now();
      if (!row || row.retention_until <= now || row.table_id !== tableId) {
        return { ok: false, code: "NOT_FOUND" } as const;
      }
      if (row.outcome === outcome) {
        return {
          ok: true,
          reservation: this.toCreationReservation(row),
        } as const;
      }
      if (row.outcome !== "reserved") {
        return { ok: false, code: "OUTCOME_CONFLICT" } as const;
      }
      if (row.expires_at <= now) {
        return { ok: false, code: "TABLE_EXPIRED" } as const;
      }
      this.ctx.storage.sql.exec(
        "UPDATE guest_creation_reservations SET outcome = ? WHERE request_id = ?",
        outcome,
        requestId,
      );
      return {
        ok: true,
        reservation: { ...this.toCreationReservation(row), outcome },
      } as const;
    });
  }

  /** Physical pruning is bounded; deadline checks do not depend on it. */
  pruneExpiredReservations(
    limit: number = CREATION_LIMITS.maxCleanupBatch,
  ): number {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > CREATION_LIMITS.maxCleanupBatch
    ) {
      throw new Error("Invalid cleanup batch size");
    }
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM guest_creation_reservations WHERE request_id IN (
          SELECT request_id FROM guest_creation_reservations
          WHERE retention_until <= ? ORDER BY retention_until LIMIT ?
        )`,
        Date.now(),
        limit,
      );
      return this.ctx.storage.sql
        .exec<{ count: number }>("SELECT changes() AS count")
        .one().count;
    });
  }

  /** The next durable cleanup deadline, independent of any in-memory timer. */
  private earliestDeadline(): number | null {
    return this.ctx.storage.sql
      .exec<{ deadline: number | null }>(
        `SELECT MIN(next_deadline) AS deadline FROM (
          SELECT MIN(expires_at) AS next_deadline FROM guest_sessions
          UNION ALL SELECT MIN(expires_at) FROM guest_connections
          UNION ALL SELECT MIN(retention_until) FROM guest_creation_reservations
        )`,
      )
      .one().deadline;
  }

  private deleteDue(
    kind: "sessions" | "connections" | "reservations",
    now: number,
    limit: number,
  ) {
    if (limit <= 0) return 0;
    const statements = {
      sessions: `DELETE FROM guest_sessions WHERE rowid IN (
        SELECT rowid FROM guest_sessions WHERE expires_at <= ?
        ORDER BY expires_at LIMIT ?
      )`,
      connections: `DELETE FROM guest_connections WHERE rowid IN (
        SELECT rowid FROM guest_connections WHERE expires_at <= ?
        ORDER BY expires_at LIMIT ?
      )`,
      reservations: `DELETE FROM guest_creation_reservations WHERE rowid IN (
        SELECT rowid FROM guest_creation_reservations WHERE retention_until <= ?
        ORDER BY retention_until LIMIT ?
      )`,
    } as const;
    this.ctx.storage.sql.exec(statements[kind], now, limit);
    return this.ctx.storage.sql
      .exec<{ count: number }>("SELECT changes() AS count")
      .one().count;
  }

  private pruneDue(now: number, budget: number): number {
    let total = this.deleteDue("sessions", now, budget);
    total += this.deleteDue("connections", now, budget - total);
    total += this.deleteDue("reservations", now, budget - total);
    return total;
  }

  /** At-least-once alarm processing; remaining work is always rearmed. */
  async alarm(): Promise<void> {
    // During independent reconciliation, park the wakeup but never prune
    // restored private rows or issue any downstream effect.
    if (await deferQuarantinedAlarm(this.env, this.ctx.storage)) return;
    const started = Date.now();
    try {
      const earliest = this.earliestDeadline();
      const drained = await this.deadlines.drainDueWork(
        () => this.earliestDeadline(),
        (now, budget) => this.pruneDue(now, budget),
      );
      emitOperationalEvent({
        kind: "alarm",
        component: "guest",
        outcome: "committed",
        processed: drained.processed,
        backlogLagMs:
          earliest === null ? null : Math.max(0, started - earliest),
        durationMs: Date.now() - started,
      });
    } catch {
      emitOperationalEvent({
        kind: "alarm",
        component: "guest",
        outcome: "unknown",
        processed: null,
        backlogLagMs: null,
        durationMs: Date.now() - started,
      });
      throw new Error("Guest cleanup unavailable");
    }
  }
}
