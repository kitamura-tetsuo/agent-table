import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getOwnConnectionIdentity } from "../../src/mcp/connection-identity";
import type { AuthenticatedMcpIdentity } from "../../src/mcp/server";
import { CONNECTION_SCOPES, type ConnectionScope } from "../../src/shared/auth";

async function connection(
  grantScopes: ConnectionScope[] = [...CONNECTION_SCOPES],
) {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const grant = await guest.createConnection(
    session.sessionId,
    session.secret,
    grantScopes,
    Date.now() + 3_600_000,
  );
  if (!grant) throw new Error("Missing synthetic connection grant");
  const identity: AuthenticatedMcpIdentity = {
    guestId,
    connectionId: grant.connectionId,
    scopes: [...grantScopes],
    tokenExpiresAtMs: Date.now() + 60_000,
  };
  return { guest, session, grant, identity };
}

// These checks use actual GuestDO grant authority and retained SQLite rows.
// The OAuth-to-tool boundary is separately exercised with the real MCP SDK.
describe("authenticated own connection inspection", () => {
  it("returns only the authenticated connection and bounds current authority", async () => {
    const f = await connection();
    const other = await f.guest.createConnection(
      f.session.sessionId,
      f.session.secret,
      ["tables:read"],
      Date.now() + 120_000,
    );
    expect(other).not.toBeNull();
    const result = await getOwnConnectionIdentity(env, f.identity);
    expect(result).toEqual({
      guestId: f.identity.guestId,
      connectionId: f.grant.connectionId,
      scopes: [...CONNECTION_SCOPES],
      expiresAt: new Date(f.identity.tokenExpiresAtMs as number).toISOString(),
      grantExpiresAt: new Date(f.grant.expiresAt).toISOString(),
      tokenExpiresAt: new Date(
        f.identity.tokenExpiresAtMs as number,
      ).toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain(other?.connectionId);
    expect(JSON.stringify(result)).not.toContain(f.session.sessionId);
    expect(JSON.stringify(result)).not.toContain(f.session.secret);
  });

  it("intersects token delegation with the current grant without adding scopes", async () => {
    const f = await connection(["tables:read", "tables:write"]);
    expect(
      await getOwnConnectionIdentity(env, {
        ...f.identity,
        scopes: ["tables:write"],
      }),
    ).toMatchObject({ scopes: ["tables:write"] });
    expect(
      await getOwnConnectionIdentity(env, {
        ...f.identity,
        scopes: [...CONNECTION_SCOPES],
      }),
    ).toMatchObject({ scopes: ["tables:read", "tables:write"] });
    expect(
      await getOwnConnectionIdentity(env, {
        ...f.identity,
        scopes: ["events:subscribe"],
      }),
    ).toBeNull();
  });

  it("uses a shortened persisted grant deadline after reconstruction", async () => {
    const f = await connection();
    const deadline = Date.now() + 30_000;
    await runInDurableObject(f.guest, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_connections SET expires_at = ? WHERE connection_id = ?",
        deadline,
        f.grant.connectionId,
      );
    });
    await evictDurableObject(f.guest);
    expect(await getOwnConnectionIdentity(env, f.identity)).toMatchObject({
      expiresAt: new Date(deadline).toISOString(),
      grantExpiresAt: new Date(deadline).toISOString(),
      tokenExpiresAt: new Date(
        f.identity.tokenExpiresAtMs as number,
      ).toISOString(),
    });
  });

  it("does not cache an earlier positive result after browser revocation", async () => {
    const f = await connection();
    expect(await getOwnConnectionIdentity(env, f.identity)).not.toBeNull();
    expect(
      await f.guest.revokeConnection(
        f.session.sessionId,
        f.session.secret,
        f.grant.connectionId,
      ),
    ).toMatchObject({ status: "revoked" });
    expect(await getOwnConnectionIdentity(env, f.identity)).toBeNull();
  });

  for (const terminal of ["expired", "deleted"] as const) {
    it(`refuses a ${terminal} persisted connection`, async () => {
      const f = await connection();
      await runInDurableObject(f.guest, async (_instance, state) => {
        if (terminal === "expired") {
          state.storage.sql.exec(
            "UPDATE guest_connections SET expires_at = ? WHERE connection_id = ?",
            Date.now() - 1,
            f.grant.connectionId,
          );
        } else {
          state.storage.sql.exec(
            "DELETE FROM guest_connections WHERE connection_id = ?",
            f.grant.connectionId,
          );
        }
      });
      await evictDurableObject(f.guest);
      expect(await getOwnConnectionIdentity(env, f.identity)).toBeNull();
    });
  }

  it("refuses foreign connections, missing identities and quarantine", async () => {
    const f = await connection();
    const foreign = await connection();
    expect(
      await getOwnConnectionIdentity(env, {
        ...f.identity,
        connectionId: foreign.grant.connectionId,
      }),
    ).toBeNull();
    expect(
      await getOwnConnectionIdentity(env, {
        ...f.identity,
        guestId: crypto.randomUUID(),
      }),
    ).toBeNull();
    expect(
      await getOwnConnectionIdentity(
        { ...env, RESTORE_QUARANTINE: "true" },
        f.identity,
      ),
    ).toBeNull();
  });

  it("refuses unknown, expired or out-of-range token authority", async () => {
    const f = await connection();
    for (const tokenExpiresAtMs of [
      null,
      0,
      Date.now() - 1,
      Math.floor(Date.now() / 1_000),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(
        await getOwnConnectionIdentity(env, {
          ...f.identity,
          tokenExpiresAtMs,
        }),
      ).toBeNull();
    }
    for (const scopes of [
      [],
      ["tables:read", "tables:read"],
      [...CONNECTION_SCOPES, "tables:read"],
      ["unrecognized-scope"],
    ]) {
      expect(
        await getOwnConnectionIdentity(env, {
          ...f.identity,
          scopes: scopes as ConnectionScope[],
        }),
      ).toBeNull();
    }
  });

  it("fails closed when the current authority cannot be read", async () => {
    const f = await connection();
    const unavailable = {
      ...env,
      GUESTS: {
        idFromName: () => {
          throw new Error("private-authority-error-sentinel");
        },
      } as unknown as Env["GUESTS"],
    };
    expect(await getOwnConnectionIdentity(unavailable, f.identity)).toBeNull();
  });
});
