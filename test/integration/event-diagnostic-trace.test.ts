import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginEventDiagnosticTrace } from "../../src/mcp/event-diagnostic-trace";
import { handleMcp } from "../../src/mcp/server";
import { inboxStreamFixture } from "../helpers/inbox-stream-fixture";

const CALLBACK =
  "https://events.example.org/TRACE_CALLBACK_PATH_SENTINEL?secret=TRACE_CALLBACK_QUERY_SENTINEL";
const SECRET = `whsec_${btoa("S".repeat(32))}`;
const PRIVATE_METADATA = "TRACE_PROTOCOL_METADATA_SENTINEL";

function parameters(tableId: string) {
  return {
    name: "table.message.created",
    arguments: { table_id: tableId },
    delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
    cursor: null,
    _meta: { private: PRIVATE_METADATA },
  };
}

async function fixture() {
  const f = await inboxStreamFixture(env);
  const now = Date.now();
  const policy = {
    schemaVersion: 1,
    mode: "a-only-discovery",
    observationMode: "private-redacted",
    buildSha: "b".repeat(40),
    approvedAt: new Date(now - 2_000).toISOString(),
    notBefore: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 180_000).toISOString(),
    approvalRef: "synthetic-diagnostic-trace",
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
  await runInDurableObject(f.table, (instance) => {
    const harness = instance as unknown as { env: Env };
    harness.env = { ...harness.env, ...overlay };
  });
  await runInDurableObject(f.owner.stub, (instance) => {
    const harness = instance as unknown as { env: Env };
    harness.env = { ...harness.env, ...overlay };
  });
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
  const read = () =>
    f.owner.stub.readEventDiagnostics(f.owner.id, f.owner.grant.connectionId);
  return { ...f, policy, overlay, rows, read };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function wire(
  f: Fixture,
  method: string,
  params: Record<string, unknown> = {},
  options: { jsonrpc?: string; traceEnv?: Env; mcpEnv?: Env } = {},
) {
  const request = new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      Host: new URL(env.PUBLIC_ORIGIN).host,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      "X-Private-Sentinel": "TRACE_HEADER_SENTINEL",
    },
    body: JSON.stringify({
      jsonrpc: options.jsonrpc ?? "2.0",
      id: "TRACE_JSONRPC_ID_SENTINEL",
      method,
      params: {
        ...params,
        _meta: {
          private: PRIVATE_METADATA,
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const context = createExecutionContext();
  const trace = beginEventDiagnosticTrace(
    request,
    options.traceEnv ?? f.overlay,
  );
  trace?.record(trace.methodHint, "request", "received");
  const response = await handleMcp(
    request,
    options.mcpEnv ?? f.overlay,
    context,
    {
      guestId: f.owner.id,
      connectionId: f.owner.grant.connectionId,
      scopes: ["tables:read", "tables:write", "events:subscribe"],
      tokenExpiresAtMs: Date.now() + 60_000,
    },
    trace,
  );
  trace?.record(
    trace.methodHint,
    "response",
    response.status >= 500
      ? "http_server_error"
      : response.status >= 400
        ? "http_client_error"
        : "http_success",
  );
  trace?.finish(context);
  await waitOnExecutionContext(context);
  const body = (await response.json()) as {
    result?: unknown;
    error?: { code: number; message: string; data?: { reason: string } };
  };
  return { response, body, trace };
}

function assertPrivateValuesAbsent(value: unknown, f: Fixture) {
  const encoded = JSON.stringify(value);
  for (const forbidden of [
    CALLBACK,
    "TRACE_CALLBACK_PATH_SENTINEL",
    "TRACE_CALLBACK_QUERY_SENTINEL",
    SECRET,
    PRIVATE_METADATA,
    "TRACE_HEADER_SENTINEL",
    "TRACE_JSONRPC_ID_SENTINEL",
    f.owner.id,
    f.owner.grant.connectionId,
    f.owner.session.secret,
    f.peer.id,
    f.tableId,
    "Internal hints",
  ])
    expect(encoded).not.toContain(forbidden);
}

afterEach(() => vi.restoreAllMocks());

describe("durable Events protocol diagnostics through the real MCP handler", () => {
  it("records the actual discovery refusal without authorizing delivery or storing input", async () => {
    const f = await fixture();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected outbound callback"));
    const { response, body } = await wire(
      f,
      "events/subscribe",
      parameters(f.tableId),
    );
    expect(response.status).toBe(200);
    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({
      code: -32015,
      data: { reason: "operator_review_required" },
    });
    const snapshot = await f.read();
    expect(snapshot?.scopeMatches).toBe(true);
    expect(snapshot?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "events/subscribe",
          stage: "handler",
          outcome: "received",
        }),
        expect.objectContaining({
          method: "events/subscribe",
          stage: "parameters",
          outcome: "valid",
        }),
        expect.objectContaining({
          method: "events/subscribe",
          stage: "table",
          outcome: "success",
        }),
        expect.objectContaining({
          method: "events/subscribe",
          stage: "handler",
          outcome: "operator_review_required",
        }),
      ]),
    );
    expect(new Set(snapshot?.records.map((row) => row.diagnosticId)).size).toBe(
      1,
    );
    expect(
      snapshot?.records.every((row) => /^[a-f0-9]{12}$/.test(row.diagnosticId)),
    ).toBe(true);
    assertPrivateValuesAbsent(snapshot, f);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("identifies a malformed signing secret before entering the TableDO observation path", async () => {
    const f = await fixture();
    const input = parameters(f.tableId);
    input.delivery.secret = "MALFORMED_SIGNING_SECRET_SENTINEL";
    const { body } = await wire(f, "events/subscribe", input);
    expect(body.error).toMatchObject({ code: -32602 });
    const snapshot = await f.read();
    expect(snapshot?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "events/subscribe",
          stage: "parameters",
          outcome: "invalid",
          detail: "secret",
        }),
      ]),
    );
    expect(snapshot?.records.some((row) => row.stage === "table")).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(input.delivery.secret);
    assertPrivateValuesAbsent(snapshot, f);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
  });

  it("distinguishes SDK envelope rejection from an actual Events handler entry", async () => {
    const f = await fixture();
    const { response, body } = await wire(
      f,
      "events/subscribe",
      parameters(f.tableId),
      {
        jsonrpc: "INVALID_JSONRPC_ENVELOPE_SENTINEL",
      },
    );
    expect(response.status >= 400 || body.error !== undefined).toBe(true);
    const snapshot = await f.read();
    expect(snapshot?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "events/subscribe",
          stage: "request",
          outcome: "received",
        }),
      ]),
    );
    expect(snapshot?.records.some((row) => row.stage === "handler")).toBe(
      false,
    );
    expect(JSON.stringify(snapshot)).not.toContain(
      "INVALID_JSONRPC_ENVELOPE_SENTINEL",
    );
    assertPrivateValuesAbsent(snapshot, f);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
  });

  it("does not collect outside the active staging window or for diagnostic tool reads", async () => {
    const f = await fixture();
    const request = new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Mcp-Method": "events/list" },
    });
    expect(
      beginEventDiagnosticTrace(request, {
        ...f.overlay,
        RELEASE_ENVIRONMENT: "production",
      }),
    ).toBeUndefined();
    expect(
      beginEventDiagnosticTrace(request, {
        ...f.overlay,
        PRIVATE_PILOT_POLICY: JSON.stringify({
          ...f.policy,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        }),
      }),
    ).toBeUndefined();
    for (const method of ["tools/call", "tools/list"]) {
      expect(
        beginEventDiagnosticTrace(
          new Request(request, {
            headers: { "Mcp-Method": method },
          }),
          f.overlay,
        ),
      ).toBeUndefined();
    }
    expect((await f.read())?.records).toEqual([]);
  });

  it("does not persist requests rejected before authentication starts", async () => {
    const f = await fixture();
    const write = vi.fn().mockResolvedValue(true);
    const trace = beginEventDiagnosticTrace(
      new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Mcp-Method": "events/subscribe" },
      }),
      {
        ...f.overlay,
        GUESTS: {
          idFromName: (name: string) => f.overlay.GUESTS.idFromName(name),
          get: () => ({ recordEventDiagnostics: write }),
        },
      } as unknown as Env,
    );
    expect(trace).toBeDefined();
    trace?.record("events/subscribe", "request", "received");
    trace?.record("events/subscribe", "response", "http_client_error");
    const context = createExecutionContext();
    trace?.finish(context);
    await waitOnExecutionContext(context);
    expect(write).not.toHaveBeenCalled();
    expect((await f.read())?.records).toEqual([]);
  });

  it("does not claim TableDO receipt when observation dispatch fails", async () => {
    const f = await fixture();
    const failedDispatch = vi.fn(() => {
      throw new Error("PRIVATE_TABLE_DISPATCH_ERROR_SENTINEL");
    });
    const mcpEnv = {
      ...f.overlay,
      TABLES: {
        idFromName: (name: string) => f.overlay.TABLES.idFromName(name),
        get: failedDispatch,
      },
    } as unknown as Env;
    const { body } = await wire(f, "events/subscribe", parameters(f.tableId), {
      mcpEnv,
    });
    expect(body.error).toMatchObject({ code: -32603 });
    expect(failedDispatch).toHaveBeenCalledOnce();
    const snapshot = await f.read();
    expect(snapshot?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "events/subscribe",
          stage: "table",
          outcome: "unavailable",
        }),
      ]),
    );
    expect(
      snapshot?.records.some(
        (row) => row.stage === "table" && row.outcome === "received",
      ),
    ).toBe(false);
    expect(JSON.stringify({ body, snapshot })).not.toContain(
      "PRIVATE_TABLE_DISPATCH_ERROR_SENTINEL",
    );
    assertPrivateValuesAbsent(snapshot, f);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
  });

  it("keeps the real subscription outcome when asynchronous diagnostic storage fails", async () => {
    const f = await fixture();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const failedWrite = vi
      .fn()
      .mockRejectedValue(new Error("PRIVATE_STORAGE_ERROR_SENTINEL"));
    const traceEnv = {
      ...f.overlay,
      GUESTS: {
        idFromName: (name: string) => f.overlay.GUESTS.idFromName(name),
        get: () => ({ recordEventDiagnostics: failedWrite }),
      },
    } as unknown as Env;
    const { body } = await wire(f, "events/subscribe", parameters(f.tableId), {
      traceEnv,
    });
    expect(body.error).toMatchObject({
      code: -32015,
      data: { reason: "operator_review_required" },
    });
    expect(failedWrite).toHaveBeenCalledOnce();
    expect(JSON.stringify(body)).not.toContain(
      "PRIVATE_STORAGE_ERROR_SENTINEL",
    );
    expect((await f.read())?.records).toEqual([]);
    expect(await f.rows()).toEqual({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
  });
});
