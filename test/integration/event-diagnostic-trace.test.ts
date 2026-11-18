import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginEventDiagnosticTrace } from "../../src/mcp/event-diagnostic-trace";
import { handleMcp } from "../../src/mcp/server";
import { nativeDiagnosticDigest } from "../../src/shared/native-event-diagnostics";
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

async function fixture(
  mode: "a-only-discovery" | "a-only" | "native" = "a-only-discovery",
) {
  const f = await inboxStreamFixture(env);
  const now = Date.now();
  const policy = {
    schemaVersion: 1,
    mode: mode === "native" ? "a-only-discovery" : mode,
    observationMode: "private-redacted",
    buildSha: "b".repeat(40),
    approvedAt: new Date(now - 2_000).toISOString(),
    notBefore: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 180_000).toISOString(),
    approvalRef: "synthetic-diagnostic-trace",
    recipientGuestId: f.owner.id,
    recipientConnectionId: f.owner.grant.connectionId,
    tableIds: [f.tableId],
    callbackTargets:
      mode === "a-only"
        ? [{ origin: "https://events.example.org", pathPrefix: "/" }]
        : [],
  };
  const overlay: Env = {
    ...env,
    RELEASE_ENVIRONMENT: "staging",
    RELEASE_PROFILE: "private-pilot-a-only",
    RELEASE_BUILD_SHA: policy.buildSha,
    RESTORE_QUARANTINE: "false",
    ENABLE_MCP_SUBSCRIPTIONS: "false",
    ENABLE_OPENAI_EVENTS: "false",
    ALLOW_OUTBOUND_NOTIFICATIONS: mode === "a-only" ? "true" : "false",
    PRIVATE_PILOT_POLICY: JSON.stringify(policy),
  };
  if (mode === "native") {
    overlay.RELEASE_PROFILE = "test-native-events";
    overlay.ENABLE_MCP_SUBSCRIPTIONS = "true";
    overlay.ENABLE_OPENAI_EVENTS = "true";
    overlay.ALLOW_OUTBOUND_NOTIFICATIONS = "true";
    delete overlay.PRIVATE_PILOT_POLICY;
    overlay.TEST_NATIVE_EVENTS_RISK_ACCEPTANCE =
      "accept-unverified-dns-peer-boundary";
    overlay.EVENTS_REVIEWED_CALLBACK_TARGETS = JSON.stringify([
      { origin: "https://events.example.org", pathPrefix: "/" },
    ]);
    overlay.TEST_NATIVE_EVENT_DIAGNOSTICS = JSON.stringify({
      schemaVersion: 1,
      buildSha: policy.buildSha,
      approvalRef: policy.approvalRef,
      connectionId: f.owner.grant.connectionId,
      notBefore: policy.notBefore,
      expiresAt: policy.expiresAt,
    });
  }
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
  it.each([
    "callback_destination_rejected",
    "callback_challenge_failed",
    "callback_transport_failed",
  ] as const)(
    "retains the actual delivery-mode %s outcome without private callback values",
    async (outcome) => {
      const f = await fixture("a-only");
      const input = parameters(f.tableId);
      if (outcome === "callback_destination_rejected")
        input.delivery.url = "https://unreviewed.example.org/PRIVATE_PATH";
      const network = vi.spyOn(globalThis, "fetch");
      if (outcome === "callback_challenge_failed") {
        network.mockResolvedValue(
          Response.json({ challenge: "CALLBACK_RESPONSE_SENTINEL" }),
        );
      } else {
        network.mockRejectedValue(new Error("PRIVATE_TRANSPORT_SENTINEL"));
      }
      const { body, trace } = await wire(f, "events/subscribe", input);
      expect(trace).toBeDefined();
      expect(body.error).toMatchObject({ code: -32015 });
      const snapshot = await f.read();
      expect(snapshot).toMatchObject({
        scopeMatches: true,
        context: { mode: "a-only", policyActive: true },
      });
      expect(snapshot?.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "events/subscribe",
            stage: "handler",
            outcome,
          }),
        ]),
      );
      assertPrivateValuesAbsent(snapshot, f);
      const encoded = JSON.stringify({ body, snapshot });
      for (const sentinel of [
        "unreviewed.example.org",
        "PRIVATE_PATH",
        "CALLBACK_RESPONSE_SENTINEL",
        "PRIVATE_TRANSPORT_SENTINEL",
      ])
        expect(encoded).not.toContain(sentinel);
      expect(network).toHaveBeenCalledTimes(
        outcome === "callback_destination_rejected" ? 0 : 1,
      );
      const rows = await f.rows();
      expect(rows.candidates).toEqual([]);
      expect(rows.subscriptions.some((row) => row.status === "active")).toBe(
        false,
      );
      expect(rows.outbox).toEqual([]);
    },
  );

  it.each([false, true])(
    "preserves a verified delivery-mode subscription when diagnostic storage fails: %s",
    async (failStorage) => {
      const f = await fixture("a-only");
      const failedWrite = vi
        .fn()
        .mockRejectedValue(new Error("PRIVATE_STORAGE_ERROR_SENTINEL"));
      const traceEnv = failStorage
        ? ({
            ...f.overlay,
            GUESTS: {
              idFromName: (name: string) => f.overlay.GUESTS.idFromName(name),
              get: () => ({ recordEventDiagnostics: failedWrite }),
            },
          } as unknown as Env)
        : f.overlay;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const challenge = JSON.parse(
          new TextDecoder().decode(init?.body as ArrayBuffer),
        ).challenge;
        return Response.json({ challenge });
      });
      const { body } = await wire(
        f,
        "events/subscribe",
        parameters(f.tableId),
        { traceEnv },
      );
      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({
        id: expect.stringMatching(/^sub_/),
        cursor: null,
        truncated: false,
      });
      const rows = await f.rows();
      expect(rows.candidates).toEqual([]);
      expect(
        rows.subscriptions.filter((row) => row.status === "active"),
      ).toHaveLength(1);
      const snapshot = await f.read();
      if (failStorage) {
        expect(failedWrite).toHaveBeenCalledOnce();
        expect(snapshot?.records).toEqual([]);
      } else {
        expect(snapshot?.records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              method: "events/subscribe",
              stage: "handler",
              outcome: "success",
            }),
          ]),
        );
      }
      assertPrivateValuesAbsent(snapshot, f);
      expect(JSON.stringify({ body, snapshot })).not.toContain(
        "PRIVATE_STORAGE_ERROR_SENTINEL",
      );
    },
  );

  it("does not start delivery traces without opt-in or while paused or expired", async () => {
    const f = await fixture("a-only");
    const request = new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Mcp-Method": "events/subscribe" },
    });
    expect(beginEventDiagnosticTrace(request, f.overlay)).toBeDefined();
    const withoutOptIn = { ...f.policy };
    Reflect.deleteProperty(withoutOptIn, "observationMode");
    for (const patch of [
      { ALLOW_OUTBOUND_NOTIFICATIONS: "false" },
      { PRIVATE_PILOT_POLICY: JSON.stringify(withoutOptIn) },
      {
        PRIVATE_PILOT_POLICY: JSON.stringify({
          ...f.policy,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        }),
      },
    ])
      expect(
        beginEventDiagnosticTrace(request, { ...f.overlay, ...patch }),
      ).toBeUndefined();
    expect((await f.read())?.records).toEqual([]);
  });

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

describe("bounded native protocol diagnostics", () => {
  it("records actual native Events handlers and invalid resume arguments without sending a callback", async () => {
    const f = await fixture("native");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected live callback"));
    const listed = await wire(f, "events/list");
    expect(listed.body.result).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ name: "table.resume.requested" }),
      ]),
    });
    const invalid = await wire(f, "events/subscribe", {
      ...parameters(f.tableId),
      name: "table.resume.requested",
      arguments: { table_id: f.tableId, generation: 0 },
    });
    expect(invalid.body.error?.code).toBe(-32602);
    expect(fetch).not.toHaveBeenCalled();
    expect(await f.rows()).toMatchObject({
      candidates: [],
      subscriptions: [],
      outbox: [],
    });
    const snapshot = await f.read();
    expect(snapshot?.scopeMatches).toBe(true);
    expect(snapshot?.context.diagnosticCollection).toMatchObject({
      configured: true,
      active: true,
      recipientMatched: true,
    });
    expect(snapshot?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "events/list",
          stage: "handler",
          outcome: "success",
        }),
        expect.objectContaining({
          method: "events/subscribe",
          stage: "parameters",
          outcome: "invalid",
          detail: "arguments",
        }),
      ]),
    );
    assertPrivateValuesAbsent(snapshot, f);
  });
  it("does not collect without opt-in, after collection expiry, while paused or in production", async () => {
    const f = await fixture("native");
    for (const patch of [
      { TEST_NATIVE_EVENT_DIAGNOSTICS: undefined },
      { ALLOW_OUTBOUND_NOTIFICATIONS: "false" },
      { RELEASE_ENVIRONMENT: "production" },
      {
        TEST_NATIVE_EVENT_DIAGNOSTICS: JSON.stringify({
          ...JSON.parse(f.overlay.TEST_NATIVE_EVENT_DIAGNOSTICS ?? "null"),
          expiresAt: new Date(Date.now() - 1).toISOString(),
        }),
      },
    ])
      expect(
        beginEventDiagnosticTrace(new Request(`${env.PUBLIC_ORIGIN}/mcp`), {
          ...f.overlay,
          ...patch,
        }),
      ).toBeUndefined();
    const trace = beginEventDiagnosticTrace(
      new Request(`${env.PUBLIC_ORIGIN}/mcp`),
      f.overlay,
    );
    if (!trace) throw new Error("Missing native trace");
    trace.authenticate?.({
      guestId: f.owner.id,
      connectionId: crypto.randomUUID(),
    });
    trace.record("events/subscribe", "handler", "received");
    const ctx = createExecutionContext();
    trace.finish(ctx);
    await waitOnExecutionContext(ctx);
    expect((await f.read())?.records).toEqual([]);
  });
  it("expires and physically prunes only the native diagnostic ring without disturbing guest state", async () => {
    const f = await fixture("native");
    await wire(f, "events/list");
    const snapshot = await f.read();
    expect(snapshot?.records.length).toBeGreaterThan(0);
    const nativeKey = "native-event-diagnostics:v1";
    const before = await runInDurableObject(
      f.owner.stub,
      (_instance, state) => ({
        ring: state.storage.get(nativeKey),
        alarm: state.storage.getAlarm(),
      }),
    );
    expect(await before.ring).toBeDefined();
    const until = Date.parse(f.policy.expiresAt) + 15 * 60_000;
    expect(await before.alarm).toBeLessThanOrEqual(until);
    vi.spyOn(Date, "now").mockReturnValue(until);
    await runInDurableObject(f.owner.stub, async (instance, state) => {
      await instance.alarm();
      expect(await state.storage.get(nativeKey)).toBeUndefined();
    });
    expect((await f.read())?.records).toEqual([]);
  });
});

describe("native diagnostic storage race and deadline boundaries", () => {
  it.each(["revocation", "pause", "policy-change"] as const)(
    "refuses a batch when %s occurs during hashing",
    async (change) => {
      const f = await fixture("native");
      const policy = JSON.parse(
        f.overlay.TEST_NATIVE_EVENT_DIAGNOSTICS ?? "null",
      );
      const scope = {
        buildSha: policy.buildSha,
        approvalRef: policy.approvalRef,
        policyDigest: await nativeDiagnosticDigest(f.overlay, policy),
      };
      await runInDurableObject(f.owner.stub, async (instance, state) => {
        const harness = instance as unknown as { env: Env };
        const original = crypto.subtle.digest.bind(crypto.subtle);
        const hash = vi
          .spyOn(crypto.subtle, "digest")
          .mockImplementation(async (algorithm, data) => {
            const result = await original(algorithm, data);
            if (change === "revocation")
              state.storage.sql.exec(
                "UPDATE guest_connections SET revoked_at = ? WHERE connection_id = ?",
                Date.now(),
                f.owner.grant.connectionId,
              );
            else if (change === "pause")
              harness.env = {
                ...harness.env,
                ALLOW_OUTBOUND_NOTIFICATIONS: "false",
              };
            else
              harness.env = {
                ...harness.env,
                TEST_NATIVE_EVENT_DIAGNOSTICS: JSON.stringify({
                  ...policy,
                  approvalRef: "changed-policy-approval",
                }),
              };
            return result;
          });
        try {
          expect(
            await instance.recordEventDiagnostics(
              [
                {
                  diagnosticId: "abcdef012345",
                  observedAt: Date.now(),
                  method: "events/subscribe",
                  stage: "handler",
                  outcome: "received",
                  detail: "none",
                },
              ],
              scope,
              { guestId: f.owner.id, connectionId: f.owner.grant.connectionId },
            ),
          ).toBe(false);
          expect(
            await state.storage.get("native-event-diagnostics:v1"),
          ).toBeUndefined();
        } finally {
          hash.mockRestore();
        }
      });
    },
  );
  it("caps the ring and preserves an earlier real connection expiry through reconstruction and alarms", async () => {
    const f = await fixture("native");
    const short = await f.owner.stub.createConnection(
      f.owner.session.sessionId,
      f.owner.session.secret,
      ["events:subscribe"],
      Date.now() + 2000,
    );
    if (!short) throw new Error("Missing short connection");
    const policy = JSON.parse(
      f.overlay.TEST_NATIVE_EVENT_DIAGNOSTICS ?? "null",
    );
    const scope = {
      buildSha: policy.buildSha,
      approvalRef: policy.approvalRef,
      policyDigest: await nativeDiagnosticDigest(f.overlay, policy),
    };
    const before = await runInDurableObject(f.owner.stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    for (let batch = 0; batch < 5; batch++) {
      const records = Array.from({ length: 16 }, (_, i) => ({
        diagnosticId: (batch * 16 + i).toString(16).padStart(12, "0"),
        observedAt: Date.parse(policy.notBefore) + batch * 16 + i,
        method: "events/list" as const,
        stage: "handler" as const,
        outcome: "received" as const,
        detail: "none" as const,
      }));
      expect(
        await f.owner.stub.recordEventDiagnostics(records, scope, {
          guestId: f.owner.id,
          connectionId: f.owner.grant.connectionId,
        }),
      ).toBe(true);
    }
    const snapshot = await f.read();
    expect(snapshot?.records).toHaveLength(64);
    expect(snapshot?.droppedCount).toBe(16);
    expect(
      await runInDurableObject(f.owner.stub, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(before);
    const schemaBefore = await f.owner.stub.schemaVersion();
    // A fresh instance must retain both the earlier SQL expiry and the KV cleanup deadline.
    await evictDurableObject(f.owner.stub);
    await runInDurableObject(f.owner.stub, (instance) => {
      (instance as unknown as { env: Env }).env = f.overlay;
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3000);
    await runInDurableObject(f.owner.stub, (instance) => instance.alarm());
    expect(
      (
        await f.owner.stub.authorizeConnection(
          f.owner.id,
          short.connectionId,
          "events:subscribe",
        )
      ).allowed,
    ).toBe(false);
    expect((await f.read())?.records).toHaveLength(64);
    expect(await f.owner.stub.schemaVersion()).toBe(schemaBefore);
    const until = Date.parse(policy.expiresAt) + 15 * 60_000;
    expect(
      await runInDurableObject(f.owner.stub, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeLessThanOrEqual(until);
  });
});

it("contains hashing failures even when no authenticated actor is ever bound", async () => {
  const f = await fixture("native");
  const hash = vi
    .spyOn(crypto.subtle, "digest")
    .mockRejectedValue(new Error("PRIVATE_HASH_ERROR_SENTINEL"));
  try {
    const trace = beginEventDiagnosticTrace(
      new Request(`${env.PUBLIC_ORIGIN}/mcp`),
      f.overlay,
    );
    expect(trace).toBeDefined();
    const ctx = createExecutionContext();
    trace?.finish(ctx);
    await waitOnExecutionContext(ctx);
    await Promise.resolve();
    hash.mockRestore();
    expect((await f.read())?.records).toEqual([]);
  } finally {
    hash.mockRestore();
  }
});
