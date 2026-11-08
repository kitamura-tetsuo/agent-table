import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { canonicalMcpResource } from "../../src/auth/provider";

const ORIGIN = "http://localhost:8787";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example/callback";

function jsonUrl(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

async function register() {
  const result = await exports.default.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Synthetic OAuth client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(result.status).toBe(201);
  const info = await jsonUrl(result);
  return String(info.client_id);
}

async function start(clientId: string, extra: Record<string, string> = {}) {
  const verifier = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const bytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(verifier),
  ));
  const challenge = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const url = new URL(`${ORIGIN}/authorize`);
  const params = {
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
    scope: "tables:read tables:write", state: "synthetic_state",
    code_challenge: challenge, code_challenge_method: "S256",
    resource: RESOURCE, ...extra,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url: String(url), verifier };
}

describe("OAuth library and consent boundary", () => {
  it("advertises DCR, PKCE and exact canonical resource without OIDC scope", async () => {
    expect(canonicalMcpResource(env)).toBe(RESOURCE);
    const metadata = await exports.default.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    const data = await jsonUrl(metadata);
    expect(data.issuer).toBe(ORIGIN);
    expect(data.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(data.code_challenge_methods_supported).toContain("S256");
    expect(data.scopes_supported).toEqual([
      "tables:read", "tables:write", "tables:delete", "events:subscribe",
    ]);
    expect(data.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
  });

  it("does not create a grant from a GET without a browser guest", async () => {
    const clientId = await register();
    const { url } = await start(clientId);
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects invalid redirect and PKCE downgrade before consent", async () => {
    const clientId = await register();
    const attempts: Record<string, string>[] = [
      { redirect_uri: "https://evil.example/callback" },
      { code_challenge_method: "plain" },
    ];
    for (const extra of attempts) {
      const { url } = await start(clientId, extra);
      const result = await exports.default.fetch(url);
      expect(result.status).not.toBe(302);
      expect(result.headers.get("location")).toBeNull();
    }
  });

  it("does not accept a token endpoint code replay or invented grant", async () => {
    const clientId = await register();
    const response = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId, grant_type: "authorization_code",
        code: "invented", redirect_uri: REDIRECT, code_verifier: "A".repeat(43),
        resource: RESOURCE,
      }),
    });
    expect(response.status).toBe(400);
    const body = await jsonUrl(response);
    expect(body.error).toBe("invalid_grant");
  });
});
