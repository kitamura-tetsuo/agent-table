import { allowNewTables } from "../shared/admission";
import type { VerifiedConnectionActor } from "../shared/auth";
import type { CreationActor } from "../shared/creation";
import {
  InvalidCreationRequestError,
  parseCreationRequest,
} from "../shared/creation";
import type { DeletionReceipt } from "../shared/deletion";
import type {
  CloseTableReceipt,
  LifecycleInvalidation,
} from "../shared/lifecycle";
import { parseOwnInboxUri } from "../shared/resources";
import type { SafeTableMetadata, TableResult } from "../shared/table";
import { emitOperationalEvent } from "../shared/telemetry";
import type {
  PostMessageInput,
  PostReceipt,
  ReadMessagesInput,
  TranscriptPage,
  TransientPeerUpdateHint,
} from "../shared/transcript";

export type PublicTableResult =
  | { ok: true; value: SafeTableMetadata }
  | { ok: false; code: string; retryAfterMs?: number };

const unavailable = (): PublicTableResult => ({
  ok: false,
  code: "TEMPORARILY_UNAVAILABLE",
});

/**
 * Record only categorical invitation outcomes at the application authority.
 * MCP tool errors are usually HTTP 200 and cannot be counted at the edge.
 * Never attach invite tokens, table IDs, arguments, or returned values.
 */
function observeInvitation<T extends { ok: boolean }>(
  operation: "create_invite" | "join_table",
  result: T,
  started: number,
): T {
  const code = "code" in result ? result.code : undefined;
  const failureCategory = result.ok
    ? "none"
    : code === "TEMPORARILY_UNAVAILABLE"
      ? "unavailable"
      : code === "INVITATION_EXPIRED"
        ? "expired"
        : code === "INVITATION_INVALID" || code === "INVITATION_REVOKED"
          ? "invalid"
          : code === "TABLE_NOT_FOUND" || code === "NOT_AUTHORIZED"
            ? "denied"
            : "other";
  emitOperationalEvent({
    kind: "invitation",
    operation,
    outcome: result.ok
      ? "accepted"
      : code === "TEMPORARILY_UNAVAILABLE"
        ? "unknown"
        : "rejected",
    failureCategory,
    durationMs: Date.now() - started,
  });
  return result;
}

/**
 * Reservations and table initialization are separate durable transactions.
 * Never treat a reserved ID or an ambiguous RPC outcome as created.
 * A retry with the original request_id reconstructs the same operation.
 */
export async function createTable(
  env: Env,
  actor: CreationActor,
  input: unknown,
): Promise<PublicTableResult> {
  const started = Date.now();
  if (!allowNewTables(env)) {
    return { ok: false, code: "ADMISSION_DISABLED" };
  }
  let parsed: ReturnType<typeof parseCreationRequest>;
  try {
    parsed = parseCreationRequest(input);
  } catch (error) {
    if (error instanceof InvalidCreationRequestError) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    return unavailable();
  }
  try {
    const guest = env.GUESTS.get(env.GUESTS.idFromName(actor.guestId));
    const reserved = await guest.reserveCreation(actor, input);
    if (!reserved.ok) return reserved;
    const receipt = reserved.reservation;
    if (receipt.expiresAt <= Date.now()) {
      return { ok: false, code: "TABLE_EXPIRED" };
    }
    const table = env.TABLES.get(env.TABLES.idFromName(receipt.tableId));
    // The TableDO checks the retained GuestDO receipt and current grant again.
    const result = await table.initializeTable(actor, input, receipt);
    if (!result.ok) return result;
    const metadata = result.value;
    const inbox = parseOwnInboxUri(metadata.ownInboxUri);
    const creator = metadata.memberships.find(
      (member) => member.membershipId === metadata.ownMembershipId,
    );
    if (
      metadata.tableId !== receipt.tableId ||
      metadata.createdAt !== new Date(receipt.createdAt).toISOString() ||
      metadata.expiresAt !== new Date(receipt.expiresAt).toISOString() ||
      !creator ||
      creator.seat !== 1 ||
      creator.role !== "creator" ||
      !inbox ||
      inbox.tableId !== receipt.tableId ||
      inbox.membershipId !== metadata.ownMembershipId
    ) {
      return unavailable();
    }
    // An outcome is only a receipt annotation, never the creation authority.
    // If this write fails, retry must recheck TableDO, not claim success.
    const recorded = await guest.recordCreationOutcome(
      actor,
      parsed.requestId,
      receipt.tableId,
      "initialized",
    );
    if (!recorded.ok) return unavailable();
    emitOperationalEvent({
      kind: "commit",
      operation: "create_table",
      outcome: "committed",
      durationMs: Date.now() - started,
    });
    return result;
  } catch {
    // A timed-out initializer might have committed. Preserve the reservation.
    return unavailable();
  }
}

/** Unknown/nonmember reads share the same TableDO authorization response. */
export async function getTable(
  env: Env,
  actor: VerifiedConnectionActor,
  tableId: string,
): Promise<PublicTableResult> {
  try {
    return await env.TABLES.get(env.TABLES.idFromName(tableId)).getMetadata(
      actor,
    );
  } catch {
    return unavailable();
  }
}

/** Invite issue results contain a short-lived secret; callers must not log them. */
export async function createInvite(
  env: Env,
  actor: VerifiedConnectionActor,
  tableId: string,
  requestId: string,
) {
  const started = Date.now();
  try {
    const result = await env.TABLES.get(
      env.TABLES.idFromName(tableId),
    ).issueInvite(actor, requestId);
    return observeInvitation("create_invite", result, started);
  } catch {
    return observeInvitation(
      "create_invite",
      { ok: false as const, code: "TEMPORARILY_UNAVAILABLE" },
      started,
    );
  }
}

export async function joinTable(
  env: Env,
  actor: VerifiedConnectionActor,
  invitation: string,
  requestId: string,
): Promise<PublicTableResult> {
  const started = Date.now();
  const { parseInvitation } = await import("../shared/invitations");
  const parsed = parseInvitation(invitation);
  if (!parsed) {
    return observeInvitation(
      "join_table",
      { ok: false as const, code: "INVITATION_INVALID" },
      started,
    );
  }
  try {
    const result = await env.TABLES.get(
      env.TABLES.idFromName(parsed.tableId),
    ).redeemInvite(actor, invitation, requestId);
    return observeInvitation("join_table", result, started);
  } catch {
    return observeInvitation(
      "join_table",
      { ok: false as const, code: "TEMPORARILY_UNAVAILABLE" },
      started,
    );
  }
}

/** Route only a validated table ID to the authoritative TableDO. */
export async function postMessage(
  env: Env,
  actor: VerifiedConnectionActor,
  id: string,
  input: PostMessageInput,
  onPeerUpdate?: (hint: TransientPeerUpdateHint) => void,
): Promise<TableResult<PostReceipt>> {
  try {
    const committed = await env.TABLES.get(
      env.TABLES.idFromName(id),
    ).postMessage(actor, input);
    if (!committed.ok) return committed;
    if (committed.peerUpdateHint && onPeerUpdate) {
      try {
        // The SQL commit is already complete. This is not durable delivery.
        onPeerUpdate(committed.peerUpdateHint);
      } catch {
        // A transient observer cannot change the persisted post receipt.
      }
    }
    // Never expose internal peer routing details through public MCP tools.
    return { ok: true, value: committed.value };
  } catch {
    return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
  }
}

export async function readMessages(
  env: Env,
  actor: VerifiedConnectionActor,
  id: string,
  input: ReadMessagesInput,
): Promise<TableResult<TranscriptPage>> {
  try {
    return await env.TABLES.get(env.TABLES.idFromName(id)).readMessages(
      actor,
      input,
    );
  } catch {
    return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
  }
}

/**
 * Close is a durable, peer-authorized state transition; transient observers
 * never change a committed result or authorize an external dispatch.
 */
export async function closeTable(
  env: Env,
  actor: VerifiedConnectionActor,
  id: string,
  requestId: string,
  onTerminal?: (hint: LifecycleInvalidation) => void,
): Promise<TableResult<CloseTableReceipt>> {
  const started = Date.now();
  try {
    const committed = await env.TABLES.get(
      env.TABLES.idFromName(id),
    ).closeTable(actor, requestId);
    if (!committed.ok) return committed;
    emitOperationalEvent({
      kind: "commit",
      operation: "close_table",
      outcome: "committed",
      durationMs: Date.now() - started,
    });
    if (committed.terminalHint && onTerminal) {
      try {
        onTerminal(committed.terminalHint);
      } catch {
        // Observer failures never reverse already committed terminal state.
      }
    }
    return { ok: true, value: committed.value };
  } catch {
    return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
  }
}

/** Agent requests only create a pending browser confirmation, never a purge. */
export async function requestTableDeletion(
  env: Env,
  actor: VerifiedConnectionActor,
  tableId: string,
  requestId: string,
): Promise<TableResult<DeletionReceipt>> {
  try {
    return await env.TABLES.get(env.TABLES.idFromName(tableId)).requestDeletion(
      actor,
      requestId,
    );
  } catch {
    return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
  }
}
