import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_INBOX_STREAM_LIFETIME_MS } from "../../src/mcp/subscriptions";
import {
  authorizeGuestConnection,
  type ConnectionScope,
  type VerifiedConnectionActor,
} from "../../src/shared/auth";

async function guest(scopes: ConnectionScope[] = ["events:subscribe"]) {
  const id = crypto.randomUUID();
  const stub = env.GUESTS.get(env.GUESTS.idFromName(id));
  const session = await stub.createSession(id);
  const grant = await stub.createConnection(
    session.sessionId,
    session.secret,
    scopes,
    Date.now() + 3_600_000,
  );
  if (!grant) throw new Error("Missing grant");
  const actor = (scope: ConnectionScope): VerifiedConnectionActor => ({
    kind: "verified-connection",
    guestId: id,
    connectionId: grant.connectionId,
    scope,
    // Deliberately untrusted: TableDO must use the current grant deadline.
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  return { id, stub, session, grant, actor };
}

async function fixture() {
  const owner = await guest(["tables:write", "events:subscribe"]);
  const input = {
    request_id: "subscription_authority_create_001",
    title: "Subscription admission",
  };
  const write = owner.actor("tables:write");
  const reservation = await owner.stub.reserveCreation(write, input);
  if (!reservation.ok) throw new Error("Missing reservation");
  const tableId = reservation.reservation.tableId;
  const table = env.TABLES.get(env.TABLES.idFromName(tableId));
  const created = await table.initializeTable(
    write,
    input,
    reservation.reservation,
  );
  if (!created.ok) throw new Error("Missing table");
  const filter = { resourceSubscriptions: [created.value.ownInboxUri] };
  const actor = owner.actor("events:subscribe");
  return { owner, tableId, table, created, filter, actor };
}

// These are real GuestDO/TableDO RPC and SQLite tests. They establish admission
// authority only: no stream is attached and no cross-Worker delivery is claimed.
describe("TableDO inbox subscription preflight (public streaming disabled)", () => {
  it("allows subscribe without tables:read and grants no transcript access", async () => {
    const f = await fixture();
    const before = Date.now();
    const check = await f.table.checkInboxSubscription(
      f.actor,
      f.filter,
      before + 900_000,
    );
    expect(check).toMatchObject({
      ok: true,
      value: {
        uri: f.created.value.ownInboxUri,
        tableId: f.tableId,
        membershipId: f.created.value.ownMembershipId,
        lastSeq: 0,
        latestPeerSeq: 0,
      },
    });
    if (!check.ok) throw new Error("Missing admission snapshot");
    expect(check.value.expiresAt).toBeGreaterThan(before);
    expect(check.value.expiresAt).toBeLessThanOrEqual(
      Date.now() + MAX_INBOX_STREAM_LIFETIME_MS,
    );
    expect(
      await f.table.readMessages(f.owner.actor("tables:read"), {}),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    expect(JSON.stringify(check)).not.toContain(f.owner.id);
    expect(JSON.stringify(check)).not.toContain(f.owner.grant.connectionId);
    await evictDurableObject(f.table);
    expect(
      await f.table.checkInboxSubscription(f.actor, f.filter, before + 900_000),
    ).toMatchObject({ ok: true, value: { lastSeq: 0 } });
  });

  it("bounds the snapshot by token, freshly read grant, and table deadlines", async () => {
    const f = await fixture();
    const tokenExpiry = Date.now() + 50_000;
    expect(
      await f.table.checkInboxSubscription(f.actor, f.filter, tokenExpiry),
    ).toMatchObject({ ok: true, value: { expiresAt: tokenExpiry } });
    const grantExpiry = Date.now() + 40_000;
    await runInDurableObject(f.owner.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_connections SET expires_at = ? WHERE connection_id = ?",
        grantExpiry,
        f.owner.grant.connectionId,
      );
    });
    expect(
      await f.table.checkInboxSubscription(f.actor, f.filter, tokenExpiry),
    ).toMatchObject({ ok: true, value: { expiresAt: grantExpiry } });
    const tableExpiry = Date.now() + 30_000;
    await runInDurableObject(f.table, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE table_metadata SET expires_at = ?",
        tableExpiry,
      );
    });
    expect(
      await f.table.checkInboxSubscription(f.actor, f.filter, tokenExpiry),
    ).toMatchObject({ ok: true, value: { expiresAt: tableExpiry } });
    for (const invalid of [
      NaN,
      Infinity,
      0,
      Date.now(),
      Math.floor(Date.now() / 1000),
    ]) {
      expect(
        await f.table.checkInboxSubscription(f.actor, f.filter, invalid),
      ).toEqual({ ok: false, code: "NOT_AUTHORIZED" });
    }
  });

  it("rejects foreign membership, wrong table routing, outsiders and aliases", async () => {
    const f = await fixture();
    const outsider = await guest();
    expect(
      await f.table.checkInboxSubscription(
        outsider.actor("events:subscribe"),
        f.filter,
        Date.now() + 30_000,
      ),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    for (const uri of [
      f.created.value.ownInboxUri.replace(
        f.created.value.ownMembershipId,
        crypto.randomUUID(),
      ),
      f.created.value.ownInboxUri.replace(f.tableId, crypto.randomUUID()),
    ]) {
      expect(
        await f.table.checkInboxSubscription(
          f.actor,
          { resourceSubscriptions: [uri] },
          Date.now() + 30_000,
        ),
      ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    }
    const relocated = env.TABLES.get(
      env.TABLES.idFromName(crypto.randomUUID()),
    );
    expect(
      await relocated.checkInboxSubscription(
        f.actor,
        f.filter,
        Date.now() + 30_000,
      ),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    for (const filter of [
      {},
      {
        resourceSubscriptions: [
          f.created.value.ownInboxUri,
          f.created.value.ownInboxUri,
        ],
      },
      { ...f.filter, toolsListChanged: false },
      { resourceSubscriptions: [`${f.created.value.ownInboxUri}?alias=1`] },
    ]) {
      expect(
        await f.table.checkInboxSubscription(
          f.actor,
          filter,
          Date.now() + 30_000,
        ),
      ).toEqual({ ok: false, code: "INVALID_REQUEST" });
    }
  });

  it("rechecks grant scope and revocation rather than trusting an old actor", async () => {
    const f = await fixture();
    const checked = await authorizeGuestConnection(
      env,
      f.owner.id,
      f.owner.grant.connectionId,
      "events:subscribe",
    );
    if (!checked.allowed) throw new Error("Missing current grant");
    expect(
      await f.table.checkInboxSubscription(
        f.owner.actor("tables:write"),
        f.filter,
        Date.now() + 30_000,
      ),
    ).toEqual({ ok: false, code: "NOT_AUTHORIZED" });
    await runInDurableObject(f.owner.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_connections SET scopes_json = ?",
        '["tables:write"]',
      );
    });
    expect(
      await f.table.checkInboxSubscription(
        checked.actor,
        f.filter,
        Date.now() + 30_000,
      ),
    ).toEqual({ ok: false, code: "NOT_AUTHORIZED" });
    await runInDurableObject(f.owner.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_connections SET scopes_json = ?",
        '["events:subscribe"]',
      );
    });
    await f.owner.stub.revokeConnection(
      f.owner.session.sessionId,
      f.owner.session.secret,
      f.owner.grant.connectionId,
    );
    expect(
      await f.table.checkInboxSubscription(
        checked.actor,
        f.filter,
        Date.now() + 30_000,
      ),
    ).toEqual({ ok: false, code: "NOT_AUTHORIZED" });
  });

  it.each(["close", "expire", "delete"] as const)(
    "rechecks local %s after yielding for the remote grant",
    async (transition) => {
      const f = await fixture();
      await runInDurableObject(f.table, async (instance, state) => {
        const pending = instance.checkInboxSubscription(
          f.actor,
          f.filter,
          Date.now() + 30_000,
        );
        // The async method has reached the GuestDO await, so these SQL changes
        // happen after invocation but before the admission snapshot is read.
        if (transition === "close")
          state.storage.sql.exec("UPDATE table_metadata SET state = 'closed'");
        if (transition === "expire")
          state.storage.sql.exec(
            "UPDATE table_metadata SET created_at = ?, expires_at = ?",
            Date.now() - 2_000,
            Date.now() - 1_000,
          );
        if (transition === "delete") {
          state.storage.sql.exec("DELETE FROM table_memberships");
          state.storage.sql.exec("UPDATE table_metadata SET state = 'deleted'");
        }
        expect(await pending).toEqual({
          ok: false,
          code:
            transition === "close"
              ? "TABLE_TERMINAL"
              : transition === "expire"
                ? "TABLE_EXPIRED"
                : "TABLE_NOT_FOUND",
        });
      });
    },
  );
});
