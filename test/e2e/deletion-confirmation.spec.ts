import { createHash, randomBytes } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { type APIResponse, expect, test } from "@playwright/test";

const ORIGIN = "http://localhost:8787";
const REDIRECT = "https://client.example/callback";
const RESOURCE = "http://localhost:8787/mcp";

function cookieFrom(response: APIResponse, name: string): string {
  const header = response
    .headersArray()
    .find(
      (entry) =>
        entry.name.toLowerCase() === "set-cookie" &&
        entry.value.startsWith(`${name}=`),
    )?.value;
  if (!header) throw new Error("Missing authentication cookie");
  return header.split(";")[0];
}

function toolOutput(result: Awaited<ReturnType<Client["callTool"]>>) {
  const text = result.content.find((entry) => entry.type === "text");
  if (text?.type !== "text") throw new Error("No tool result");
  return JSON.parse(text.text) as Record<string, unknown>;
}

test("official SDK deletion requires an explicit same-guest browser POST", async ({
  request,
  page,
  context,
}) => {
  // A fresh guest and OAuth consent are required before any model tool call.
  const landing = await request.get("/guest");
  const csrf = (await landing.text()).match(
    /name="csrf" value="([A-Za-z0-9_-]{43})"/,
  )?.[1];
  if (!csrf) throw new Error("Missing guest session CSRF");
  const guestCsrf = cookieFrom(landing, "__Host-agent_table_csrf");
  const signedIn = await request.post("/guest/session", {
    headers: { Origin: ORIGIN, Cookie: guestCsrf },
    form: { choice: "new", csrf },
    maxRedirects: 0,
  });
  expect(signedIn.status()).toBe(303);
  const originalCookie = cookieFrom(signedIn, "__Host-agent_table_session");

  const registered = await request.post("/oauth/register", {
    data: {
      client_name: "Deletion browser E2E",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    },
  });
  expect(registered.status()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as {
    client_id: string;
  };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL("/authorize", ORIGIN);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "tables:read tables:write tables:delete",
    state: "browser_deletion_e2e",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  })) {
    authorization.searchParams.set(key, value);
  }
  const consent = await request.get(authorization.toString(), {
    headers: { Cookie: originalCookie },
  });
  expect(consent.status()).toBe(200);
  const markup = await consent.text();
  const hidden = (name: string) =>
    new RegExp(`name="${name}" type="hidden" value="([^"]+)"`).exec(
      markup,
    )?.[1];
  const handle = hidden("handle");
  const consentCsrf = hidden("csrf");
  const binding = hidden("binding");
  const guestId = hidden("guest_id");
  if (!handle || !consentCsrf || !binding || !guestId) {
    throw new Error("Missing OAuth consent inputs");
  }
  const consentCookies = consent
    .headersArray()
    .filter((entry) => entry.name.toLowerCase() === "set-cookie")
    .map((entry) => entry.value.split(";")[0]);
  const approved = await request.post("/authorize", {
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: [originalCookie, ...consentCookies].join("; "),
    },
    data: new URLSearchParams([
      ["handle", handle],
      ["csrf", consentCsrf],
      ["binding", binding],
      ["guest_id", guestId],
      ["decision", "approve"],
      ["scope", "tables:read"],
      ["scope", "tables:write"],
      ["scope", "tables:delete"],
    ]).toString(),
    maxRedirects: 0,
  });
  expect(approved.status()).toBe(302);
  const browserCookie = cookieFrom(approved, "__Host-agent_table_session");
  const authorizationCode = new URL(
    approved.headers().location ?? REDIRECT,
  ).searchParams.get("code");
  if (!authorizationCode) throw new Error("Missing authorization code");
  const exchanged = await request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      client_id: clientId,
      code: authorizationCode,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    },
  });
  expect(exchanged.status()).toBe(200);
  const { access_token: accessToken } = (await exchanged.json()) as {
    access_token: string;
  };
  const client = new Client(
    { name: "browser-deletion-e2e", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    );
    const created = await client.callTool({
      name: "create_table",
      arguments: {
        request_id: "e2e_browser_delete_create_0001",
        title: "Browser must confirm first",
      },
    });
    expect(created.isError).not.toBe(true);
    const tableId = String(toolOutput(created).tableId);
    expect(
      (
        await client.callTool({
          name: "post_message",
          arguments: {
            table_id: tableId,
            request_id: "e2e_browser_delete_post_0001",
            body: "Never erase by GET",
          },
        })
      ).isError,
    ).not.toBe(true);

    const operation = {
      table_id: tableId,
      request_id: "e2e_browser_delete_request_0001",
    };
    const pending = await client.callTool({
      name: "delete_table",
      arguments: operation,
    });
    expect(pending.isError).not.toBe(true);
    const receipt = toolOutput(pending);
    expect(receipt.confirmation_required).toBe(true);
    const link = String(receipt.confirmation_url);

    // A public URL is routing information, not permission.
    await page.goto(link);
    await expect(page.locator("body")).toContainText(
      "valid guest browser session",
    );
    const stillThere = await client.callTool({
      name: "read_messages",
      arguments: { table_id: tableId },
    });
    expect(toolOutput(stillThere)).toMatchObject({
      messages: [{ body: "Never erase by GET" }],
    });

    const browserValue = browserCookie.split("=").slice(1).join("=");
    await context.addCookies([
      {
        name: "__Host-agent_table_session",
        value: browserValue,
        url: ORIGIN,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto(link);
    await expect(
      page.getByRole("button", { name: "Permanently delete shared content" }),
    ).toBeVisible();
    expect(
      toolOutput(
        await client.callTool({
          name: "read_messages",
          arguments: { table_id: tableId },
        }),
      ),
    ).toMatchObject({ messages: [{ seq: 1 }] });
    await page
      .getByRole("button", { name: "Permanently delete shared content" })
      .click();
    await expect(page.locator("main")).toContainText("Deletion committed");
    const after = await client.callTool({
      name: "read_messages",
      arguments: { table_id: tableId },
    });
    expect(after.isError).toBe(true);
    expect(
      toolOutput(
        await client.callTool({
          name: "delete_table",
          arguments: operation,
        }),
      ),
    ).toMatchObject({
      confirmation_required: false,
      state: "deleted",
    });
  } finally {
    await client.close();
  }
});
