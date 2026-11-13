import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_DIAGNOSTIC_RETENTION_MS,
  type EventDiagnosticRecord,
  eventDiagnosticPolicyDigest,
} from "../../src/evidence/event-diagnostics";
import { handleMcp } from "../../src/mcp/server";
import { getEventDiagnostics } from "../../src/services/event-diagnostics";
import type {
  ConnectionScope,
  VerifiedConnectionActor,
} from "../../src/shared/auth";
import { parsePrivatePilotPolicy } from "../../src/shared/private-pilot";
import { inboxStreamFixture } from "../helpers/inbox-stream-fixture";

async function fixture() {
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
    approvalRef: "synthetic-diagnostics-review",
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
  const configureTable = (patch: Partial<Env> = {}) =>
    runInDurableObject(f.table, (instance) => {
      const harness = instance as unknown as { env: Env };
      harness.env = { ...harness.env, ...overlay, ...patch };
    });
  const configureGuest = (patch: Partial<Env> = {}) =>
    runInDurableObject(f.owner.stub, (instance) => {
      const harness = instance as unknown as { env: Env };
      harness.env = { ...harness.env, ...overlay, ...patch };
    });
  await Promise.all([configureTable(), configureGuest()]);
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
      metadata: state.storage.sql
        .exec("SELECT * FROM table_metadata")
        .toArray(),
    }));
  return {
    ...f,
    actor: f.owner.actor("events:subscribe"),
    policy,
    overlay,
    configureTable,
    configureGuest,
    rows,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function wire(
  f: Fixture,
  actor: VerifiedConnectionActor,
  scopes: ConnectionScope[] = ["tables:read", "events:subscribe"],
) {
  // The real handler receives a synthetic already-validated OAuth identity;
  // real GuestDO grants and TableDO membership remain authoritative below it.
  const response = await handleMcp(
    new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Host: new URL(env.PUBLIC_ORIGIN).host,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "get_event_diagnostics",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name: "get_event_diagnostics",
          arguments: { table_id: f.tableId },
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
      scopes,
      tokenExpiresAtMs: Date.now() + 60_000,
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as {
    result: {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
  };
  return {
    isError: body.result.isError ?? false,
    value: JSON.parse(body.result.content[0].text),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("membership-authorized Events diagnostics", () => {
  it("combines actual component reads without creating subscription work", async () => {
    const f = await fixture();
    const record: EventDiagnosticRecord = {
      diagnosticId: "0123456789ab",
      observedAt: Date.now(),
      method: "events/subscribe",
      stage: "parameters",
      outcome: "invalid",
      detail: "delivery",
    };
    const policy = parsePrivatePilotPolicy(f.overlay.PRIVATE_PILOT_POLICY);
    if (!policy) throw new Error("Missing parsed diagnostic fixture policy");
    expect(
      await f.owner.stub.recordEventDiagnostics([record], {
        buildSha: policy.buildSha,
        approvalRef: policy.approvalRef,
        policyDigest: await eventDiagnosticPolicyDigest(policy),
      }),
    ).toBe(true);
    const before = await f.rows();
    const result = await getEventDiagnostics(f.overlay, f.actor, f.tableId);
    expect(result).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 1,
        worker: {
          environment: "staging",
          profile: "private-pilot-a-only",
          buildSha: f.policy.buildSha,
          policyConfigured: true,
          policyActive: true,
          recipientMatched: true,
          tableAllowed: true,
        },
        table: {
          context: { policyConfigured: true, recipientMatched: true },
          lifecycle: { state: "open", expired: false },
          notifications: { status: "disabled", pendingCount: 0 },
        },
        recent: {
          status: "available",
          scopeMatches: true,
          records: [record],
          context: { tableAllowed: null },
        },
        limitations: {
          emptyRecordsDoNotProveNoRequest: true,
          arrivalDoesNotProveHostAcceptance: true,
          componentReadsAreAtomic: false,
        },
      },
    });
    expect(await f.rows()).toEqual(before);
    expect(before.candidates).toEqual([]);
    expect(before.subscriptions).toEqual([]);
    expect(before.outbox).toEqual([]);
  });

  it("retains only a sanitized origin for the exact policy, actor and bounded lifetime", async () => {
    const f = await fixture();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const callback =
      "https://events.provider.example.org/PRIVATE_PATH_SENTINEL?secret=PRIVATE_QUERY_SENTINEL";
    const secret = `whsec_${btoa("S".repeat(32))}`;
    const before = await f.rows();
    expect(
      await getEventDiagnostics(f.overlay, f.actor, f.tableId),
    ).toMatchObject({
      ok: true,
      value: { table: { callbackOrigin: null } },
    });
    expect(
      await f.table.observeEventCallback(f.actor, {
        name: "table.message.created",
        arguments: { table_id: f.tableId },
        delivery: { mode: "webhook", url: callback, secret },
        cursor: null,
      }),
    ).toEqual({ ok: true, value: {} });
    const retained = await runInDurableObject(f.table, (_instance, state) =>
      state.storage.get<Record<string, unknown>>("event-callback-origin:v1"),
    );
    expect(retained).toMatchObject({
      origin: "https://events.provider.example.org",
      retentionUntil:
        Date.parse(f.policy.expiresAt) + EVENT_DIAGNOSTIC_RETENTION_MS,
    });
    await evictDurableObject(f.table);
    await f.configureTable();
    const result = await getEventDiagnostics(f.overlay, f.actor, f.tableId);
    expect(result).toMatchObject({
      ok: true,
      value: {
        table: { callbackOrigin: "https://events.provider.example.org" },
      },
    });
    for (const privateValue of [
      callback,
      "PRIVATE_PATH_SENTINEL",
      "PRIVATE_QUERY_SENTINEL",
      secret,
    ]) {
      expect(JSON.stringify(result)).not.toContain(privateValue);
      expect(JSON.stringify(retained)).not.toContain(privateValue);
    }
    expect(
      await getEventDiagnostics(
        f.overlay,
        f.peer.actor("events:subscribe"),
        f.tableId,
      ),
    ).toMatchObject({
      ok: true,
      value: { table: { callbackOrigin: null } },
    });
    const other = await f.owner.stub.createConnection(
      f.owner.session.sessionId,
      f.owner.session.secret,
      ["tables:read", "events:subscribe"],
      Date.now() + 60_000,
    );
    if (!other) throw new Error("Missing synthetic second diagnostic grant");
    expect(
      await getEventDiagnostics(
        f.overlay,
        { ...f.actor, connectionId: other.connectionId },
        f.tableId,
      ),
    ).toMatchObject({
      ok: true,
      value: { table: { callbackOrigin: null } },
    });
    await f.configureTable({
      PRIVATE_PILOT_POLICY: JSON.stringify({
        ...f.policy,
        approvalRef: "synthetic-replacement-review",
      }),
    });
    expect(
      await getEventDiagnostics(f.overlay, f.actor, f.tableId),
    ).toMatchObject({
      ok: true,
      value: { table: { callbackOrigin: null } },
    });
    await f.configureTable();
    const retentionUntil =
      Date.parse(f.policy.expiresAt) + EVENT_DIAGNOSTIC_RETENTION_MS;
    await runInDurableObject(f.owner.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_connections SET expires_at = ? WHERE connection_id = ?",
        retentionUntil + 60_000,
        f.owner.grant.connectionId,
      );
    });
    vi.spyOn(Date, "now").mockReturnValue(retentionUntil);
    expect(
      await getEventDiagnostics(f.overlay, f.actor, f.tableId),
    ).toMatchObject({
      ok: true,
      value: { table: { callbackOrigin: null } },
    });
    expect(await f.rows()).toEqual(before);
  });

  it("keeps the authorized observation result when origin persistence fails", async () => {
    const f = await fixture();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await runInDurableObject(
      f.table,
      async (instance, state) => {
        const failure = vi
          .spyOn(state.storage, "put")
          .mockRejectedValue(new Error("PRIVATE_STORAGE_EXCEPTION_SENTINEL"));
        try {
          return await instance.observeEventCallback(f.actor, {
            name: "table.message.created",
            arguments: { table_id: f.tableId },
            delivery: {
              mode: "webhook",
              url: "https://events.provider.example.org/private-path",
              secret: `whsec_${btoa("S".repeat(32))}`,
            },
            cursor: null,
          });
        } finally {
          failure.mockRestore();
        }
      },
    );
    expect(result).toEqual({ ok: true, value: {} });
    const read = await getEventDiagnostics(f.overlay, f.actor, f.tableId);
    expect(read).toMatchObject({
      ok: true,
      value: {
        table: { callbackOrigin: null },
        limitations: { missingCallbackOriginIsUnknown: true },
      },
    });
    expect(JSON.stringify(read)).not.toContain(
      "PRIVATE_STORAGE_EXCEPTION_SENTINEL",
    );
  });

  it("requires fresh Events authority and actual membership on every read", async () => {
    const f = await fixture();
    const outsider = await inboxStreamFixture(env);
    const missingEventScope = await f.owner.stub.createConnection(
      f.owner.session.sessionId,
      f.owner.session.secret,
      ["tables:read"],
      Date.now() + 60_000,
    );
    if (!missingEventScope)
      throw new Error("Missing synthetic read-only grant");
    for (const actor of [
      outsider.owner.actor("events:subscribe"),
      f.owner.actor("tables:read"),
      { ...f.actor, connectionId: missingEventScope.connectionId },
      { ...f.actor, connectionId: f.peer.grant.connectionId },
    ]) {
      expect(await getEventDiagnostics(f.overlay, actor, f.tableId)).toEqual({
        ok: false,
        code: "TABLE_NOT_FOUND",
      });
    }
    expect(
      await getEventDiagnostics(f.overlay, f.actor, f.tableId),
    ).toMatchObject({
      ok: true,
    });
    await f.owner.stub.revokeConnection(
      f.owner.session.sessionId,
      f.owner.session.secret,
      f.owner.grant.connectionId,
    );
    expect(await getEventDiagnostics(f.overlay, f.actor, f.tableId)).toEqual({
      ok: false,
      code: "TABLE_NOT_FOUND",
    });
  });

  it("shows Worker, TableDO and GuestDO configuration mismatches safely", async () => {
    const f = await fixture();
    await f.configureTable({
      RELEASE_PROFILE: "manual",
      RELEASE_BUILD_SHA: "b".repeat(40),
      PRIVATE_PILOT_POLICY: undefined,
    });
    await f.configureGuest({
      PRIVATE_PILOT_POLICY: JSON.stringify({
        ...f.policy,
        recipientConnectionId: f.peer.grant.connectionId,
      }),
    });
    expect(
      await getEventDiagnostics(f.overlay, f.actor, f.tableId),
    ).toMatchObject({
      ok: true,
      value: {
        worker: { policyConfigured: true, recipientMatched: true },
        table: {
          context: {
            profile: "manual",
            buildSha: "b".repeat(40),
            policyConfigured: false,
            recipientMatched: false,
          },
        },
        recent: {
          status: "available",
          scopeMatches: false,
          records: [],
          context: { policyConfigured: true, recipientMatched: false },
        },
      },
    });
  });

  it("reports policy and retained table expiry without advancing lifecycle", async () => {
    const f = await fixture();
    const now = Date.now();
    const patch = {
      PRIVATE_PILOT_POLICY: JSON.stringify({
        ...f.policy,
        approvedAt: new Date(now - 120_000).toISOString(),
        notBefore: new Date(now - 119_000).toISOString(),
        expiresAt: new Date(now - 1).toISOString(),
      }),
    };
    await Promise.all([f.configureTable(patch), f.configureGuest(patch)]);
    await runInDurableObject(f.table, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE table_metadata SET created_at = ?, expires_at = ?",
        now - 2_000,
        now - 1_000,
      );
    });
    const before = await f.rows();
    expect(
      await getEventDiagnostics({ ...f.overlay, ...patch }, f.actor, f.tableId),
    ).toMatchObject({
      ok: true,
      value: {
        worker: { policyConfigured: true, policyActive: false },
        table: {
          context: { policyActive: false },
          lifecycle: { state: "open", expired: true },
        },
        recent: { status: "available", scopeMatches: true },
      },
    });
    expect(await f.rows()).toEqual(before);
  });

  it("never returns stored callback, credential, content or other identity values", async () => {
    const f = await fixture();
    const callback =
      "https://private.example/CALLBACK_SENTINEL?key=QUERY_SENTINEL";
    const secret = "CALLBACK_SECRET_SENTINEL";
    const title = "PRIVATE_TITLE_SENTINEL";
    await runInDurableObject(f.table, (_instance, state) => {
      // Synthetic persisted secrets exercise the actual public read projection.
      state.storage.sql.exec("UPDATE table_metadata SET title = ?", title);
      state.storage.sql.exec(
        `INSERT INTO table_event_subscriptions
         (membership_id, generation, fence, status, guest_id, connection_id,
          subscription_id, callback_url, secret_envelope, expires_at)
         VALUES (?, 1, 1, 'active', ?, ?, ?, ?, ?, ?)`,
        f.created.value.ownMembershipId,
        f.owner.id,
        f.owner.grant.connectionId,
        "PRIVATE_SUBSCRIPTION_SENTINEL",
        callback,
        secret,
        Date.now() + 60_000,
      );
    });
    const before = await f.rows();
    const result = await getEventDiagnostics(f.overlay, f.actor, f.tableId);
    expect(result).toMatchObject({
      ok: true,
      value: {
        table: { notifications: { status: "active", pendingCount: 0 } },
      },
    });
    const encoded = JSON.stringify(result);
    for (const privateValue of [
      callback,
      secret,
      title,
      "PRIVATE_SUBSCRIPTION_SENTINEL",
      f.owner.id,
      f.owner.grant.connectionId,
      f.owner.session.secret,
      f.peer.id,
      f.peer.grant.connectionId,
      f.joined.value.ownMembershipId,
      f.policy.approvalRef,
      f.overlay.CALLBACK_CREDENTIAL_KEYRING,
    ]) {
      if (privateValue) expect(encoded).not.toContain(privateValue);
    }
    const secondGrant = await f.owner.stub.createConnection(
      f.owner.session.sessionId,
      f.owner.session.secret,
      ["tables:read", "events:subscribe"],
      Date.now() + 60_000,
    );
    if (!secondGrant) throw new Error("Missing synthetic second grant");
    expect(
      await getEventDiagnostics(
        f.overlay,
        { ...f.actor, connectionId: secondGrant.connectionId },
        f.tableId,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        worker: { recipientMatched: false },
        table: { notifications: { status: "disabled", pendingCount: 0 } },
        recent: { scopeMatches: false, records: [] },
      },
    });
    expect(await f.rows()).toEqual(before);
  });

  it("reports an unavailable diagnostic store as unknown without exception details", async () => {
    const f = await fixture();
    for (const unavailable of [false, true]) {
      // TableDO still checks the actual GuestDO grant; only the later ring read
      // is replaced to exercise null and RPC-failure handling independently.
      const overlay: Env = {
        ...f.overlay,
        GUESTS: {
          idFromName: (name: string) => env.GUESTS.idFromName(name),
          get: () => ({
            readEventDiagnostics: async () => {
              if (unavailable)
                throw new Error("RPC_PRIVATE_EXCEPTION_SENTINEL");
              return null;
            },
          }),
        } as unknown as Env["GUESTS"],
      };
      const result = await getEventDiagnostics(overlay, f.actor, f.tableId);
      expect(result).toMatchObject({
        ok: true,
        value: { recent: { status: "unknown" } },
      });
      if (result.ok) expect(result.value.recent).toEqual({ status: "unknown" });
      expect(JSON.stringify(result)).not.toContain(
        "RPC_PRIVATE_EXCEPTION_SENTINEL",
      );
    }
  });

  it("enforces token scopes and membership through the actual MCP tool handler", async () => {
    const f = await fixture();
    expect(await wire(f, f.actor)).toMatchObject({
      isError: false,
      value: { schemaVersion: 1, worker: { recipientMatched: true } },
    });
    for (const scopes of [
      ["tables:read"],
      ["events:subscribe"],
    ] as ConnectionScope[][]) {
      expect(await wire(f, f.actor, scopes)).toEqual({
        isError: true,
        value: { error: { code: "NOT_AUTHORIZED" } },
      });
    }
    const outsider = await inboxStreamFixture(env);
    expect(await wire(f, outsider.owner.actor("events:subscribe"))).toEqual({
      isError: true,
      value: { error: { code: "TABLE_NOT_FOUND" } },
    });
  });
});
