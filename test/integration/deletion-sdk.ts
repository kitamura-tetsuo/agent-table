import { exports } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const ORIGIN = "http://localhost:8787";
const REDIRECT = "https://client.example/callback";
const RESOURCE = `${ORIGIN}/mcp`;

/** Use the real OAuth/consent endpoints and official MCP SDK in Worker tests. */
export async function deletionSdkForBrowserGuest(
  guestId: string,
  originalCookie: string,
) {
  const registered = await exports.default.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Deletion failure regression",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  if (registered.status !== 201) throw new Error("OAuth registration failed");
  const { client_id: clientId } = (await registered.json()) as {
    client_id: string;
  };
  const verifier = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...hash))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const authorizeUrl = new URL(`${ORIGIN}/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "tables:read tables:write tables:delete",
    state: "deletion_storage_failure",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  })) {
    authorizeUrl.searchParams.set(name, value);
  }
  const consent = await exports.default.fetch(authorizeUrl.toString(), {
    headers: { Cookie: originalCookie },
  });
  if (consent.status !== 200) throw new Error("OAuth consent page missing");
  const markup = await consent.text();
  const field = (name: string) =>
    new RegExp(`name="${name}" type="hidden" value="([^"]+)"`).exec(
      markup,
    )?.[1];
  const handle = field("handle");
  const csrf = field("csrf");
  const binding = field("binding");
  if (!handle || !csrf || !binding) throw new Error("Consent form incomplete");
  const formCookies = consent.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]);
  const accepted = await exports.default.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: [originalCookie, ...formCookies].join("; "),
    },
    body: new URLSearchParams([
      ["handle", handle],
      ["csrf", csrf],
      ["guest_id", guestId],
      ["binding", binding],
      ["decision", "approve"],
      ["scope", "tables:read"],
      ["scope", "tables:write"],
      ["scope", "tables:delete"],
    ]),
  });
  if (accepted.status !== 302) throw new Error("OAuth consent failed");
  const code = new URL(
    accepted.headers.get("Location") ?? REDIRECT,
  ).searchParams.get("code");
  const cookie = accepted.headers
    .getSetCookie()
    .find((line) => line.startsWith("__Host-agent_table_session="))
    ?.split(";")[0];
  if (!code || !cookie) throw new Error("OAuth approval result incomplete");
  const exchanged = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  if (exchanged.status !== 200) throw new Error("OAuth token exchange failed");
  const { access_token: accessToken } = (await exchanged.json()) as {
    access_token: string;
  };
  const client = new Client(
    { name: "deletion-failure-regression", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    authProvider: { token: async () => accessToken },
    fetch: (url, init) => {
      const request = new Request(url, init);
      request.headers.set("Host", new URL(request.url).host);
      return exports.default.fetch(request);
    },
  });
  await client.connect(transport);
  const segments = cookie.split("=")[1].split(".");
  const [version, returnedId, sessionId, secret] = segments;
  if (version !== "v1" || returnedId !== guestId || !sessionId || !secret) {
    await client.close();
    throw new Error("Invalid rotated session cookie");
  }
  return {
    client,
    cookie,
    credential: { guestId, sessionId, secret },
  };
}
