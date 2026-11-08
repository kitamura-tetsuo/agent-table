import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { closeTable as serviceCloseTable } from "../../src/services/tables";
import { authorizeGuestConnection, type ConnectionScope } from "../../src/shared/auth";

async function guest() {
  const id = crypto.randomUUID();
  const stub = env.GUESTS.get(env.GUESTS.idFromName(id));
  const session = await stub.createSession(id);
  const grant = await stub.createConnection(
    session.sessionId,
    session.secret,
    ["tables:read", "tables:write"],
    Date.now() + 24 * 60 * 60_000,
  );
  if (!grant) throw new Error("Missing test guest grant");
  const connectionId = grant.connectionId;
  async function actor(scope: ConnectionScope) {
    const result = await authorizeGuestConnection(env, id, connectionId, scope);
    if (!result.allowed) throw new Error("Missing test actor");
    return result.actor;
  }
  return { id, stub, actor };
}

async function tableFixture() {
  const owner = await guest();
  const input = {
    request_id: "lifecycle_create_request_0001",
    title: "Synthetic lifecycle content",
    purpose: "No real identity",
  };
  const writer = await owner.actor("tables:write");
  const reserved = await owner.stub.reserveCreation(writer, input);
  if (!reserved.ok) throw new Error("Creation was not reserved");
  const id = reserved.reservation.tableId;
  const stub = env.TABLES.get(env.TABLES.idFromName(id));
  const created = await stub.initializeTable(writer, input, reserved.reservation);
  if (!created.ok) throw new Error("Table was not initialized");
  return { owner, writer, id, stub, input, reserved, created };
}

describe("TableDO terminal lifecycle and durable cleanup", () => {
  it("closes once, keeps original expiry/reads and old receipts, and rejects new work", async () => {
    const fixture = await tableFixture();
    const peer = await guest();
    const initial = {
      request_id: "lifecycle_committed_post_0001",
      body: "Committed before close",
    };
    const posted = await fixture.stub.postMessage(fixture.writer, initial);
    expect(posted).toMatchObject({ ok: true, value: { seq: 1, persisted: true } });
    const invite = await fixture.stub.issueInvite(
      fixture.writer,
      "lifecycle_invitation_0001",
    );
    if (!invite.ok) throw new Error("Invitation was not issued");
    const hints: Array<{ tableId: string; state: string }> = [];
    const close = await serviceCloseTable(
      env, fixture.writer, fixture.id, "lifecycle_close_owner_0001",
      (hint) => hints.push(hint),
    );
    expect(close).toMatchObject({
      ok: true,
      value: { table_id: fixture.id, state: "closed" },
    });
    if (!close.ok) throw new Error("Expected successful close");
    expect(close.value.expires_at).toBe(fixture.created.value.expiresAt);
    expect(hints).toEqual([{ tableId: fixture.id, state: "closed" }]);
    const retry = await serviceCloseTable(
      env, fixture.writer, fixture.id, "lifecycle_close_owner_0001",
      (hint) => hints.push(hint),
    );
    expect(retry).toEqual(close);
    expect(hints).toHaveLength(1);
    const page = await fixture.stub.readMessages(
      await fixture.owner.actor("tables:read"), {},
    );
    expect(page).toMatchObject({
      ok: true,
      value: { messages: [{ body: initial.body, seq: 1 }] },
    });
    const old = await fixture.stub.postMessage(fixture.writer, initial);
    expect(old).toEqual(posted);
    expect(await fixture.stub.postMessage(fixture.writer, {
      request_id: "lifecycle_new_post_0001", body: "Should be refused",
    })).toEqual({ ok: false, code: "TABLE_TERMINAL" });
    expect(await fixture.stub.postMessage(fixture.writer, {
      ...initial, body: "Modified after close",
    })).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect((await fixture.stub.issueInvite(fixture.writer, "lifecycle_new_invite_0001")).ok).toBe(false);
    expect((await fixture.stub.redeemInvite(
      await peer.actor("tables:write"),
      invite.value.invitation,
      "lifecycle_join_after_close_0001",
    )).ok).toBe(false);
    await runInDurableObject(fixture.stub, async (_instance, storage) => {
      const row = storage.storage.sql.exec<{
        expires_at: number; state: string; closed_at: number;
      }>("SELECT expires_at, state, closed_at FROM table_metadata").one();
      expect(row.state).toBe("closed");
      expect(new Date(row.expires_at).toISOString()).toBe(fixture.created.value.expiresAt);
      expect(Number.isInteger(row.closed_at)).toBe(true);
      expect(storage.storage.sql.exec("SELECT COUNT(*) AS total FROM table_messages").one()).toEqual({ total: 1 });
    });
    expect(await fixture.stub.closeTable(
      await peer.actor("tables:write"), "lifecycle_outsider_close_0001",
    )).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
  });

  it("purges privately and leaves no content or credential authority after eviction", async () => {
    const fixture = await tableFixture();
    expect((await fixture.stub.postMessage(fixture.writer, {
      request_id: "lifecycle_purge_post_0001", body: "Erase this synthetic body",
    })).ok).toBe(true);
    expect((await fixture.stub.issueInvite(
      fixture.writer, "lifecycle_purge_invite_0001",
    )).ok).toBe(true);
    const purged = await fixture.stub.purgeTable(fixture.writer);
    expect(purged).toMatchObject({
      ok: true, value: { table_id: fixture.id, state: "deleted" },
      terminalHint: { tableId: fixture.id, state: "deleted" },
    });
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      for (const table of [
        "table_metadata", "table_memberships", "table_invitations",
        "table_join_receipts", "table_messages", "table_post_receipts",
        "table_transcript_usage",
      ]) {
        expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one()).toEqual({ n: 0 });
      }
      const tombstone = state.storage.sql.exec<{
        table_id: string; terminal_state: string; retain_until: number;
      }>("SELECT table_id, terminal_state, retain_until FROM table_tombstones").one();
      expect(tombstone.table_id).toBe(fixture.id);
      expect(tombstone.terminal_state).toBe("deleted");
      expect(tombstone.retain_until).toBeGreaterThan(Date.now());
      expect(state.storage.sql.exec("SELECT guest_id FROM table_tombstone_guests").toArray()).toEqual([{ guest_id: fixture.owner.id }]);
    });
    await evictDurableObject(fixture.stub);
    expect(await fixture.stub.readMessages(await fixture.owner.actor("tables:read"), {})).toEqual({
      ok: false, code: "TABLE_NOT_FOUND",
    });
    expect(await fixture.stub.postMessage(fixture.writer, {
      request_id: "lifecycle_deleted_post_0001", body: "No revival",
    })).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    const replay = await fixture.stub.initializeTable(
      fixture.writer, fixture.input, fixture.reserved.reservation,
    );
    expect(replay).toEqual({ ok: false, code: "TABLE_TERMINAL" });
    await expect(fixture.stub.lifecycleStatus()).resolves.toMatchObject({
      state: "deleted", canDispatch: false,
    });
  });

  it("denies expiry before delayed alarms and cleans the bounded tombstone afterwards", async () => {
    const fixture = await tableFixture();
    expect((await fixture.stub.postMessage(fixture.writer, {
      request_id: "lifecycle_expiry_post_0001", body: "Expiring",
    })).ok).toBe(true);
    // Shift only the synthetic test table's original lifetime to the past.
    // The existing alarm may still be armed for the original future deadline.
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE table_metadata SET created_at = ?, expires_at = ?",
        Date.now() - 120_000, Date.now() - 1,
      );
    });
    expect(await fixture.stub.readMessages(await fixture.owner.actor("tables:read"), {})).toEqual({
      ok: false, code: "TABLE_EXPIRED",
    });
    expect(await fixture.stub.postMessage(fixture.writer, {
      request_id: "lifecycle_expired_new_post_001", body: "Too late",
    })).toEqual({ ok: false, code: "TABLE_EXPIRED" });
    expect(await fixture.stub.closeTable(fixture.writer, "lifecycle_expired_close_0001")).toEqual({
      ok: false, code: "TABLE_EXPIRED",
    });
    await runInDurableObject(fixture.stub, (instance) => instance.alarm());
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM table_metadata").one()).toEqual({ total: 0 });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM table_messages").one()).toEqual({ total: 0 });
      expect(state.storage.sql.exec("SELECT terminal_state FROM table_tombstones").one()).toEqual({ terminal_state: "expired" });
      state.storage.sql.exec("UPDATE table_tombstones SET retain_until = ?", Date.now() - 1);
    });
    await evictDurableObject(fixture.stub);
    await fixture.stub.alarm();
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM table_tombstones").one()).toEqual({ n: 0 });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM table_tombstone_guests").one()).toEqual({ n: 0 });
    });
    const retried = await fixture.stub.initializeTable(
      fixture.writer, fixture.input, fixture.reserved.reservation,
    );
    expect(retried.ok).toBe(false);
  });
});
