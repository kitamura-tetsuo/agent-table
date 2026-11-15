import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { inboxStreamFixture } from "../helpers/inbox-stream-fixture";
import { relayBindings } from "../helpers/production-relay-fixture";

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
