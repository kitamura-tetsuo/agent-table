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
      reason: "relay-key-unavailable",
    });
    expect(isRestoreQuarantined(env)).toBe(true);
    const context = eventDiagnosticContext(
      env,
      { guestId: "synthetic", connectionId: "synthetic" },
      "synthetic",
    );
    expect(context.profile).toBe("production-relay-events");
    expect(context.transportState).toBe("relay-key-unavailable");
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

it("production private scope never becomes global readiness and rejects mismatched targets/key", async () => {
  const { privateRelayBindings } = await import(
    "../helpers/production-relay-fixture"
  );
  const { privatePilotDiscoveryAllowed } = await import(
    "../../src/shared/private-pilot"
  );
  const actor = {
    guestId: "11111111-1111-4111-8111-111111111111",
    connectionId: "22222222-2222-4222-8222-222222222222",
  };
  const table = "33333333-3333-4333-8333-333333333333";
  const value = privateRelayBindings({ ...actor, tableIds: [table] });
  expect(productionRelayConfiguration(value)).not.toBeNull();
  expect(productionRelayReadiness(value)).toMatchObject({
    enabled: false,
    configured: true,
  });
  expect(isRestoreQuarantined(value)).toBe(false);
  expect(privatePilotDiscoveryAllowed(value, actor, table)).toBe(true);
  expect(
    privatePilotDiscoveryAllowed(
      value,
      { ...actor, connectionId: crypto.randomUUID() },
      table,
    ),
  ).toBe(false);
  expect(privatePilotDiscoveryAllowed(value, actor, crypto.randomUUID())).toBe(
    false,
  );
  expect(
    isRestoreQuarantined({
      ...value,
      EVENTS_RELAY_SIGNING_KEY_PKCS8: "invalid",
    }),
  ).toBe(true);
  const unavailable = eventDiagnosticContext(
    { ...value, EVENTS_RELAY_SIGNING_KEY_PKCS8: "invalid" },
    actor,
    table,
  );
  expect(unavailable.policyActive).toBe(false);
  expect(unavailable.recipientMatched).toBe(false);
  expect(unavailable.tableAllowed).toBe(false);
  expect(
    productionRelayConfiguration({ ...value, ENABLE_OPENAI_EVENTS: "true" }),
  ).toBeNull();
  const malformedGlobal = {
    ...value,
    ENABLE_MCP_SUBSCRIPTIONS: "true",
    ENABLE_OPENAI_EVENTS: "true",
  };
  expect(productionRelayReadiness(malformedGlobal).enabled).toBe(false);
  expect(isRestoreQuarantined(malformedGlobal)).toBe(true);
  expect(
    productionRelayConfiguration({
      ...value,
      EVENTS_REVIEWED_CALLBACK_TARGETS: JSON.stringify([
        { origin: "https://other.example.org", pathPrefix: "/" },
      ]),
    }),
  ).toBeNull();
});

it("staging signed private relay binds test audience and refuses native fallback or production identity", async () => {
  const { privateRelayBindings } = await import(
    "../helpers/production-relay-fixture"
  );
  const { productionRelayProfileSelected } = await import(
    "../../src/shared/production-relay-events"
  );
  const { selectProductionRelayAdapters } = await import(
    "../../src/notifications/production-relay-adapters"
  );
  const actor = {
    guestId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
  };
  const tableId = crypto.randomUUID();
  const value = {
    ...privateRelayBindings({ ...actor, tableIds: [tableId] }),
    RELEASE_ENVIRONMENT: "staging",
  };
  const config = JSON.parse(value.EVENTS_RELAY_CONFIGURATION);
  config.environment = "staging";
  config.audience = "test:agent-table";
  value.EVENTS_RELAY_CONFIGURATION = JSON.stringify(config);
  expect(productionRelayProfileSelected(value)).toBe(true);
  expect(productionRelayConfiguration(value)?.environment).toBe("staging");
  expect(
    selectProductionRelayAdapters(value)?.outbox.configuration.audience,
  ).toBe("test:agent-table");
  expect(isRestoreQuarantined(value)).toBe(false);
  expect(productionRelayReadiness(value).enabled).toBe(false); // never global capability
  for (const change of [
    { environment: "production" },
    { audience: "production:agent-table" },
  ]) {
    const invalid = {
      ...value,
      EVENTS_RELAY_CONFIGURATION: JSON.stringify({ ...config, ...change }),
    };
    expect(productionRelayProfileSelected(invalid)).toBe(true);
    expect(selectProductionRelayAdapters(invalid)).toBeNull();
    expect(isRestoreQuarantined(invalid)).toBe(true);
    expect(eventDiagnosticContext(invalid, actor, tableId).policyActive).toBe(
      false,
    );
  }
  expect(
    selectProductionRelayAdapters({
      ...value,
      EVENTS_RELAY_SIGNING_KEY_PKCS8: "invalid",
    }),
  ).toBeNull();
  expect(
    isRestoreQuarantined({
      ...value,
      EVENTS_RELAY_SIGNING_KEY_PKCS8: "invalid",
    }),
  ).toBe(true);
  expect(
    productionRelayConfiguration({
      ...value,
      RELEASE_PROFILE: "production-relay-events",
    }),
  ).toBeNull();
});
