/** Connection grants are a separate authority from table membership. */
export const CONNECTION_SCOPES = [
  "tables:read",
  "tables:write",
  "tables:delete",
  "events:subscribe",
] as const;

export type ConnectionScope = (typeof CONNECTION_SCOPES)[number];

export const OPERATION_SCOPE = {
  "table-metadata": "tables:read",
  "transcript-read": "tables:read",
  "own-inbox-read": "tables:read",
  "table-create": "tables:write",
  "table-invite": "tables:write",
  "table-join": "tables:write",
  "message-post": "tables:write",
  "table-close": "tables:write",
  "delete-request": "tables:delete",
  "delete-result": "tables:delete",
  "notification-subscribe": "events:subscribe",
  "notification-refresh": "events:subscribe",
  "notification-unsubscribe": "events:subscribe",
} as const satisfies Record<string, ConnectionScope>;

export type ProtectedOperation = keyof typeof OPERATION_SCOPE;

export function isConnectionScope(value: unknown): value is ConnectionScope {
  return (
    typeof value === "string" &&
    (CONNECTION_SCOPES as readonly string[]).includes(value)
  );
}

export type ConnectionDenialReason =
  | "invalid"
  | "missing"
  | "mismatched"
  | "expired"
  | "revoked"
  | "insufficient-scope"
  | "unavailable";

/**
 * A successful check is evidence from GuestDO, not an assertion from JSON or
 * OAuth token claims. Future consumers must obtain it for every new operation.
 */
export type VerifiedConnectionActor = {
  readonly kind: "verified-connection";
  readonly guestId: string;
  readonly connectionId: string;
  readonly scope: ConnectionScope;
  readonly expiresAt: number;
};

export type ConnectionDecision =
  | { allowed: true; actor: VerifiedConnectionActor }
  | { allowed: false; reason: ConnectionDenialReason };

/** Do not cache positive decisions across requests or delivery attempts. */
export async function authorizeGuestConnection(
  bindings: Pick<Env, "GUESTS">,
  guestId: string,
  connectionId: string,
  scope: ConnectionScope,
): Promise<ConnectionDecision> {
  if (
    typeof guestId !== "string" ||
    typeof connectionId !== "string" ||
    !isConnectionScope(scope)
  ) {
    return { allowed: false, reason: "invalid" };
  }
  try {
    const stub = bindings.GUESTS.get(bindings.GUESTS.idFromName(guestId));
    return await stub.authorizeConnection(guestId, connectionId, scope);
  } catch {
    // Object/binding/storage failures are denials, never permission.
    return { allowed: false, reason: "unavailable" };
  }
}
