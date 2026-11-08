import { DurableObject } from "cloudflare:workers";
import { digestSessionSecret, randomBase64Url } from "../shared/random";
import {
  initializeApplicationSchema,
  readApplicationSchemaVersion,
} from "../shared/schema";

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLEANUP_BATCH = 100;
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeApplicationSchema(ctx.storage, "guest");
  }

  schemaVersion(): number {
    return readApplicationSchemaVersion(this.ctx.storage);
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
    const now = Date.now();
    const expiresAt = now + SESSION_LIFETIME_MS;

    return this.ctx.storage.transactionSync(() => {
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
    });
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
}
