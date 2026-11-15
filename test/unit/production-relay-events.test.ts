import { describe, expect, it } from "vitest";
import { eventDiagnosticContext } from "../../src/evidence/event-diagnostics";
import {
  productionRelayConfiguration,
  productionRelayReadiness,
} from "../../src/shared/production-relay-events";
import { isRestoreQuarantined } from "../../src/shared/release-quarantine";

import { relayBindings } from "../helpers/production-relay-fixture";

const patch = (config: Record<string, unknown>) => {
  const env = relayBindings();
  env.EVENTS_RELAY_CONFIGURATION = JSON.stringify({
    ...JSON.parse(env.EVENTS_RELAY_CONFIGURATION),
    ...config,
  });
  return env;
};
describe("production relay candidate cannot bypass activation prerequisites", () => {
  it("parses only nonsecret shape but preserves quarantine and unavailable diagnostics", () => {
    const env = relayBindings();
    expect(productionRelayConfiguration(env)).not.toBeNull();
    expect(productionRelayReadiness(env)).toEqual({
      enabled: false,
      configured: true,
      reason: "relay-integration-incomplete",
    });
    expect(isRestoreQuarantined(env)).toBe(true);
    const context = eventDiagnosticContext(
      env,
      { guestId: "synthetic", connectionId: "synthetic" },
      "synthetic",
    );
    expect(context.profile).toBe("production-relay-events");
    expect(context.transportState).toBe("relay-integration-incomplete");
    expect(context.policyActive).toBe(false);
    expect(context.recipientMatched).toBe(false);
    expect(context.tableAllowed).toBe(false);
    expect(context.transportRisk).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("relay.example.org");
    expect(JSON.stringify(context)).not.toContain("synthetic_caller_123");
  });
  it("rejects every missing prerequisite and cross-environment/stale/unknown config", () => {
    for (const key of Object.keys(relayBindings())) {
      expect(
        productionRelayConfiguration({ ...relayBindings(), [key]: undefined }),
      ).toBeNull();
    }
    for (const change of [
      { environment: "test" },
      { audience: "test:agent-table" },
      { version: 2 },
      { buildSha: "b".repeat(40) },
      { origin: "https://127.0.0.1" },
      { origin: "https://relay.example.org/" },
      { origin: "https://user:pass@relay.example.org" },
      { origin: "http://relay.example.org" },
      { origin: "https://relay.example.org:8443" },
      { callerId: "short" },
      { signingKeyPkcs8: "SECRET_SENTINEL" },
      { operatorApproved: true },
    ])
      expect(productionRelayConfiguration(patch(change))).toBeNull();
    for (const encoded of ["null", "[]", "{}", "invalid", " ".repeat(2049)])
      expect(
        productionRelayConfiguration({
          ...relayBindings(),
          EVENTS_RELAY_CONFIGURATION: encoded,
        }),
      ).toBeNull();
    for (const RELEASE_ENVIRONMENT of ["staging", "local", undefined])
      expect(
        productionRelayConfiguration({
          ...relayBindings(),
          RELEASE_ENVIRONMENT,
        }),
      ).toBeNull();
  });
  it("never imports test risk or pilot authority and pause cannot enable transport", () => {
    for (const env of [
      {
        ...relayBindings(),
        TEST_NATIVE_EVENTS_RISK_ACCEPTANCE:
          "accept-unverified-dns-peer-boundary",
      },
      { ...relayBindings(), PRIVATE_PILOT_POLICY: "{}" },
      { ...relayBindings(), RESTORE_QUARANTINE: "true" },
    ])
      expect(productionRelayConfiguration(env)).toBeNull();
    const paused = {
      ...relayBindings(),
      ALLOW_OUTBOUND_NOTIFICATIONS: "false",
    };
    expect(productionRelayConfiguration(paused)).not.toBeNull();
    expect(productionRelayReadiness(paused).enabled).toBe(false);
    expect(isRestoreQuarantined(paused)).toBe(true);
  });
});
