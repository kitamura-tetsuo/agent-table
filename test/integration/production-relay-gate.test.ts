import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { handleMcp } from "../../src/mcp/server";
import { inboxStreamFixture } from "../helpers/inbox-stream-fixture";
import {
  relayBindings,
  syntheticRelayKey,
} from "../helpers/production-relay-fixture";

afterEach(() => vi.restoreAllMocks());
it("real Worker and TableDO entry points remain quarantined across two tables despite complete candidate config", async () => {
  const fixtures = await Promise.all([
    inboxStreamFixture(env),
    inboxStreamFixture(env),
  ]);
  const overlay: Env = { ...env, ...relayBindings() };
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected external transport"));
  const response = await worker.fetch(
    new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    }) as Parameters<typeof worker.fetch>[0],
    overlay,
    createExecutionContext(),
  );
  expect(response.status).toBe(503);
  for (const f of fixtures) {
    await runInDurableObject(f.table, (instance) => {
      (instance as unknown as { env: Env }).env = overlay;
    });
    const result = await f.table.beginEventSubscription(
      f.owner.actor("events:subscribe"),
      {
        name: "table.message.created",
        arguments: { table_id: f.tableId },
        delivery: {
          mode: "webhook",
          url: "https://events.provider.example.org/callback/synthetic",
          secret: `whsec_${btoa("S".repeat(32))}`,
        },
        cursor: null,
      },
    );
    expect(result.ok).toBe(false);
    const counts = await runInDurableObject(f.table, (_instance, state) => ({
      candidates: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) n FROM table_event_candidates")
        .one().n,
      outbox: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) n FROM table_event_outbox")
        .one().n,
    }));
    expect(counts).toEqual({ candidates: 0, outbox: 0 });
  }
  expect(network).not.toHaveBeenCalled();
});

it.each(["production", "staging"])(
  "scoped %s relay advertises only its exact recipient and cannot activate without relay proof",
  async (environment) => {
    const [selected, other] = await Promise.all([
      inboxStreamFixture(env),
      inboxStreamFixture(env),
    ]);
    const now = Date.now();
    const overlay: Env = {
      ...env,
      ...relayBindings(),
      EVENTS_RELAY_SIGNING_KEY_PKCS8: syntheticRelayKey,
      RELEASE_PROFILE: "private-pilot-a-only",
      ENABLE_MCP_SUBSCRIPTIONS: "false",
      ENABLE_OPENAI_EVENTS: "false",
      PRIVATE_PILOT_POLICY: JSON.stringify({
        schemaVersion: 1,
        mode: "a-only",
        buildSha: "a".repeat(40),
        approvedAt: new Date(now - 2000).toISOString(),
        notBefore: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        approvalRef: "synthetic-pending-only",
        recipientGuestId: selected.owner.id,
        recipientConnectionId: selected.owner.grant.connectionId,
        tableIds: [selected.tableId],
        callbackTargets: [
          {
            origin: "https://events.provider.example.org",
            pathPrefix: "/callback",
          },
        ],
      }),
    };
    if (environment === "staging") {
      overlay.RELEASE_ENVIRONMENT = "staging";
      overlay.EVENTS_RELAY_CONFIGURATION = JSON.stringify({
        ...JSON.parse(overlay.EVENTS_RELAY_CONFIGURATION ?? "{}"),
        environment: "staging",
        audience: "test:agent-table",
      });
    }
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("no external request allowed"));
    // Independently authorized recipients include a peer in the selected table
    // and an owner in another table. None may be activated by a declaration.
    const secondGrant = await selected.owner.stub.createConnection(
      selected.owner.session.sessionId,
      selected.owner.session.secret,
      ["tables:read", "events:subscribe"],
      now + 60000,
    );
    if (!secondGrant) throw new Error("Missing independent second connection");
    const secondConnection = { ...selected.owner, grant: secondGrant };
    for (const participant of [
      selected.owner,
      selected.peer,
      other.owner,
      secondConnection,
    ]) {
      const response = await handleMcp(
        new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: new URL(env.PUBLIC_ORIGIN).host,
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "server/discover",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
        overlay,
        createExecutionContext(),
        {
          guestId: participant.id,
          connectionId: participant.grant.connectionId,
          scopes: ["tables:read", "tables:write", "events:subscribe"],
          tokenExpiresAtMs: now + 60000,
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const reply = (await response.json()) as {
        result?: { capabilities?: Record<string, unknown> };
      };
      expect(reply.result?.capabilities).toBeDefined();
      if (
        participant.id === selected.owner.id &&
        participant.grant.connectionId === selected.owner.grant.connectionId
      )
        expect(reply.result?.capabilities?.events).toEqual({});
      else expect(reply.result?.capabilities?.events).toBeUndefined();
    }
    const control = await handleMcp(
      new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Host: new URL(env.PUBLIC_ORIGIN).host,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
      {
        ...env,
        ...relayBindings(),
        EVENTS_RELAY_SIGNING_KEY_PKCS8: syntheticRelayKey,
      },
      createExecutionContext(),
      {
        guestId: other.owner.id,
        connectionId: other.owner.grant.connectionId,
        scopes: ["tables:read", "tables:write", "events:subscribe"],
        tokenExpiresAtMs: now + 60000,
      },
    );
    expect(control.status).toBe(200);
    const controlBody = (await control.json()) as {
      result?: { capabilities?: Record<string, unknown> };
    };
    expect(controlBody.result?.capabilities?.events).toEqual({});
    for (const f of [selected, other]) {
      await runInDurableObject(f.table, (instance) => {
        (instance as unknown as { env: Env }).env = overlay;
      });
      for (const participant of [f.owner, f.peer]) {
        const result = await f.table.beginEventSubscription(
          participant.actor("events:subscribe"),
          {
            name: "table.message.created",
            arguments: { table_id: f.tableId },
            delivery: {
              mode: "webhook",
              url: "https://events.provider.example.org/callback/synthetic",
              secret: `whsec_${btoa("S".repeat(32))}`,
            },
            cursor: null,
          },
        );
        if (f === selected && participant === selected.owner) {
          expect(result.ok).toBe(true);
          if (result.ok) {
            const activated = await f.table.commitVerifiedEventSubscription(
              participant.actor("events:subscribe"),
              result.value.candidateId,
            );
            expect(activated.ok).toBe(false);
          }
        } else expect(result.ok).toBe(false);
      }
      const counts = await runInDurableObject(
        f.table,
        async (instance, state) => {
          await instance.alarm();
          return {
            candidates: state.storage.sql
              .exec<{ n: number }>(
                "SELECT COUNT(*) n FROM table_event_candidates",
              )
              .one().n,
            outbox: state.storage.sql
              .exec<{ n: number }>("SELECT COUNT(*) n FROM table_event_outbox")
              .one().n,
          };
        },
      );
      expect(counts).toEqual({ candidates: f === selected ? 1 : 0, outbox: 0 });
      if (f === selected) {
        const second = await f.table.beginEventSubscription(
          {
            ...selected.owner.actor("events:subscribe"),
            connectionId: secondGrant.connectionId,
          },
          {
            name: "table.message.created",
            arguments: { table_id: f.tableId },
            delivery: {
              mode: "webhook",
              url: "https://events.provider.example.org/callback/synthetic",
              secret: `whsec_${btoa("S".repeat(32))}`,
            },
            cursor: null,
          },
        );
        expect(second.ok).toBe(false);
        const proof = await runInDurableObject(f.table, (_instance, state) => ({
          modes: state.storage.sql
            .exec<{ verification_mode: string }>(
              "SELECT verification_mode FROM table_event_candidates",
            )
            .toArray()
            .map((r) => r.verification_mode),
          active: state.storage.sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) n FROM table_event_subscriptions WHERE status='active'",
            )
            .one().n,
        }));
        expect(proof).toEqual({ modes: ["relay"], active: 0 });
      }
    }
    expect(network).not.toHaveBeenCalled();
  },
);
