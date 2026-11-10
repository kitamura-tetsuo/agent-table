import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { inboxStreamFixture } from "../helpers/inbox-stream-fixture";

const fixture = () => inboxStreamFixture(env);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Actual TableDO RPC byte streams, GuestDO authority and committed SQLite rows.
// These do NOT exercise the public MCP handler or prove two-edge SDK delivery.
describe("TableDO internal committed-peer hint streams (public MCP disabled)", () => {
  it("suppresses self, retry, failed post and reads; delivers after peer commit", async () => {
    const f = await fixture();
    const opened = await f.open();
    if (!opened.ok) throw new Error("No internal stream");
    const reader = opened.value.stream.getReader();
    try {
      const next = reader.read();
      const own = {
        request_id: "hint_stream_own_post_001",
        body: "Own private text",
      };
      expect(
        await f.table.postMessage(f.owner.actor("tables:write"), own),
      ).toMatchObject({ ok: true, value: { seq: 1 } });
      expect(
        await f.table.postMessage(f.owner.actor("tables:write"), own),
      ).toMatchObject({ ok: true, value: { seq: 1 } });
      expect(
        await f.table.postMessage(f.peer.actor("tables:write"), {
          request_id: "hint_stream_failed_00001",
          body: "",
        }),
      ).toMatchObject({ ok: false });
      await f.table.readMessages(f.owner.actor("tables:read"), {});
      expect(
        await Promise.race([
          next.then(() => "unexpected"),
          pause(40).then(() => "quiet"),
        ]),
      ).toBe("quiet");
      const post = {
        request_id: "hint_stream_peer_post_01",
        body: "Committed private text",
      };
      const committed = await f.table.postMessage(
        f.peer.actor("tables:write"),
        post,
      );
      expect(committed).toMatchObject({ ok: true, value: { seq: 2 } });
      const chunk = await next;
      expect(JSON.parse(new TextDecoder().decode(chunk.value))).toEqual({
        kind: "resource_updated",
        uri: f.created.value.ownInboxUri,
      });
      expect(
        await f.table.readMessages(f.owner.actor("tables:read"), {
          after_seq: 1,
        }),
      ).toMatchObject({
        ok: true,
        value: { messages: [{ seq: 2, body: post.body }] },
      });
      const quiet = reader.read();
      await f.table.postMessage(f.peer.actor("tables:write"), post);
      expect(
        await Promise.race([
          quiet.then(() => "unexpected"),
          pause(40).then(() => "quiet"),
        ]),
      ).toBe("quiet");
    } finally {
      await f.table.cancelInboxHintStream(
        opened.value.snapshot.membershipId,
        opened.value.cancellationId,
      );
      await reader.cancel().catch(() => {});
    }
  });

  it("replaces a membership stream, cancels, and recovers disconnected gaps by read", async () => {
    const f = await fixture();
    const first = await f.open();
    if (!first.ok) throw new Error("No stream");
    const old = first.value.stream.getReader();
    const second = await f.open();
    if (!second.ok) throw new Error("No replacement");
    await expect(old.read()).rejects.toThrow();
    await f.table.cancelInboxHintStream(
      first.value.snapshot.membershipId,
      first.value.cancellationId,
    );
    await second.value.stream.cancel();
    await f.table.cancelInboxHintStream(
      second.value.snapshot.membershipId,
      second.value.cancellationId,
    );
    await f.table.postMessage(f.peer.actor("tables:write"), {
      request_id: "hint_stream_gap_post_001",
      body: "Disconnected gap",
    });
    const third = await f.open();
    if (!third.ok) throw new Error("No reconnect");
    try {
      expect(third.value.snapshot).toMatchObject({
        lastSeq: 1,
        latestPeerSeq: 1,
      });
      expect(
        await f.table.readMessages(f.owner.actor("tables:read"), {
          after_seq: 0,
        }),
      ).toMatchObject({
        ok: true,
        value: { messages: [{ seq: 1, body: "Disconnected gap" }] },
      });
    } finally {
      await f.table.cancelInboxHintStream(
        third.value.snapshot.membershipId,
        third.value.cancellationId,
      );
      await third.value.stream.cancel().catch(() => {});
    }
  });

  it.each([
    "revocation",
    "scope",
    "close",
    "purge",
    "token",
    "table",
    "grant",
  ] as const)("terminates idle streams on %s", async (reason) => {
    const f = await fixture();
    const result = await f.open(
      reason === "token" ? Date.now() + 100 : undefined,
    );
    if (!result.ok) throw new Error("No stream");
    const reader = result.value.stream.getReader();
    const ended = reader.read();
    // Register the rejection assertion before triggering terminal state.
    const assertion = expect(ended).rejects.toThrow();
    if (reason === "revocation")
      await f.owner.stub.revokeConnection(
        f.owner.session.sessionId,
        f.owner.session.secret,
        f.owner.grant.connectionId,
      );
    if (reason === "scope" || reason === "grant")
      await runInDurableObject(f.owner.stub, async (_instance, state) => {
        if (reason === "scope")
          state.storage.sql.exec(
            "UPDATE guest_connections SET scopes_json = ?",
            '["tables:read","tables:write"]',
          );
        else
          state.storage.sql.exec(
            "UPDATE guest_connections SET expires_at = ?",
            Date.now() + 100,
          );
      });
    if (reason === "close")
      await f.table.closeTable(
        f.owner.actor("tables:write"),
        "hint_stream_close_00001",
      );
    if (reason === "purge")
      await f.table.purgeTable(f.owner.actor("tables:write"));
    if (reason === "table")
      await runInDurableObject(f.table, async (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_metadata SET expires_at = ?",
          Date.now() + 100,
        );
      });
    try {
      await assertion;
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("denies foreign ownership, invalid token deadlines and revoked attach", async () => {
    const f = await fixture();
    expect(
      await f.table.openInboxHintStream(
        f.peer.actor("events:subscribe"),
        f.filter,
        Date.now() + 30_000,
      ),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    for (const deadline of [
      NaN,
      Infinity,
      Date.now(),
      Math.floor(Date.now() / 1000),
    ]) {
      expect(await f.open(deadline)).toEqual({
        ok: false,
        code: "NOT_AUTHORIZED",
      });
    }
    await f.owner.stub.revokeConnection(
      f.owner.session.sessionId,
      f.owner.session.secret,
      f.owner.grant.connectionId,
    );
    expect(await f.open()).toEqual({ ok: false, code: "NOT_AUTHORIZED" });
  });
});
