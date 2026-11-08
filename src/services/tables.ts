import type { VerifiedConnectionActor } from "../shared/auth";
import {
  InvalidCreationRequestError,
  parseCreationRequest,
} from "../shared/creation";
import { parseOwnInboxUri } from "../shared/resources";
import type { SafeTableMetadata } from "../shared/table";

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
    return await env.TABLES.get(env.TABLES.idFromName(tableId)).issueInvite(actor, requestId);
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
    return await env.TABLES.get(env.TABLES.idFromName(parsed.tableId))
      .redeemInvite(actor, invitation, requestId);
  } catch {
    return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
  }
}
