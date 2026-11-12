import {
  type ReviewedCallbackTarget,
  reviewedCallbackTargets,
} from "../notifications/egress.ts";

export const PRIVATE_PILOT_PROFILE = "private-pilot-a-only";
export const PRIVATE_PILOT_MAX_WINDOW_MS = 2 * 60 * 60_000;
export const PRIVATE_PILOT_MAX_MESSAGE_SEQ = 12;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** Nonsecret policy delivered only through the protected staging release. */
export interface PrivatePilotPolicy {
  schemaVersion: 1;
  mode: "a-only";
  buildSha: string;
  approvedAt: string;
  notBefore: string;
  expiresAt: string;
  approvalRef: string;
  recipientGuestId: string;
  recipientConnectionId: string;
  tableIds: string[];
  callbackTargets: readonly ReviewedCallbackTarget[];
}

/** Independent of Cloudflare globals so the release scripts use the same parser. */
export interface PrivatePilotBindings {
  RELEASE_ENVIRONMENT?: string;
  RELEASE_PROFILE?: string;
  RELEASE_BUILD_SHA?: string;
  RESTORE_QUARANTINE?: string;
  ENABLE_MCP_SUBSCRIPTIONS?: string;
  ENABLE_OPENAI_EVENTS?: string;
  ALLOW_OUTBOUND_NOTIFICATIONS?: string;
  PRIVATE_PILOT_POLICY?: string;
}

function instant(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return Number.NaN;
  const parsed = Date.parse(value);
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical
    ? parsed
    : Number.NaN;
}

/** Strict syntax and scope only; a JSON approval reference is not authorization. */
export function parsePrivatePilotPolicy(
  encoded: unknown,
): PrivatePilotPolicy | null {
  if (typeof encoded !== "string" || encoded.length > 12_288) return null;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "mode",
    "buildSha",
    "approvedAt",
    "notBefore",
    "expiresAt",
    "approvalRef",
    "recipientGuestId",
    "recipientConnectionId",
    "tableIds",
    "callbackTargets",
  ];
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key)) ||
    row.schemaVersion !== 1 ||
    row.mode !== "a-only" ||
    typeof row.buildSha !== "string" ||
    !SHA.test(row.buildSha) ||
    typeof row.approvalRef !== "string" ||
    !REFERENCE.test(row.approvalRef) ||
    typeof row.recipientGuestId !== "string" ||
    !UUID.test(row.recipientGuestId) ||
    typeof row.recipientConnectionId !== "string" ||
    !UUID.test(row.recipientConnectionId) ||
    !Array.isArray(row.tableIds) ||
    row.tableIds.length < 1 ||
    row.tableIds.length > 3 ||
    !row.tableIds.every((id) => typeof id === "string" && UUID.test(id)) ||
    new Set(row.tableIds).size !== row.tableIds.length
  )
    return null;
  const approved = instant(row.approvedAt);
  const start = instant(row.notBefore);
  const end = instant(row.expiresAt);
  if (
    !(
      approved <= start &&
      start < end &&
      end - start <= PRIVATE_PILOT_MAX_WINDOW_MS
    )
  )
    return null;
  const callbackTargets = reviewedCallbackTargets(
    JSON.stringify(row.callbackTargets),
  );
  if (!callbackTargets.length) return null;
  return {
    schemaVersion: 1,
    mode: "a-only",
    buildSha: row.buildSha,
    approvedAt: row.approvedAt as string,
    notBefore: row.notBefore as string,
    expiresAt: row.expiresAt as string,
    approvalRef: row.approvalRef,
    recipientGuestId: row.recipientGuestId,
    recipientConnectionId: row.recipientConnectionId,
    tableIds: row.tableIds as string[],
    callbackTargets,
  };
}

/** Expiry/kill pauses effects without disabling authorized reads or closure. */
export function privatePilotConfiguration(
  env: PrivatePilotBindings,
): PrivatePilotPolicy | null {
  if (
    env.RELEASE_ENVIRONMENT !== "staging" ||
    env.RELEASE_PROFILE !== PRIVATE_PILOT_PROFILE ||
    env.RESTORE_QUARANTINE !== "false" ||
    env.ENABLE_MCP_SUBSCRIPTIONS !== "false" ||
    env.ENABLE_OPENAI_EVENTS !== "false" ||
    !["true", "false"].includes(env.ALLOW_OUTBOUND_NOTIFICATIONS ?? "")
  )
    return null;
  const policy = parsePrivatePilotPolicy(env.PRIVATE_PILOT_POLICY);
  return policy && policy.buildSha === env.RELEASE_BUILD_SHA ? policy : null;
}

export function activePrivatePilotPolicy(
  env: PrivatePilotBindings,
  now = Date.now(),
): PrivatePilotPolicy | null {
  const policy = privatePilotConfiguration(env);
  return policy &&
    env.ALLOW_OUTBOUND_NOTIFICATIONS === "true" &&
    Number.isFinite(now) &&
    Date.parse(policy.notBefore) <= now &&
    now < Date.parse(policy.expiresAt)
    ? policy
    : null;
}

export function privatePilotRecipientMatches(
  policy: PrivatePilotPolicy,
  actor: { guestId: string; connectionId: string },
  tableId?: string,
): boolean {
  return (
    policy.recipientGuestId === actor.guestId &&
    policy.recipientConnectionId === actor.connectionId &&
    (tableId === undefined || policy.tableIds.includes(tableId))
  );
}

export function privatePilotRecipientAllowed(
  env: PrivatePilotBindings,
  actor: { guestId: string; connectionId: string },
  tableId?: string,
  now = Date.now(),
): boolean {
  const policy = activePrivatePilotPolicy(env, now);
  return !!policy && privatePilotRecipientMatches(policy, actor, tableId);
}
