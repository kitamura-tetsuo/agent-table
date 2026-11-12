import { describe, expect, it, vi } from "vitest";
import { callbackTransportReadiness } from "../../src/notifications/egress";
import { subscribeEvent } from "../../src/services/events";
import type { VerifiedConnectionActor } from "../../src/shared/auth";
import {
  activePrivatePilotDiscoveryPolicy,
  activePrivatePilotPolicy,
  PRIVATE_PILOT_PROFILE,
  parsePrivatePilotPolicy,
  privatePilotConfiguration,
  privatePilotDiscoveryAllowed,
  privatePilotRecipientAllowed,
} from "../../src/shared/private-pilot";
import { isRestoreQuarantined } from "../../src/shared/release-quarantine";

const now = Date.parse("2026-11-12T00:01:00Z");
const policy = {
  schemaVersion: 1,
  mode: "a-only",
  buildSha: "a".repeat(40),
  approvedAt: "2026-11-12T00:00:00Z",
  notBefore: "2026-11-12T00:00:01Z",
  expiresAt: "2026-11-12T01:00:00Z",
  approvalRef: "synthetic-review-0001",
  recipientGuestId: "11111111-1111-4111-8111-111111111111",
  recipientConnectionId: "22222222-2222-4222-8222-222222222222",
  tableIds: ["33333333-3333-4333-8333-333333333333"],
  callbackTargets: [
    { origin: "https://events.provider.example.org", pathPrefix: "/callback" },
  ],
};
const bindings = () => ({
  RELEASE_ENVIRONMENT: "staging",
  RELEASE_PROFILE: PRIVATE_PILOT_PROFILE,
  RELEASE_BUILD_SHA: policy.buildSha,
  RESTORE_QUARANTINE: "false",
  ENABLE_MCP_SUBSCRIPTIONS: "false",
  ENABLE_OPENAI_EVENTS: "false",
  ALLOW_OUTBOUND_NOTIFICATIONS: "true",
  PRIVATE_PILOT_POLICY: JSON.stringify(policy),
});

describe("private callback discovery policy", () => {
  const discoveryPolicy = {
    ...policy,
    mode: "a-only-discovery",
    observationMode: "private-redacted",
    callbackTargets: [],
  };
  const discoveryBindings = () => ({
    ...bindings(),
    ALLOW_OUTBOUND_NOTIFICATIONS: "false",
    PRIVATE_PILOT_POLICY: JSON.stringify(discoveryPolicy),
  });
  const actor = {
    guestId: policy.recipientGuestId,
    connectionId: policy.recipientConnectionId,
  };

  it("advertises only the selected identity without authorizing delivery", () => {
    const env = discoveryBindings();
    expect(parsePrivatePilotPolicy(env.PRIVATE_PILOT_POLICY)).toEqual(
      discoveryPolicy,
    );
    expect(activePrivatePilotDiscoveryPolicy(env, now)).toEqual(
      discoveryPolicy,
    );
    expect(
      privatePilotDiscoveryAllowed(env, actor, policy.tableIds[0], now),
    ).toBe(true);
    expect(
      privatePilotDiscoveryAllowed(
        env,
        { ...actor, connectionId: "other-connection" },
        policy.tableIds[0],
        now,
      ),
    ).toBe(false);
    expect(
      privatePilotDiscoveryAllowed(
        env,
        { ...actor, guestId: "other-guest" },
        policy.tableIds[0],
        now,
      ),
    ).toBe(false);
    expect(privatePilotDiscoveryAllowed(env, actor, "other-table", now)).toBe(
      false,
    );
    expect(activePrivatePilotPolicy(env, now)).toBeNull();
    expect(
      privatePilotRecipientAllowed(env, actor, policy.tableIds[0], now),
    ).toBe(false);
    expect(isRestoreQuarantined(env)).toBe(false);
    expect(callbackTransportReadiness().enabled).toBe(false);
  });

  it("stops discovery at the window boundary while preserving ordinary access", () => {
    const env = discoveryBindings();
    for (const outside of [
      Date.parse(policy.notBefore) - 1,
      Date.parse(policy.expiresAt),
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(activePrivatePilotDiscoveryPolicy(env, outside)).toBeNull();
      expect(
        privatePilotDiscoveryAllowed(env, actor, policy.tableIds[0], outside),
      ).toBe(false);
    }
    expect(privatePilotConfiguration(env)).not.toBeNull();
    const stopped = { ...bindings(), ALLOW_OUTBOUND_NOTIFICATIONS: "false" };
    expect(activePrivatePilotDiscoveryPolicy(stopped, now)).toBeNull();
    expect(privatePilotDiscoveryAllowed(stopped, actor, undefined, now)).toBe(
      false,
    );
    expect(isRestoreQuarantined(stopped)).toBe(false);
  });

  it.each([
    { observationMode: undefined },
    { observationMode: "off" },
    { callbackTargets: policy.callbackTargets },
    { callbackTargets: null },
    { callbackTargets: {} },
    { unexpected: "unreviewed-field" },
  ])("rejects broadened or implicit discovery authority %#", (patch) => {
    expect(
      parsePrivatePilotPolicy(JSON.stringify({ ...discoveryPolicy, ...patch })),
    ).toBeNull();
  });

  it.each([
    { RELEASE_ENVIRONMENT: "production" },
    { RELEASE_ENVIRONMENT: "local" },
    { RELEASE_BUILD_SHA: "b".repeat(40) },
    { RELEASE_PROFILE: "manual" },
    { RESTORE_QUARANTINE: "true" },
    { ENABLE_MCP_SUBSCRIPTIONS: "true" },
    { ENABLE_OPENAI_EVENTS: "true" },
    { ALLOW_OUTBOUND_NOTIFICATIONS: "true" },
  ])("rejects a mismatched discovery configuration %#", (patch) => {
    const env = { ...discoveryBindings(), ...patch };
    expect(privatePilotConfiguration(env)).toBeNull();
    expect(activePrivatePilotDiscoveryPolicy(env, now)).toBeNull();
    expect(activePrivatePilotPolicy(env, now)).toBeNull();
    expect(privatePilotDiscoveryAllowed(env, actor, undefined, now)).toBe(
      false,
    );
  });
});

describe("private staging pilot policy", () => {
  it("allows only the exact A guest, connection and table without public readiness", () => {
    const env = bindings();
    const actor = {
      guestId: policy.recipientGuestId,
      connectionId: policy.recipientConnectionId,
    };
    expect(
      privatePilotRecipientAllowed(env, actor, policy.tableIds[0], now),
    ).toBe(true);
    expect(
      privatePilotRecipientAllowed(
        env,
        { ...actor, guestId: "other-guest" },
        policy.tableIds[0],
        now,
      ),
    ).toBe(false);
    expect(
      privatePilotRecipientAllowed(
        env,
        { ...actor, connectionId: "other-connection" },
        policy.tableIds[0],
        now,
      ),
    ).toBe(false);
    expect(privatePilotRecipientAllowed(env, actor, "other-table", now)).toBe(
      false,
    );
    expect(callbackTransportReadiness().enabled).toBe(false);
  });

  it("keeps expiry and the outbound kill switch distinct from restore quarantine", () => {
    const env = bindings();
    expect(
      activePrivatePilotPolicy(env, Date.parse(policy.notBefore) - 1),
    ).toBeNull();
    expect(
      activePrivatePilotPolicy(env, Date.parse(policy.expiresAt)),
    ).toBeNull();
    env.ALLOW_OUTBOUND_NOTIFICATIONS = "false";
    expect(activePrivatePilotPolicy(env, now)).toBeNull();
    expect(privatePilotConfiguration(env)).not.toBeNull();
    expect(isRestoreQuarantined(env)).toBe(false);
  });

  it("discards a reservation that expires before verification without starting outbound I/O", async () => {
    const actor: VerifiedConnectionActor = {
      kind: "verified-connection",
      guestId: policy.recipientGuestId,
      connectionId: policy.recipientConnectionId,
      scope: "events:subscribe",
      expiresAt: Date.parse(policy.expiresAt) + 60_000,
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const fetch = vi.spyOn(globalThis, "fetch");
    const discard = vi.fn(async () => ({ ok: true }));
    const begin = vi.fn(async () => {
      clock.mockReturnValue(Date.parse(policy.expiresAt));
      return {
        ok: true,
        value: { candidateId: "candidate", subscriptionId: "subscription" },
      };
    });
    const env = {
      ...bindings(),
      TABLES: {
        idFromName: (id: string) => id,
        get: () => ({
          beginEventSubscription: begin,
          discardEventCandidate: discard,
        }),
      },
    } as unknown as Env;
    try {
      expect(
        await subscribeEvent(env, actor, {
          name: "table.message.created",
          arguments: { table_id: policy.tableIds[0] },
          delivery: {
            mode: "webhook",
            url: "https://events.provider.example.org/callback/receiver",
            secret: `whsec_${btoa("A".repeat(32))}`,
          },
          cursor: null,
        }),
      ).toEqual({ ok: false, reason: "denied" });
      expect(begin).toHaveBeenCalledOnce();
      expect(discard).toHaveBeenCalledWith(actor, "candidate");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      fetch.mockRestore();
    }
  });

  it.each([
    ["production", { RELEASE_ENVIRONMENT: "production" }],
    ["restored state", { RESTORE_QUARANTINE: "true" }],
    ["wrong source", { RELEASE_BUILD_SHA: "b".repeat(40) }],
    ["public Events", { ENABLE_OPENAI_EVENTS: "true" }],
    ["public subscriptions", { ENABLE_MCP_SUBSCRIPTIONS: "true" }],
    ["missing policy", { PRIVATE_PILOT_POLICY: "" }],
  ])("refuses %s at both activation and hosted ingress", (_name, patch) => {
    const env = { ...bindings(), ...patch };
    expect(activePrivatePilotPolicy(env, now)).toBeNull();
    expect(isRestoreQuarantined(env)).toBe(true);
  });

  it.each([
    { expiresAt: "2026-11-12T03:00:00Z" },
    { approvedAt: "2026-11-12T00:00:02Z" },
    {
      approvedAt: "2026-02-30T00:00:00Z",
      notBefore: "2026-02-30T00:00:01Z",
      expiresAt: "2026-02-30T01:00:00Z",
    },
    { tableIds: [] },
    { tableIds: [...policy.tableIds, ...policy.tableIds] },
    {
      callbackTargets: [
        {
          origin: "http://events.provider.example.org",
          pathPrefix: "/callback",
        },
      ],
    },
    {
      callbackTargets: [
        { origin: "https://127.0.0.1", pathPrefix: "/callback" },
      ],
    },
    {
      callbackTargets: [
        {
          origin: "https://events.provider.example.org",
          pathPrefix: "/callback/../private",
        },
      ],
    },
    { unexpected: "no-extra-policy-fields" },
  ])("rejects an invalid or broadened policy %#", (patch) => {
    expect(
      parsePrivatePilotPolicy(JSON.stringify({ ...policy, ...patch })),
    ).toBeNull();
  });
});
