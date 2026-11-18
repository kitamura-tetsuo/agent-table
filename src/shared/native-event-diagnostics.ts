import {
  type TestNativeBindings,
  testNativeEventsAllowed,
  testNativeEventsInspectable,
} from "./test-native-events.ts";

export interface NativeDiagnosticBindings extends TestNativeBindings {
  TEST_NATIVE_EVENT_DIAGNOSTICS?: string;
}
export type NativeDiagnosticPolicy = {
  schemaVersion: 1;
  buildSha: string;
  approvalRef: string;
  connectionId: string;
  notBefore: string;
  expiresAt: string;
};
export const NATIVE_DIAGNOSTIC_KEY = "native-event-diagnostics:v1";
export const NATIVE_DIAGNOSTIC_RETENTION_MS = 15 * 60_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Exact opt-in, at most 15 minutes of collection and 15 minutes of readback. */
export function nativeDiagnosticPolicy(
  env: NativeDiagnosticBindings,
): NativeDiagnosticPolicy | null {
  if (!testNativeEventsInspectable(env)) return null;
  try {
    const p = JSON.parse(env.TEST_NATIVE_EVENT_DIAGNOSTICS ?? "");
    if (
      !p ||
      Object.keys(p).sort().join() !==
        [
          "schemaVersion",
          "buildSha",
          "approvalRef",
          "connectionId",
          "notBefore",
          "expiresAt",
        ]
          .sort()
          .join() ||
      p.schemaVersion !== 1 ||
      p.buildSha !== env.RELEASE_BUILD_SHA ||
      typeof p.connectionId !== "string" ||
      !UUID.test(p.connectionId) ||
      typeof p.approvalRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(p.approvalRef) ||
      ![p.notBefore, p.expiresAt].every(
        (t) =>
          typeof t === "string" &&
          Number.isFinite(Date.parse(t)) &&
          new Date(t).toISOString() === t,
      ) ||
      Date.parse(p.expiresAt) <= Date.parse(p.notBefore) ||
      Date.parse(p.expiresAt) - Date.parse(p.notBefore) > 15 * 60_000
    )
      return null;
    return p;
  } catch {
    return null;
  }
}
export function activeNativeDiagnosticPolicy(
  env: NativeDiagnosticBindings,
  now = Date.now(),
) {
  const p = nativeDiagnosticPolicy(env);
  return p &&
    testNativeEventsAllowed(env) &&
    now >= Date.parse(p.notBefore) &&
    now < Date.parse(p.expiresAt)
    ? p
    : null;
}
/** Bind the ring to all effective native release inputs, not just its window. */
export function nativeDiagnosticDigest(
  env: NativeDiagnosticBindings,
  policy: NativeDiagnosticPolicy,
) {
  return crypto.subtle
    .digest(
      "SHA-256",
      new TextEncoder().encode(nativeDiagnosticBindingKey(env, policy)),
    )
    .then((bytes) =>
      Array.from(new Uint8Array(bytes), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    );
}
export function nativeDiagnosticBindingKey(
  env: NativeDiagnosticBindings,
  policy: NativeDiagnosticPolicy,
) {
  return JSON.stringify({
    policy,
    environment: env.RELEASE_ENVIRONMENT,
    profile: env.RELEASE_PROFILE,
    build: env.RELEASE_BUILD_SHA,
    risk: env.TEST_NATIVE_EVENTS_RISK_ACCEPTANCE,
    targets: env.EVENTS_REVIEWED_CALLBACK_TARGETS,
  });
}
