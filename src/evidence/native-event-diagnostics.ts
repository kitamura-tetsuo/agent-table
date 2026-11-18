import {
  activeNativeDiagnosticPolicy,
  NATIVE_DIAGNOSTIC_KEY,
  NATIVE_DIAGNOSTIC_RETENTION_MS,
  nativeDiagnosticBindingKey,
  nativeDiagnosticDigest,
  nativeDiagnosticPolicy,
} from "../shared/native-event-diagnostics";
import type {
  EventDiagnosticRecord,
  EventDiagnosticScope,
  EventDiagnosticSnapshot,
} from "./event-diagnostics";
import {
  eventDiagnosticContext,
  validEventDiagnosticRecord,
} from "./event-diagnostics";

type Ring = {
  digest: string;
  retentionUntil: number;
  records: EventDiagnosticRecord[];
  droppedCount: number;
};
function validRing(value: unknown): value is Ring {
  if (!value || typeof value !== "object") return false;
  const r = value as Ring;
  return (
    Object.keys(r).sort().join() ===
      ["digest", "retentionUntil", "records", "droppedCount"].sort().join() &&
    typeof r.digest === "string" &&
    /^[a-f0-9]{64}$/.test(r.digest) &&
    Number.isSafeInteger(r.retentionUntil) &&
    r.retentionUntil > 0 &&
    r.retentionUntil <= 8_640_000_000_000_000 &&
    Number.isSafeInteger(r.droppedCount) &&
    r.droppedCount >= 0 &&
    Array.isArray(r.records) &&
    r.records.length <= 64 &&
    r.records.every(validEventDiagnosticRecord)
  );
}
export async function writeNativeDiagnostics(
  getEnv: () => Env,
  storage: DurableObjectStorage,
  authorized: () => boolean,
  connectionId: string,
  records: EventDiagnosticRecord[],
  scope: EventDiagnosticScope,
): Promise<boolean> {
  const policy = activeNativeDiagnosticPolicy(getEnv());
  if (
    !policy ||
    !scope ||
    typeof scope !== "object" ||
    Array.isArray(scope) ||
    Object.keys(scope).sort().join() !==
      ["buildSha", "approvalRef", "policyDigest"].sort().join() ||
    scope.buildSha !== policy.buildSha ||
    scope.approvalRef !== policy.approvalRef ||
    policy.connectionId !== connectionId ||
    !authorized() ||
    !Array.isArray(records) ||
    !records.length ||
    records.length > 16 ||
    !records.every(
      (r) =>
        validEventDiagnosticRecord(r) &&
        (r.method === "events/list" || r.method === "events/subscribe") &&
        r.observedAt >= Date.parse(policy.notBefore) &&
        r.observedAt < Date.parse(policy.expiresAt),
    )
  )
    return false;
  const digest = scope.policyDigest;
  const bindingKey = nativeDiagnosticBindingKey(getEnv(), policy);
  if (digest !== (await nativeDiagnosticDigest(getEnv(), policy))) return false;
  const stillMatches = () =>
    authorized() &&
    nativeDiagnosticBindingKey(getEnv(), policy) === bindingKey &&
    JSON.stringify(activeNativeDiagnosticPolicy(getEnv())) ===
      JSON.stringify(policy);
  return storage.transaction(async (tx) => {
    if (!stillMatches()) return false;
    const stored = await tx.get<unknown>(NATIVE_DIAGNOSTIC_KEY);
    if (!stillMatches()) return false;
    const prior = validRing(stored) && stored.digest === digest ? stored : null;
    const all = [...(prior?.records ?? []), ...records].sort(
      (a, b) => a.observedAt - b.observedAt,
    );
    const alarm = await tx.getAlarm();
    if (!stillMatches()) return false;
    const retentionUntil =
      Date.parse(policy.expiresAt) + NATIVE_DIAGNOSTIC_RETENTION_MS;
    if (alarm === null || alarm > retentionUntil)
      await tx.setAlarm(retentionUntil);
    if (!stillMatches()) return false;
    await tx.put(NATIVE_DIAGNOSTIC_KEY, {
      digest,
      retentionUntil:
        Date.parse(policy.expiresAt) + NATIVE_DIAGNOSTIC_RETENTION_MS,
      records: all.slice(-64),
      droppedCount: Math.min(
        Number.MAX_SAFE_INTEGER,
        (prior?.droppedCount ?? 0) + Math.max(0, all.length - 64),
      ),
    } satisfies Ring);
    return true;
  });
}
export async function readNativeDiagnostics(
  getEnv: () => Env,
  storage: DurableObjectStorage,
  authorized: () => boolean,
  actor: { guestId: string; connectionId: string },
): Promise<EventDiagnosticSnapshot | null> {
  if (!authorized()) return null;
  const empty = (
    scopeMatches = false,
    retentionUntil: number | null = null,
  ): EventDiagnosticSnapshot => ({
    records: [],
    droppedCount: 0,
    scopeMatches,
    retentionUntil,
    context: eventDiagnosticContext(getEnv(), actor),
  });
  const p = nativeDiagnosticPolicy(getEnv());
  if (!p || p.connectionId !== actor.connectionId) return empty();
  const until = Date.parse(p.expiresAt) + NATIVE_DIAGNOSTIC_RETENTION_MS;
  if (Date.now() < Date.parse(p.notBefore) || Date.now() >= until)
    return empty();
  const bindingKey = nativeDiagnosticBindingKey(getEnv(), p);
  const digest = await nativeDiagnosticDigest(getEnv(), p);
  const stored = await storage.get<unknown>(NATIVE_DIAGNOSTIC_KEY);
  if (!authorized()) return null;
  const current = nativeDiagnosticPolicy(getEnv());
  if (
    !current ||
    bindingKey !== nativeDiagnosticBindingKey(getEnv(), current) ||
    !authorized() ||
    Date.now() >= until
  )
    return empty();
  if (stored === undefined) return empty(true, until);
  if (!validRing(stored)) return null;
  if (stored.digest !== digest || stored.retentionUntil !== until)
    return empty();
  return {
    ...empty(true, until),
    records: stored.records,
    droppedCount: stored.droppedCount,
  };
}

/** Called in the GuestDO alarm transaction after ordinary SQL pruning. */
export async function pruneNativeDiagnostics(
  tx: DurableObjectTransaction,
): Promise<number | null> {
  try {
    const stored = await tx.get<unknown>(NATIVE_DIAGNOSTIC_KEY);
    if (stored === undefined) return null;
    if (!validRing(stored) || Date.now() >= stored.retentionUntil) {
      await tx.delete(NATIVE_DIAGNOSTIC_KEY);
      return null;
    }
    return stored.retentionUntil;
  } catch {
    return Date.now() + 60_000;
  }
}
