import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcp } from "../../src/mcp/server";
import type { VerifiedConnectionActor } from "../../src/shared/auth";
import { inboxStreamFixture } from "../helpers/inbox-stream-fixture";

const CALLBACK_ORIGIN = "https://events.provider.example.org";
const CALLBACK = `${CALLBACK_ORIGIN}/CALLBACK_PATH_SENTINEL?secret=CALLBACK_QUERY_SENTINEL`;
const SECRET = `whsec_${btoa("S".repeat(32))}`;
const SCHEMA = "agent-table.private-pilot.v1";

function parameters(tableId: string, url = CALLBACK) {
  return {
    name: "table.message.created",
    arguments: { table_id: tableId },
    delivery: { mode: "webhook", url, secret: SECRET },
    cursor: null,
    _meta: { private: "PROTOCOL_METADATA_SENTINEL" },
  };
}

async function fixture(configureInitially = true) {
  const f = await inboxStreamFixture(env);
  const now = Date.now();
  const policy = {
    schemaVersion: 1,
    mode: "a-only-discovery",
    observationMode: "private-redacted",
    buildSha: "a".repeat(40),
    approvedAt: new Date(now - 2_000).toISOString(),
    notBefore: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    approvalRef: "synthetic-discovery-review",
    recipientGuestId: f.owner.id,
    recipientConnectionId: f.owner.grant.connectionId,
    tableIds: [f.tableId],
    callbackTargets: [],
  };
  const overlay: Env = {
    ...env,
    RELEASE_ENVIRONMENT: "staging",
    RELEASE_PROFILE: "private-pilot-a-only",
    RELEASE_BUILD_SHA: policy.buildSha,
    RESTORE_QUARANTINE: "false",
    ENABLE_MCP_SUBSCRIPTIONS: "false",
    ENABLE_OPENAI_EVENTS: "false",
    ALLOW_OUTBOUND_NOTIFICATIONS: "false",
    PRIVATE_PILOT_POLICY: JSON.stringify(policy),
  };
  const configure = async (patch: Partial<Env> = {}, reconstruct = false) => {
    if (reconstruct) await evictDurableObject(f.table);
    await runInDurableObject(f.table, (instance) => {
      const harness = instance as unknown as { env: Env };
      harness.env = { ...harness.env, ...overlay, ...patch };
    });
  };
  if (configureInitially) await configure();
  const rows = () =>
    runInDurableObject(f.table, (_instance, state) => ({
      candidates: state.storage.sql
        .exec("SELECT * FROM table_event_candidates")
        .toArray(),
      subscriptions: state.storage.sql
        .exec("SELECT * FROM table_event_subscriptions")
        .toArray(),
      outbox: state.storage.sql
        .exec("SELECT * FROM table_event_outbox")
        .toArray(),
    }));
  return {
    ...f,
    actor: f.owner.actor("events:subscribe"),
    policy,
    overlay,
    configure,
    rows,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function capture() {
  const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Discovery must never initiate an outbound request");
  });
  const records = () =>
    logs.mock.calls.flatMap(([value]) => {
      try {
        const parsed = JSON.parse(String(value));
        return parsed.schema === SCHEMA ? [parsed] : [];
      } catch {
        return [];
      }
    });
  return { logs, network, records };
}

async function wire(
  f: Fixture,
  actor: VerifiedConnectionActor,
  method: string,
  params: Record<string, unknown> = {},
) {
  // This exercises the real MCP HTTP handler and fresh GuestDO authority.
  // The fixture identity stands in for already-validated OAuth middleware;
  // separate OAuth/MCP integration tests exercise that outer token boundary.
  const response = await handleMcp(
    new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
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
        id: crypto.randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
    f.overlay,
    createExecutionContext(),
    {
      guestId: actor.guestId,
      connectionId: actor.connectionId,
      scopes: ["tables:read", "tables:write", "events:subscribe"],
      tokenExpiresAtMs: Date.now() + 60_000,
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{
    result?: {
      capabilities?: Record<string, unknown>;
      events?: Array<{ name: string }>;
    };
    error?: { code: number; message: string; data?: { reason: string } };
  }>;
}

afterEach(() => vi.restoreAllMocks());

describe("private staging callback discovery without delivery", () => {
  it("records only the scoped callback origin and persists no subscription work", async () => {
    const f = await fixture();
    const c = capture();
    const before = Date.now();
    expect(
      await f.table.observeEventCallback(f.actor, parameters(f.tableId)),
    ).toEqual({
      ok: true,
      value: {},
    });
    expect(c.records()).toEqual([
      {
        schema: SCHEMA,
        kind: "callback-origin",
        buildSha: f.policy.buildSha,
        approvalRef: f.policy.approvalRef,
        tableId: f.tableId,
        membershipId: f.created.value.ownMembershipId,
        observedAt: expect.any(Number),
        callbackOrigin: CALLBACK_ORIGIN,
      },
    ]);
    expect(c.records()[0].observedAt).toBeGreaterThanOrEqual(before);
    expect(c.records()[0].observedAt).toBeLessThanOrEqual(Date.now());
    for (const forbidden of [
      CALLBACK,
      "CALLBACK_PATH_SENTINEL",
      "CALLBACK_QUERY_SENTINEL",
      "PROTOCOL_METADATA_SENTINEL",
      SECRET,
      f.owner.id,
      f.owner.grant.connectionId,
      f.owner.session.secret,
      "Internal hints",
    ]) {
      expect(JSON.stringify(c.logs.mock.calls)).not.toContain(forbidden);
    }
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
    expect(c.network).not.toHaveBeenCalled();
  });

  it("advertises Events only to A and returns a review error without subscribing", async () => {
    const f = await fixture();
    const c = capture();
    const a = await wire(f, f.actor, "server/discover");
    const b = await wire(
      f,
      f.peer.actor("events:subscribe"),
      "server/discover",
    );
    expect(a.result?.capabilities?.events).toEqual({});
    expect(b.result?.capabilities?.events).toBeUndefined();
    expect(
      (await wire(f, f.actor, "events/list")).result?.events,
    ).toMatchObject([{ name: "table.message.created" }]);
    expect(
      (await wire(f, f.peer.actor("events:subscribe"), "events/list")).error,
    ).toMatchObject({ code: -32001 });
    const subscription = await wire(
      f,
      f.actor,
      "events/subscribe",
      parameters(f.tableId),
    );
    expect(subscription.result).toBeUndefined();
    expect(subscription.error).toMatchObject({
      code: -32015,
      data: { reason: "operator_review_required" },
    });
    expect(c.records()).toHaveLength(1);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
    expect(c.network).not.toHaveBeenCalled();
  });

  it("refuses foreign scope, connection and table arguments before logging", async () => {
    const f = await fixture();
    const c = capture();
    for (const actor of [
      f.peer.actor("events:subscribe"),
      f.owner.actor("tables:read"),
      { ...f.actor, connectionId: crypto.randomUUID() },
    ]) {
      expect(
        await f.table.observeEventCallback(actor, parameters(f.tableId)),
      ).toEqual({
        ok: false,
        code: "TABLE_NOT_FOUND",
      });
    }
    expect(
      await f.table.observeEventCallback(
        f.actor,
        parameters(crypto.randomUUID()),
      ),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    expect(c.records()).toEqual([]);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
    expect(c.network).not.toHaveBeenCalled();
  });

  it("requires actual membership even when the policy names the actor and table", async () => {
    const f = await fixture();
    const outsider = await inboxStreamFixture(env);
    await f.configure({
      PRIVATE_PILOT_POLICY: JSON.stringify({
        ...f.policy,
        recipientGuestId: outsider.owner.id,
        recipientConnectionId: outsider.owner.grant.connectionId,
      }),
    });
    const c = capture();
    expect(
      await f.table.observeEventCallback(
        outsider.owner.actor("events:subscribe"),
        parameters(f.tableId),
      ),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    expect(c.records()).toEqual([]);
    expect(c.network).not.toHaveBeenCalled();
  });

  it("rejects malformed parameters and unsafe destinations without echoing input", async () => {
    const f = await fixture();
    const c = capture();
    for (const url of [
      "http://events.provider.example.org/callback",
      "https://127.0.0.1/callback",
      "https://[::1]/callback",
      "https://localhost/callback",
      "https://internal.local/callback",
      "https://events.provider.example.org:8443/callback",
      "https://user:URL_PASSWORD_SENTINEL@events.provider.example.org/callback",
      `${CALLBACK_ORIGIN}/callback#fragment`,
    ]) {
      expect(
        await f.table.observeEventCallback(f.actor, parameters(f.tableId, url)),
      ).toEqual({
        ok: false,
        code: "INVALID_REQUEST",
      });
    }
    expect(
      await f.table.observeEventCallback(f.actor, {
        ...parameters(f.tableId),
        headers: { Authorization: "PRIVATE_HEADER_SENTINEL" },
      }),
    ).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(c.records()).toEqual([]);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
    expect(c.network).not.toHaveBeenCalled();
  });

  it.each([
    ["production", { RELEASE_ENVIRONMENT: "production" }],
    ["quarantine", { RESTORE_QUARANTINE: "true" }],
    ["outbound enabled", { ALLOW_OUTBOUND_NOTIFICATIONS: "true" }],
    ["public Events", { ENABLE_OPENAI_EVENTS: "true" }],
  ])("refuses %s configuration", async (_name, patch) => {
    const f = await fixture();
    await f.configure(patch);
    const c = capture();
    expect(
      await f.table.observeEventCallback(f.actor, parameters(f.tableId)),
    ).toEqual({
      ok: false,
      code: "TABLE_NOT_FOUND",
    });
    expect(c.records()).toEqual([]);
    expect(c.network).not.toHaveBeenCalled();
  });

  it("refuses expired discovery and a stopped delivery configuration", async () => {
    const f = await fixture();
    const c = capture();
    const now = Date.now();
    await f.configure({
      PRIVATE_PILOT_POLICY: JSON.stringify({
        ...f.policy,
        approvedAt: new Date(now - 120_000).toISOString(),
        notBefore: new Date(now - 119_000).toISOString(),
        expiresAt: new Date(now - 1).toISOString(),
      }),
    });
    expect(
      await f.table.observeEventCallback(f.actor, parameters(f.tableId)),
    ).toEqual({
      ok: false,
      code: "TABLE_NOT_FOUND",
    });
    await f.configure({
      PRIVATE_PILOT_POLICY: JSON.stringify({
        ...f.policy,
        mode: "a-only",
        callbackTargets: [{ origin: CALLBACK_ORIGIN, pathPrefix: "/" }],
      }),
    });
    expect(
      await f.table.observeEventCallback(f.actor, parameters(f.tableId)),
    ).toEqual({
      ok: false,
      code: "TABLE_NOT_FOUND",
    });
    expect(c.records()).toEqual([]);
    expect(c.network).not.toHaveBeenCalled();
  });

  it.each(["closed", "expired"] as const)(
    "refuses a table in the %s state",
    async (tableState) => {
      const f = await fixture();
      if (tableState === "closed") {
        expect(
          await f.table.closeTable(
            f.owner.actor("tables:write"),
            crypto.randomUUID(),
          ),
        ).toMatchObject({ ok: true });
      } else {
        await runInDurableObject(f.table, (_instance, state) => {
          state.storage.sql.exec(
            "UPDATE table_metadata SET expires_at = ?",
            Date.now() - 1,
          );
        });
      }
      const c = capture();
      expect(
        await f.table.observeEventCallback(f.actor, parameters(f.tableId)),
      ).toEqual({
        ok: false,
        code: "TABLE_TERMINAL",
      });
      expect(c.records()).toEqual([]);
      expect(c.network).not.toHaveBeenCalled();
    },
  );

  it("rechecks the real guest grant after awaiting durable quota admission", async () => {
    const f = await fixture();
    let revocationStatus: string | undefined;
    await f.configure({
      ADMISSION: {
        idFromName: (name: string) => env.ADMISSION.idFromName(name),
        get: (id: DurableObjectId) => ({
          consume: async (category: "application", maximum: number) => {
            const admitted = await env.ADMISSION.get(id).consume(
              category,
              maximum,
            );
            const guest = env.GUESTS.get(env.GUESTS.idFromName(f.owner.id));
            revocationStatus = (
              await guest.revokeConnection(
                f.owner.session.sessionId,
                f.owner.session.secret,
                f.owner.grant.connectionId,
              )
            ).status;
            return admitted;
          },
        }),
      } as unknown as Env["ADMISSION"],
    });
    const c = capture();
    expect(
      await f.table.observeEventCallback(f.actor, parameters(f.tableId)),
    ).toEqual({
      ok: false,
      code: "TABLE_NOT_FOUND",
    });
    expect(revocationStatus).toBe("revoked");
    expect(c.records()).toEqual([]);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
    expect(c.network).not.toHaveBeenCalled();
  });

  it("preserves the one-per-minute admission charge across object reconstruction", async () => {
    const f = await fixture();
    const c = capture();
    expect(
      await f.table.observeEventCallback(f.actor, parameters(f.tableId)),
    ).toMatchObject({ ok: true });
    const key = `pilot-origin-v1:${f.policy.buildSha}:${f.policy.approvalRef}:${f.owner.id}:${f.owner.grant.connectionId}`;
    const quota = env.ADMISSION.get(env.ADMISSION.idFromName(key));
    await evictDurableObject(quota);
    await f.configure({}, true);
    expect(
      await f.table.observeEventCallback(f.actor, parameters(f.tableId)),
    ).toEqual({
      ok: false,
      code: "TEMPORARILY_UNAVAILABLE",
    });
    expect(
      await runInDurableObject(quota, (_instance, state) =>
        state.storage.sql.exec("SELECT category FROM admission_hits").toArray(),
      ),
    ).toEqual([{ category: "application" }]);
    expect(c.records()).toHaveLength(1);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
    expect(c.network).not.toHaveBeenCalled();
  });

  it("fails closed when quota authority is unavailable", async () => {
    const f = await fixture();
    await f.configure({
      ADMISSION: {
        idFromName: () => {
          throw new Error("PRIVATE_QUOTA_ERROR_SENTINEL");
        },
      } as unknown as Env["ADMISSION"],
    });
    const c = capture();
    expect(
      await f.table.observeEventCallback(f.actor, parameters(f.tableId)),
    ).toEqual({
      ok: false,
      code: "TEMPORARILY_UNAVAILABLE",
    });
    expect(c.records()).toEqual([]);
    expect(c.network).not.toHaveBeenCalled();
  });

  it("cannot reserve or commit a normal subscription under discovery authority", async () => {
    const f = await fixture(false);
    const candidate = await f.table.beginEventSubscription(
      f.actor,
      parameters(f.tableId),
    );
    if (!candidate.ok) throw new Error("Missing local setup candidate");
    await f.configure();
    const before = await f.rows();
    const c = capture();
    expect(
      await f.table.beginEventSubscription(f.actor, parameters(f.tableId)),
    ).toMatchObject({ ok: false });
    expect(
      await f.table.commitVerifiedEventSubscription(
        f.actor,
        candidate.value.candidateId,
      ),
    ).toMatchObject({ ok: false });
    expect(await f.rows()).toEqual(before);
    expect(before.subscriptions).toMatchObject([{ status: "inactive" }]);
    expect(c.records()).toEqual([]);
    expect(c.network).not.toHaveBeenCalled();
  });
});
