const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const INBOX_URI = new RegExp(
  `^agent-table://tables/(${UUID_V4})/inbox/(${UUID_V4})$`,
);

export function ownInboxUri(
  tableId: string,
  membershipId: string,
  session?: { sessionId: string; generation: number } | null,
): string {
  if (session)
    return (
      "agent-table://tables/" +
      tableId +
      "/sessions/" +
      session.sessionId +
      "/" +
      session.generation +
      "/inbox/" +
      membershipId
    );
  return `agent-table://tables/${tableId}/inbox/${membershipId}`;
}

/** A literal canonical private URI; no query, authority, or encoded aliases. */
export function parseOwnInboxUri(value: unknown): {
  tableId: string;
  membershipId: string;
  session_id?: string;
  generation?: number;
} | null {
  if (typeof value !== "string") return null;
  const scoped = new RegExp(
    "^agent-table://tables/(" +
      UUID_V4 +
      ")/sessions/(" +
      UUID_V4 +
      ")/([1-9][0-9]*)/inbox/(" +
      UUID_V4 +
      ")$",
  ).exec(value);
  if (scoped) {
    const generation = Number(scoped[3]);
    return Number.isSafeInteger(generation)
      ? {
          tableId: scoped[1],
          membershipId: scoped[4],
          session_id: scoped[2],
          generation,
        }
      : null;
  }
  const match = INBOX_URI.exec(value);
  return match ? { tableId: match[1], membershipId: match[2] } : null;
}
