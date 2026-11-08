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
import { ownInboxUri, parseOwnInboxUri } from "../shared/resources";
import {
  initializeApplicationSchema,
  readApplicationSchemaVersion,
} from "../shared/schema";
import {
  EFFECTIVE_TABLE_LIMITS,
  type OwnInboxStatus,
  type SafeTableMetadata,
  type TableResult,
  type TableState,
} from "../shared/table";
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeApplicationSchema(ctx.storage, "table");
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
}
