import { DurableObject } from "cloudflare:workers";
import {
  authorizeGuestConnection,
  type ConnectionScope,
  type VerifiedConnectionActor,
} from "../shared/auth";
import {
  creationRequestDigest,
  InvalidCreationRequestError,
  parseCreationRequest,
} from "../shared/creation";
import { DurableDeadlineScheduler } from "../shared/deadlines";
import {
  encodeInvitation,
  invitationLandingUrl,
  parseInvitation,
  validInvitationOperationId,
  validTableId,
} from "../shared/invitations";
import { TABLE_LIMITS } from "../shared/limits";
import { digestSessionSecret, randomBase64Url } from "../shared/random";
import { ownInboxUri, parseOwnInboxUri } from "../shared/resources";
import {
  initializeApplicationSchema,
  readApplicationSchemaVersion,
} from "../shared/schema";
import { openSecret, sealSecret } from "../shared/secret-envelope";
import {
  EFFECTIVE_TABLE_LIMITS,
  type OwnInboxStatus,
  type SafeTableMetadata,
  type TableResult,
  type TableState,
} from "../shared/table";
import {
  MAX_POSTS_PER_MINUTE,
  POST_WINDOW_MS,
  type PostReceipt,
  postDigest,
  type TranscriptPage,
  type TransientPeerUpdateHint,
  validPostInput,
  validReadInput,
} from "../shared/transcript";
import type { CreationLookupResult, CreationReservation } from "./guest";

type MetadataRow = {
  table_id: string;
  creation_request_id: string;
  request_digest: string;
  creator_guest_id: string;
  title: string;
  purpose: string | null;
  state: TableState;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
  deleted_at: number | null;
  last_seq: number;
};

type MembershipRow = {
  membership_id: string;
  table_id: string;
  guest_id: string;
  seat: 1 | 2;
  role: "creator" | "invitee";
  joined_at: number;
  latest_peer_seq: number;
};

type InvitationRow = {
  invite_id: string;
  request_id: string;
  issuer_guest_id: string;
  secret_digest: string;
  response_envelope: string | null;
  issued_at: number;
  expires_at: number;
  state: "active" | "revoked" | "consumed";
  consumed_by: string | null;
  consumed_at: number | null;
};

type MessageRow = {
  seq: number;
  message_id: string;
  sender_membership_id: string;
  body: string;
  created_at: number;
  reply_to_message_id: string | null;
};
type PostReceiptRow = {
  guest_id: string;
  request_id: string;
  request_digest: string;
  message_seq: number;
};
type JoinReceiptRow = {
  guest_id: string;
  request_id: string;
  invite_id: string;
  secret_digest: string;
  membership_id: string;
};

export type InvitationResult =
  | {
      ok: true;
      value: {
        tableId: string;
        inviteId: string;
        expiresAt: string;
        invitation: string;
        landingUrl: string;
      };
    }
  | { ok: false; code: string };

function sameReservation(
  claimed: CreationReservation,
  authoritative: CreationReservation,
): boolean {
  return (
    claimed.requestId === authoritative.requestId &&
    claimed.tableId === authoritative.tableId &&
    claimed.requestDigest === authoritative.requestDigest &&
    claimed.createdAt === authoritative.createdAt &&
    claimed.expiresAt === authoritative.expiresAt &&
    claimed.retentionUntil === authoritative.retentionUntil &&
    claimed.chargedAt === authoritative.chargedAt
  );
}

export class TableDO extends DurableObject<Env> {
  private readonly deadlines: DurableDeadlineScheduler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeApplicationSchema(ctx.storage, "table");
    this.deadlines = new DurableDeadlineScheduler(ctx.storage);
  }

  // An application schema exists even when no table has ever been created.
  schemaVersion(): number {
    return readApplicationSchemaVersion(this.ctx.storage);
  }

  private metadataRow(): MetadataRow | undefined {
    return this.ctx.storage.sql
      .exec<MetadataRow>(
        `SELECT table_id, creation_request_id, request_digest,
                creator_guest_id, title, purpose, state, created_at,
                expires_at, closed_at, deleted_at, last_seq
         FROM table_metadata WHERE singleton = 1`,
      )
      .toArray()[0];
  }

  private memberships(): MembershipRow[] {
    return this.ctx.storage.sql
      .exec<MembershipRow>(
        `SELECT membership_id, table_id, guest_id, seat, role,
                joined_at, latest_peer_seq
         FROM table_memberships ORDER BY seat`,
      )
      .toArray();
  }

  private memberFor(guestId: string): MembershipRow | undefined {
    return this.ctx.storage.sql
      .exec<MembershipRow>(
        `SELECT membership_id, table_id, guest_id, seat, role,
                joined_at, latest_peer_seq
         FROM table_memberships WHERE guest_id = ?`,
        guestId,
      )
      .toArray()[0];
  }

  private publicMetadata(
    table: MetadataRow,
    own: MembershipRow,
  ): SafeTableMetadata {
    return {
      tableId: table.table_id,
      title: table.title,
      ...(table.purpose === null ? {} : { purpose: table.purpose }),
      state: table.state,
      createdAt: new Date(table.created_at).toISOString(),
      expiresAt: new Date(table.expires_at).toISOString(),
      memberships: this.memberships().map((member) => ({
        membershipId: member.membership_id,
        seat: member.seat,
        role: member.role,
        joinedAt: new Date(member.joined_at).toISOString(),
      })),
      ownMembershipId: own.membership_id,
      ownInboxUri: ownInboxUri(table.table_id, own.membership_id),
      limits: EFFECTIVE_TABLE_LIMITS,
    };
  }

  private async verifyActor(
    actor: VerifiedConnectionActor,
    requiredScope: ConnectionScope,
  ): Promise<boolean> {
    if (
      actor?.kind !== "verified-connection" ||
      actor.scope !== requiredScope ||
      typeof actor.guestId !== "string" ||
      typeof actor.connectionId !== "string"
    ) {
      return false;
    }
    const decision = await authorizeGuestConnection(
      this.env,
      actor.guestId,
      actor.connectionId,
      requiredScope,
    );
    return decision.allowed;
  }

  /**
   * Only a real, still-active GuestDO reservation can initialize this object.
   * No application table state is written until the local SQLite transaction.
   */
  async initializeTable(
    actor: VerifiedConnectionActor,
    input: unknown,
    reservation: CreationReservation,
  ): Promise<TableResult<SafeTableMetadata>> {
    let parsed: ReturnType<typeof parseCreationRequest>;
    try {
      parsed = parseCreationRequest(input);
    } catch (error) {
      if (error instanceof InvalidCreationRequestError) {
        return { ok: false, code: "INVALID_RESERVATION" };
      }
      throw error;
    }
    if (
      actor?.kind !== "verified-connection" ||
      actor.scope !== "tables:write" ||
      !reservation ||
      typeof reservation.tableId !== "string" ||
      typeof actor.guestId !== "string" ||
      !this.ctx.id.equals(this.env.TABLES.idFromName(reservation.tableId))
    ) {
      return { ok: false, code: "INVALID_RESERVATION" };
    }

    const digest = await creationRequestDigest(parsed.arguments);
    if (
      reservation.requestId !== parsed.requestId ||
      reservation.requestDigest !== digest
    ) {
      return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
    }

    // A caller-provided reservation-shaped value is not evidence of admission.
    // GuestDO independently rechecks the grant and retained durable receipt.
    let authoritative: CreationLookupResult;
    try {
      const guest = this.env.GUESTS.get(
        this.env.GUESTS.idFromName(actor.guestId),
      );
      authoritative = await guest.getCreationReservation(
        actor,
        parsed.requestId,
      );
    } catch {
      return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
    }
    if (!authoritative.ok) {
      return { ok: false, code: "INVALID_RESERVATION" };
    }
    if (!sameReservation(reservation, authoritative.reservation)) {
      return { ok: false, code: "INVALID_RESERVATION" };
    }
    if (!authoritative.initializationAllowed) {
      return { ok: false, code: "TABLE_EXPIRED" };
    }

    const trusted = authoritative.reservation;
    return this.ctx.storage.transactionSync(() => {
      // The original expiry remains authoritative even after the remote read.
      if (Date.now() >= trusted.expiresAt) {
        return { ok: false, code: "TABLE_EXPIRED" } as const;
      }
      const previous = this.metadataRow();
      if (previous) {
        if (
          previous.state === "closed" ||
          previous.state === "deleted" ||
          previous.state === "expired"
        ) {
          return { ok: false, code: "TABLE_TERMINAL" } as const;
        }
        if (
          previous.table_id !== trusted.tableId ||
          previous.creation_request_id !== trusted.requestId ||
          previous.request_digest !== digest ||
          previous.creator_guest_id !== actor.guestId ||
          previous.title !== parsed.arguments.title ||
          previous.purpose !== (parsed.arguments.purpose ?? null) ||
          previous.created_at !== trusted.createdAt ||
          previous.expires_at !== trusted.expiresAt
        ) {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" } as const;
        }
        const creator = this.memberFor(actor.guestId);
        if (creator?.seat !== 1 || creator.role !== "creator") {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" } as const;
        }
        return {
          ok: true,
          value: this.publicMetadata(previous, creator),
        } as const;
      }

      const membershipId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO table_metadata
         (singleton, table_id, creation_request_id, request_digest,
          creator_guest_id, title, purpose, state, created_at, expires_at,
          closed_at, deleted_at, last_seq)
         VALUES (1, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, NULL, NULL, 0)`,
        trusted.tableId,
        trusted.requestId,
        trusted.requestDigest,
        actor.guestId,
        parsed.arguments.title,
        parsed.arguments.purpose ?? null,
        trusted.createdAt,
        trusted.expiresAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO table_memberships
         (membership_id, table_id, guest_id, seat, role, joined_at, latest_peer_seq)
         VALUES (?, ?, ?, 1, 'creator', ?, 0)`,
        membershipId,
        trusted.tableId,
        actor.guestId,
        trusted.createdAt,
      );
      const table = this.metadataRow();
      const creator = this.memberFor(actor.guestId);
      if (!table || !creator)
        throw new Error("Incomplete table initialization");
      return { ok: true, value: this.publicMetadata(table, creator) } as const;
    });
  }

  private inviteForRequest(key: string): InvitationRow | undefined {
    return this.ctx.storage.sql
      .exec<InvitationRow>(
        "SELECT * FROM table_invitations WHERE request_id = ?",
        key,
      )
      .toArray()[0];
  }

  /**
   * Secrets and envelopes are generated before the synchronous transaction.
   * A retry decrypts only an active matching receipt and rechecks it after
   * the asynchronous decryption, so rotation cannot reveal an old secret.
   */
  async issueInvite(
    actor: VerifiedConnectionActor,
    requestId: string,
  ): Promise<InvitationResult> {
    if (
      !validInvitationOperationId(requestId) ||
      !(await this.verifyActor(actor, "tables:write"))
    ) {
      return { ok: false, code: "NOT_AUTHORIZED" };
    }
    const inviteId = crypto.randomUUID();
    const secret = randomBase64Url(32);
    // The stable table ID comes from metadata, not an untrusted caller.
    const table = this.metadataRow();
    if (
      !table ||
      !validTableId(table.table_id) ||
      !this.ctx.id.equals(this.env.TABLES.idFromName(table.table_id))
    ) {
      return { ok: false, code: "TABLE_NOT_FOUND" };
    }
    const encoded = encodeInvitation({
      tableId: table.table_id,
      inviteId,
      secret,
    });
    let envelope: string;
    try {
      envelope = await sealSecret(
        "invitation-response",
        encoded,
        { recordId: inviteId },
        this.env,
      );
    } catch {
      return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
    }
    const digest = await digestSessionSecret(secret);
    const snapshot = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const current = this.metadataRow();
      const creator = this.memberFor(actor.guestId);
      if (
        !current ||
        !creator ||
        creator.seat !== 1 ||
        creator.role !== "creator" ||
        current.creator_guest_id !== actor.guestId
      ) {
        return { kind: "error", code: "TABLE_NOT_FOUND" } as const;
      }
      if (
        current.expires_at <= now ||
        current.state !== "waiting" ||
        this.memberships().length !== 1
      ) {
        return { kind: "error", code: "TABLE_TERMINAL" } as const;
      }
      const previous = this.inviteForRequest(requestId);
      if (previous) {
        if (previous.issuer_guest_id !== actor.guestId) {
          return { kind: "error", code: "IDEMPOTENCY_CONFLICT" } as const;
        }
        if (previous.expires_at <= now) {
          this.ctx.storage.sql.exec(
            "UPDATE table_invitations SET state = 'revoked', response_envelope = NULL WHERE invite_id = ? AND state = 'active'",
            previous.invite_id,
          );
          return { kind: "error", code: "INVITATION_EXPIRED" } as const;
        }
        if (previous.state !== "active" || !previous.response_envelope) {
          return { kind: "error", code: "INVITATION_REVOKED" } as const;
        }
        return { kind: "retry", row: previous } as const;
      }
      const expiresAt = Math.min(now + 60 * 60 * 1000, current.expires_at);
      if (expiresAt <= now)
        return { kind: "error", code: "TABLE_TERMINAL" } as const;
      this.ctx.storage.sql.exec(
        "UPDATE table_invitations SET state = 'revoked', response_envelope = NULL WHERE state = 'active'",
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO table_invitations (invite_id, request_id, issuer_guest_id, secret_digest, response_envelope, issued_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
        inviteId,
        requestId,
        actor.guestId,
        digest,
        envelope,
        now,
        expiresAt,
      );
      return { kind: "new", row: this.inviteForRequest(requestId) } as const;
    });
    if (snapshot.kind === "error") return { ok: false, code: snapshot.code };
    const row = snapshot.row;
    if (!row?.response_envelope) {
      return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
    }
    let recovered: string;
    try {
      recovered =
        snapshot.kind === "new"
          ? encoded
          : await openSecret(
              "invitation-response",
              row.response_envelope,
              { recordId: row.invite_id },
              this.env,
            );
    } catch {
      return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
    }
    const stillActive = this.ctx.storage.transactionSync(() => {
      const current = this.inviteForRequest(requestId);
      return (
        current?.state === "active" &&
        current.invite_id === row.invite_id &&
        current.response_envelope === row.response_envelope &&
        current.expires_at > Date.now() &&
        this.metadataRow()?.state === "waiting"
      );
    });
    if (!stillActive) return { ok: false, code: "INVITATION_REVOKED" };
    return {
      ok: true,
      value: {
        tableId: table.table_id,
        inviteId: row.invite_id,
        expiresAt: new Date(row.expires_at).toISOString(),
        invitation: recovered,
        landingUrl: invitationLandingUrl(this.env.PUBLIC_ORIGIN, recovered),
      },
    };
  }

  /**
   * The seat insert, consumed receipt, and waiting-to-open transition commit
   * in one SQLite transaction. Cross-DO grant validation precedes the lock.
   */
  async redeemInvite(
    actor: VerifiedConnectionActor,
    encoded: string,
    requestId: string,
  ): Promise<TableResult<SafeTableMetadata>> {
    const parts = parseInvitation(encoded);
    if (
      !parts ||
      !validInvitationOperationId(requestId) ||
      !this.ctx.id.equals(this.env.TABLES.idFromName(parts.tableId))
    ) {
      return { ok: false, code: "INVITATION_INVALID" };
    }
    if (!(await this.verifyActor(actor, "tables:write"))) {
      return { ok: false, code: "INVITATION_INVALID" };
    }
    const digest = await digestSessionSecret(parts.secret);
    return this.ctx.storage.transactionSync(() => {
      const table = this.metadataRow();
      const now = Date.now();
      if (
        !table ||
        table.table_id !== parts.tableId ||
        table.expires_at <= now ||
        table.state === "deleted" ||
        table.state === "expired"
      ) {
        return { ok: false, code: "INVITATION_INVALID" } as const;
      }
      const receipt = this.ctx.storage.sql
        .exec<JoinReceiptRow>(
          "SELECT * FROM table_join_receipts WHERE guest_id = ? AND request_id = ?",
          actor.guestId,
          requestId,
        )
        .toArray()[0];
      if (
        receipt &&
        (receipt.invite_id !== parts.inviteId ||
          receipt.secret_digest !== digest)
      ) {
        return { ok: false, code: "IDEMPOTENCY_CONFLICT" } as const;
      }
      const invitation = this.ctx.storage.sql
        .exec<InvitationRow>(
          "SELECT * FROM table_invitations WHERE invite_id = ?",
          parts.inviteId,
        )
        .toArray()[0];
      if (!invitation || invitation.secret_digest !== digest) {
        return { ok: false, code: "INVITATION_INVALID" } as const;
      }
      const existing = this.memberFor(actor.guestId);
      if (
        invitation.state === "consumed" &&
        invitation.consumed_by === actor.guestId &&
        existing?.seat === 2 &&
        (table.state === "open" || table.state === "closed")
      ) {
        if (!receipt) {
          this.ctx.storage.sql.exec(
            "INSERT INTO table_join_receipts (guest_id, request_id, invite_id, secret_digest, membership_id) VALUES (?, ?, ?, ?, ?)",
            actor.guestId,
            requestId,
            parts.inviteId,
            digest,
            existing.membership_id,
          );
        }
        return {
          ok: true,
          value: this.publicMetadata(table, existing),
        } as const;
      }
      if (invitation.expires_at <= now) {
        return { ok: false, code: "INVITATION_INVALID" } as const;
      }
      if (
        receipt ||
        invitation.state !== "active" ||
        table.state !== "waiting" ||
        existing ||
        this.memberships().length !== 1
      ) {
        return { ok: false, code: "INVITATION_INVALID" } as const;
      }
      const membershipId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO table_memberships (membership_id, table_id, guest_id, seat, role, joined_at, latest_peer_seq) VALUES (?, ?, ?, 2, 'invitee', ?, ?)",
        membershipId,
        table.table_id,
        actor.guestId,
        now,
        table.last_seq,
      );
      this.ctx.storage.sql.exec(
        "UPDATE table_invitations SET state = 'consumed', consumed_by = ?, consumed_at = ?, response_envelope = NULL WHERE invite_id = ? AND state = 'active'",
        actor.guestId,
        now,
        parts.inviteId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE table_metadata SET state = 'open' WHERE singleton = 1 AND state = 'waiting'",
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO table_join_receipts (guest_id, request_id, invite_id, secret_digest, membership_id) VALUES (?, ?, ?, ?, ?)",
        actor.guestId,
        requestId,
        parts.inviteId,
        digest,
        membershipId,
      );
      const updated = this.metadataRow();
      const member = this.memberFor(actor.guestId);
      if (!updated || !member) throw new Error("Incomplete invitation claim");
      return { ok: true, value: this.publicMetadata(updated, member) } as const;
    });
  }

  /**
   * Authorization is fresh for each private read. Membership and terminal
   * status are checked synchronously after the cross-object grant decision.
   */
  private async readMembership(
    actor: VerifiedConnectionActor,
  ): Promise<TableResult<{ table: MetadataRow; member: MembershipRow }>> {
    if (!(await this.verifyActor(actor, "tables:read"))) {
      return { ok: false, code: "TABLE_NOT_FOUND" };
    }
    const table = this.metadataRow();
    const member = this.memberFor(actor.guestId);
    if (!table || !member || member.table_id !== table.table_id) {
      return { ok: false, code: "TABLE_NOT_FOUND" };
    }
    if (table.state === "deleted") {
      return { ok: false, code: "TABLE_NOT_FOUND" };
    }
    if (table.expires_at <= Date.now() || table.state === "expired") {
      return { ok: false, code: "TABLE_EXPIRED" };
    }
    return { ok: true, value: { table, member } };
  }

  async getMetadata(
    actor: VerifiedConnectionActor,
  ): Promise<TableResult<SafeTableMetadata>> {
    const access = await this.readMembership(actor);
    return access.ok
      ? {
          ok: true,
          value: this.publicMetadata(access.value.table, access.value.member),
        }
      : access;
  }

  async readOwnInbox(
    actor: VerifiedConnectionActor,
    inboxUri: string,
  ): Promise<TableResult<OwnInboxStatus>> {
    const parsed = parseOwnInboxUri(inboxUri);
    if (!parsed) return { ok: false, code: "TABLE_NOT_FOUND" };
    const access = await this.readMembership(actor);
    if (!access.ok) return access;
    const { table, member } = access.value;
    if (
      parsed.tableId !== table.table_id ||
      parsed.membershipId !== member.membership_id
    ) {
      return { ok: false, code: "TABLE_NOT_FOUND" };
    }
    return {
      ok: true,
      value: {
        tableId: table.table_id,
        membershipId: member.membership_id,
        state: table.state,
        lastSeq: table.last_seq,
        latestPeerSeq: member.latest_peer_seq,
        expiresAt: new Date(table.expires_at).toISOString(),
      },
    };
  }

  /** One SQLite transaction owns the message, sequence, limits and receipt. */
  async postMessage(
    actor: VerifiedConnectionActor,
    input: unknown,
  ): Promise<
    TableResult<PostReceipt> & { peerUpdateHint?: TransientPeerUpdateHint }
  > {
    if (!validPostInput(input)) return { ok: false, code: "INVALID_REQUEST" };
    if (!(await this.verifyActor(actor, "tables:write"))) {
      return { ok: false, code: "TABLE_NOT_FOUND" };
    }
    const digest = await postDigest(input);
    const bytes = new TextEncoder().encode(input.body).byteLength;
    const messageId = crypto.randomUUID();
    return this.ctx.storage.transactionSync(() => {
      const table = this.metadataRow();
      const member = this.memberFor(actor.guestId);
      const now = Date.now();
      if (
        !table ||
        !member ||
        member.table_id !== table.table_id ||
        table.state === "deleted"
      ) {
        return { ok: false, code: "TABLE_NOT_FOUND" } as const;
      }
      if (table.state === "expired" || table.expires_at <= now) {
        return { ok: false, code: "TABLE_EXPIRED" } as const;
      }
      const previous = this.ctx.storage.sql
        .exec<PostReceiptRow>(
          "SELECT * FROM table_post_receipts WHERE guest_id = ? AND request_id = ?",
          actor.guestId,
          input.request_id,
        )
        .toArray()[0];
      if (previous) {
        if (previous.request_digest !== digest) {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" } as const;
        }
        const original = this.ctx.storage.sql
          .exec<MessageRow>(
            "SELECT * FROM table_messages WHERE seq = ?",
            previous.message_seq,
          )
          .one();
        return {
          ok: true,
          value: this.postReceipt(table.table_id, original),
        } as const;
      }
      if (table.state !== "waiting" && table.state !== "open") {
        return { ok: false, code: "TABLE_TERMINAL" } as const;
      }
      if (input.reply_to_message_id !== undefined) {
        const reference = this.ctx.storage.sql
          .exec(
            "SELECT message_id FROM table_messages WHERE message_id = ?",
            input.reply_to_message_id,
          )
          .toArray()[0];
        if (!reference) return { ok: false, code: "INVALID_REPLY" } as const;
      }
      const usage = this.ctx.storage.sql
        .exec<{ body_bytes: number }>(
          "SELECT body_bytes FROM table_transcript_usage WHERE singleton = 1",
        )
        .one();
      if (
        table.last_seq >= TABLE_LIMITS.maxMessages ||
        usage.body_bytes + bytes > TABLE_LIMITS.transcriptBodyBytes
      ) {
        return { ok: false, code: "LIMIT_REACHED" } as const;
      }
      const count = this.ctx.storage.sql
        .exec<{ total: number }>(
          "SELECT COUNT(*) AS total FROM table_messages WHERE created_at > ?",
          now - POST_WINDOW_MS,
        )
        .one();
      if (count.total >= MAX_POSTS_PER_MINUTE) {
        return { ok: false, code: "RATE_LIMITED" } as const;
      }
      const seq = table.last_seq + 1;
      const peer = this.ctx.storage.sql
        .exec<{ membership_id: string }>(
          "SELECT membership_id FROM table_memberships WHERE table_id = ? AND guest_id <> ? LIMIT 1",
          table.table_id,
          actor.guestId,
        )
        .toArray()[0];
      this.ctx.storage.sql.exec(
        `INSERT INTO table_messages
          (seq, message_id, sender_membership_id, body, body_bytes, created_at, reply_to_message_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        seq,
        messageId,
        member.membership_id,
        input.body,
        bytes,
        now,
        input.reply_to_message_id ?? null,
      );
      this.ctx.storage.sql.exec(
        "UPDATE table_metadata SET last_seq = ? WHERE singleton = 1",
        seq,
      );
      this.ctx.storage.sql.exec(
        "UPDATE table_transcript_usage SET body_bytes = body_bytes + ? WHERE singleton = 1",
        bytes,
      );
      // The poster never receives a self-generated peer watermark.
      this.ctx.storage.sql.exec(
        "UPDATE table_memberships SET latest_peer_seq = ? WHERE guest_id <> ?",
        seq,
        actor.guestId,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO table_post_receipts (guest_id, request_id, request_digest, message_seq) VALUES (?, ?, ?, ?)",
        actor.guestId,
        input.request_id,
        digest,
        seq,
      );
      return {
        ok: true,
        value: this.postReceipt(table.table_id, {
          seq,
          message_id: messageId,
          sender_membership_id: member.membership_id,
          body: input.body,
          created_at: now,
          reply_to_message_id: input.reply_to_message_id ?? null,
        }),
        // This metadata becomes observable only after transactionSync commits.
        // Identical receipt retries take the earlier return and never produce it.
        ...(peer
          ? {
              peerUpdateHint: {
                tableId: table.table_id,
                seq,
                peerMembershipId: peer.membership_id,
              },
            }
          : {}),
      } as const;
    });
  }

  private postReceipt(tableId: string, row: MessageRow): PostReceipt {
    return {
      table_id: tableId,
      message_id: row.message_id,
      seq: row.seq,
      sender_membership_id: row.sender_membership_id,
      created_at: new Date(row.created_at).toISOString(),
      persisted: true,
    };
  }

  /** Snapshot reads never acknowledge events or modify server cursors. */
  async readMessages(
    actor: VerifiedConnectionActor,
    input: unknown,
  ): Promise<TableResult<TranscriptPage>> {
    if (!validReadInput(input)) return { ok: false, code: "INVALID_REQUEST" };
    if (!(await this.verifyActor(actor, "tables:read"))) {
      return { ok: false, code: "TABLE_NOT_FOUND" };
    }
    return this.ctx.storage.transactionSync(() => {
      const table = this.metadataRow();
      const member = this.memberFor(actor.guestId);
      if (
        !table ||
        !member ||
        member.table_id !== table.table_id ||
        table.state === "deleted"
      ) {
        return { ok: false, code: "TABLE_NOT_FOUND" } as const;
      }
      if (table.state === "expired" || table.expires_at <= Date.now()) {
        return { ok: false, code: "TABLE_EXPIRED" } as const;
      }
      const after = input.after_seq ?? 0;
      const through = input.through_seq ?? table.last_seq;
      const limit = input.limit ?? 50;
      if (through > table.last_seq || after > through) {
        return { ok: false, code: "INVALID_CURSOR" } as const;
      }
      const rows = this.ctx.storage.sql
        .exec<MessageRow>(
          `SELECT * FROM table_messages
         WHERE seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
          after,
          through,
          limit + 1,
        )
        .toArray();
      const more = rows.length > limit;
      const slice = more ? rows.slice(0, limit) : rows;
      return {
        ok: true,
        value: {
          messages: slice.map((row) => ({
            seq: row.seq,
            message_id: row.message_id,
            sender_membership_id: row.sender_membership_id,
            body: row.body,
            created_at: new Date(row.created_at).toISOString(),
            ...(row.reply_to_message_id === null
              ? {}
              : { reply_to_message_id: row.reply_to_message_id }),
          })),
          next_after_seq: slice.at(-1)?.seq ?? after,
          through_seq: through,
          has_more: more,
          own_inbox_uri: ownInboxUri(table.table_id, member.membership_id),
          latest_peer_seq: member.latest_peer_seq,
        },
      } as const;
    });
  }

  /**
   * No TableDO deadline consumer exists yet. Lifecycle and delivery producers
   * will use this same per-object scheduler when their schemas are introduced.
   */
  async alarm(): Promise<void> {
    await this.deadlines.drainDueWork(
      () => null,
      () => 0,
    );
  }
}
