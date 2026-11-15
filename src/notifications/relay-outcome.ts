/** Status-only metadata. Unknown delay MUST NOT imply normal default backoff. */
export type RelayHttpOutcome = {
  kind: "http";
  status: number;
} & (
  | { retryAfterState: "unknown" | "absent" }
  | {
      retryAfterState: "known";
      retryAfterSeconds: number;
      retryAfterObservedAt: number;
    }
);

export function parseRelayHttpOutcome(
  value: unknown,
  allowLegacy = false,
): RelayHttpOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    v.kind !== "http" ||
    typeof v.status !== "number" ||
    !Number.isInteger(v.status) ||
    v.status < 100 ||
    v.status > 599
  )
    return null;
  const keys = Object.keys(v).sort().join(",");
  if (allowLegacy && keys === "kind,status")
    return { kind: "http", status: v.status, retryAfterState: "unknown" };
  if (
    (v.retryAfterState === "unknown" || v.retryAfterState === "absent") &&
    keys === "kind,retryAfterState,status"
  )
    return {
      kind: "http",
      status: v.status,
      retryAfterState: v.retryAfterState,
    };
  if (
    v.retryAfterState === "known" &&
    keys ===
      "kind,retryAfterObservedAt,retryAfterSeconds,retryAfterState,status" &&
    typeof v.retryAfterSeconds === "number" &&
    Number.isInteger(v.retryAfterSeconds) &&
    v.retryAfterSeconds >= 0 &&
    v.retryAfterSeconds <= 900 &&
    typeof v.retryAfterObservedAt === "number" &&
    Number.isSafeInteger(v.retryAfterObservedAt) &&
    v.retryAfterObservedAt > 0 &&
    v.retryAfterObservedAt <= Number.MAX_SAFE_INTEGER - 900000
  )
    return {
      kind: "http",
      status: v.status,
      retryAfterState: "known",
      retryAfterSeconds: v.retryAfterSeconds,
      retryAfterObservedAt: v.retryAfterObservedAt,
    };
  return null;
}

export type RelayChallengeOutcome = {
  kind: "challenge";
  verification: "verified" | "failed";
};
export function parseRelayChallengeOutcome(
  value: unknown,
): RelayChallengeOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "kind,verification" ||
    v.kind !== "challenge" ||
    (v.verification !== "verified" && v.verification !== "failed")
  )
    return null;
  return { kind: "challenge", verification: v.verification };
}
