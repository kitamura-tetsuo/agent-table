import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

const ORIGIN = "http://localhost:8787";
const REDIRECT = "https://client.example/callback";
const RESOURCE = `${ORIGIN}/mcp`;

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
    refreshToken: String(tokens.refresh_token),
    clientId,
    connectionId: liveGrants?.[0].connectionId ?? "",
    browserCookie: rotatedCookie?.split(";")[0] ?? "",
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

describe("Privacy-safe invitation and storage telemetry through OAuth/MCP", () => {
  it("records privacy-safe invitation failures and durable post commits through real OAuth/MCP calls", async () => {
    const owner = await tokenForGuest("tables:read tables:write");
    const peer = await tokenForGuest("tables:read tables:write");
    const creator = await sdk(owner.token);
    const joiner = await sdk(peer.token);
    const privateTitle = `private-title-${crypto.randomUUID()}`;
    const privateBody = `private-message-${crypto.randomUUID()}`;
    const invalidInvitation = `invalid-invitation-${crypto.randomUUID()}`;
    const captured: string[] = [];
    const recorder = vi.spyOn(console, "log").mockImplementation((value) => {
      if (value && typeof value === "object" && "schema" in value) {
        captured.push(JSON.stringify(value));
      }
    });
    try {
      const created = await creator.callTool({
        name: "create_table",
        arguments: {
          request_id: "telemetry_mcp_create_0001",
          title: privateTitle,
        },
      });
      expect(created.isError).not.toBe(true);
      const tableId = String(output(created).tableId);
      const invalid = await joiner.callTool({
        name: "join_table",
        arguments: {
          invitation: invalidInvitation,
          request_id: "telemetry_mcp_invalid_join_0001",
        },
      });
      expect(invalid.isError).toBe(true);
      expect(output(invalid)).toMatchObject({
        error: { code: "INVITATION_INVALID" },
      });

      const issued = await creator.callTool({
        name: "create_invite",
        arguments: {
          table_id: tableId,
          request_id: "telemetry_mcp_issue_0001",
        },
      });
      expect(issued.isError).not.toBe(true);
      const invitationSecret = String(output(issued).invitation);
      const joined = await joiner.callTool({
        name: "join_table",
        arguments: {
          invitation: invitationSecret,
          request_id: "telemetry_mcp_valid_join_0001",
        },
      });
      expect(joined.isError).not.toBe(true);
      const eventRows = () =>
        captured.map((line) => JSON.parse(line) as Record<string, unknown>);
      const inviteEvents = eventRows().filter(
        (event) => event.kind === "invitation",
      );
      expect(inviteEvents).toEqual([
        expect.objectContaining({
          operation: "join_table",
          outcome: "rejected",
          failureCategory: "invalid",
        }),
        expect.objectContaining({
          operation: "create_invite",
          outcome: "accepted",
          failureCategory: "none",
        }),
        expect.objectContaining({
          operation: "join_table",
          outcome: "accepted",
          failureCategory: "none",
        }),
      ]);

      const first = {
        table_id: tableId,
        request_id: "telemetry_mcp_first_post_0001",
        body: privateBody,
      };
      const second = {
        table_id: tableId,
        request_id: "telemetry_mcp_second_post_0001",
        body: `another-private-body-${crypto.randomUUID()}`,
      };
      const firstResult = await creator.callTool({
        name: "post_message",
        arguments: first,
      });
      expect(firstResult.isError).not.toBe(true);
      const sameResult = await creator.callTool({
        name: "post_message",
        arguments: first,
      });
      expect(output(sameResult)).toEqual(output(firstResult));
      const refused = await creator.callTool({
        name: "post_message",
        arguments: { ...first, body: second.body },
      });
      expect(refused.isError).toBe(true);
      expect(output(refused)).toMatchObject({
        error: { code: "IDEMPOTENCY_CONFLICT" },
      });
      const secondResult = await creator.callTool({
        name: "post_message",
        arguments: second,
      });
      expect(secondResult.isError).not.toBe(true);

      const lost = {
        table_id: tableId,
        request_id: "telemetry_mcp_lost_post_0001",
        body: `lost-response-private-${crypto.randomUUID()}`,
      };
      let dropped = false;
      const flaky = await sdk(owner.token, async (request) => {
        let isLostPost = false;
        if (request.method === "POST") {
          try {
            const payload = (await request.clone().json()) as {
              method?: string;
              params?: { name?: string; arguments?: { request_id?: string } };
            };
            isLostPost =
              payload.method === "tools/call" &&
              payload.params?.name === "post_message" &&
              payload.params.arguments?.request_id === lost.request_id;
          } catch {
            // Other MCP requests are forwarded unchanged.
          }
        }
        const response = await exports.default.fetch(request);
        if (isLostPost && !dropped) {
          dropped = true;
          throw new Error("Synthetic transport response loss");
        }
        return response;
      });
      try {
        await expect(
          flaky.callTool({ name: "post_message", arguments: lost }),
        ).rejects.toThrow();
        expect(dropped).toBe(true);
      } finally {
        await flaky.close();
      }
      const recovered = await creator.callTool({
        name: "post_message",
        arguments: lost,
      });
      expect(recovered.isError).not.toBe(true);
      expect(output(recovered)).toMatchObject({ seq: 3, persisted: true });

      const table = env.TABLES.get(env.TABLES.idFromName(tableId));
      const authoritative = await runInDurableObject(
        table,
        async (_instance, state) => ({
          messages: state.storage.sql
            .exec<{ total: number }>(
              "SELECT COUNT(*) AS total FROM table_messages",
            )
            .one().total,
          receipts: state.storage.sql
            .exec<{ total: number }>(
              "SELECT COUNT(*) AS total FROM table_post_receipts",
            )
            .one().total,
        }),
      );
      const commits = eventRows().filter(
        (event) =>
          event.kind === "commit" && event.operation === "post_message",
      );
      expect(authoritative).toEqual({ messages: 3, receipts: 3 });
      expect(commits).toHaveLength(authoritative.messages);
      expect(commits).toHaveLength(authoritative.receipts);
      expect(commits.every((event) => event.outcome === "committed")).toBe(
        true,
      );
      expect(
        commits.every(
          (event) =>
            Object.keys(event).sort().join(",") ===
            "durationMs,kind,operation,outcome,schema",
        ),
      ).toBe(true);
      const artifact = captured.join("\n");
      for (const sentinel of [
        privateTitle,
        privateBody,
        second.body,
        lost.body,
        invalidInvitation,
        invitationSecret,
        owner.token,
        peer.token,
      ]) {
        expect(artifact).not.toContain(sentinel);
      }
      expect(artifact).not.toContain('"hostRun"');
      expect(artifact).not.toContain('"receiver"');
    } finally {
      recorder.mockRestore();
      await creator.close();
      await joiner.close();
    }
  });
});

