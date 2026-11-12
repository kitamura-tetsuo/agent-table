import {
  authorizeGuestConnection,
  CONNECTION_SCOPES,
  type ConnectionScope,
  isConnectionScope,
} from "../shared/auth";
import { isRestoreQuarantined } from "../shared/release-quarantine";
import type { AuthenticatedMcpIdentity } from "./server";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OwnConnectionIdentity {
  guestId: string;
  connectionId: string;
  scopes: ConnectionScope[];
  /** Current request authority ends at the earlier token or grant deadline. */
  expiresAt: string;
  grantExpiresAt: string;
  tokenExpiresAt: string;
}

function futureDeadline(value: number | null, now: number): value is number {
  return (
    value !== null &&
    Number.isSafeInteger(value) &&
    value > now &&
    Number.isFinite(new Date(value).getTime())
  );
}

/**
 * Inspect only the OAuth-authenticated caller, never an identity supplied in
 * tool arguments. Scope observations authorize neither future calls nor table
 * membership; every operation still performs its own fresh authority check.
 */
export async function getOwnConnectionIdentity(
  env: Env,
  identity: AuthenticatedMcpIdentity,
): Promise<OwnConnectionIdentity | null> {
  if (
    isRestoreQuarantined(env) ||
    !UUID_V4.test(identity.guestId) ||
    !UUID_V4.test(identity.connectionId) ||
    !futureDeadline(identity.tokenExpiresAtMs, Date.now()) ||
    !Array.isArray(identity.scopes) ||
    identity.scopes.length === 0 ||
    identity.scopes.length > CONNECTION_SCOPES.length ||
    !identity.scopes.every(isConnectionScope) ||
    new Set(identity.scopes).size !== identity.scopes.length
  ) {
    return null;
  }

  const delegated = CONNECTION_SCOPES.filter((scope) =>
    identity.scopes.includes(scope),
  );
  const decisions = await Promise.all(
    delegated.map((scope) =>
      authorizeGuestConnection(
        env,
        identity.guestId,
        identity.connectionId,
        scope,
      ),
    ),
  );
  const now = Date.now();
  if (!futureDeadline(identity.tokenExpiresAtMs, now)) return null;

  const scopes: ConnectionScope[] = [];
  let grantDeadline: number | undefined;
  for (const [index, decision] of decisions.entries()) {
    if (!decision.allowed) {
      // Only scope narrowing may yield a smaller result. Missing, revoked,
      // expired, inconsistent or unavailable authority discloses no identity.
      if (decision.reason === "insufficient-scope") continue;
      return null;
    }
    const { actor } = decision;
    if (
      actor.kind !== "verified-connection" ||
      actor.guestId !== identity.guestId ||
      actor.connectionId !== identity.connectionId ||
      actor.scope !== delegated[index] ||
      !futureDeadline(actor.expiresAt, now) ||
      (grantDeadline !== undefined && grantDeadline !== actor.expiresAt)
    ) {
      return null;
    }
    grantDeadline = actor.expiresAt;
    scopes.push(actor.scope);
  }
  if (grantDeadline === undefined || scopes.length === 0) return null;

  return {
    guestId: identity.guestId,
    connectionId: identity.connectionId,
    scopes,
    expiresAt: new Date(
      Math.min(grantDeadline, identity.tokenExpiresAtMs),
    ).toISOString(),
    grantExpiresAt: new Date(grantDeadline).toISOString(),
    tokenExpiresAt: new Date(identity.tokenExpiresAtMs).toISOString(),
  };
}
