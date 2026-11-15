import { describe, expect, it } from "vitest";
import { eventDiagnosticContext } from "../../src/evidence/event-diagnostics";
import { callbackTransportReadiness } from "../../src/notifications/egress";
import { isRestoreQuarantined } from "../../src/shared/release-quarantine";
import {
  TEST_NATIVE_EVENTS_PROFILE,
  TEST_NATIVE_EVENTS_RISK,
  testNativeEventsAllowed,
} from "../../src/shared/test-native-events";

const bindings = () => ({
  RELEASE_ENVIRONMENT: "staging",
  RELEASE_PROFILE: TEST_NATIVE_EVENTS_PROFILE,
  RELEASE_BUILD_SHA: "a".repeat(40),
  RESTORE_QUARANTINE: "false",
  ENABLE_MCP_SUBSCRIPTIONS: "true",
  ENABLE_OPENAI_EVENTS: "true",
  ALLOW_OUTBOUND_NOTIFICATIONS: "true",
  TEST_NATIVE_EVENTS_RISK_ACCEPTANCE: TEST_NATIVE_EVENTS_RISK,
  EVENTS_REVIEWED_CALLBACK_TARGETS: JSON.stringify([
    { origin: "https://events.provider.example.org", pathPrefix: "/callback" },
  ]),
});

describe("explicit staging native-transport exception", () => {
  it("opens only the fully configured test profile without claiming peer safety", () => {
    expect(testNativeEventsAllowed(bindings())).toBe(true);
    expect(isRestoreQuarantined(bindings())).toBe(false);
    expect(eventDiagnosticContext(bindings()).transportRisk).toBe(
      "native-dns-peer-boundary-unverified",
    );
    expect(
      eventDiagnosticContext({
        ...bindings(),
        RELEASE_ENVIRONMENT: "production",
      }).transportRisk,
    ).toBeUndefined();
    expect(callbackTransportReadiness()).toEqual({
      enabled: false,
      reason: "connection-boundary-unverified",
    });
  });
  it("never accepts production or unknown environments", () => {
    for (const RELEASE_ENVIRONMENT of [
      "production",
      "local",
      "test",
      "",
      undefined,
    ]) {
      const config = { ...bindings(), RELEASE_ENVIRONMENT };
      expect(testNativeEventsAllowed(config)).toBe(false);
      if (RELEASE_ENVIRONMENT !== "local")
        expect(isRestoreQuarantined(config)).toBe(true);
    }
  });
  it("fails closed on each missing or altered prerequisite", () => {
    for (const key of Object.keys(bindings())) {
      expect(testNativeEventsAllowed({ ...bindings(), [key]: undefined })).toBe(
        false,
      );
      expect(testNativeEventsAllowed({ ...bindings(), [key]: "invalid" })).toBe(
        false,
      );
    }
  });
  it("retains reviewed destination requirements rather than allowing arbitrary URLs", () => {
    for (const target of [
      "[]",
      "invalid",
      JSON.stringify([{ origin: "https://127.0.0.1", pathPrefix: "/" }]),
      JSON.stringify([
        { origin: "http://events.provider.example.org", pathPrefix: "/" },
      ]),
    ]) {
      expect(
        testNativeEventsAllowed({
          ...bindings(),
          EVENTS_REVIEWED_CALLBACK_TARGETS: target,
        }),
      ).toBe(false);
    }
  });
});
