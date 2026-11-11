const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const INBOX_URI = new RegExp(
  `^agent-table://tables/(${UUID_V4})/inbox/(${UUID_V4})$`,
);

export function ownInboxUri(tableId: string, membershipId: string): string {
  return `agent-table://tables/${tableId}/inbox/${membershipId}`;
}

/** A literal canonical private URI; no query, authority, or encoded aliases. */
export function parseOwnInboxUri(
  value: unknown,
): { tableId: string; membershipId: string } | null {
  if (typeof value !== "string") return null;
  const match = INBOX_URI.exec(value);
  return match ? { tableId: match[1], membershipId: match[2] } : null;
}
