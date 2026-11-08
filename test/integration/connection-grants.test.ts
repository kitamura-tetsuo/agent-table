import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/auth/guest";
import worker from "../../src/index";
import {
  authorizeGuestConnection,
  CONNECTION_SCOPES,
  type ConnectionScope,
  OPERATION_SCOPE,
} from "../../src/shared/auth";

// This oracle is transcribed from Issue #5 REQ-002, not from OPERATION_SCOPE.
const EXPECTED_OPERATION_SCOPE = {
  "table-metadata": "tables:read",
  "transcript-read": "tables:read",
  "own-inbox-read": "tables:read",
  "table-create": "tables:write",
  "table-invite": "tables:write",
  "table-join": "tables:write",
  "message-post": "tables:write",
  "table-close": "tables:write",
  "delete-request": "tables:delete",
  "delete-result": "tables:delete",
  "notification-subscribe": "events:subscribe",
  "notification-refresh": "events:subscribe",
  "notification-unsubscribe": "events:subscribe",
} as const satisfies Record<keyof typeof OPERATION_SCOPE, ConnectionScope>;

const ORIGIN = "http://localhost:8787";
const CSRF_NAME = "__Host-agent_table_csrf";
const bindings: Env = { ...env, ALLOW_NEW_GUESTS: "true" };

function dispatch(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, init) as Parameters<typeof worker.fetch>[0],
    bindings,
    {} as ExecutionContext,
  );
}

function cookie(response: Response, name: string): string {
  const header = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
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
  return { csrf, csrfCookie: cookie(response, CSRF_NAME), html };
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

type Guest = Awaited<ReturnType<typeof newGuest>>;

function decision(guest: Guest, id: string, scope: ConnectionScope) {
  return authorizeGuestConnection(env, guest.guestId, id, scope);
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
      Cookie: `${browserSession}; ${csrfCookie}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ connection_id: connectionId, csrf }),
  });
}

describe("Worker and durable connection grant authority", () => {
  it("enforces scopes, ownership and private grant creation", async () => {
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
    // Assert invalid input directly inside the DO to avoid duplicate RPC
    // unhandled rejections emitted by the test harness.
    await runInDurableObject(guest.stub, async (instance) => {
      await expect(
        instance.createConnection(
          guest.sessionId,
          guest.secret,
          ["unknown" as ConnectionScope],
          expiry,
        ),
      ).rejects.toThrow(/Invalid connection scopes/);
      await expect(
        instance.createConnection(
          guest.sessionId,
          guest.secret,
          ["tables:read", "tables:read"],
          expiry,
        ),
      ).rejects.toThrow(/Invalid connection scopes/);
    });

    expect(OPERATION_SCOPE).toEqual(EXPECTED_OPERATION_SCOPE);
    const grants = {} as Record<
      ConnectionScope,
      NonNullable<Awaited<ReturnType<typeof guest.stub.createConnection>>>
    >;
    for (const scope of CONNECTION_SCOPES) {
      const grant = await guest.stub.createConnection(
        guest.sessionId,
        guest.secret,
        [scope],
        expiry,
      );
      if (!grant) throw new Error("Grant not created");
      grants[scope] = grant;
    }
    expect(
      new Set(Object.values(grants).map((grant) => grant.connectionId)).size,
    ).toBe(4);

    for (const [operation, requiredScope] of Object.entries(
      EXPECTED_OPERATION_SCOPE,
    )) {
      const implementationScope =
        OPERATION_SCOPE[operation as keyof typeof OPERATION_SCOPE];
      expect(implementationScope).toBe(requiredScope);
      for (const grantScope of CONNECTION_SCOPES) {
        const grant = grants[grantScope];
        const actual = await decision(
          guest,
          grant.connectionId,
          implementationScope,
        );
        if (grantScope === requiredScope) {
          expect(actual).toEqual({
            allowed: true,
            actor: {
              kind: "verified-connection",
              guestId: guest.guestId,
              connectionId: grant.connectionId,
              scope: requiredScope,
              expiresAt: grant.expiresAt,
            },
          });
        } else {
          expect(actual).toEqual({
            allowed: false,
            reason: "insufficient-scope",
          });
        }
      }
    }
    const read = grants["tables:read"];
    expect(await decision(guest, crypto.randomUUID(), "tables:read")).toEqual({
      allowed: false,
      reason: "missing",
    });
    expect(
      await authorizeGuestConnection(
        env,
        crypto.randomUUID(),
        read.connectionId,
        "tables:read",
      ),
    ).toEqual({ allowed: false, reason: "mismatched" });
    expect(
      await authorizeGuestConnection(
        { GUESTS: undefined } as unknown as Pick<Env, "GUESTS">,
        guest.guestId,
        read.connectionId,
        "tables:read",
      ),
    ).toEqual({ allowed: false, reason: "unavailable" });
    expect(
      await decision(guest, read.connectionId, "unknown" as ConnectionScope),
    ).toEqual({ allowed: false, reason: "invalid" });

    // A grant cannot implicitly create table membership or a public endpoint.
    expect((await dispatch("/internal/connections")).status).toBe(404);
    await runInDurableObject(guest.stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ guest_id: string }>("SELECT guest_id FROM guest_connections")
        .toArray();
      expect(rows).toHaveLength(4);
      expect(rows.every((row) => row.guest_id === guest.guestId)).toBe(true);
    });

    // Losing the browser session does not invalidate an agent grant.
    expect((await dispatch("/guest/connections")).status).toBe(401);
    expect(
      (await decision(guest, read.connectionId, "tables:read")).allowed,
    ).toBe(true);
  });

  it("refuses cross-guest and CSRF revocation, then persists denial", async () => {
    const owner = await newGuest();
    const outsider = await newGuest();
    const grant = await owner.stub.createConnection(
      owner.sessionId,
      owner.secret,
      ["tables:read"],
      Date.now() + 60_000,
    );
    if (!grant) throw new Error("Grant not created");
    expect(
      (await decision(owner, grant.connectionId, "tables:read")).allowed,
    ).toBe(true);

    const ownerPage = await formPage("/guest/connections", owner.session);
    const outsiderPage = await formPage("/guest", outsider.session);
    const otherList = await dispatch("/guest/connections", {
      headers: { Cookie: outsider.session },
    });
    expect(ownerPage.html).toContain(grant.connectionId);
    expect(await otherList.text()).not.toContain(grant.connectionId);
    expect((await dispatch("/guest/connections/revoke")).status).toBe(405);

    const crossOrigin = await revoke(
      grant.connectionId,
      owner.session,
      ownerPage.csrf,
      ownerPage.csrfCookie,
      "https://evil.example",
    );
    expect(crossOrigin.status).toBe(403);
    const wrongCsrf = await revoke(
      grant.connectionId,
      owner.session,
      "invalid",
      ownerPage.csrfCookie,
    );
    expect(wrongCsrf.status).toBe(403);
    const foreign = await revoke(
      grant.connectionId,
      outsider.session,
      outsiderPage.csrf,
      outsiderPage.csrfCookie,
    );
    expect(foreign.status).toBe(404);
    expect(
      (await decision(owner, grant.connectionId, "tables:read")).allowed,
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
    const oldIdentity = await dispatch("/guest/me", {
      headers: { Cookie: owner.session },
    });
    const nextIdentity = await dispatch("/guest/me", {
      headers: { Cookie: nextSession },
    });
    expect(oldIdentity.status).toBe(401);
    expect(nextIdentity.status).toBe(200);
    const denial = { allowed: false, reason: "revoked" };
    expect(await decision(owner, grant.connectionId, "tables:read")).toEqual(
      denial,
    );

    await evictDurableObject(owner.stub);
    expect(await decision(owner, grant.connectionId, "tables:read")).toEqual(
      denial,
    );
    const nextPage = await formPage("/guest", nextSession);
    const nextList = await dispatch("/guest/connections", {
      headers: { Cookie: nextSession },
    });
    expect(await nextList.text()).toContain("Revoked");
    const repeated = await revoke(
      grant.connectionId,
      nextSession,
      nextPage.csrf,
      nextPage.csrfCookie,
    );
    expect(repeated.status).toBe(303);
    expect(await decision(owner, grant.connectionId, "tables:read")).toEqual(
      denial,
    );
  });

  it("refuses expired grants and corrupted persisted scopes", async () => {
    const guest = await newGuest();
    const grant = await guest.stub.createConnection(
      guest.sessionId,
      guest.secret,
      ["events:subscribe"],
      Date.now() + 60_000,
    );
    if (!grant) throw new Error("Grant not created");
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
      await decision(guest, grant.connectionId, "events:subscribe"),
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
      await decision(guest, grant.connectionId, "events:subscribe"),
    ).toEqual({ allowed: false, reason: "insufficient-scope" });
  });
});
