/** Single-use invitations are opaque application credentials, never URLs. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const OPERATION = /^[A-Za-z0-9_-]{16,128}$/;
const PREFIX = "at1";

export interface InvitationParts {
  tableId: string;
  inviteId: string;
  secret: string;
}

export function validInvitationOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION.test(value);
}

export function validTableId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function encodeInvitation(parts: InvitationParts): string {
  if (
    !validTableId(parts.tableId) ||
    !validTableId(parts.inviteId) ||
    !SECRET.test(parts.secret)
  ) {
    throw new Error("Invalid invitation parts");
  }
  return [
    PREFIX,
    parts.tableId.toLowerCase(),
    parts.inviteId.toLowerCase(),
    parts.secret,
  ].join(".");
}

/** A syntactically invalid invitation is never dereferenced as a URL. */
export function parseInvitation(value: unknown): InvitationParts | null {
  if (typeof value !== "string" || value.length > 160) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, tableId, inviteId, secret] = parts;
  if (
    !validTableId(tableId) ||
    !validTableId(inviteId) ||
    !SECRET.test(secret) ||
    tableId !== tableId.toLowerCase() ||
    inviteId !== inviteId.toLowerCase()
  ) {
    return null;
  }
  return { tableId, inviteId, secret };
}

/** A shareable landing-page URL keeps the secret after the fragment marker. */
export function invitationLandingUrl(
  origin: string,
  invitation: string,
): string {
  if (!parseInvitation(invitation)) throw new Error("Invalid invitation");
  const url = new URL("/join", origin);
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new Error("Invalid landing-page origin");
  }
  url.hash = invitation;
  return url.toString();
}
