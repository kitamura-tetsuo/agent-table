import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/auth/guest";
import worker from "../../src/index";
import { OPERATION_SCOPE, authorizeGuestConnection, type ConnectionScope } from "../../src/shared/auth";

const ORIGIN = "http://localhost:8787";
const CSRF_COOKIE_NAME = "__Host-agent_table_csrf";
const bindings: Env = { ...env, ALLOW_NEW_GUESTS: "true" };

function dispatch(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(ORIGIN + path, init) as Parameters<typeof worker.fetch>[0],
    bindings,
    {} as ExecutionContext,
  );
}

function cookie(response: Response, name: string): string {
  const header = response.headers
    .getSetCookie()
    .find((item) => item.startsWith(name + "="));
  if (!header) throw new Error("Expected test cookie");
  return header.split(";")[0];
}

async function formPage(path: string, session?: string) {
  const response = await dispatch(path, {
    headers: session ? { Cookie: session } : {},
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
  if (!csrf) throw new Error("Missing form CSRF");
  return { csrf, csrfCookie: cookie(response, CSRF_COOKIE_NAME), html };
}

async function newGuest() {
  const form = await formPage("/guest");
  const response = await dispatch("/guest/session", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Cookie: form.csrfCookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ choice: "new", csrf: form.csrf }),
  });
  expect(response.status).toBe(303);
  const session = cookie(response, SESSION_COOKIE_NAME);
  const [version, guestId, sessionId, secret] = session
    .slice(SESSION_COOKIE_NAME.length + 1)
    .split(".");
  expect(version).toBe("v1");
  if (!guestId || !sessionId || !secret) {
    throw new Error("Invalid test guest session");
  }
  return {
    guestId,
    sessionId,
    secret,
    session,
    stub: env.GUESTS.get(env.GUESTS.idFromName(guestId)),
  };
}

async function revoke(
  connectionId: string,
  browserSession: string,
  csrf: string,
  csrfCookie: string,
  origin = ORIGIN,
) {
  return dispatch("/guest/connections/revoke", {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: browserSession + "; " + csrfCookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ connection_id: connectionId, csrf }),
  });
}

describe("browser -> Worker -> durable connection grant authority", () => {
  it("enforces every documented operation category and refuses unknown scopes", async () => {
    const guest = await newGuest();
    const expiry = Date.now() + 60_000;
    expect(
      await guest.stub.createConnection(
        crypto.randomUUID(),
        guest.secret,
        ["tables:read"],
        expiry,
      ),
    ).toBe(null);
    await expect(
      guest.stub.createConnection(
        guest.sessionId,
        guest.secret,
        ["unrecognized" as ConnectionScope],
        expiry,
      ),
    ).rejects.toThrow(/Invalid connection scopes/);
    await expect(
      guest.stub.createConnection(
        guest.sessionId,
        guest.secret,
        ["tables:read", "tables:read"],
        expiry,
      ),
    ).rejects.toThrow(/Invalid connection scopes/);

    const read = await guest.stub.createConnection(
      guest.sessionId,
      guest.secret,
      ["tables:read"],
      expiry,
    );
    const write = await guest.stub.createConnection(
      guest.sessionId,
      guest.secret,
      ["tables:write", "tables:delete", "events:subscribe"],
      expiry,
    );
    expect(read?.connectionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(write?.connectionId).not.toBe(read?.connectionId);
    if (!read || !write) throw new Error("Grant was not created");

    for (const [operation, scope] of Object.entries(OPERATION_SCOPE)) {
      expect(operation.length).toBeGreaterThan(0);
      expect(scope).toMatch(/^(tables:read|tables:write|tables:delete|events:subscribe)$/);
      const chosen = scope === "tables:read" ? read : write;
      const result = await authorizeGuestConnection(
        env,
        guest.guestId,
        chosen.connectionId,
        scope,
      );
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.actor).toEqual({
          kind: "verified-connection",
          guestId: guest.guestId,
          connectionId: chosen.connectionId,
          scope,
          expiresAt: chosen.expiresAt,
        });
      }
    }
    expect(
      await authorizeGuestConnection(env, guest.guestId, read.connectionId, "tables:write"),
    ).toEqual({ allowed: false, reason: "insufficient-scope" });
    expect(
      await authorizeGuestConnection(env, crypto.randomUUID(), read.connectionId, "tables:read"),
    ).toEqual({ allowed: false, reason: "mismatched" });
    expect(
      await authorizeGuestConnection(env, guest.guestId, crypto.randomUUID(), "tables:read"),
    ).toEqual({ allowed: false, reason: "missing" });
    expect(
      await authorizeGuestConnection(
        { GUESTS: undefined } as unknown as Pick<Env, "GUESTS">,
        guest.guestId,
        read.connectionId,
        "tables:read",
      ),
    ).toEqual({ allowed: false, reason: "unavailable" });
    expect(
      await authorizeGuestConnection(env, guest.guestId, read.connectionId, "unknown" as ConnectionScope),
    ).toEqual({ allowed: false, reason: "invalid" });

    // A grant is not a membership record, and is not exposed as a public API.
    expect((await dispatch("/internal/connections")).status).toBe(404);
    await runInDurableObject(guest.stub, async (_instance, state) => {
      const rows = state.storage.sql.exec<{ guest_id: string }>(
        "SELECT guest_id FROM guest_connections",
      ).toArray();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.guest_id === guest.guestId)).toBe(true);
    });

    // Losing the cookie blocks the browser but does not revoke the grant.
    expect((await dispatch("/guest/connections")).status).toBe(401);
    expect(
      (await authorizeGuestConnection(env, guest.guestId, read.connectionId, "tables:read")).allowed,
    ).toBe(true);
  });

  it("uses same-guest CSRF POST, rotates sessions, and never resurrects revocation", async () => {
    const owner = await newGuest();
    const outsider = await newGuest();
    const grant = await owner.stub.createConnection(
      owner.sessionId,
      owner.secret,
      ["tables:read"],
      Date.now() + 60_000,
    );
    if (!grant) throw new Error("Grant was not created");
    const checkedBefore = await authorizeGuestConnection(
      env, owner.guestId, grant.connectionId, "tables:read",
    );
    expect(checkedBefore.allowed).toBe(true);

    const ownerPage = await formPage("/guest/connections", owner.session);
    const outsiderPage = await formPage("/guest", outsider.session);
    const outsiderList = await dispatch("/guest/connections", {
      headers: { Cookie: outsider.session },
    });
    expect(ownerPage.html).toContain(grant.connectionId);
    expect(await outsiderList.text()).not.toContain(grant.connectionId);
    expect((await dispatch("/guest/connections/revoke")).status).toBe(405);
    expect(
      (await revoke(grant.connectionId, owner.session, ownerPage.csrf, ownerPage.csrfCookie, "https://evil.example")).status,
    ).toBe(403);
    expect(
      (await revoke(grant.connectionId, owner.session, "invalid", ownerPage.csrfCookie)).status,
    ).toBe(403);
    expect(
      (await revoke(grant.connectionId, outsider.session, outsiderPage.csrf, outsiderPage.csrfCookie)).status,
    ).toBe(404);
    expect(
      (await authorizeGuestConnection(env, owner.guestId, grant.connectionId, "tables:read")).allowed,
    ).toBe(true);

    const revoked = await revoke(
      grant.connectionId,
      owner.session,
      ownerPage.csrf,
      ownerPage.csrfCookie,
    );
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("Location")).toBe("/guest/connections");
    const nextSession = cookie(revoked, SESSION_COOKIE_NAME);
    expect(nextSession).not.toBe(owner.session);
    expect((await dispatch("/guest/me", { headers: { Cookie: owner.session } })).status).toBe(401);
    expect((await dispatch("/guest/me", { headers: { Cookie: nextSession } })).status).toBe(200);
    expect(
      await authorizeGuestConnection(env, owner.guestId, grant.connectionId, "tables:read"),
    ).toEqual({ allowed: false, reason: "revoked" });

    await evictDurableObject(owner.stub);
    expect(
      await authorizeGuestConnection(env, owner.guestId, grant.connectionId, "tables:read"),
    ).toEqual({ allowed: false, reason: "revoked" });
    const repeatedPage = await formPage("/guest", nextSession);
    const repeatedList = await dispatch("/guest/connections", {
      headers: { Cookie: nextSession },
    });
    expect(await repeatedList.text()).toContain("Revoked");
    const repeated = await revoke(
      grant.connectionId, nextSession, repeatedPage.csrf, repeatedPage.csrfCookie,
    );
    expect(repeated.status).toBe(303);
    expect(
      await authorizeGuestConnection(env, owner.guestId, grant.connectionId, "tables:read"),
    ).toEqual({ allowed: false, reason: "revoked" });
  });

  it("fails closed on expiration and persisted malformed authority", async () => {
    const guest = await newGuest();
    const grant = await guest.stub.createConnection(
      guest.sessionId,
      guest.secret,
      ["events:subscribe"],
      Date.now() + 60_000,
    );
    if (!grant) throw new Error("Grant was not created");
    await runInDurableObject(guest.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_connections SET created_at = ?, expires_at = ? WHERE connection_id = ?",
        Date.now() - 200_000,
        Date.now() - 100_000,
        grant.connectionId,
      );
    });
    await evictDurableObject(guest.stub);
    expect(
      await authorizeGuestConnection(env, guest.guestId, grant.connectionId, "events:subscribe"),
    ).toEqual({ allowed: false, reason: "expired" });
    await runInDurableObject(guest.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_connections SET expires_at = ?, scopes_json = ? WHERE connection_id = ?",
        Date.now() + 50_000,
        JSON.stringify(["unknown"]),
        grant.connectionId,
      );
    });
    expect(
      await authorizeGuestConnection(env, guest.guestId, grant.connectionId, "events:subscribe"),
    ).toEqual({ allowed: false, reason: "insufficient-scope" });
  });
});
