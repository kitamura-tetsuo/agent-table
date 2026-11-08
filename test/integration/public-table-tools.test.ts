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
import type {
  CreationReservation,
  CreationResult,
} from "../../src/objects/guest";
import {
  authorizeGuestConnection,
  type VerifiedConnectionActor,
} from "../../src/shared/auth";
import { TABLE_LIMITS } from "../../src/shared/limits";
import type { SafeTableMetadata, TableResult } from "../../src/shared/table";

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
          return value;
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
          return value;
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
        "close_table",
        "create_invite",
        "create_table",
        "get_table",
        "join_table",
        "post_message",
        "read_messages",
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
    const overlay = withInitializationRpc(
      async (real, actor, request, receipt) => {
        const actual = await real(actor, request, receipt);
        if (actual.ok && !committed) {
          committed = true;
          throw new Error("Injected reply loss after persisted initialization");
        }
        return actual;
      },
    );
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

  it("issues encrypted active invitations, rotates keys, and refuses creator self-admission", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const client = await sdk(owner.token);
    try {
      const created = await client.callTool({
        name: "create_table",
        arguments: { ...input, request_id: "invitation_creator_setup_001" },
      });
      const tableId = String(output(created).tableId);
      const issue = (key: string) =>
        client.callTool({
          name: "create_invite",
          arguments: { table_id: tableId, request_id: key },
        });
      const first = await issue("invitation_issue_key_one_001");
      expect(first.isError).not.toBe(true);
      const active = output(first);
      const secret = String(active.invitation);
      expect(secret).toMatch(
        /^at1\.[0-9a-f-]+\.[0-9a-f-]+\.[A-Za-z0-9_-]{43}$/,
      );
      expect(String(active.landingUrl)).toContain("/join#at1.");
      expect(String(active.landingUrl)).not.toContain("?invitation=");
      const retry = await issue("invitation_issue_key_one_001");
      expect(output(retry)).toEqual(active);
      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      await runInDurableObject(table, async (_instance, state) => {
        const rows = state.storage.sql
          .exec<{
            response_envelope: string;
            secret_digest: string;
            state: string;
          }>(
            "SELECT response_envelope, secret_digest, state FROM table_invitations",
          )
          .toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("active");
        expect(rows[0].response_envelope).not.toContain(secret);
        expect(rows[0].secret_digest).toMatch(/^[0-9a-f]{64}$/);
      });
      const creatorJoin = await client.callTool({
        name: "join_table",
        arguments: {
          invitation: secret,
          request_id: "creator_self_join_key_001",
        },
      });
      expect(creatorJoin.isError).toBe(true);
      const rotated = await issue("invitation_issue_key_two_001");
      expect(rotated.isError).not.toBe(true);
      expect(output(rotated).invitation).not.toBe(secret);
      const rotatedSecret = String(output(rotated).invitation);
      const oldRetry = await issue("invitation_issue_key_one_001");
      expect(oldRetry.isError).toBe(true);
      expect(JSON.stringify(output(oldRetry))).not.toContain(secret);
      const oldJoin = await client.callTool({
        name: "join_table",
        arguments: {
          invitation: secret,
          request_id: "old_revoked_invite_key_001",
        },
      });
      expect(oldJoin.isError).toBe(true);
      await runInDurableObject(table, async (_instance, state) => {
        const rows = state.storage.sql
          .exec<{
            state: string;
            response_envelope: string | null;
          }>(
            "SELECT state, response_envelope FROM table_invitations ORDER BY issued_at, rowid",
          )
          .toArray();
        expect(rows.map((row) => row.state)).toEqual(["revoked", "active"]);
        expect(rows[0].response_envelope).toBeNull();
        expect(
          state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
        ).toHaveLength(1);
      });
      await runInDurableObject(table, async (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_invitations SET expires_at = ? WHERE state = 'active'",
          Date.now() - 1,
        );
      });
      const expiredRetry = await issue("invitation_issue_key_two_001");
      expect(expiredRetry.isError).toBe(true);
      expect(output(expiredRetry)).toMatchObject({
        error: { code: "INVITATION_EXPIRED" },
      });
      expect(JSON.stringify(output(expiredRetry))).not.toContain(rotatedSecret);
      await runInDurableObject(table, async (_instance, state) => {
        const terminal = state.storage.sql
          .exec<{ state: string; response_envelope: string | null }>(
            "SELECT state, response_envelope FROM table_invitations WHERE request_id = ?",
            "invitation_issue_key_two_001",
          )
          .one();
        expect(terminal.state).toBe("revoked");
        expect(terminal.response_envelope).toBeNull();
      });
      const expiredGuest = await tokenForGuest("tables:read tables:write");
      const expiredClient = await sdk(expiredGuest.token);
      try {
        const expiredJoin = await expiredClient.callTool({
          name: "join_table",
          arguments: {
            invitation: rotatedSecret,
            request_id: "expired_invitation_join_key_001",
          },
        });
        expect(expiredJoin.isError).toBe(true);
        expect(output(expiredJoin)).toMatchObject({
          error: { code: "INVITATION_INVALID" },
        });
      } finally {
        await expiredClient.close();
      }
      const landing = await exports.default.fetch(`${ORIGIN}/join`);
      expect(landing.status).toBe(200);
      expect(await landing.text()).not.toContain(secret);
      expect(landing.headers.get("Referrer-Policy")).toBe("no-referrer");
    } finally {
      await client.close();
    }
  });

  it("serializes two real SDK redemption contenders and keeps the winner after a lost response", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const guestA = await tokenForGuest("tables:read tables:write");
    const guestB = await tokenForGuest("tables:read tables:write");
    const creator = await sdk(owner.token);
    const initial = await creator.callTool({
      name: "create_table",
      arguments: { ...input, request_id: "join_contenders_creator_001" },
    });
    const tableId = String(output(initial).tableId);
    const originalExpiry = String(output(initial).expiresAt);
    const issued = await creator.callTool({
      name: "create_invite",
      arguments: {
        table_id: tableId,
        request_id: "join_contenders_invite_001",
      },
    });
    expect(issued.isError).not.toBe(true);
    const invitation = String(output(issued).invitation);
    let entered = 0;
    let dropped = false;
    const overlay = {
      ...env,
      TABLES: {
        idFromName: (name: string) => env.TABLES.idFromName(name),
        get: (id: DurableObjectId): TableStub => {
          const stub = env.TABLES.get(id);
          return new Proxy(stub, {
            get(target, property) {
              if (property === "redeemInvite") {
                return async (
                  actor: VerifiedConnectionActor,
                  token: string,
                  key: string,
                ) => {
                  entered++;
                  for (
                    let attempt = 0;
                    entered < 2 && attempt < 500;
                    attempt++
                  ) {
                    await new Promise<void>((resolve) =>
                      setTimeout(resolve, 10),
                    );
                  }
                  if (entered < 2)
                    throw new Error("Redemption attempts did not overlap");
                  const result = await target.redeemInvite(actor, token, key);
                  if (result.ok && !dropped) {
                    dropped = true;
                    throw new Error("Injected committed join response loss");
                  }
                  return result;
                };
              }
              return Reflect.get(target, property, target);
            },
          });
        },
      } as Env["TABLES"],
    };
    const [a, b] = await Promise.all([
      sdk(guestA.token, fetchThroughWorker(overlay)),
      sdk(guestB.token, fetchThroughWorker(overlay)),
    ]);
    const originalKeyA = "joining_guest_a_request_001";
    const originalKeyB = "joining_guest_b_request_001";
    try {
      const [resultA, resultB] = await Promise.all([
        a.callTool({
          name: "join_table",
          arguments: { invitation, request_id: originalKeyA },
        }),
        b.callTool({
          name: "join_table",
          arguments: { invitation, request_id: originalKeyB },
        }),
      ]);
      expect(entered).toBe(2);
      expect(dropped).toBe(true);
      expect(resultA.isError).toBe(true);
      expect(resultB.isError).toBe(true);
      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      const winner = await runInDurableObject(
        table,
        async (_instance, state) => {
          const [row] = state.storage.sql
            .exec<{
              consumed_by: string;
              state: string;
              response_envelope: string | null;
            }>(
              "SELECT consumed_by, state, response_envelope FROM table_invitations",
            )
            .toArray();
          expect(row.state).toBe("consumed");
          expect(row.response_envelope).toBeNull();
          expect(
            state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
          ).toHaveLength(2);
          expect(
            state.storage.sql
              .exec<{ state: string }>("SELECT state FROM table_metadata")
              .one().state,
          ).toBe("open");
          return row.consumed_by;
        },
      );
      const winningClient = winner === guestA.guestId ? a : b;
      const losingClient = winner === guestA.guestId ? b : a;
      const winningKey =
        winner === guestA.guestId ? originalKeyA : originalKeyB;
      const losingKey = winner === guestA.guestId ? originalKeyB : originalKeyA;
      await evictDurableObject(table);
      const recovered = await winningClient.callTool({
        name: "join_table",
        arguments: { invitation, request_id: winningKey },
      });
      expect(recovered.isError).not.toBe(true);
      expect(output(recovered)).toMatchObject({
        tableId,
        state: "open",
        limits: { participants: 2 },
      });
      const membership = String(output(recovered).ownMembershipId);
      expect(output(recovered).expiresAt).toBe(originalExpiry);
      await runInDurableObject(table, async (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_invitations SET expires_at = ? WHERE state = 'consumed'",
          Date.now() - 1,
        );
      });
      const again = await winningClient.callTool({
        name: "join_table",
        arguments: { invitation, request_id: winningKey },
      });
      expect(output(again).ownMembershipId).toBe(membership);
      const denied = await losingClient.callTool({
        name: "join_table",
        arguments: { invitation, request_id: losingKey },
      });
      expect(denied.isError).toBe(true);
      const changedKey = await winningClient.callTool({
        name: "join_table",
        arguments: { invitation: "at1.invalid", request_id: winningKey },
      });
      expect(changedKey.isError).toBe(true);
      const alteredInvitation =
        invitation.slice(0, -1) + (invitation.endsWith("A") ? "B" : "A");
      const conflicting = await winningClient.callTool({
        name: "join_table",
        arguments: {
          invitation: alteredInvitation,
          request_id: winningKey,
        },
      });
      expect(conflicting.isError).toBe(true);
      expect(output(conflicting)).toMatchObject({
        error: { code: "IDEMPOTENCY_CONFLICT" },
      });
      const creatorRetry = await creator.callTool({
        name: "create_invite",
        arguments: {
          table_id: tableId,
          request_id: "join_contenders_invite_001",
        },
      });
      expect(creatorRetry.isError).toBe(true);
      expect(JSON.stringify(output(creatorRetry))).not.toContain(invitation);
      const read = await winningClient.callTool({
        name: "get_table",
        arguments: { table_id: tableId },
      });
      expect(output(read).ownMembershipId).toBe(membership);
      await runInDurableObject(table, async (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_metadata SET state = 'closed' WHERE singleton = 1",
        );
      });
      const afterClose = await winningClient.callTool({
        name: "join_table",
        arguments: { invitation, request_id: winningKey },
      });
      expect(afterClose.isError).not.toBe(true);
      expect(output(afterClose).ownMembershipId).toBe(membership);
      expect(output(afterClose).state).toBe("closed");
    } finally {
      await a.close();
      await b.close();
      await creator.close();
    }
  });

  it("uses the real OAuth SDK boundary for post retries, private reads and fixed snapshots", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const outsider = await tokenForGuest("tables:read tables:write");
    const invitee = await tokenForGuest("tables:read tables:write");
    const readOnly = await tokenForGuest("tables:read");
    const [client, stranger, peer, reader] = await Promise.all([
      sdk(owner.token),
      sdk(outsider.token),
      sdk(invitee.token),
      sdk(readOnly.token),
    ]);
    try {
      const created = await client.callTool({
        name: "create_table",
        arguments: {
          ...input,
          request_id: "sdk_transcript_create_0001",
        },
      });
      expect(created.isError).not.toBe(true);
      const metadata = output(created);
      const tableId = String(metadata.tableId);
      const body = "  é 😀\nPreserve whitespace  ";
      const original = {
        table_id: tableId,
        body,
        request_id: "sdk_transcript_post_0001",
      };
      const first = await client.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(first.isError).not.toBe(true);
      expect(output(first)).toMatchObject({
        table_id: tableId,
        seq: 1,
        persisted: true,
      });
      const receipt = output(first);
      const retry = await client.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(output(retry)).toEqual(receipt);
      const conflict = await client.callTool({
        name: "post_message",
        arguments: { ...original, body: "Changed" },
      });
      expect(conflict.isError).toBe(true);
      expect(output(conflict)).toMatchObject({
        error: { code: "IDEMPOTENCY_CONFLICT" },
      });
      const noGrant = await reader.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(noGrant.isError).toBe(true);
      expect(output(noGrant)).toMatchObject({
        error: { code: "NOT_AUTHORIZED" },
      });
      for (const peer of [stranger]) {
        const foreignRead = await peer.callTool({
          name: "read_messages",
          arguments: { table_id: tableId },
        });
        expect(foreignRead.isError).toBe(true);
        expect(output(foreignRead)).toMatchObject({
          error: { code: "TABLE_NOT_FOUND" },
        });
        const foreignPost = await peer.callTool({
          name: "post_message",
          arguments: { ...original, request_id: "sdk_foreign_post_0001" },
        });
        expect(foreignPost.isError).toBe(true);
        expect(output(foreignPost)).toMatchObject({
          error: { code: "TABLE_NOT_FOUND" },
        });
      }
      const issued = await client.callTool({
        name: "create_invite",
        arguments: {
          table_id: tableId,
          request_id: "sdk_transcript_prejoin_invite_0001",
        },
      });
      expect(issued.isError).not.toBe(true);
      const joined = await peer.callTool({
        name: "join_table",
        arguments: {
          invitation: output(issued).invitation,
          request_id: "sdk_transcript_prejoin_join_0001",
        },
      });
      expect(joined.isError).not.toBe(true);
      const prejoinRead = await peer.callTool({
        name: "read_messages",
        arguments: { table_id: tableId },
      });
      expect(prejoinRead.isError).not.toBe(true);
      expect(output(prejoinRead)).toMatchObject({
        through_seq: 1,
        messages: [{ seq: 1, body }],
        latest_peer_seq: 1,
      });
      const inboxUri = String(metadata.ownInboxUri);
      const peerInboxUri = String(output(joined).ownInboxUri);
      const peerInbox = await peer.readResource({ uri: peerInboxUri });
      const peerContent = peerInbox.contents.find(
        (entry) => entry.uri === peerInboxUri && "text" in entry,
      );
      if (!peerContent || !("text" in peerContent)) {
        throw new Error("Authenticated peer inbox resource missing");
      }
      expect(JSON.parse(peerContent.text)).toMatchObject({
        tableId,
        lastSeq: 1,
        latestPeerSeq: 1,
      });
      await expect(
        client.readResource({ uri: peerInboxUri }),
      ).rejects.toThrow();
      await expect(peer.readResource({ uri: inboxUri })).rejects.toThrow();
      const inbox = await client.readResource({ uri: inboxUri });
      const ownContent = inbox.contents.find(
        (entry) => entry.uri === inboxUri && "text" in entry,
      );
      if (!ownContent || !("text" in ownContent)) {
        throw new Error("Authenticated own-inbox resource missing");
      }
      expect(JSON.parse(ownContent.text)).toMatchObject({
        tableId,
        lastSeq: 1,
        latestPeerSeq: 0,
      });
      await expect(stranger.readResource({ uri: inboxUri })).rejects.toThrow();
      for (const [key, invalidBody] of [
        ["sdk_transcript_bad_whitespace_001", "  \n  "],
        ["sdk_transcript_bad_utf8_limit_001", "😀".repeat(2049)],
      ] as const) {
        const invalid = await client.callTool({
          name: "post_message",
          arguments: {
            table_id: tableId,
            request_id: key,
            body: invalidBody,
          },
        });
        expect(invalid.isError).toBe(true);
        expect(output(invalid)).toMatchObject({
          error: { code: "INVALID_REQUEST" },
        });
      }
      const firstPage = await client.callTool({
        name: "read_messages",
        arguments: { table_id: tableId, limit: 1 },
      });
      expect(firstPage.isError).not.toBe(true);
      expect(output(firstPage)).toMatchObject({
        through_seq: 1,
        next_after_seq: 1,
        has_more: false,
        messages: [{ seq: 1, body }],
      });
      const second = await client.callTool({
        name: "post_message",
        arguments: {
          table_id: tableId,
          body: "Later",
          request_id: "sdk_transcript_post_0002",
        },
      });
      expect(output(second)).toMatchObject({ seq: 2, persisted: true });
      const unchanged = await client.callTool({
        name: "read_messages",
        arguments: { table_id: tableId, after_seq: 1, through_seq: 1 },
      });
      expect(output(unchanged)).toMatchObject({
        messages: [],
        through_seq: 1,
        next_after_seq: 1,
        has_more: false,
      });
      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      await evictDurableObject(table);
      const replay = await client.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(output(replay)).toEqual(receipt);
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT * FROM table_messages").toArray(),
        ).toHaveLength(2);
        expect(
          state.storage.sql.exec("SELECT * FROM table_post_receipts").toArray(),
        ).toHaveLength(2);
      });
    } finally {
      await client.close();
      await stranger.close();
      await peer.close();
      await reader.close();
    }
  });

  it("rolls back a failed transcript insert and recovers with the same SDK request key", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const client = await sdk(owner.token);
    try {
      const created = await client.callTool({
        name: "create_table",
        arguments: {
          ...input,
          request_id: "sdk_transcript_fault_create_001",
        },
      });
      const tableId = String(output(created).tableId);
      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      await runInDurableObject(table, async (_instance, state) => {
        state.storage.sql.exec(
          "CREATE TRIGGER reject_transcript_insert BEFORE INSERT ON table_messages BEGIN SELECT RAISE(ABORT, 'injected-write-failure'); END",
        );
      });
      const original = {
        table_id: tableId,
        request_id: "sdk_transcript_fault_post_001",
        body: "Must be committed or absent",
      };
      const failed = await client.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(failed.isError).toBe(true);
      expect(output(failed)).toMatchObject({
        error: { code: "TEMPORARILY_UNAVAILABLE" },
      });
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT last_seq FROM table_metadata").one(),
        ).toMatchObject({ last_seq: 0 });
        expect(
          state.storage.sql.exec("SELECT * FROM table_messages").toArray(),
        ).toHaveLength(0);
        expect(
          state.storage.sql.exec("SELECT * FROM table_post_receipts").toArray(),
        ).toHaveLength(0);
        expect(
          state.storage.sql
            .exec("SELECT body_bytes FROM table_transcript_usage")
            .one(),
        ).toMatchObject({ body_bytes: 0 });
        state.storage.sql.exec("DROP TRIGGER reject_transcript_insert");
      });
      await evictDurableObject(table);
      const recovered = await client.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(recovered.isError).not.toBe(true);
      expect(output(recovered)).toMatchObject({ seq: 1, persisted: true });
      const exactRetry = await client.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(output(exactRetry)).toEqual(output(recovered));
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT * FROM table_messages").toArray(),
        ).toHaveLength(1);
        expect(
          state.storage.sql.exec("SELECT * FROM table_post_receipts").toArray(),
        ).toHaveLength(1);
      });
    } finally {
      await client.close();
    }
  });

  it("bounds two overlapping SDK post requests at the last rate-limit slot", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const peer = await tokenForGuest("tables:read tables:write");
    const creator = await sdk(owner.token);
    const invitee = await sdk(peer.token);
    try {
      const created = await creator.callTool({
        name: "create_table",
        arguments: {
          ...input,
          request_id: "sdk_transcript_race_create_001",
        },
      });
      const tableId = String(output(created).tableId);
      const issued = await creator.callTool({
        name: "create_invite",
        arguments: {
          table_id: tableId,
          request_id: "sdk_transcript_race_invite_001",
        },
      });
      const joined = await invitee.callTool({
        name: "join_table",
        arguments: {
          invitation: output(issued).invitation,
          request_id: "sdk_transcript_race_join_0001",
        },
      });
      expect(joined.isError).not.toBe(true);
      for (let i = 0; i < 9; i++) {
        const seed = await creator.callTool({
          name: "post_message",
          arguments: {
            table_id: tableId,
            body: `Seed ${i}`,
            request_id: `sdk_transcript_race_seed_${i}`,
          },
        });
        expect(seed.isError).not.toBe(true);
      }
      let entered = 0;
      const overlay: Env = {
        ...env,
        TABLES: {
          idFromName: (name: string) => env.TABLES.idFromName(name),
          get: (id: DurableObjectId): TableStub => {
            const stub = env.TABLES.get(id);
            return new Proxy(stub, {
              get(target, property) {
                if (property === "postMessage") {
                  return async (
                    actor: VerifiedConnectionActor,
                    value: unknown,
                  ) => {
                    entered++;
                    for (
                      let attempt = 0;
                      entered < 2 && attempt < 500;
                      attempt++
                    ) {
                      await new Promise<void>((resolve) =>
                        setTimeout(resolve, 10),
                      );
                    }
                    if (entered < 2)
                      throw new Error("SDK posts did not overlap");
                    return target.postMessage(actor, value);
                  };
                }
                return Reflect.get(target, property, target);
              },
            });
          },
        } as Env["TABLES"],
      };
      const [a, b] = await Promise.all([
        sdk(owner.token, fetchThroughWorker(overlay)),
        sdk(peer.token, fetchThroughWorker(overlay)),
      ]);
      const argsA = {
        table_id: tableId,
        request_id: "sdk_transcript_race_winner_a_001",
        body: "Competing creator",
      };
      const argsB = {
        table_id: tableId,
        request_id: "sdk_transcript_race_winner_b_001",
        body: "Competing invitee",
      };
      try {
        const results = await Promise.all([
          a.callTool({ name: "post_message", arguments: argsA }),
          b.callTool({ name: "post_message", arguments: argsB }),
        ]);
        expect(entered).toBe(2);
        expect(results.filter((result) => !result.isError)).toHaveLength(1);
        const winningIndex = results.findIndex((result) => !result.isError);
        const winner = winningIndex === 0 ? creator : invitee;
        const original = winningIndex === 0 ? argsA : argsB;
        const rejected = results[1 - winningIndex];
        expect(output(rejected)).toMatchObject({
          error: { code: "RATE_LIMITED" },
        });
        expect(output(results[winningIndex])).toMatchObject({
          seq: 10,
          persisted: true,
        });
        const table = env.TABLES.get(env.TABLES.idFromName(tableId));
        await evictDurableObject(table);
        const retry = await winner.callTool({
          name: "post_message",
          arguments: original,
        });
        expect(output(retry)).toEqual(output(results[winningIndex]));
        await runInDurableObject(table, async (_instance, state) => {
          expect(
            state.storage.sql.exec("SELECT last_seq FROM table_metadata").one(),
          ).toMatchObject({ last_seq: 10 });
          expect(
            state.storage.sql.exec("SELECT * FROM table_messages").toArray(),
          ).toHaveLength(10);
          expect(
            state.storage.sql
              .exec("SELECT * FROM table_post_receipts")
              .toArray(),
          ).toHaveLength(10);
        });
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await creator.close();
      await invitee.close();
    }
  });

  it("recovers a committed post after its TableDO response is lost through the SDK", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const primary = await sdk(owner.token);
    try {
      const created = await primary.callTool({
        name: "create_table",
        arguments: {
          ...input,
          request_id: "sdk_transcript_lost_create_001",
        },
      });
      const tableId = String(output(created).tableId);
      let dropped = false;
      const overlay: Env = {
        ...env,
        TABLES: {
          idFromName: (name: string) => env.TABLES.idFromName(name),
          get: (id: DurableObjectId): TableStub => {
            const stub = env.TABLES.get(id);
            return new Proxy(stub, {
              get(target, property) {
                if (property === "postMessage") {
                  return async (
                    actor: VerifiedConnectionActor,
                    value: unknown,
                  ) => {
                    const result = await target.postMessage(actor, value);
                    if (result.ok && !dropped) {
                      dropped = true;
                      throw new Error("Injected lost committed post response");
                    }
                    return result;
                  };
                }
                return Reflect.get(target, property, target);
              },
            });
          },
        } as Env["TABLES"],
      };
      const intercepted = await sdk(owner.token, fetchThroughWorker(overlay));
      const original = {
        table_id: tableId,
        request_id: "sdk_transcript_lost_post_0001",
        body: "One committed post only",
      };
      try {
        const ambiguous = await intercepted.callTool({
          name: "post_message",
          arguments: original,
        });
        expect(dropped).toBe(true);
        expect(ambiguous.isError).toBe(true);
        expect(output(ambiguous)).toMatchObject({
          error: { code: "TEMPORARILY_UNAVAILABLE" },
        });
      } finally {
        await intercepted.close();
      }
      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      const originalRow = await runInDurableObject(
        table,
        async (_instance, state) => {
          const rows = state.storage.sql
            .exec<{ message_id: string; seq: number }>(
              "SELECT message_id, seq FROM table_messages",
            )
            .toArray();
          expect(rows).toHaveLength(1);
          expect(
            state.storage.sql
              .exec("SELECT * FROM table_post_receipts")
              .toArray(),
          ).toHaveLength(1);
          return rows[0];
        },
      );
      await evictDurableObject(table);
      const recovered = await primary.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(recovered.isError).not.toBe(true);
      expect(output(recovered)).toMatchObject({
        message_id: originalRow.message_id,
        seq: originalRow.seq,
        persisted: true,
      });
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT * FROM table_messages").toArray(),
        ).toHaveLength(1);
      });
    } finally {
      await primary.close();
    }
  });
  it("keeps the 256-message and 2 MiB ceiling under competing authenticated SDK posts", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const peer = await tokenForGuest("tables:read tables:write");
    const creator = await sdk(owner.token);
    const invitee = await sdk(peer.token);
    try {
      const created = await creator.callTool({
        name: "create_table",
        arguments: {
          ...input,
          request_id: "sdk_capacity_table_create_0001",
        },
      });
      const tableId = String(output(created).tableId);
      const invited = await creator.callTool({
        name: "create_invite",
        arguments: {
          table_id: tableId,
          request_id: "sdk_capacity_invite_0001",
        },
      });
      const joined = await invitee.callTool({
        name: "join_table",
        arguments: {
          invitation: output(invited).invitation,
          request_id: "sdk_capacity_join_000001",
        },
      });
      expect(joined.isError).not.toBe(true);

      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      const ownerMembershipId = String(output(created).ownMembershipId);
      const peerMembershipId = String(output(joined).ownMembershipId);
      const historicalBody = "H".repeat(TABLE_LIMITS.messageBodyBytes);
      const historicalTime = Date.now() - 120_000;
      // Seed the equivalent of 255 old committed posts in SQLite, rather than
      // running 255 expensive OAuth/SDK calls. Keep the receipt and byte
      // ledgers consistent; only the final competing posts use the live SDK.
      await runInDurableObject(table, async (_instance, state) => {
        state.storage.sql.exec(
          `WITH RECURSIVE seed(n) AS (
             SELECT 1 UNION ALL SELECT n + 1 FROM seed WHERE n < 255
           )
           INSERT INTO table_messages
             (seq, message_id, sender_membership_id, body, body_bytes, created_at, reply_to_message_id)
           SELECT n, printf('00000000-0000-4000-8000-%012d', n), ?, ?, ?, ?, NULL
           FROM seed`,
          ownerMembershipId,
          historicalBody,
          TABLE_LIMITS.messageBodyBytes,
          historicalTime,
        );
        state.storage.sql.exec(
          `WITH RECURSIVE seed(n) AS (
             SELECT 1 UNION ALL SELECT n + 1 FROM seed WHERE n < 255
           )
           INSERT INTO table_post_receipts (guest_id, request_id, request_digest, message_seq)
           SELECT ?, printf('sdk_seed_capacity_%04d', n), ?, n FROM seed`,
          owner.guestId,
          "0".repeat(64),
        );
        state.storage.sql.exec(
          "UPDATE table_metadata SET last_seq = 255 WHERE singleton = 1",
        );
        state.storage.sql.exec(
          "UPDATE table_transcript_usage SET body_bytes = ? WHERE singleton = 1",
          255 * TABLE_LIMITS.messageBodyBytes,
        );
        state.storage.sql.exec(
          "UPDATE table_memberships SET latest_peer_seq = 255 WHERE membership_id = ?",
          peerMembershipId,
        );
      });

      await runInDurableObject(table, async (instance) => {
        const testInstance = instance as unknown as {
          transcriptCommitBarrierEnabledForTest: boolean;
        };
        testInstance.transcriptCommitBarrierEnabledForTest = true;
      });
      const [a, b] = await Promise.all([sdk(owner.token), sdk(peer.token)]);
      const argsA = {
        table_id: tableId,
        request_id: "sdk_capacity_final_owner_0001",
        body: "🧪".repeat(2048),
      };
      const argsB = {
        table_id: tableId,
        request_id: "sdk_capacity_final_peer_0001",
        body: "B".repeat(TABLE_LIMITS.messageBodyBytes),
      };
      try {
        const results = await Promise.all([
          a.callTool({ name: "post_message", arguments: argsA }),
          b.callTool({ name: "post_message", arguments: argsB }),
        ]);
        const arrivals = await runInDurableObject(table, async (instance) => {
          const testInstance = instance as unknown as {
            transcriptCommitBarrierArrivalsForTest: number;
            transcriptCommitBarrierOverlappedForTest: boolean;
          };
          return {
            count: testInstance.transcriptCommitBarrierArrivalsForTest,
            overlapped: testInstance.transcriptCommitBarrierOverlappedForTest,
          };
        });
        expect(arrivals).toEqual({ count: 2, overlapped: true });
        expect(results.filter((result) => !result.isError)).toHaveLength(1);
        const winnerIndex = results.findIndex((result) => !result.isError);
        const winner = winnerIndex === 0 ? creator : invitee;
        const winnerArgs = winnerIndex === 0 ? argsA : argsB;
        const accepted = output(results[winnerIndex]);
        expect(accepted).toMatchObject({ seq: 256, persisted: true });
        expect(output(results[1 - winnerIndex])).toMatchObject({
          error: { code: "LIMIT_REACHED" },
        });
        await evictDurableObject(table);
        const replay = await winner.callTool({
          name: "post_message",
          arguments: winnerArgs,
        });
        expect(output(replay)).toEqual(accepted);
        await runInDurableObject(table, async (_instance, state) => {
          expect(
            state.storage.sql.exec("SELECT last_seq FROM table_metadata").one(),
          ).toEqual({ last_seq: 256 });
          expect(
            state.storage.sql
              .exec("SELECT body_bytes FROM table_transcript_usage")
              .one(),
          ).toEqual({ body_bytes: TABLE_LIMITS.transcriptBodyBytes });
          expect(
            state.storage.sql
              .exec("SELECT COUNT(*) AS total FROM table_messages")
              .one(),
          ).toEqual({ total: 256 });
          expect(
            state.storage.sql
              .exec("SELECT COUNT(*) AS total FROM table_post_receipts")
              .one(),
          ).toEqual({ total: 256 });
          expect(
            state.storage.sql
              .exec("SELECT message_id FROM table_messages WHERE seq = 256")
              .one(),
          ).toEqual({ message_id: accepted.message_id });
        });
      } finally {
        await runInDurableObject(table, async (instance) => {
          const testInstance = instance as unknown as {
            transcriptCommitBarrierEnabledForTest: boolean;
          };
          testInstance.transcriptCommitBarrierEnabledForTest = false;
        });
        await a.close();
        await b.close();
      }
    } finally {
      await creator.close();
      await invitee.close();
    }
  }, 10_000);

  it("rejects SDK posts against the aggregate byte budget before the message-count ceiling", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const creator = await sdk(owner.token);
    try {
      const created = await creator.callTool({
        name: "create_table",
        arguments: {
          ...input,
          request_id: "sdk_byte_budget_create_0001",
        },
      });
      expect(created.isError).not.toBe(true);
      const tableId = String(output(created).tableId);
      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      // These default ceilings coincide for valid full-size bodies:
      // 256 * 8 KiB = 2 MiB. A controlled storage budget fixture isolates
      // the aggregate-byte branch without reaching the message-count ceiling.
      await runInDurableObject(table, async (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_transcript_usage SET body_bytes = ? WHERE singleton = 1",
          TABLE_LIMITS.transcriptBodyBytes - 4,
        );
      });
      const overflow = await creator.callTool({
        name: "post_message",
        arguments: {
          table_id: tableId,
          request_id: "sdk_byte_budget_overflow_001",
          body: "12345",
        },
      });
      expect(overflow.isError).toBe(true);
      expect(output(overflow)).toMatchObject({
        error: { code: "LIMIT_REACHED" },
      });
      const justFits = {
        table_id: tableId,
        request_id: "sdk_byte_budget_exact_0001",
        body: "1234",
      };
      const accepted = await creator.callTool({
        name: "post_message",
        arguments: justFits,
      });
      expect(accepted.isError).not.toBe(true);
      expect(output(accepted)).toMatchObject({ seq: 1, persisted: true });
      await evictDurableObject(table);
      const retried = await creator.callTool({
        name: "post_message",
        arguments: justFits,
      });
      expect(output(retried)).toEqual(output(accepted));
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql.exec("SELECT last_seq FROM table_metadata").one(),
        ).toEqual({ last_seq: 1 });
        expect(
          state.storage.sql
            .exec("SELECT body_bytes FROM table_transcript_usage")
            .one(),
        ).toEqual({ body_bytes: TABLE_LIMITS.transcriptBodyBytes });
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS total FROM table_messages")
            .one(),
        ).toEqual({ total: 1 });
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS total FROM table_post_receipts")
            .one(),
        ).toEqual({ total: 1 });
      });
    } finally {
      await creator.close();
    }
  });
  it("closes a shared table via the authenticated SDK and keeps only earlier posts readable", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const creator = await sdk(owner.token);
    const guest = await tokenForGuest("tables:read tables:write");
    const outsider = await sdk(guest.token);
    try {
      const created = await creator.callTool({
        name: "create_table",
        arguments: { ...input, request_id: "sdk_lifecycle_create_0001" },
      });
      expect(created.isError).not.toBe(true);
      const tableId = String(output(created).tableId);
      const original = {
        table_id: tableId,
        request_id: "sdk_lifecycle_post_0001",
        body: "A synthetic completed message",
      };
      const first = await creator.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(first.isError).not.toBe(true);
      const closeRequest = {
        table_id: tableId,
        request_id: "sdk_lifecycle_close_0001",
      };
      const forbidden = await outsider.callTool({
        name: "close_table",
        arguments: closeRequest,
      });
      expect(forbidden.isError).toBe(true);
      expect(output(forbidden)).toMatchObject({
        error: { code: "TABLE_NOT_FOUND" },
      });
      const closed = await creator.callTool({
        name: "close_table",
        arguments: closeRequest,
      });
      expect(closed.isError).not.toBe(true);
      expect(output(closed)).toMatchObject({
        table_id: tableId,
        state: "closed",
        expires_at: output(created).expiresAt,
      });
      const replay = await creator.callTool({
        name: "close_table",
        arguments: closeRequest,
      });
      expect(output(replay)).toEqual(output(closed));
      const oldPost = await creator.callTool({
        name: "post_message",
        arguments: original,
      });
      expect(output(oldPost)).toEqual(output(first));
      const newPost = await creator.callTool({
        name: "post_message",
        arguments: {
          table_id: tableId,
          request_id: "sdk_lifecycle_post_late_0001",
          body: "Must never commit",
        },
      });
      expect(newPost.isError).toBe(true);
      expect(output(newPost)).toMatchObject({
        error: { code: "TABLE_TERMINAL" },
      });
      const page = await creator.callTool({
        name: "read_messages",
        arguments: { table_id: tableId },
      });
      expect(page.isError).not.toBe(true);
      expect(output(page)).toMatchObject({
        messages: [{ seq: 1, body: original.body }],
      });
      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      await evictDurableObject(table);
      const afterEviction = await creator.callTool({
        name: "get_table",
        arguments: { table_id: tableId },
      });
      expect(output(afterEviction)).toMatchObject({ state: "closed", tableId });
      await runInDurableObject(table, async (_instance, state) => {
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS n FROM table_messages")
            .one(),
        ).toEqual({ n: 1 });
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS n FROM table_post_receipts")
            .one(),
        ).toEqual({ n: 1 });
      });
    } finally {
      await creator.close();
      await outsider.close();
    }
  });
});
