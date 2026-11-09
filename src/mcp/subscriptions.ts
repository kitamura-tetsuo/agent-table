import { ownInboxUri, parseOwnInboxUri } from "../shared/resources";

export type CanonicalInboxFilter = {
  readonly uri: string;
  readonly tableId: string;
  readonly membershipId: string;
};

/**
 * Parse only the supported single-inbox profile. Parsing is NOT authority:
 * callers must independently verify current events:subscribe grant, table
 * membership, lifecycle and capacity in TableDO before acknowledging a stream.
 */
export function parseCanonicalInboxFilter(
  requested: unknown,
): CanonicalInboxFilter | null {
  if (
    requested === null ||
    typeof requested !== "object" ||
    Array.isArray(requested)
  ) {
    return null;
  }
  const keys = Object.keys(requested);
  if (keys.length !== 1 || keys[0] !== "resourceSubscriptions") {
    return null;
  }
  const subscriptions = (requested as { resourceSubscriptions?: unknown })
    .resourceSubscriptions;
  if (
    !Array.isArray(subscriptions) ||
    subscriptions.length !== 1 ||
    typeof subscriptions[0] !== "string"
  ) {
    return null;
  }
  const uri = subscriptions[0];
  const parsed = parseOwnInboxUri(uri);
  if (!parsed) return null;
  // The resource parser accepts case-insensitive UUIDs for read compatibility.
  // Live streams require a single byte-exact canonical URI, without aliases.
  const tableId = parsed.tableId.toLowerCase();
  const membershipId = parsed.membershipId.toLowerCase();
  if (ownInboxUri(tableId, membershipId) !== uri) return null;
  return { uri, tableId, membershipId };
}
