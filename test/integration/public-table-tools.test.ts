import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { CreationReservation, CreationResult } from "../../src/objects/guest";
import type { SafeTableMetadata, TableResult } from "../../src/shared/table";
import { authorizeGuestConnection, type VerifiedConnectionActor } from "../../src/shared/auth";

const ORIGIN = "http://localhost:8787";
const REDIRECT = "https://client.example/callback";
const RESOURCE = `${ORIGIN}/mcp`;
const input = {
  request_id: "public_create_request_001",
  title: "Unchanged title é 😀",
  purpose: "Private conversation",
};

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

async function tokenForGuest(scope: string) {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const cookie = `__Host-agent_table_session=v1.${guestId}.${session.sessionId}.${session.secret}`;
  const registered = await exports.default.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "SDK table client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const clientId = String((await json(registered)).client_id);
  const verifier = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...hash))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const url = new URL(`${ORIGIN}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "sdk_table_client",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  })) {
    url.searchParams.set(key, value);
  }
  const page = await exports.default.fetch(url.toString(), {
    headers: { Cookie: cookie },
  });
  expect(page.status).toBe(200);
  const html = await page.text();
  const extract = (name: string) =>
    new RegExp(`name="${name}" type="hidden" value="([^"]+)"`).exec(html)?.[1];
  const handle = extract("handle");
  const csrf = extract("csrf");
  const binding = extract("binding");
  if (!handle || !csrf || !binding) throw new Error("Consent form incomplete");
  const cookies = page.headers.getSetCookie().map((line) => line.split(";")[0]);
  const granted = await exports.default.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: [cookie, ...cookies].join("; "),
    },
    body: new URLSearchParams([
      ["handle", handle],
      ["csrf", csrf],
      ["guest_id", guestId],
      ["binding", binding],
      ["decision", "approve"],
      ...scope.split(" ").map((value): [string, string] => ["scope", value]),
    ]),
  });
  expect(granted.status).toBe(302);
  const code = new URL(
    granted.headers.get("Location") ?? REDIRECT,
  ).searchParams.get("code");
  if (!code) throw new Error("Missing consented authorization code");
  const exchanged = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  expect(exchanged.status).toBe(200);
  const tokens = await json(exchanged);
  const grants = await guest.listConnections(session.sessionId, session.secret);
  // Consent rotates the session, so list via the new session credential.
  const rotatedCookie = granted.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-agent_table_session="));
  const parts = rotatedCookie?.split(";")[0].split("=")[1].split(".");
  const liveGrants = await guest.listConnections(
    parts?.[2] ?? "",
    parts?.[3] ?? "",
  );
  expect(liveGrants).toHaveLength(1);
  expect(grants).toBeNull();
  return {
    guestId,
    guest,
    token: String(tokens.access_token),
    connectionId: liveGrants?.[0].connectionId ?? "",
  };
}

async function sdk(
  token: string,
  transportFetch?: (request: Request) => Promise<Response>,
) {
  const client = new Client(
    { name: "table-integration", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    authProvider: { token: async () => token },
    fetch: (url, init) => {
      const request = new Request(url, init);
      // An in-process fetch needs the Host header a real HTTP client supplies.
      request.headers.set("Host", new URL(request.url).host);
      return transportFetch
        ? transportFetch(request)
        : exports.default.fetch(request);
    },
  });
  await client.connect(transport);
  return client;
}

function output(result: Awaited<ReturnType<Client["callTool"]>>) {
  const block = result.content?.find((content) => content.type === "text");
  if (block?.type !== "text") throw new Error("No textual tool result");
  return JSON.parse(block.text) as Record<string, unknown>;
}

type GuestStub = ReturnType<Env["GUESTS"]["get"]>;
type TableStub = ReturnType<Env["TABLES"]["get"]>;
type ReserveRpc = (
  actor: VerifiedConnectionActor,
  input: unknown,
) => Promise<CreationResult>;
type InitializeRpc = (
  actor: VerifiedConnectionActor,
  input: unknown,
  receipt: CreationReservation,
) => Promise<TableResult<SafeTableMetadata>>;

/**
 * Inject only at Worker-to-DO RPC bindings; the official SDK, OAuth handler,
 * GuestDO/TableDO methods, and SQLite storage remain real. No final MCP tool
 * response is replaced by a fixture.
 */
function withReservationRpc(
  intercept: (
    real: ReserveRpc,
    actor: VerifiedConnectionActor,
    input: unknown,
  ) => ReturnType<ReserveRpc>,
): Env {
  const guests = {
    idFromName: (name: string) => env.GUESTS.idFromName(name),
    get: (id: DurableObjectId): GuestStub => {
      const stub = env.GUESTS.get(id);
      return new Proxy(stub, {
        get(target, property) {
          if (property === "reserveCreation") {
            return (actor: VerifiedConnectionActor, request: unknown) =>
              intercept(
                (actor, request) => target.reserveCreation(actor, request),
                actor,
                request,
              );
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  return { ...env, GUESTS: guests as Env["GUESTS"] };
}

function withInitializationRpc(
  intercept: (
    real: InitializeRpc,
    actor: VerifiedConnectionActor,
    input: unknown,
    receipt: CreationReservation,
  ) => ReturnType<InitializeRpc>,
): Env {
  const tables = {
    idFromName: (name: string) => env.TABLES.idFromName(name),
    get: (id: DurableObjectId): TableStub => {
      const stub = env.TABLES.get(id);
      return new Proxy(stub, {
        get(target, property) {
          if (property === "initializeTable") {
            return (
              actor: VerifiedConnectionActor,
              request: unknown,
              receipt: CreationReservation,
            ) =>
              intercept(
                (actor, request, receipt) =>
                  target.initializeTable(actor, request, receipt),
                actor,
                request,
                receipt,
              );
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  return { ...env, TABLES: tables as Env["TABLES"] };
}

function fetchThroughWorker(overlay: Env) {
  return (request: Request) =>
    worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      overlay,
      createExecutionContext(),
    );
}

describe("public SDK → OAuth Worker → GuestDO → TableDO composition", () => {
  it("creates exactly one waiting table, checks membership, and rejects unexpected fields", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const client = await sdk(owner.token);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "create_table",
        "get_table",
      ]);
      const rejected = await client.callTool({
        name: "create_table",
        arguments: { ...input, guest_id: crypto.randomUUID() },
      });
      expect(rejected.isError).toBe(true);
      const created = await client.callTool({
        name: "create_table",
        arguments: input,
      });
      expect(created.isError).not.toBe(true);
      const metadata = output(created);
      expect(metadata).toMatchObject({
        title: input.title,
        state: "waiting",
        limits: { participants: 2 },
        notifications: { available: false, reason: "not_implemented" },
      });
      const tableId = String(metadata.tableId);
      expect(tableId).toMatch(/^[0-9a-f-]{36}$/);
      expect(metadata.ownMembershipId).toEqual(
        (metadata.memberships as Array<{ membershipId: string }>)[0]
          .membershipId,
      );
      expect(String(metadata.ownInboxUri)).toContain(tableId);
      const fetched = await client.callTool({
        name: "get_table",
        arguments: { table_id: tableId },
      });
      expect(output(fetched)).toEqual(metadata);
      const retried = await client.callTool({
        name: "create_table",
        arguments: { ...input, ttl_seconds: 86_400 },
      });
      expect(output(retried)).toEqual(metadata);
      const changed = await client.callTool({
        name: "create_table",
        arguments: { ...input, title: "Different" },
      });
      expect(changed.isError).toBe(true);
      expect(output(changed)).toMatchObject({
        error: { code: "IDEMPOTENCY_CONFLICT" },
      });
      await runInDurableObject(owner.guest, async (_instance, state) => {
        const receipts = state.storage.sql
          .exec<{ table_id: string }>(
            "SELECT table_id FROM guest_creation_reservations",
          )
          .toArray();
        expect(receipts).toEqual([{ table_id: tableId }]);
      });
      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
        ).toHaveLength(1);
        expect(
          state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
        ).toHaveLength(1);
      });
      await evictDurableObject(owner.guest);
      await evictDurableObject(table);
      const reconstruct = await client.callTool({
        name: "create_table",
        arguments: input,
      });
      expect(output(reconstruct)).toEqual(metadata);
    } finally {
      await client.close();
    }
  });

  it("hides foreign and unknown table metadata without creating table state", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const outsider = await tokenForGuest("tables:read");
    const [first, other] = await Promise.all([
      sdk(owner.token),
      sdk(outsider.token),
    ]);
    try {
      const created = await first.callTool({
        name: "create_table",
        arguments: { ...input, request_id: "public_create_request_002" },
      });
      const tableId = String(output(created).tableId);
      const unknownId = crypto.randomUUID();
      for (const id of [tableId, unknownId]) {
        const notFound = await other.callTool({
          name: "get_table",
          arguments: { table_id: id },
        });
        expect(notFound.isError).toBe(true);
        expect(output(notFound)).toMatchObject({
          error: { code: "TABLE_NOT_FOUND" },
        });
      }
      const readOnly = await other.callTool({
        name: "create_table",
        arguments: { ...input, request_id: "public_create_request_003" },
      });
      expect(readOnly.isError).toBe(true);
      expect(output(readOnly)).toMatchObject({
        error: { code: "NOT_AUTHORIZED" },
      });
      const absent = env.TABLES.get(env.TABLES.idFromName(unknownId));
      await runInDurableObject(absent, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
        ).toEqual([]);
      });
    } finally {
      await first.close();
      await other.close();
    }
  });

  it("reports a public SDK uncertainty after a committed reservation RPC loses its reply", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const originalKey = {
      ...input,
      request_id: "sdk_reservation_response_loss_001",
    };
    let intercepted = 0;
    const overlay = withReservationRpc(async (real, actor, request) => {
      const result = await real(actor, request);
      if (result.ok && intercepted++ === 0) {
        throw new Error("Injected reservation reply loss after commit");
      }
      return result;
    });
    const client = await sdk(owner.token, fetchThroughWorker(overlay));
    try {
      const uncertain = await client.callTool({
        name: "create_table",
        arguments: originalKey,
      });
      expect(intercepted).toBe(1);
      expect(uncertain.isError).toBe(true);
      expect(output(uncertain)).toMatchObject({
        error: {
          code: "TEMPORARILY_UNAVAILABLE",
          retry: "Retry with the same request_id and unchanged arguments.",
        },
      });
      const rows = await runInDurableObject(
        owner.guest,
        async (_instance, state) =>
          state.storage.sql
            .exec<{
              table_id: string;
              expires_at: number;
              charged_at: number;
              outcome: string;
            }>(
              "SELECT table_id, expires_at, charged_at, outcome FROM guest_creation_reservations",
            )
            .toArray(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe("reserved");
      const table = env.TABLES.get(env.TABLES.idFromName(rows[0].table_id));
      const readDecision = await authorizeGuestConnection(
        env,
        owner.guestId,
        owner.connectionId,
        "tables:read",
      );
      if (!readDecision.allowed) throw new Error("Read grant unavailable");
      expect(await table.getMetadata(readDecision.actor)).toMatchObject({
        ok: false,
        code: "TABLE_NOT_FOUND",
      });
      await evictDurableObject(owner.guest);
      await evictDurableObject(table);
      const recovered = await client.callTool({
        name: "create_table",
        arguments: originalKey,
      });
      expect(recovered.isError).not.toBe(true);
      expect(output(recovered)).toMatchObject({
        tableId: rows[0].table_id,
        expiresAt: new Date(rows[0].expires_at).toISOString(),
      });
      await runInDurableObject(owner.guest, async (_instance, state) => {
        const after = state.storage.sql
          .exec<{
            table_id: string;
            charged_at: number;
            outcome: string;
          }>(
            "SELECT table_id, charged_at, outcome FROM guest_creation_reservations",
          )
          .toArray();
        expect(after).toEqual([
          {
            table_id: rows[0].table_id,
            charged_at: rows[0].charged_at,
            outcome: "initialized",
          },
        ]);
      });
    } finally {
      await client.close();
    }
  });

  it("returns an isError public result after TableDO commits but its RPC response is lost", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const originalKey = {
      ...input,
      request_id: "sdk_initializer_response_loss_001",
    };
    const decision = await authorizeGuestConnection(
      env,
      owner.guestId,
      owner.connectionId,
      "tables:write",
    );
    if (!decision.allowed) throw new Error("Expected active write grant");
    const reserved = await owner.guest.reserveCreation(
      decision.actor,
      originalKey,
    );
    if (!reserved.ok) throw new Error("Missing durable reservation");
    const table = env.TABLES.get(
      env.TABLES.idFromName(reserved.reservation.tableId),
    );
    let committed = false;
    const overlay = withInitializationRpc(async (real, actor, request, receipt) => {
      const actual = await real(actor, request, receipt);
      if (actual.ok) {
        committed = true;
        throw new Error("Injected reply loss after persisted initialization");
      }
      return actual;
    });
    const client = await sdk(owner.token, fetchThroughWorker(overlay));
    try {
      const uncertain = await client.callTool({
        name: "create_table",
        arguments: originalKey,
      });
      expect(committed).toBe(true);
      expect(uncertain.isError).toBe(true);
      expect(output(uncertain)).toMatchObject({
        error: {
          code: "TEMPORARILY_UNAVAILABLE",
          retry: "Retry with the same request_id and unchanged arguments.",
        },
      });
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
        ).toHaveLength(1);
        expect(
          state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
        ).toHaveLength(1);
      });
      await evictDurableObject(owner.guest);
      await evictDurableObject(table);
      const retry = await client.callTool({
        name: "create_table",
        arguments: originalKey,
      });
      expect(retry.isError).not.toBe(true);
      expect(output(retry)).toMatchObject({
        tableId: reserved.reservation.tableId,
        expiresAt: new Date(reserved.reservation.expiresAt).toISOString(),
      });
      await runInDurableObject(owner.guest, async (_instance, state) => {
        const rows = state.storage.sql
          .exec<{ table_id: string; outcome: string }>(
            "SELECT table_id, outcome FROM guest_creation_reservations",
          )
          .toArray();
        expect(rows).toEqual([
          {
            table_id: reserved.reservation.tableId,
            outcome: "initialized",
          },
        ]);
      });
    } finally {
      await client.close();
    }
  });

  it("joins two overlapping public SDK creation retries before the reservation decision", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const originalKey = {
      ...input,
      request_id: "sdk_parallel_reservation_001",
    };
    let entered = 0;
    let observedOverlap = false;
    const overlay = withReservationRpc(async (real, actor, request) => {
      entered++;
      // Each request waits in its own Workers I/O context. A shared deferred
      // Promise would cross Durable Object contexts and is not a valid barrier.
      for (let attempt = 0; entered < 2 && attempt < 500; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (entered !== 2) {
        throw new Error("Public SDK reservation attempts did not overlap");
      }
      observedOverlap = true;
      return real(actor, request);
    });
    const [left, right] = await Promise.all([
      sdk(owner.token, fetchThroughWorker(overlay)),
      sdk(owner.token, fetchThroughWorker(overlay)),
    ]);
    try {
      const first = left.callTool({
        name: "create_table",
        arguments: originalKey,
      });
      const second = right.callTool({
        name: "create_table",
        arguments: originalKey,
      });
      const [a, b] = await Promise.all([first, second]);
      expect(entered).toBe(2);
      expect(observedOverlap).toBe(true);
      expect(a.isError).not.toBe(true);
      expect(b.isError).not.toBe(true);
      expect(output(a)).toEqual(output(b));
      const tableId = String(output(a).tableId);
      await runInDurableObject(owner.guest, async (_instance, state) => {
        const rows = state.storage.sql
          .exec<{ table_id: string }>(
            "SELECT table_id FROM guest_creation_reservations",
          )
          .toArray();
        expect(rows).toEqual([{ table_id: tableId }]);
      });
      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
        ).toHaveLength(1);
        expect(
          state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
        ).toHaveLength(1);
      });
    } finally {
      await left.close();
      await right.close();
    }
  });

  it("survives a committed public SDK response lost after the Worker reply", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const originalKey = {
      ...input,
      request_id: "sdk_worker_response_drop_001",
    };
    let dropped = false;
    const flaky = await sdk(owner.token, async (request) => {
      let isCreate = false;
      if (request.method === "POST") {
        const body = (await request
          .clone()
          .json()
          .catch(() => null)) as {
          method?: string;
          params?: { name?: string };
        } | null;
        isCreate =
          body?.method === "tools/call" && body.params?.name === "create_table";
      }
      const response = await exports.default.fetch(request);
      if (isCreate && !dropped) {
        dropped = true;
        throw new Error("Synthetic lost Worker-to-SDK response");
      }
      return response;
    });
    try {
      await expect(
        flaky.callTool({
          name: "create_table",
          arguments: originalKey,
        }),
      ).rejects.toThrow();
      expect(dropped).toBe(true);
    } finally {
      await flaky.close();
    }
    const rows = await runInDurableObject(
      owner.guest,
      async (_instance, state) =>
        state.storage.sql
          .exec<{
            table_id: string;
            expires_at: number;
            outcome: string;
          }>(
            "SELECT table_id, expires_at, outcome FROM guest_creation_reservations",
          )
          .toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("initialized");
    const table = env.TABLES.get(env.TABLES.idFromName(rows[0].table_id));
    await evictDurableObject(owner.guest);
    await evictDurableObject(table);
    const fresh = await sdk(owner.token);
    try {
      const retry = await fresh.callTool({
        name: "create_table",
        arguments: originalKey,
      });
      expect(retry.isError).not.toBe(true);
      expect(output(retry)).toMatchObject({
        tableId: rows[0].table_id,
        expiresAt: new Date(rows[0].expires_at).toISOString(),
      });
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
        ).toHaveLength(1);
        expect(
          state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
        ).toHaveLength(1);
      });
    } finally {
      await fresh.close();
    }
  });

  it("never turns missing credentials into a public MCP tool result", async () => {
    const response = await exports.default.fetch(RESOURCE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=",
    );
  });
});
