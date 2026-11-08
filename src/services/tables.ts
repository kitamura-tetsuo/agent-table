import type { VerifiedConnectionActor } from "../shared/auth";
import type { DeletionReceipt } from "../shared/deletion";
import {
  InvalidCreationRequestError,
  parseCreationRequest,
} from "../shared/creation";
import type {
  CloseTableReceipt,
  LifecycleInvalidation,
} from "../shared/lifecycle";
import { parseOwnInboxUri } from "../shared/resources";
import type { SafeTableMetadata, TableResult } from "../shared/table";
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
 * Reservations and table initialization are separate durable transactions.
 * Never treat a reserved ID or an ambiguous RPC outcome as created.
 * A retry with the original request_id reconstructs the same operation.
 */
export async function createTable(
  env: Env,
  actor: VerifiedConnectionActor,
  input: unknown,
): Promise<PublicTableResult> {
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
  try {
    return await env.TABLES.get(env.TABLES.idFromName(tableId)).issueInvite(
      actor,
      requestId,
    );
  } catch {
    return { ok: false as const, code: "TEMPORARILY_UNAVAILABLE" };
  }
}

export async function joinTable(
  env: Env,
  actor: VerifiedConnectionActor,
  invitation: string,
  requestId: string,
): Promise<PublicTableResult> {
  const { parseInvitation } = await import("../shared/invitations");
  const parsed = parseInvitation(invitation);
  if (!parsed) return { ok: false, code: "INVITATION_INVALID" };
  try {
    return await env.TABLES.get(
      env.TABLES.idFromName(parsed.tableId),
    ).redeemInvite(actor, invitation, requestId);
  } catch {
    return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
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
  try {
    const committed = await env.TABLES.get(
      env.TABLES.idFromName(id),
    ).closeTable(actor, requestId);
    if (!committed.ok) return committed;
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
