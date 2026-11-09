import { evictDurableObject, runInDurableObject } from "cloudflare:test";
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
  const verifier =
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const url = new URL(`${ORIGIN}/authorize`);
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "tables:read tables:write",
    state: "synthetic_state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...extra,
  };
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  return { url: String(url), verifier };
}

describe("OAuth library and consent boundary", () => {
  it("advertises DCR, PKCE and exact canonical resource without OIDC scope", async () => {
    expect(canonicalMcpResource(env)).toBe(RESOURCE);
    const metadata = await exports.default.fetch(
      `${ORIGIN}/.well-known/oauth-authorization-server`,
    );
    expect(metadata.status).toBe(200);
    const data = await jsonUrl(metadata);
    expect(data.issuer).toBe(ORIGIN);
    expect(data.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(data.code_challenge_methods_supported).toContain("S256");
    expect(data.scopes_supported).toEqual([
      "tables:read",
      "tables:write",
      "tables:delete",
      "events:subscribe",
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

  it("rejects bad redirects, resource audiences and PKCE through a real browser guest", async () => {
    const browser = await withBrowserGuest();
    const clientId = await register();
    const valid = await start(clientId);
    const control = await exports.default.fetch(valid.url, {
      headers: { Cookie: browser.cookie },
    });
    expect(control.status).toBe(200);
    expect(await control.text()).toContain("Synthetic OAuth client");

    const attempts: Record<string, string>[] = [
      { redirect_uri: "https://evil.example/callback" },
      { code_challenge_method: "plain" },
      { resource: "https://unrelated.example/mcp" },
    ];
    for (const extra of attempts) {
      const { url } = await start(clientId, extra);
      const result = await exports.default.fetch(url, {
        headers: { Cookie: browser.cookie },
        redirect: "manual",
      });
      expect(result.status).not.toBe(200);
      const location = result.headers.get("location");
      expect(location ?? "").not.toContain("code=");
      expect(location ?? "").not.toContain("evil.example");
      expect(
        await browser.guest.listConnections(
          browser.session.sessionId,
          browser.session.secret,
        ),
      ).toEqual([]);
    }
  });

  it("does not accept a token endpoint code replay or invented grant", async () => {
    const clientId = await register();
    const response = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code: "invented",
        redirect_uri: REDIRECT,
        code_verifier: "A".repeat(43),
        resource: RESOURCE,
      }),
    });
    expect(response.status).toBe(400);
    const body = await jsonUrl(response);
    expect(body.error).toBe("invalid_grant");
  });
});

async function withBrowserGuest() {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  return {
    guestId,
    guest,
    session,
    cookie: `__Host-agent_table_session=v1.${guestId}.${session.sessionId}.${session.secret}`,
  };
}

async function approvedConsent(
  browser: Awaited<ReturnType<typeof withBrowserGuest>>,
  clientId: string,
  extra: Record<string, string> = {},
) {
  const { url, verifier } = await start(clientId, extra);
  const response = await exports.default.fetch(url, {
    headers: { Cookie: browser.cookie },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "form-action 'self' https://client.example",
  );
  const html = await response.text();
  expect(html).toContain("Synthetic OAuth client");
  expect(html).toContain(browser.guestId);
  expect(html).toContain("lose your browser session"); // The page states the loss-of-access limitation.
  const handle = /name="handle" type="hidden" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf" type="hidden" value="([^"]+)"/.exec(html)?.[1];
  const guestId = /name="guest_id" type="hidden" value="([^"]+)"/.exec(
    html,
  )?.[1];
  const binding = /name="binding" type="hidden" value="([^"]+)"/.exec(
    html,
  )?.[1];
  if (!handle || !csrf || !binding || guestId !== browser.guestId)
    throw Error("Consent form missing bound guest or values");
  const cookies = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]);
  const approved = await exports.default.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: [browser.cookie, ...cookies].join("; "),
    },
    body: new URLSearchParams([
      ["handle", handle],
      ["csrf", csrf],
      ["guest_id", browser.guestId],
      ["binding", binding],
      ["decision", "approve"],
      ["scope", "tables:read"],
    ]),
  });
  expect(approved.status).toBe(302);
  const redirectTo = approved.headers.get("Location");
  if (!redirectTo) throw Error("OAuth authorization redirect was absent");
  const code = new URL(redirectTo).searchParams.get("code");
  if (!code) throw Error("Code absent");
  const newSession = approved.headers
    .getSetCookie()
    .find((line) => line.startsWith("__Host-agent_table_session="));
  const values =
    newSession &&
    /^__Host-agent_table_session=v1\.([0-9a-f-]+)\.([0-9a-f-]+)\.([A-Za-z0-9_-]{43})/.exec(
      newSession,
    );
  if (!values) throw Error("Browser session not rotated");
  return { code, verifier, sessionId: values[2], sessionSecret: values[3] };
}

async function redeem(clientId: string, code: string, verifier: string) {
  return exports.default.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
}

describe("real authorization code and guest-grant flow", () => {
  it("binds an explicit browser consent to guest grants and revokes future token operations", async () => {
    const browser = await withBrowserGuest();
    const clientId = await register();
    const approved = await approvedConsent(browser, clientId);
    expect(
      await browser.guest.validateSession(
        browser.session.sessionId,
        browser.session.secret,
      ),
    ).toBeNull();
    const grants = await browser.guest.listConnections(
      approved.sessionId,
      approved.sessionSecret,
    );
    expect(grants).toHaveLength(1);
    expect(grants?.[0].scopes).toEqual(["tables:read"]);

    const response = await redeem(clientId, approved.code, approved.verifier);
    expect(response.status).toBe(200);
    const tokens = await jsonUrl(response);
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");
    expect(tokens.expires_in).toBe(900);
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const protectedRead = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
        params: {},
      }),
    });
    expect(protectedRead.status).not.toBe(401);

    const revoked = await browser.guest.revokeConnection(
      approved.sessionId,
      approved.sessionSecret,
      grants?.[0].connectionId ?? "",
    );
    expect(revoked.status).toBe("revoked");
    const denied = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
        params: {},
      }),
    });
    expect(denied.status).toBe(401);
    const refresh = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: String(tokens.refresh_token),
      }),
    });
    expect(refresh.status).toBe(400);
    expect((await jsonUrl(refresh)).error).toBe("invalid_grant");
  });

  it("excludes a second redemption while the real provider's grant read is held", async () => {
    const browser = await withBrowserGuest();
    const clientId = await register();
    const approved = await approvedConsent(browser, clientId);
    const tokenDO = env.OAUTH_SERIALIZER.get(
      env.OAUTH_SERIALIZER.idFromName("token-exchange-v1"),
    );
    const waitFor = async (requests: number, reads: number) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        const state = await tokenDO.redemptionReadProbeState();
        // Count admitted requests monotonically: a racing unsynchronized
        // exchange may finish before this poll observes activeRequests.
        if (state.requestArrivals >= requests && state.grantReads >= reads) {
          return state;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        "Provider never reached the observed redemption boundary",
      );
    };
    await tokenDO.armRedemptionReadProbe();
    try {
      const first = redeem(clientId, approved.code, approved.verifier);
      await waitFor(1, 1);
      // The first request has already read the real pre-consumption KV grant,
      // but cannot change it until the probe releases that exact read.
      const second = redeem(clientId, approved.code, approved.verifier);
      await waitFor(2, 1);
      // Give the second request a scheduling turn. Without serialization it
      // would enter the real provider and read the unconsumed KV grant.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const held = await tokenDO.redemptionReadProbeState();
      expect(held.providerEntries).toBe(1);
      expect(held.grantReads).toBe(1);
      await tokenDO.releaseRedemptionReadProbe();
      const results = await Promise.all([first, second]);
      expect(results.map((response) => response.status).sort()).toEqual([
        200, 400,
      ]);
      const payloads = await Promise.all(results.map(jsonUrl));
      expect(
        payloads.filter((item) => typeof item.access_token === "string"),
      ).toHaveLength(1);
      expect(
        payloads.filter((item) => item.error === "invalid_grant"),
      ).toHaveLength(1);

      // A third sequential exchange must observe the provider's durable
      // consumed-code state, independently of the two overlapping responses.
      // Do not use KV.list() as an immediate consistency oracle.
      const replay = await redeem(clientId, approved.code, approved.verifier);
      expect(replay.status).toBe(400);
      const replayBody = await jsonUrl(replay);
      expect(replayBody.error).toBe("invalid_grant");
      expect(replayBody.access_token).toBeUndefined();
    } finally {
      await tokenDO.clearRedemptionReadProbe();
    }
  });

  it("rejects an approval submitted after the selected browser guest changed", async () => {
    const browserA = await withBrowserGuest();
    const browserB = await withBrowserGuest();
    const clientId = await register();
    const { url } = await start(clientId);
    const form = await exports.default.fetch(url, {
      headers: { Cookie: browserA.cookie },
    });
    expect(form.status).toBe(200);
    const html = await form.text();
    const handle = /name="handle" type="hidden" value="([^"]+)"/.exec(
      html,
    )?.[1];
    const csrf = /name="csrf" type="hidden" value="([^"]+)"/.exec(html)?.[1];
    const binding = /name="binding" type="hidden" value="([^"]+)"/.exec(
      html,
    )?.[1];
    const cookies = form.headers
      .getSetCookie()
      .map((line) => line.split(";")[0]);
    if (!handle || !csrf || !binding) throw Error("Consent handle missing");
    const stale = await exports.default.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: [browserB.cookie, ...cookies].join("; "),
      },
      body: new URLSearchParams({
        handle,
        csrf,
        guest_id: browserA.guestId,
        binding,
        decision: "approve",
        scope: "tables:read",
      }),
    });
    expect(stale.status).toBe(409);
    // Editing both hidden guest fields cannot turn A's displayed consent
    // into authorization for the second browser's credential.
    const forged = await exports.default.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: [browserB.cookie, ...cookies].join("; "),
      },
      body: new URLSearchParams({
        handle,
        csrf,
        guest_id: browserB.guestId,
        binding,
        decision: "approve",
        scope: "tables:read",
      }),
    });
    expect(forged.status).toBe(409);
    expect(
      await browserB.guest.listConnections(
        browserB.session.sessionId,
        browserB.session.secret,
      ),
    ).toEqual([]);
  });

  it("refreshes a live grant without creating a new connection, then refuses it after revocation", async () => {
    const browser = await withBrowserGuest();
    const clientId = await register();
    const approved = await approvedConsent(browser, clientId);
    const issued = await redeem(clientId, approved.code, approved.verifier);
    expect(issued.status).toBe(200);
    const original = await jsonUrl(issued);
    const before = await browser.guest.listConnections(
      approved.sessionId,
      approved.sessionSecret,
    );
    expect(before).toHaveLength(1);
    const refresh = (refreshToken: string) =>
      exports.default.fetch(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          resource: RESOURCE,
        }),
      });
    const refreshed = await refresh(String(original.refresh_token));
    expect(refreshed.status).toBe(200);
    const renewal = await jsonUrl(refreshed);
    expect(typeof renewal.access_token).toBe("string");
    expect(renewal.expires_in).toBe(900);
    const after = await browser.guest.listConnections(
      approved.sessionId,
      approved.sessionSecret,
    );
    expect(after?.map((item) => item.connectionId)).toEqual(
      before?.map((item) => item.connectionId),
    );
    const protectedRead = () =>
      exports.default.fetch(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${renewal.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/list",
          params: {},
        }),
      });
    expect((await protectedRead()).status).not.toBe(401);
    const revoked = await browser.guest.revokeConnection(
      approved.sessionId,
      approved.sessionSecret,
      before?.[0].connectionId ?? "",
    );
    expect(revoked.status).toBe("revoked");
    expect((await protectedRead()).status).toBe(401);
    const rejected = await refresh(String(renewal.refresh_token));
    expect(rejected.status).toBe(400);
    expect((await jsonUrl(rejected)).error).toBe("invalid_grant");
  });

  it("denies real-provider refresh and protected reads after persisted connection expiry", async () => {
    const browser = await withBrowserGuest();
    const clientId = await register();
    const approved = await approvedConsent(browser, clientId);
    const issued = await redeem(clientId, approved.code, approved.verifier);
    expect(issued.status).toBe(200);
    const tokens = await jsonUrl(issued);
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");
    expect(tokens.expires_in).toBe(900);
    const grants = await browser.guest.listConnections(
      approved.sessionId,
      approved.sessionSecret,
    );
    expect(grants).toHaveLength(1);
    const grant = grants?.[0];
    if (!grant) throw new Error("Consent-created grant was not found");
    expect(grant.expiresAt).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1_000,
    );

    // Simulate the original grant deadline through the real SQLite authority.
    // Do not mock the OAuth provider, token handler, or validation decision.
    await runInDurableObject(browser.guest, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_connections SET created_at = ?, expires_at = ? WHERE connection_id = ?",
        Date.now() - 120_000,
        Date.now() - 60_000,
        grant.connectionId,
      );
    });
    await evictDurableObject(browser.guest);

    const access = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(tokens.access_token)}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 29,
        method: "tools/list",
        params: {},
      }),
    });
    expect(access.status).toBe(401);
    const renewal = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: String(tokens.refresh_token),
        resource: RESOURCE,
      }),
    });
    expect(renewal.status).toBe(400);
    const denial = await jsonUrl(renewal);
    expect(denial.error).toBe("invalid_grant");
    expect(denial.access_token).toBeUndefined();
    expect(denial.refresh_token).toBeUndefined();
  });

  it("keeps two overlapping bearer connections independent after revoking only one", async () => {
    const first = await withBrowserGuest();
    const second = await withBrowserGuest();
    const clientA = await register();
    const clientB = await register();
    const consentA = await approvedConsent(first, clientA);
    const consentB = await approvedConsent(second, clientB);
    const issued = await Promise.all([
      redeem(clientA, consentA.code, consentA.verifier),
      redeem(clientB, consentB.code, consentB.verifier),
    ]);
    expect(issued.map((response) => response.status)).toEqual([200, 200]);
    const [tokenA, tokenB] = await Promise.all(issued.map(jsonUrl));
    const request = (token: unknown) =>
      exports.default.fetch(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${String(token)}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 12,
          method: "tools/list",
          params: {},
        }),
      });
    const both = await Promise.all([
      request(tokenA.access_token),
      request(tokenB.access_token),
    ]);
    expect(both.every((response) => response.status !== 401)).toBe(true);
    const grantsA = await first.guest.listConnections(
      consentA.sessionId,
      consentA.sessionSecret,
    );
    expect(grantsA).toHaveLength(1);
    const revoked = await first.guest.revokeConnection(
      consentA.sessionId,
      consentA.sessionSecret,
      grantsA?.[0].connectionId ?? "",
    );
    expect(revoked.status).toBe("revoked");
    const [denied, unaffected] = await Promise.all([
      request(tokenA.access_token),
      request(tokenB.access_token),
    ]);
    expect(denied.status).toBe(401);
    expect(unaffected.status).not.toBe(401);
  });

  it("rejects a wrong resource during a real authorization-code exchange", async () => {
    const browser = await withBrowserGuest();
    const clientId = await register();
    const approved = await approvedConsent(browser, clientId);
    const before = await browser.guest.listConnections(
      approved.sessionId,
      approved.sessionSecret,
    );
    expect(before).toHaveLength(1);

    const response = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code: approved.code,
        redirect_uri: REDIRECT,
        code_verifier: approved.verifier,
        resource: "https://unrelated.example/mcp",
      }),
    });
    expect(response.status).toBe(400);
    const result = await jsonUrl(response);
    expect(result.access_token).toBeUndefined();
    expect(result.refresh_token).toBeUndefined();
    expect(
      await browser.guest.listConnections(
        approved.sessionId,
        approved.sessionSecret,
      ),
    ).toEqual(before);
  });

  it("rejects a wrong PKCE verifier for an actual consented code", async () => {
    const browser = await withBrowserGuest();
    const clientId = await register();
    const approved = await approvedConsent(browser, clientId);
    const rejected = await redeem(clientId, approved.code, "B".repeat(43));
    expect(rejected.status).toBe(400);
    const data = await jsonUrl(rejected);
    expect(data.access_token).toBeUndefined();
    expect(data.error).toBe("invalid_grant");
  });

  it("records repeatable library refresh tokens but revokes every derived access token", async () => {
    const browser = await withBrowserGuest();
    const clientId = await register();
    const approved = await approvedConsent(browser, clientId);
    const issued = await redeem(clientId, approved.code, approved.verifier);
    expect(issued.status).toBe(200);
    const original = await jsonUrl(issued);
    const retry = () =>
      exports.default.fetch(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: String(original.refresh_token),
          resource: RESOURCE,
        }),
      });
    const responses = await Promise.all([retry(), retry()]);
    // Provider 1.2.4 accepts repeat redemption; serialization alone does not rotate it.
    expect(responses.map((item) => item.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map(jsonUrl));
    expect(results.every((item) => typeof item.access_token === "string")).toBe(
      true,
    );
    const grants = await browser.guest.listConnections(
      approved.sessionId,
      approved.sessionSecret,
    );
    expect(grants).toHaveLength(1);
    const protectedRead = (token: unknown) =>
      exports.default.fetch(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${String(token)}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 12,
          method: "tools/list",
          params: {},
        }),
      });
    const before = await Promise.all(
      results.map((token) => protectedRead(token.access_token)),
    );
    expect(before.every((response) => response.status !== 401)).toBe(true);
    const revoked = await browser.guest.revokeConnection(
      approved.sessionId,
      approved.sessionSecret,
      grants?.[0].connectionId ?? "",
    );
    expect(revoked.status).toBe("revoked");
    const after = await Promise.all(
      results.map((token) => protectedRead(token.access_token)),
    );
    expect(after.map((response) => response.status)).toEqual([401, 401]);
    const rejected = await retry();
    expect(rejected.status).toBe(400);
    expect((await jsonUrl(rejected)).error).toBe("invalid_grant");
  });
  it("does not authorize a denied browser consent", async () => {
    const browser = await withBrowserGuest();
    const clientId = await register();
    const { url } = await start(clientId);
    const response = await exports.default.fetch(url, {
      headers: { Cookie: browser.cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const handle = /name="handle" type="hidden" value="([^"]+)"/.exec(
      html,
    )?.[1];
    const csrf = /name="csrf" type="hidden" value="([^"]+)"/.exec(html)?.[1];
    const cookies = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0]);
    if (!handle || !csrf) throw Error("Consent form missing bound values");
    const denied = await exports.default.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: [browser.cookie, ...cookies].join("; "),
      },
      body: new URLSearchParams({ handle, csrf, decision: "deny" }),
    });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("Location")).toContain("error=access_denied");
    const grants = await browser.guest.listConnections(
      browser.session.sessionId,
      browser.session.secret,
    );
    expect(grants).toEqual([]);
  });
});
