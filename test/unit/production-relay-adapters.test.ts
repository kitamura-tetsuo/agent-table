import { describe, expect, it, vi } from "vitest";
import {
  prepareProductionRelayAdapters,
  selectProductionRelayAdapters,
} from "../../src/notifications/production-relay-adapters";
import { relayBindings } from "../helpers/production-relay-fixture";

// Public RFC8032 test vector; never an operational credential.
const key = Buffer.from(
  "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "hex",
).toString("base64");
const bindings = () => ({
  ...relayBindings(),
  EVENTS_RELAY_SIGNING_KEY_PKCS8: key,
});
const request = {
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(
    JSON.stringify({
      type: "verification",
      challenge: "123e4567-e89b-42d3-a456-426614174000",
    }),
  ),
};
const operation = () => ({
  requestId: "synthetic-operation-001",
  timestamp: Date.now(),
});
describe("production relay preparation is not operational authority", () => {
  it("requires canonical Ed25519 PKCS8 and exact production configuration", () => {
    for (const bad of [
      undefined,
      "",
      "not-key",
      key + "AAAA",
      Buffer.from("invalid").toString("base64"),
    ])
      expect(
        prepareProductionRelayAdapters({
          ...bindings(),
          EVENTS_RELAY_SIGNING_KEY_PKCS8: bad,
        }),
      ).toBeNull();
    expect(
      prepareProductionRelayAdapters({
        ...bindings(),
        RELEASE_ENVIRONMENT: "staging",
      }),
    ).toBeNull();
    const mismatched = bindings();
    mismatched.EVENTS_RELAY_CONFIGURATION = JSON.stringify({
      ...JSON.parse(mismatched.EVENTS_RELAY_CONFIGURATION),
      signingPublicKeySha256: "f".repeat(64),
    });
    expect(prepareProductionRelayAdapters(mismatched)).toBeNull();
    expect(selectProductionRelayAdapters(mismatched)).toBeNull();
    const value = prepareProductionRelayAdapters(bindings());
    expect(value?.signingPublicKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value?.verification.configuration).toBe(value?.outbox.configuration);
    expect(
      Object.isFrozen(value?.outbox.configuration.callbackTargets[0]),
    ).toBe(true);
    expect(selectProductionRelayAdapters(bindings())).not.toBeNull();
    expect(selectProductionRelayAdapters(relayBindings())).toBeNull();
  });
  it("unifies all three signed paths without trusting a caller replacement config", async () => {
    const prepared = prepareProductionRelayAdapters(bindings())!;
    const config = prepared.outbox.configuration;
    const replacement = { ...config, origin: "https://other.example.org" };
    const seen: string[] = [];
    const transport = vi.fn(async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ state: "unknown" }), {
        status: 200,
      });
    });
    await prepared.outbox.send(
      replacement,
      operation(),
      "https://events.provider.example.org/callback/test",
      request,
      async () => true,
      transport,
    );
    await prepared.verification.send(
      replacement,
      operation(),
      "https://events.provider.example.org/callback/test",
      request,
      async () => true,
      transport,
    );
    expect(
      await prepared.outbox.read(
        replacement,
        { ...operation(), operationDigest: "a".repeat(64) },
        async () => true,
        transport,
      ),
    ).toEqual({ ok: true, state: "unknown" });
    expect(seen).toEqual([
      "https://relay.example.org/relay/v1/message",
      "https://relay.example.org/relay/v1/challenge",
      "https://relay.example.org/relay/v1/status",
    ]);
  });
  it("rechecks binding and grant changes after async authorization, never sends on stale identity", async () => {
    for (const change of ["pause", "key", "origin", "grant"]) {
      const env = bindings(),
        prepared = prepareProductionRelayAdapters(env)!;
      const transport = vi.fn(async () => new Response("{}"));
      const current = async () => {
        if (change === "pause") env.ALLOW_OUTBOUND_NOTIFICATIONS = "false";
        if (change === "key") env.EVENTS_RELAY_SIGNING_KEY_PKCS8 = "replaced";
        if (change === "origin") env.EVENTS_RELAY_CONFIGURATION = "{}";
        return change !== "grant";
      };
      expect(
        (
          await prepared.outbox.send(
            prepared.outbox.configuration,
            operation(),
            "https://events.provider.example.org/callback/test",
            request,
            current,
            transport,
          )
        ).ok,
      ).toBe(false);
      expect(transport).not.toHaveBeenCalled();
    }
  });
});
