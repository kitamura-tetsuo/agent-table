import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

const ORIGIN = "http://localhost:8787";
const CALLBACK = "https://client.example/callback";
// A second loopback origin exercises actual navigation without external DNS.
const CALLBACK_LOOPBACK = "http://127.0.0.1:8787/health";

test("browser OAuth approval preserves same-origin CSRF enforcement", async ({
  page,
}) => {
  await page.goto("/guest");
  await page.getByRole("button", { name: "Create a new guest" }).click();
  expect((await page.request.get("/guest/me")).status()).toBe(200);

  const registration = await page.request.post("/oauth/register", {
    data: {
      client_name: "Synthetic browser OAuth regression",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
    },
  });
  expect(registration.status()).toBe(201);
  const client = (await registration.json()) as { client_id?: string };
  expect(typeof client.client_id).toBe("string");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${ORIGIN}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id ?? "",
    redirect_uri: CALLBACK,
    scope: "tables:read tables:write",
    state: "synthetic-browser-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  })) {
    authorize.searchParams.set(key, value);
  }

  await page.route("https://client.example/callback**", (route) =>
    route.fulfill({ status: 200, body: "Synthetic callback received" }),
  );
  const consent = await page.goto(authorize.toString());
  expect(consent?.status()).toBe(200);
  expect(consent?.headers()["referrer-policy"]).toBe("same-origin");
  expect(consent?.headers()["content-security-policy"]).toContain(
    "form-action 'self' https://client.example",
  );
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();

  const submission = page.waitForRequest(
    (request) =>
      request.url() === `${ORIGIN}/authorize` && request.method() === "POST",
  );
  const approval = page.waitForResponse(
    (response) =>
      response.url() === `${ORIGIN}/authorize` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Allow" }).click();

  const headers = await (await submission).allHeaders();
  expect(headers.origin).toBe(ORIGIN);
  expect(headers["sec-fetch-site"]).not.toBe("cross-site");
  expect(headers.cookie).toContain("__Host-agent_table_session=");
  expect(headers.cookie).toContain("__Host-agent_table_oauth_csrf=");

  const approved = await approval;
  expect(approved.status()).toBe(302);
  const location = approved.headers().location;
  expect(location).toBeTruthy();
  const redirected = new URL(location ?? CALLBACK);
  expect(redirected.origin).toBe("https://client.example");
  expect(redirected.searchParams.get("state")).toBe("synthetic-browser-state");
  expect(redirected.searchParams.get("code")).toBeTruthy();
  // The synthetic callback host has no service behind it. A real consent POST
  // and a validated authorization redirect are the local browser oracle;
  // actual third-party host callback acceptance belongs to Issue #23.
});

test("browser OAuth approval performs real cross-loopback callback navigation", async ({
  page,
}) => {
  await page.goto("/guest");
  await page.getByRole("button", { name: "Create a new guest" }).click();
  expect((await page.request.get("/guest/me")).status()).toBe(200);

  const registration = await page.request.post("/oauth/register", {
    data: {
      client_name: "Synthetic browser OAuth regression",
      redirect_uris: [CALLBACK_LOOPBACK],
      token_endpoint_auth_method: "none",
    },
  });
  expect(registration.status()).toBe(201);
  const client = (await registration.json()) as { client_id?: string };
  expect(typeof client.client_id).toBe("string");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${ORIGIN}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id ?? "",
    redirect_uri: CALLBACK_LOOPBACK,
    scope: "tables:read tables:write",
    state: "synthetic-browser-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  })) {
    authorize.searchParams.set(key, value);
  }

  const consent = await page.goto(authorize.toString());
  expect(consent?.status()).toBe(200);
  expect(consent?.headers()["referrer-policy"]).toBe("same-origin");
  expect(consent?.headers()["content-security-policy"]).toContain(
    "form-action 'self' http://127.0.0.1:8787",
  );
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();

  const submission = page.waitForRequest(
    (request) =>
      request.url() === `${ORIGIN}/authorize` && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Allow" }).click();

  const postRequest = await submission;
  const headers = await postRequest.allHeaders();
  expect(headers.origin).toBe(ORIGIN);
  expect(headers["sec-fetch-site"]).not.toBe("cross-site");
  expect(headers.cookie).toContain("__Host-agent_table_session=");
  expect(headers.cookie).toContain("__Host-agent_table_oauth_csrf=");

  // Inspect the navigation response directly; callback navigation may still be in flight.
  const approval = await postRequest.response();
  expect(approval?.status()).toBe(302);
  const redirected = new URL(approval?.headers().location ?? ORIGIN);
  expect(redirected.origin).toBe("http://127.0.0.1:8787");
  expect(redirected.searchParams.get("state")).toBe("synthetic-browser-state");
  expect(redirected.searchParams.get("code")).toBeTruthy();
  await page.waitForURL(
    (url) =>
      url.origin === "http://127.0.0.1:8787" && url.pathname === "/health",
    { waitUntil: "commit", timeout: 10_000 },
  );
  expect(new URL(page.url()).searchParams.get("code")).toBeTruthy();
});
