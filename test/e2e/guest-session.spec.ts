import { expect, test } from "@playwright/test";

const SESSION_COOKIE_NAME = "__Host-agent_table_session";

test("browser explicitly creates, reuses, or replaces its guest without implicit recovery", async ({
  page,
  context,
  playwright,
  browser,
}) => {
  await page.goto("/guest");
  expect((await page.request.get("/guest/me")).status()).toBe(401);
  // In a real browser the double-submit cookie must survive the initial GET.
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "__Host-agent_table_csrf",
    ),
  ).toBe(true);

  let postEvidence: {
    origin: string | null;
    csrfCookieSent: boolean;
    fetchSite: string | null;
  } | null = null;
  page.on("request", (outgoing) => {
    if (!outgoing.url().endsWith("/guest/session")) return;
    const headers = outgoing.headers();
    postEvidence = {
      origin: headers.origin ?? null,
      csrfCookieSent:
        headers.cookie?.includes("__Host-agent_table_csrf=") ?? false,
      fetchSite: headers["sec-fetch-site"] ?? null,
    };
  });

  const [creation] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/guest/session"),
    ),
    page.getByRole("button", { name: "Create a new guest" }).click(),
  ]);
  expect(postEvidence).toEqual({
    origin: "http://localhost:8787",
    csrfCookieSent: true,
    fetchSite: "same-origin",
  });
  expect(creation.status()).toBe(303);
  const setCookie = (await creation.headerValue("set-cookie")) ?? "";
  for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) {
    expect(setCookie.includes(attribute)).toBe(true);
  }
  expect(setCookie.includes("Domain=")).toBe(false);

  const cookies = await context.cookies();
  const firstCookie = cookies.find(
    (cookie) => cookie.name === SESSION_COOKIE_NAME,
  );
  expect(Boolean(firstCookie)).toBe(true);
  expect(firstCookie?.httpOnly).toBe(true);
  expect(firstCookie?.secure).toBe(true);
  expect(firstCookie?.sameSite).toBe("Lax");
  expect((firstCookie?.value.length ?? 0) > 100).toBe(true);
  const first = await (await page.request.get("/guest/me")).json();
  expect(typeof first.guestId).toBe("string");
  await expect(page.getByText(first.guestId, { exact: true })).toBeVisible();

  const rejected = await page.request.post("/guest/session", {
    headers: { Origin: "http://localhost:8787" },
    form: { choice: "new", csrf: "invalid" },
    maxRedirects: 0,
  });
  expect(rejected.status()).toBe(403);
  expect((await (await page.request.get("/guest/me")).json()).guestId).toBe(
    first.guestId,
  );

  await page.getByRole("button", { name: "Use this guest" }).click();
  const rotated = (await context.cookies()).find(
    (cookie) => cookie.name === SESSION_COOKIE_NAME,
  );
  expect(Boolean(rotated)).toBe(true);
  expect(rotated?.value === firstCookie?.value).toBe(false);
  expect((await (await page.request.get("/guest/me")).json()).guestId).toBe(
    first.guestId,
  );

  const stale = await playwright.request.newContext({
    baseURL: "http://localhost:8787",
    extraHTTPHeaders: {
      Cookie: `${SESSION_COOKIE_NAME}=${firstCookie?.value ?? ""}`,
    },
  });
  try {
    expect((await stale.get("/guest/me")).status()).toBe(401);
  } finally {
    await stale.dispose();
  }

  await page.getByRole("button", { name: "Create a new guest" }).click();
  const second = await (await page.request.get("/guest/me")).json();
  expect(second.guestId === first.guestId).toBe(false);

  const lostBrowser = await browser.newContext();
  try {
    const lostPage = await lostBrowser.newPage();
    await lostPage.goto("/guest");
    await expect(
      lostPage.getByText(/cannot reconstruct that browser identity/),
    ).toBeVisible();
    expect(
      (
        await lostPage.request.get(
          "/guest/me?table_id=public-id&agent_token=unrelated",
        )
      ).status(),
    ).toBe(401);
  } finally {
    await lostBrowser.close();
  }
});
