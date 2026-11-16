import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { handleMcp } from "../../src/mcp/server";
import { subscribeEvent } from "../../src/services/events";
import { inboxStreamFixture } from "../helpers/inbox-stream-fixture";
import {
  relayBindings,
  syntheticRelayKey,
} from "../helpers/production-relay-fixture";

const callback =
  "https://events.provider.example.org/callback/profile-isolation";
const secret = `whsec_${btoa("S".repeat(32))}`;
const native = (): Env => ({
  ...env,
  RELEASE_ENVIRONMENT: "staging",
  RELEASE_PROFILE: "test-native-events",
  RELEASE_BUILD_SHA: "a".repeat(40),
  RESTORE_QUARANTINE: "false",
  ENABLE_MCP_SUBSCRIPTIONS: "true",
  ENABLE_OPENAI_EVENTS: "true",
  ALLOW_OUTBOUND_NOTIFICATIONS: "true",
  TEST_NATIVE_EVENTS_RISK_ACCEPTANCE: "accept-unverified-dns-peer-boundary",
  EVENTS_REVIEWED_CALLBACK_TARGETS: JSON.stringify([
    { origin: "https://events.provider.example.org", pathPrefix: "/callback" },
  ]),
});
const params = (tableId: string) => ({
  name: "table.message.created",
  arguments: { table_id: tableId },
  delivery: { mode: "webhook", url: callback, secret },
  cursor: null,
});

type Participant = Awaited<ReturnType<typeof inboxStreamFixture>>["owner"];
async function mcp(
  overlay: Env,
  participant: Participant,
  method: string,
  input: Record<string, unknown> = {},
) {
  const request = new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      Host: new URL(env.PUBLIC_ORIGIN).host,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...input,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return handleMcp(request, overlay, createExecutionContext(), {
    guestId: participant.id,
    connectionId: participant.grant.connectionId,
    scopes: ["tables:read", "tables:write", "events:subscribe"],
    tokenExpiresAtMs: Date.now() + 60_000,
  });
}

afterEach(() => vi.restoreAllMocks());
it.each(["test-native-events", "production-relay-events"])(
  "%s admits independently authorized connections across two real tables without a pilot scope (controlled transport)",
  async (profile) => {
    const fixtures = [
      await inboxStreamFixture(env),
      await inboxStreamFixture(env),
    ];
    const overlay: Env =
      profile === "test-native-events"
        ? native()
        : {
            ...env,
            ...relayBindings(),
            EVENTS_RELAY_SIGNING_KEY_PKCS8: syntheticRelayKey,
          };
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const body = JSON.parse(
          new TextDecoder().decode(init?.body as ArrayBuffer),
        );
        if (profile === "test-native-events") {
          expect(String(url)).toBe(callback);
          expect(body.type).toBe("verification");
          return Response.json({ challenge: body.challenge });
        }
        expect(String(url)).toBe(
          "https://relay.example.org/relay/v1/challenge",
        );
        expect(body.destination).toBe(callback);
        expect(body.audience).toBe("production:agent-table");
        const payload = atob(body.payload);
        new Webhook(secret).verify(payload, body.headers);
        return Response.json({
          state: "completed",
          outcome: { kind: "challenge", verification: "verified" },
        });
      });
    for (const f of fixtures) {
      await evictDurableObject(f.table);
      await runInDurableObject(f.table, (instance) => {
        (instance as unknown as { env: Env }).env = overlay;
      });
      for (const participant of [f.owner, f.peer]) {
        const discovery = await mcp(overlay, participant, "server/discover");
        expect(discovery.status).toBe(200);
        expect(await discovery.json()).toMatchObject({
          result: { capabilities: { events: {} } },
        });
        const subscribed = await mcp(
          overlay,
          participant,
          "events/subscribe",
          params(f.tableId),
        );
        expect(subscribed.status).toBe(200);
        expect(await subscribed.json()).toMatchObject({
          result: { id: expect.any(String) },
        });
      }
      await evictDurableObject(f.table);
      const owners = await runInDurableObject(f.table, (_instance, state) =>
        state.storage.sql
          .exec<{ guest_id: string; connection_id: string; status: string }>(
            "SELECT guest_id, connection_id, status FROM table_event_subscriptions",
          )
          .toArray(),
      );
      expect(owners).toEqual(
        expect.arrayContaining(
          [f.owner, f.peer].map((p) => ({
            guest_id: p.id,
            connection_id: p.grant.connectionId,
            status: "active",
          })),
        ),
      );
      expect(owners).toHaveLength(2);
    }
    expect(network).toHaveBeenCalledTimes(4);
  },
);

it("mixed staging profiles refuse Worker, service and TableDO entry without external requests or durable candidates", async () => {
  const f = await inboxStreamFixture(env);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("unexpected external request"));
  for (const mutation of [
    { PRIVATE_PILOT_POLICY: "{}" },
    { EVENTS_RELAY_CONFIGURATION: relayBindings().EVENTS_RELAY_CONFIGURATION },
    { EVENTS_RELAY_SIGNING_KEY_PKCS8: syntheticRelayKey },
    { RELEASE_ENVIRONMENT: "production" },
    { RESTORE_QUARANTINE: "true" },
  ]) {
    const overlay = { ...native(), ...mutation };
    const response = await worker.fetch(
      new Request(`${env.PUBLIC_ORIGIN}/mcp`) as Parameters<
        typeof worker.fetch
      >[0],
      overlay,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    await evictDurableObject(f.table);
    await runInDurableObject(f.table, (instance) => {
      (instance as unknown as { env: Env }).env = overlay;
    });
    const subscribed = await subscribeEvent(
      overlay,
      f.owner.actor("events:subscribe"),
      params(f.tableId),
    );
    expect(subscribed.ok).toBe(false);
    const direct = await f.table.beginEventSubscription(
      f.owner.actor("events:subscribe"),
      params(f.tableId),
    );
    expect(direct.ok).toBe(false);
    const counts = await runInDurableObject(f.table, (_instance, state) => ({
      candidates: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) n FROM table_event_candidates")
        .one().n,
      subscriptions: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) n FROM table_event_subscriptions")
        .one().n,
    }));
    expect(counts).toEqual({ candidates: 0, subscriptions: 0 });
  }
  expect(network).not.toHaveBeenCalled();
});
