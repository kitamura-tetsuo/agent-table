import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

const ORIGIN = "http://localhost:8787";
const CALLBACK = "https://client.example/callback";

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
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();

  const submission = page.waitForRequest(
    (request) =>
      request.url() === `${ORIGIN}/authorize` && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Allow" }).click();

  const headers = await (await submission).allHeaders();
  expect(headers.origin).toBe(ORIGIN);
  expect(headers["sec-fetch-site"]).not.toBe("cross-site");
  expect(headers.cookie).toContain("__Host-agent_table_session=");
  expect(headers.cookie).toContain("__Host-agent_table_oauth_csrf=");

  await page.waitForURL(
    (url) =>
      url.origin === "https://client.example" && url.pathname === "/callback",
    { timeout: 10_000 },
  );
  const redirected = new URL(page.url());
  expect(redirected.origin).toBe("https://client.example");
  expect(redirected.searchParams.get("state")).toBe("synthetic-browser-state");
  expect(redirected.searchParams.get("code")).toBeTruthy();
  expect(consent?.headers()["referrer-policy"]).toBe("same-origin");
  await expect(page.getByText("Synthetic callback received")).toBeVisible();
});
