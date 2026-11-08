import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/auth/guest";
import worker from "../../src/index";
import { GuestDO } from "../../src/objects/guest";

const ORIGIN = "http://localhost:8787";
const CSRF_NAME = "__Host-agent_table_csrf";
const testEnv: Env = { ...env, ALLOW_NEW_GUESTS: "true" };
const context = {} as ExecutionContext;

function dispatch(
  path: string,
  options?: RequestInit,
  bindings: Env = testEnv,
): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, options) as Parameters<
      typeof worker.fetch
    >[0],
    bindings,
    context,
  );
}

function returnedCookie(response: Response, name: string): string {
  const attributeHeader = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
  if (!attributeHeader) throw new Error("Expected cookie missing");
  return attributeHeader.split(";")[0];
}

async function guestForm(sessionCookie?: string) {
  const response = await dispatch("/guest", {
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  const token = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
  if (!token) throw new Error("Expected CSRF form token missing");
  const csrfCookie = returnedCookie(response, CSRF_NAME);
  return { token, csrfCookie };
}

async function selectGuest(
  choice: "new" | "reuse",
  form: Awaited<ReturnType<typeof guestForm>>,
  sessionCookie?: string,
  bindings: Env = testEnv,
) {
  const cookies = [form.csrfCookie, sessionCookie].filter(Boolean).join("; ");
  const response = await dispatch(
    "/guest/session",
    {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Cookie: cookies,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ choice, csrf: form.token }),
    },
    bindings,
  );
  return {
    response,
    cookie:
      response.status === 303
        ? returnedCookie(response, SESSION_COOKIE_NAME)
        : null,
  };
}

async function browserIdentity(cookie?: string, path = "/guest/me") {
  const response = await dispatch(path, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const value = (await response.json()) as {
    guestId?: string;
    expiresAt?: number;
    error?: string;
  };
  return { status: response.status, value };
}

function credentialParts(cookie: string) {
  const encoded = cookie.slice(`${SESSION_COOKIE_NAME}=`.length);
  const [version, guestId, sessionId, secret] = encoded.split(".");
  if (version !== "v1" || !guestId || !sessionId || !secret) {
    throw new Error("Invalid test session cookie");
  }
  return { guestId, sessionId, secret };
}

describe("browser -> Worker -> real GuestDO guest sessions", () => {
  it("never creates an identity from GET, a link, or an unverified POST", async () => {
    expect((await browserIdentity()).status).toBe(401);
    const form = await guestForm();
    expect((await browserIdentity()).status).toBe(401);
    expect(
      (
        await browserIdentity(
          undefined,
          "/guest/me?table_id=public&agent_token=fake",
        )
      ).status,
    ).toBe(401);
    expect((await dispatch("/guest/session")).status).toBe(405);

    const body = new URLSearchParams({ choice: "new", csrf: form.token });
    const baseHeaders = {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: form.csrfCookie,
    };
    expect(
      (
        await dispatch("/guest/session", {
          method: "POST",
          headers: baseHeaders,
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await dispatch("/guest/session", {
          method: "POST",
          headers: { ...baseHeaders, Origin: "https://attacker.example" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await dispatch("/guest/session", {
          method: "POST",
          headers: { ...baseHeaders, Origin: ORIGIN },
          body: new URLSearchParams({ choice: "new", csrf: "wrong" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await dispatch("/guest/session", {
          method: "POST",
          headers: { ...baseHeaders, Origin: ORIGIN },
          body: new URLSearchParams({
            choice: "new",
            csrf: form.token,
            guestId: crypto.randomUUID(),
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await selectGuest("new", form, undefined, env)).response.status,
    ).toBe(503);
    expect((await browserIdentity()).status).toBe(401);
  });

  it("creates digest-only state, explicitly reuses or separates guests, and survives eviction", async () => {
    const initial = await selectGuest("new", await guestForm());
    expect(initial.response.status).toBe(303);
    expect(initial.response.headers.get("Location")).toBe("/guest");
    const cookie = initial.cookie ?? "";
    const attributes =
      initial.response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) {
      expect(attributes.includes(attribute)).toBe(true);
    }
    expect(attributes.includes("Domain=")).toBe(false);
    const first = await browserIdentity(cookie);
    expect(first.status).toBe(200);
    const parts = credentialParts(cookie);
    expect(parts.guestId).toBe(first.value.guestId);
    expect(parts.secret.length).toBe(43); // 32 random bytes, base64url without padding.

    const stub = env.GUESTS.get(env.GUESTS.idFromName(parts.guestId));
    await runInDurableObject(stub, async (instance, state) => {
      expect(instance).toBeInstanceOf(GuestDO);
      const rows = state.storage.sql
        .exec<{
          session_id: string;
          secret_digest: string;
          created_at: number;
          expires_at: number;
        }>(
          "SELECT session_id, secret_digest, created_at, expires_at FROM guest_sessions",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].secret_digest.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(rows[0].secret_digest)).toBe(true);
      expect(JSON.stringify(rows).includes(parts.secret)).toBe(false);
      expect(rows[0].expires_at - rows[0].created_at).toBe(
        30 * 24 * 60 * 60 * 1_000,
      );
    });

    const reused = await selectGuest("reuse", await guestForm(cookie), cookie);
    expect(reused.response.status).toBe(303);
    const rotatedCookie = reused.cookie ?? "";
    expect(rotatedCookie === cookie).toBe(false);
    expect((await browserIdentity(cookie)).status).toBe(401);
    expect((await browserIdentity(rotatedCookie)).value.guestId).toBe(
      first.value.guestId,
    );
    await evictDurableObject(stub);
    expect((await browserIdentity(cookie)).status).toBe(401);
    expect((await browserIdentity(rotatedCookie)).value.guestId).toBe(
      first.value.guestId,
    );

    const another = await selectGuest(
      "new",
      await guestForm(rotatedCookie),
      rotatedCookie,
    );
    expect(another.response.status).toBe(303);
    const second = await browserIdentity(another.cookie ?? "");
    expect(second.status).toBe(200);
    expect(second.value.guestId === first.value.guestId).toBe(false);
    expect((await browserIdentity(rotatedCookie)).value.guestId).toBe(
      first.value.guestId,
    );
  });

  it("rejects expired and invalidated sessions after reconstruction and cleans up in bounded batches", async () => {
    const created = await selectGuest("new", await guestForm());
    const cookie = created.cookie ?? "";
    const { guestId, sessionId, secret } = credentialParts(cookie);
    const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    expect((await stub.validateSession(sessionId, secret))?.guestId).toBe(
      guestId,
    );

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_sessions SET created_at = ?, expires_at = ? WHERE session_id = ?",
        Date.now() - 20_000,
        Date.now() - 10_000,
        sessionId,
      );
    });
    await evictDurableObject(stub);
    expect((await browserIdentity(cookie)).status).toBe(401);
    expect(await stub.validateSession(sessionId, secret)).toBe(null);
    expect(await stub.pruneExpiredSessions(1)).toBe(1);
    expect(await stub.pruneExpiredSessions(1)).toBe(0);
    expect((await browserIdentity(cookie)).status).toBe(401);

    const renewed = await selectGuest("new", await guestForm());
    const next = credentialParts(renewed.cookie ?? "");
    const nextStub = env.GUESTS.get(env.GUESTS.idFromName(next.guestId));
    expect(await nextStub.invalidateSession(next.sessionId, next.secret)).toBe(
      true,
    );
    await evictDurableObject(nextStub);
    expect((await browserIdentity(renewed.cookie ?? "")).status).toBe(401);
    expect(await nextStub.pruneExpiredSessions(1)).toBe(1);
  });
});
