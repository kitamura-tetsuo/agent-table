import {
  activePrivatePilotDiscoveryPolicy,
  activePrivatePilotPolicy,
  type PrivatePilotBindings,
  type PrivatePilotPolicy,
  parsePrivatePilotPolicy,
  privatePilotConfiguration,
  privatePilotRecipientMatches,
} from "../shared/private-pilot";

export const EVENT_DIAGNOSTIC_RECORD_LIMIT = 64;
export const EVENT_DIAGNOSTIC_BATCH_LIMIT = 16;
export const EVENT_DIAGNOSTIC_RETENTION_MS = 60 * 60_000;

const METHODS = [
  "initialize",
  "server/discover",
  "events/list",
  "events/subscribe",
  "events/unsubscribe",
  "other",
] as const;
const STAGES = [
  "request",
  "authentication",
  "capabilities",
  "handler",
  "parameters",
  "recipient",
  "table",
  "response",
] as const;
const OUTCOMES = [
  "received",
  "allowed",
  "denied",
  "enabled",
  "disabled",
  "valid",
  "invalid",
  "success",
  "operator_review_required",
  "conflict",
  "stale",
  "unavailable",
  "callback_destination_rejected",
  "callback_challenge_failed",
  "callback_transport_failed",
  "http_success",
  "http_client_error",
  "http_server_error",
  "exception",
] as const;
const DETAILS = [
  "none",
  "shape",
  "metadata",
  "event",
  "arguments",
  "delivery",
  "secret",
  "cursor",
  "ttl",
] as const;
const RECORD_KEYS = [
  "diagnosticId",
  "observedAt",
  "method",
  "stage",
  "outcome",
  "detail",
] as const;

export type EventDiagnosticRecord = {
  diagnosticId: string;
  observedAt: number;
  method: (typeof METHODS)[number];
  stage: (typeof STAGES)[number];
  outcome: (typeof OUTCOMES)[number];
  detail: (typeof DETAILS)[number];
};

export type EventDiagnosticScope = {
  buildSha: string;
  approvalRef: string;
  policyDigest: string;
};

/** Hash the normalized policy returned by the private-pilot parser. */
export async function eventDiagnosticPolicyDigest(
  policy: PrivatePilotPolicy,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(policy));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function member<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

/** Accept only fixed scalar projections; arbitrary fields are never retained. */
export function validEventDiagnosticRecord(
  value: unknown,
): value is EventDiagnosticRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === RECORD_KEYS.length &&
    RECORD_KEYS.every((key) => Object.hasOwn(row, key)) &&
    typeof row.diagnosticId === "string" &&
    /^[a-f0-9]{12}$/.test(row.diagnosticId) &&
    typeof row.observedAt === "number" &&
    Number.isSafeInteger(row.observedAt) &&
    row.observedAt > 0 &&
    row.observedAt <= 8_640_000_000_000_000 &&
    member(METHODS, row.method) &&
    member(STAGES, row.stage) &&
    member(OUTCOMES, row.outcome) &&
    member(DETAILS, row.detail)
  );
}

export type SafeEventRuntimeContext = {
  environment: "local" | "staging" | "production" | "unknown";
  profile:
    | "manual"
    | "live"
    | "events"
    | "autonomous"
    | "private-pilot-a-only"
    | "unknown";
  buildSha: string | null;
  policyConfigured: boolean;
  policyActive: boolean;
  recipientMatched: boolean;
  tableAllowed: boolean | null;
  mode: "a-only" | "a-only-discovery" | null;
  expiresAt: string | null;
};

export type EventDiagnosticSnapshot = {
  records: EventDiagnosticRecord[];
  droppedCount: number;
  retentionUntil: number | null;
  scopeMatches: boolean;
  context: SafeEventRuntimeContext;
};

/** Return classifications only, never raw bindings, recipients or targets. */
export function eventDiagnosticContext(
  env: PrivatePilotBindings,
  actor?: { guestId: string; connectionId: string },
  tableId?: string,
  now = Date.now(),
): SafeEventRuntimeContext {
  const policy = parsePrivatePilotPolicy(env.PRIVATE_PILOT_POLICY);
  const environment = member(
    ["local", "staging", "production"] as const,
    env.RELEASE_ENVIRONMENT,
  )
    ? env.RELEASE_ENVIRONMENT
    : "unknown";
  const profile = member(
    ["manual", "live", "events", "autonomous", "private-pilot-a-only"] as const,
    env.RELEASE_PROFILE,
  )
    ? env.RELEASE_PROFILE
    : "unknown";
  return {
    environment,
    profile,
    buildSha:
      typeof env.RELEASE_BUILD_SHA === "string" &&
      /^[a-f0-9]{40}$/.test(env.RELEASE_BUILD_SHA)
        ? env.RELEASE_BUILD_SHA
        : null,
    policyConfigured: privatePilotConfiguration(env) !== null,
    policyActive:
      activePrivatePilotDiscoveryPolicy(env, now) !== null ||
      activePrivatePilotPolicy(env, now) !== null,
    recipientMatched:
      !!policy && !!actor && privatePilotRecipientMatches(policy, actor),
    tableAllowed:
      tableId === undefined
        ? null
        : !!policy && policy.tableIds.includes(tableId),
    mode: policy?.mode ?? null,
    expiresAt: policy?.expiresAt ?? null,
  };
}
