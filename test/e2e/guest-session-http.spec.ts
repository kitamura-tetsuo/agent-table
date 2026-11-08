import { type APIResponse, expect, test } from "@playwright/test";

const SESSION_COOKIE_NAME = "__Host-agent_table_session";
const CSRF_COOKIE_NAME = "__Host-agent_table_csrf";

function cookieFrom(response: APIResponse, name: string) {
  const header = response
    .headersArray()
    .find(
      (item) =>
        item.name.toLowerCase() === "set-cookie" &&
        item.value.startsWith(`${name}=`),
    )?.value;
  if (!header) throw new Error("Expected cookie missing from HTTP response");
  return { header, cookie: header.split(";")[0] };
}

test("live Worker HTTP guest choices preserve cookie and CSRF boundaries", async ({
  request,
}) => {
  const initial = await request.get("/guest");
  expect(initial.status()).toBe(200);
  const csrf = cookieFrom(initial, CSRF_COOKIE_NAME);
  const token = (await initial.text()).match(
    /name="csrf" value="([A-Za-z0-9_-]{43})"/,
  )?.[1];
  if (!token) throw new Error("Expected form token missing");

  expect((await request.get("/guest/me")).status()).toBe(401);
  const invalid = await request.post("/guest/session", {
    headers: { Origin: "http://localhost:8787", Cookie: csrf.cookie },
    form: { choice: "new", csrf: "invalid" },
    maxRedirects: 0,
  });
  expect(invalid.status()).toBe(403);

  const created = await request.post("/guest/session", {
    headers: { Origin: "http://localhost:8787", Cookie: csrf.cookie },
    form: { choice: "new", csrf: token },
    maxRedirects: 0,
  });
  expect(created.status()).toBe(303);
  const session = cookieFrom(created, SESSION_COOKIE_NAME);
  for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) {
    expect(session.header.includes(attribute)).toBe(true);
  }
  expect(session.header.includes("Domain=")).toBe(false);

  const first = await request.get("/guest/me", {
    headers: { Cookie: session.cookie },
  });
  expect(first.status()).toBe(200);
  const firstGuest = (await first.json()).guestId;

  const reusePage = await request.get("/guest", {
    headers: { Cookie: session.cookie },
  });
  const reuseCsrf = cookieFrom(reusePage, CSRF_COOKIE_NAME);
  const reuseToken = (await reusePage.text()).match(
    /name="csrf" value="([A-Za-z0-9_-]{43})"/,
  )?.[1];
  if (!reuseToken) throw new Error("Expected reuse form token missing");
  const reused = await request.post("/guest/session", {
    headers: {
      Origin: "http://localhost:8787",
      Cookie: `${session.cookie}; ${reuseCsrf.cookie}`,
    },
    form: { choice: "reuse", csrf: reuseToken },
    maxRedirects: 0,
  });
  expect(reused.status()).toBe(303);
  const rotated = cookieFrom(reused, SESSION_COOKIE_NAME);
  expect(rotated.cookie === session.cookie).toBe(false);
  expect(
    (
      await request.get("/guest/me", { headers: { Cookie: session.cookie } })
    ).status(),
  ).toBe(401);
  const active = await request.get("/guest/me", {
    headers: { Cookie: rotated.cookie },
  });
  expect(active.status()).toBe(200);
  expect((await active.json()).guestId).toBe(firstGuest);
});
