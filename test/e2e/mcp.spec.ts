import { createHash, randomBytes } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { type APIResponse, expect, test } from "@playwright/test";

const ORIGIN = "http://localhost:8787";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example/callback";

function responseCookie(response: APIResponse, name: string): string {
  const header = response
    .headersArray()
    .find(
      (item) =>
        item.name.toLowerCase() === "set-cookie" &&
        item.value.startsWith(`${name}=`),
    )?.value;
  if (!header) throw new Error("Expected OAuth test cookie missing");
  return header.split(";")[0];
}

test("official SDK negotiates against the authenticated live Wrangler HTTP server", async ({
  request,
}) => {
  // The anonymous protocol endpoint must challenge instead of exposing private tools.
  const unauthorized = await request.post("/mcp", {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {},
    },
  });
  expect(unauthorized.status()).toBe(401);
  expect(unauthorized.headers()["www-authenticate"]).toContain(
    "resource_metadata=",
  );

  // Create an explicitly chosen browser guest on the isolated test Worker.
  const guestPage = await request.get("/guest");
  expect(guestPage.status()).toBe(200);
  const guestCsrf = (await guestPage.text()).match(
    /name="csrf" value="([A-Za-z0-9_-]{43})"/,
  )?.[1];
  if (!guestCsrf) throw new Error("Guest creation form CSRF missing");
  const guestCsrfCookie = responseCookie(guestPage, "__Host-agent_table_csrf");
  const created = await request.post("/guest/session", {
    headers: { Origin: ORIGIN, Cookie: guestCsrfCookie },
    form: { choice: "new", csrf: guestCsrf },
    maxRedirects: 0,
  });
  expect(created.status()).toBe(303);
  const sessionCookie = responseCookie(created, "__Host-agent_table_session");

  // Exercise the real provider's DCR, PKCE and browser consent over HTTP.
  const registration = await request.post("/oauth/register", {
    data: {
      client_name: "Synthetic live SDK client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    },
  });
  expect(registration.status()).toBe(201);
  const { client_id: clientId } = (await registration.json()) as {
    client_id: string;
  };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = new URL(`${ORIGIN}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "tables:read",
    state: "synthetic_live_sdk_test",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  })) {
    authUrl.searchParams.set(key, value);
  }
  const consent = await request.get(authUrl.toString(), {
    headers: { Cookie: sessionCookie },
  });
  expect(consent.status()).toBe(200);
  const html = await consent.text();
  const handle = html.match(/name="handle" type="hidden" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" type="hidden" value="([^"]+)"/)?.[1];
  const guestId = html.match(
    /name="guest_id" type="hidden" value="([^"]+)"/,
  )?.[1];
  const binding = html.match(
    /name="binding" type="hidden" value="([^"]+)"/,
  )?.[1];
  if (!handle || !csrf || !guestId || !binding)
    throw new Error("OAuth consent form is incomplete");
  // Preserve all provider-issued handle cookies, not only the CSRF cookie.
  const consentCookies = consent
    .headersArray()
    .filter((item) => item.name.toLowerCase() === "set-cookie")
    .map((item) => item.value.split(";")[0]);
  expect(
    consentCookies.some((item) =>
      item.startsWith("__Host-agent_table_oauth_csrf="),
    ),
  ).toBe(true);
  const approved = await request.post("/authorize", {
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      Cookie: [sessionCookie, ...consentCookies].join("; "),
    },
    form: {
      handle,
      csrf,
      guest_id: guestId,
      binding,
      decision: "approve",
      scope: "tables:read",
    },
    maxRedirects: 0,
  });
  expect(approved.status()).toBe(302);
  const location = approved.headers().location;
  if (!location) throw new Error("OAuth authorization redirect is missing");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("OAuth authorization code is missing");
  const exchanged = await request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    },
  });
  expect(exchanged.status()).toBe(200);
  const { access_token: accessToken } = (await exchanged.json()) as {
    access_token: string;
  };
  expect(typeof accessToken).toBe("string");

  const client = new Client(
    { name: "live-http-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        requestInit: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      }),
    );
    expect(client.getProtocolEra()).toBe("modern");
    // Table tools are now advertised only after authorized MCP setup.
    expect(client.getServerCapabilities()?.tools).toMatchObject({
      listChanged: true,
    });
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "close_table",
      "create_invite",
      "create_table",
      "delete_table",
      "get_table",
      "join_table",
      "post_message",
      "read_messages",
    ]);
    expect(
      listed.tools.find((tool) => tool.name === "create_table")?.annotations,
    ).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(
      listed.tools.find((tool) => tool.name === "get_table")?.annotations,
    ).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    // A read-only OAuth grant cannot create a table, even if the tool is listed.
    const rejected = await client.callTool({
      name: "create_table",
      arguments: {
        request_id: "live_read_only_request_001",
        title: "Should not create",
      },
    });
    expect(rejected.isError).toBe(true);
    const message = rejected.content.find((entry) => entry.type === "text");
    expect(
      message?.type === "text" ? JSON.parse(message.text) : null,
    ).toMatchObject({
      error: { code: "NOT_AUTHORIZED" },
    });
  } finally {
    await client.close();
  }
});
