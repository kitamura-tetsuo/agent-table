import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

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

async function sdk(token: string) {
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
      return exports.default.fetch(request);
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
