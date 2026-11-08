import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authorizeGuestConnection, type ConnectionScope } from "../../src/shared/auth";
import { TABLE_LIMITS } from "../../src/shared/limits";

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
  if (!grant) throw new Error("Missing guest grant");
  async function actor(scope: ConnectionScope) {
    const decision = await authorizeGuestConnection(env, id, grant.connectionId, scope);
    if (!decision.allowed) throw new Error("Missing test scope");
    return decision.actor;
  }
  return { id, stub, actor };
}
async function tableFixture() {
  const owner = await guest();
  const input = {
    request_id: "transcript_create_request_0001",
    title: "Synthetic transcript",
  };
  const write = await owner.actor("tables:write");
  const reservation = await owner.stub.reserveCreation(write, input);
  if (!reservation.ok) throw new Error("Missing creation reservation");
  const stub = env.TABLES.get(env.TABLES.idFromName(reservation.reservation.tableId));
  const created = await stub.initializeTable(write, input, reservation.reservation);
  if (!created.ok) throw new Error("Table not initialized");
  return { owner, stub, id: reservation.reservation.tableId, created };
}

describe("TableDO committed transcript and reads", () => {
  it("persists one receipt through response loss and reconstruction", async () => {
    const fixture = await tableFixture();
    const actor = await fixture.owner.actor("tables:write");
    const original = {
      request_id: "transcript_first_post_0001",
      body: "  é 😀\nMore  ",
    };
    const first = await fixture.stub.postMessage(actor, original);
    expect(first).toMatchObject({ ok: true, value: { persisted: true, seq: 1 } });
    const changed = await fixture.stub.postMessage(actor, {
      ...original, body: "changed",
    });
    expect(changed).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    await evictDurableObject(fixture.stub);
    const second = await fixture.stub.postMessage(actor, original);
    expect(second).toEqual(first);
    const page = await fixture.stub.readMessages(
      await fixture.owner.actor("tables:read"),
      {},
    );
    expect(page).toMatchObject({
      ok: true,
      value: { through_seq: 1, next_after_seq: 1, has_more: false,
        messages: [{ body: original.body, seq: 1 }] },
    });
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT * FROM table_messages").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT * FROM table_post_receipts").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec(
        "SELECT body_bytes FROM table_transcript_usage",
      ).one()).toEqual({
        body_bytes: new TextEncoder().encode(original.body).byteLength,
      });
    });
  });

  it("captures a fixed snapshot despite later posts and refuses bad cursors", async () => {
    const { owner, stub } = await tableFixture();
    const writer = await owner.actor("tables:write");
    const reader = await owner.actor("tables:read");
    for (let i = 0; i < 3; i++) {
      expect((await stub.postMessage(writer, {
        request_id: `transcript_snapshot_key_000${i}`,
        body: `Page ${i}`,
      })).ok).toBe(true);
    }
    const first = await stub.readMessages(reader, { limit: 2 });
    if (!first.ok) throw new Error("No snapshot");
    expect(first.value.messages.map((x) => x.seq)).toEqual([1, 2]);
    expect(first.value.through_seq).toBe(3);
    expect(first.value.has_more).toBe(true);
    expect((await stub.postMessage(writer, {
      request_id: "transcript_snapshot_key_0003",
      body: "Arrived later",
    })).ok).toBe(true);
    const tail = await stub.readMessages(reader, {
      after_seq: first.value.next_after_seq,
      through_seq: first.value.through_seq,
      limit: 2,
    });
    expect(tail).toMatchObject({
      ok: true, value: { through_seq: 3, has_more: false,
        messages: [{ seq: 3 }] },
    });
    for (const input of [
      { after_seq: -1 }, { after_seq: 5 }, { after_seq: 4, through_seq: 3 },
      { limit: 101 }, { limit: 0 }, { through_seq: 99 },
    ]) {
      expect((await stub.readMessages(reader, input)).ok).toBe(false);
    }
  });

  it("enforces byte, one-minute rate and aggregate authority transactionally", async () => {
    const { owner, stub } = await tableFixture();
    const actor = await owner.actor("tables:write");
    expect(await stub.postMessage(actor, {
      request_id: "transcript_too_large_0001",
      body: "あ".repeat(3000),
    })).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(await stub.postMessage(actor, {
      request_id: "transcript_empty_body_0001",
      body: "  \n  ",
    })).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(await stub.postMessage(actor, {
      request_id: "transcript_cross_table_reply",
      body: "hello", reply_to_message_id: crypto.randomUUID(),
    })).toEqual({ ok: false, code: "INVALID_REPLY" });
    for (let i = 0; i < 10; i++) {
      expect((await stub.postMessage(actor, {
        request_id: `transcript_rate_limit_000${i}`,
        body: "A".repeat(TABLE_LIMITS.messageBodyBytes),
      })).ok).toBe(true);
    }
    expect(await stub.postMessage(actor, {
      request_id: "transcript_rate_limit_0010",
      body: "full",
    })).toEqual({ ok: false, code: "RATE_LIMITED" });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT last_seq FROM table_metadata",
      ).one()).toEqual({ last_seq: 10 });
      expect(state.storage.sql.exec(
        "SELECT body_bytes FROM table_transcript_usage",
      ).one()).toEqual({ body_bytes: 10 * TABLE_LIMITS.messageBodyBytes });
    });
  });

  it("makes pre-join messages visible and advances only peer watermark", async () => {
    const { owner, stub, created } = await tableFixture();
    const pre = await stub.postMessage(await owner.actor("tables:write"), {
      request_id: "transcript_before_join_0001",
      body: "Before invitee arrives",
    });
    expect(pre.ok).toBe(true);
    const invite = await stub.issueInvite(
      await owner.actor("tables:write"),
      "transcript_invitation_key_001",
    );
    if (!invite.ok) throw new Error("No invitation");
    const newcomer = await guest();
    const joined = await stub.redeemInvite(
      await newcomer.actor("tables:write"),
      invite.value.invitation,
      "transcript_join_key_000001",
    );
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    const page = await stub.readMessages(await newcomer.actor("tables:read"), {});
    expect(page).toMatchObject({
      ok: true, value: {
        latest_peer_seq: 1,
        messages: [{ seq: 1, body: "Before invitee arrives" }],
      },
    });
    const first = await stub.postMessage(await newcomer.actor("tables:write"), {
      request_id: "transcript_invitee_post_0001",
      body: "Hello owner",
    });
    expect(first).toMatchObject({ ok: true, value: { seq: 2 } });
    const own = await stub.readOwnInbox(
      await owner.actor("tables:read"), created.value.ownInboxUri,
    );
    expect(own).toMatchObject({
      ok: true, value: { lastSeq: 2, latestPeerSeq: 2 },
    });
    const inviteeInbox = await stub.readOwnInbox(
      await newcomer.actor("tables:read"), joined.value.ownInboxUri,
    );
    expect(inviteeInbox).toMatchObject({
      ok: true, value: { lastSeq: 2, latestPeerSeq: 1 },
    });
    expect(await stub.readOwnInbox(
      await newcomer.actor("tables:read"), created.value.ownInboxUri,
    )).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
  });
});
