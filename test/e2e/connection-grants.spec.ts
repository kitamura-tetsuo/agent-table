import { type APIResponse, expect, test } from "@playwright/test";

const ORIGIN = "http://localhost:8787";
const CSRF_COOKIE = "__Host-agent_table_csrf";
const SESSION_COOKIE = "__Host-agent_table_session";

function cookie(response: APIResponse, name: string): string {
  const header = response.headersArray().find(
    (item) => item.name.toLowerCase() === "set-cookie" &&
      item.value.startsWith(name + "="),
  )?.value;
  if (!header) throw new Error("Missing test cookie");
  return header.split(";")[0];
}

test("live Worker connection management is session-only and POST+CSRF protected", async ({ request }) => {
  expect((await request.get("/guest/connections")).status()).toBe(401);
  const first = await request.get("/guest");
  const csrfCookie = cookie(first, CSRF_COOKIE);
  const csrf = (await first.text()).match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
  if (!csrf) throw new Error("Missing test CSRF");
  const created = await request.post("/guest/session", {
    headers: { Origin: ORIGIN, Cookie: csrfCookie },
    form: { choice: "new", csrf },
    maxRedirects: 0,
  });
  expect(created.status()).toBe(303);
  const session = cookie(created, SESSION_COOKIE);
  const connections = await request.get("/guest/connections", {
    headers: { Cookie: session },
  });
  expect(connections.status()).toBe(200);
  expect(await connections.text()).toContain("No connections for this guest");
  expect((await request.get("/guest/connections/revoke")).status()).toBe(405);
  const invalidPost = await request.post("/guest/connections/revoke", {
    headers: { Origin: ORIGIN, Cookie: session },
    form: { connection_id: "not-a-grant", csrf: "bad" },
    maxRedirects: 0,
  });
  expect(invalidPost.status()).toBe(403);
});
