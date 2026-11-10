import assert from "node:assert/strict";
import { GuestDO } from "../../src/objects/guest";
import { TableDO } from "../../src/objects/table";
import type { VerifiedConnectionActor } from "../../src/shared/auth";
import { inboxStreamFixture } from "../helpers/inbox-stream-fixture";

// These subclasses exist only in the socket-free native test configuration.
// They expose narrowly scoped fault injection, never a production RPC binding.
export class ProbeTableDO extends TableDO {
  streamCountForTest(): number {
    return (
      this as unknown as { inboxStreams: { entries: Map<string, unknown> } }
    ).inboxStreams.entries.size;
  }
  expireForTest() {
    this.ctx.storage.sql.exec(
      "UPDATE table_metadata SET expires_at = ?",
      Date.now() + 50,
    );
  }

  async slowConsumerForTest(
    actor: VerifiedConnectionActor,
    filter: unknown,
    writer: VerifiedConnectionActor,
  ) {
    const opened = await this.openInboxHintStream(
      actor,
      filter,
      Date.now() + 5_000,
    );
    assert(opened.ok);
    // Retain the byte stream inside TableDO so RPC prefetch cannot drain it.
    const reader = opened.value.stream.getReader();
    try {
      for (let i = 0; i < 2; i++) {
        assert(
          (
            await this.postMessage(writer, {
              request_id: `native_slow_post_000${i}`,
              body: "Synthetic slow-consumer post",
            })
          ).ok,
        );
        await new Promise((r) => setTimeout(r, 30));
      }
      await assert.rejects(reader.read(), /Inbox stream ended/);
    } finally {
      await this.cancelInboxHintStream(
        opened.value.snapshot.membershipId,
        opened.value.cancellationId,
      );
      await reader.cancel().catch(() => {});
    }
  }
}

export class ProbeGuestDO extends GuestDO {
  changeGrantForTest(kind: "scope" | "expiry") {
    if (kind === "scope")
      this.ctx.storage.sql.exec(
        "UPDATE guest_connections SET scopes_json = ?",
        '["tables:read","tables:write"]',
      );
    else
      this.ctx.storage.sql.exec(
        "UPDATE guest_connections SET expires_at = ?",
        Date.now() + 50,
      );
  }
}

type ProbeEnv = Omit<Env, "TABLES" | "GUESTS"> & {
  TABLES: DurableObjectNamespace<ProbeTableDO>;
  GUESTS: DurableObjectNamespace<ProbeGuestDO>;
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default {
  async test(_controller: unknown, env: ProbeEnv) {
    const fixture = () => inboxStreamFixture(env);
    let passed = 0;
    async function scenario(name: string, run: () => Promise<void>) {
      await run();
      passed++;
      console.log(`PASS internal TableDO: ${name}`);
    }

    await scenario(
      "RPC peer-only committed delivery and retained read",
      async () => {
        const f = await fixture();
        const opened = await f.open();
        assert(opened.ok);
        const reader = opened.value.stream.getReader();
        try {
          const next = reader.read();
          const own = {
            request_id: "native_own_post_00001",
            body: "Self text",
          };
          assert(
            (await f.table.postMessage(f.owner.actor("tables:write"), own)).ok,
          );
          assert(
            (await f.table.postMessage(f.owner.actor("tables:write"), own)).ok,
          );
          assert(
            !(
              await f.table.postMessage(f.peer.actor("tables:write"), {
                request_id: "native_failed_post_01",
                body: "",
              })
            ).ok,
          );
          await f.table.readMessages(f.owner.actor("tables:read"), {});
          assert.equal(
            await Promise.race([
              next.then(() => "unexpected"),
              pause(40).then(() => "quiet"),
            ]),
            "quiet",
          );
          const post = {
            request_id: "native_peer_post_0001",
            body: "Peer committed text",
          };
          const result = await f.table.postMessage(
            f.peer.actor("tables:write"),
            post,
          );
          assert(result.ok);
          assert.equal(result.value.seq, 2);
          const hint = await next;
          assert.deepEqual(JSON.parse(new TextDecoder().decode(hint.value)), {
            kind: "resource_updated",
            uri: f.created.value.ownInboxUri,
          });
          const read = await f.table.readMessages(
            f.owner.actor("tables:read"),
            { after_seq: 1 },
          );
          assert(read.ok);
          assert.equal(read.value.messages[0]?.body, post.body);
          assert.equal(read.value.messages[0]?.seq, 2);
          const quiet = reader.read();
          await f.table.postMessage(f.peer.actor("tables:write"), post);
          assert.equal(
            await Promise.race([
              quiet.then(() => "unexpected"),
              pause(40).then(() => "quiet"),
            ]),
            "quiet",
          );
        } finally {
          await f.table.cancelInboxHintStream(
            opened.value.snapshot.membershipId,
            opened.value.cancellationId,
          );
          await reader.cancel().catch(() => {});
        }
      },
    );

    await scenario(
      "replacement, cancellation and retained disconnected gap",
      async () => {
        const f = await fixture();
        const first = await f.open();
        assert(first.ok);
        const old = first.value.stream.getReader();
        const second = await f.open();
        assert(second.ok);
        await assert.rejects(old.read());
        assert.equal(
          await env.TABLES.get(
            env.TABLES.idFromName(f.tableId),
          ).streamCountForTest(),
          1,
        );
        await f.table.cancelInboxHintStream(
          first.value.snapshot.membershipId,
          first.value.cancellationId,
        );
        assert.equal(
          await env.TABLES.get(
            env.TABLES.idFromName(f.tableId),
          ).streamCountForTest(),
          1,
        );
        await second.value.stream.cancel();
        await pause(50);
        assert(
          (await env.TABLES.get(
            env.TABLES.idFromName(f.tableId),
          ).streamCountForTest()) <= 1,
        );
        await f.table.cancelInboxHintStream(
          second.value.snapshot.membershipId,
          second.value.cancellationId,
        );
        assert.equal(
          await env.TABLES.get(
            env.TABLES.idFromName(f.tableId),
          ).streamCountForTest(),
          0,
        );
        assert(
          (
            await f.table.postMessage(f.peer.actor("tables:write"), {
              request_id: "native_gap_post_00001",
              body: "Retained gap",
            })
          ).ok,
        );
        const third = await f.open();
        assert(third.ok);
        try {
          assert.equal(third.value.snapshot.lastSeq, 1);
          const read = await f.table.readMessages(
            f.owner.actor("tables:read"),
            { after_seq: 0 },
          );
          assert(read.ok);
          assert.equal(read.value.messages[0]?.body, "Retained gap");
        } finally {
          await f.table.cancelInboxHintStream(
            third.value.snapshot.membershipId,
            third.value.cancellationId,
          );
          await third.value.stream.cancel().catch(() => {});
        }
      },
    );

    await scenario(
      "simultaneous actors keep independent peer-only inboxes",
      async () => {
        const f = await fixture();
        const a = await f.open();
        assert(a.ok);
        const b = await f.table.openInboxHintStream(
          f.peer.actor("events:subscribe"),
          { resourceSubscriptions: [f.joined.value.ownInboxUri] },
          Date.now() + 5_000,
        );
        assert(b.ok);
        const ar = a.value.stream.getReader();
        const br = b.value.stream.getReader();
        try {
          const anext = ar.read();
          const bnext = br.read();
          await f.table.postMessage(f.owner.actor("tables:write"), {
            request_id: "native_actor_a_post_01",
            body: "A",
          });
          assert.equal(
            JSON.parse(new TextDecoder().decode((await bnext).value)).uri,
            f.joined.value.ownInboxUri,
          );
          assert.equal(
            await Promise.race([
              anext.then(() => "unexpected"),
              pause(30).then(() => "quiet"),
            ]),
            "quiet",
          );
          await f.table.postMessage(f.peer.actor("tables:write"), {
            request_id: "native_actor_b_post_01",
            body: "B",
          });
          assert.equal(
            JSON.parse(new TextDecoder().decode((await anext).value)).uri,
            f.created.value.ownInboxUri,
          );
        } finally {
          await f.table.cancelInboxHintStream(
            a.value.snapshot.membershipId,
            a.value.cancellationId,
          );
          await f.table.cancelInboxHintStream(
            b.value.snapshot.membershipId,
            b.value.cancellationId,
          );
          await ar.cancel().catch(() => {});
          await br.cancel().catch(() => {});
        }
      },
    );

    for (const reason of [
      "revocation",
      "scope",
      "grant",
      "close",
      "purge",
      "token",
      "table",
    ] as const) {
      await scenario(`idle termination: ${reason}`, async () => {
        const f = await fixture();
        const opened = await f.open(
          reason === "token" ? Date.now() + 100 : undefined,
        );
        assert(opened.ok);
        const reader = opened.value.stream.getReader();
        const rejected = assert.rejects(reader.read());
        if (reason === "revocation")
          await f.owner.stub.revokeConnection(
            f.owner.session.sessionId,
            f.owner.session.secret,
            f.owner.grant.connectionId,
          );
        if (reason === "scope" || reason === "grant")
          await env.GUESTS.get(
            env.GUESTS.idFromName(f.owner.id),
          ).changeGrantForTest(reason === "scope" ? "scope" : "expiry");
        if (reason === "table")
          await env.TABLES.get(
            env.TABLES.idFromName(f.tableId),
          ).expireForTest();
        if (reason === "close")
          await f.table.closeTable(
            f.owner.actor("tables:write"),
            "native_close_request_01",
          );
        if (reason === "purge")
          await f.table.purgeTable(f.owner.actor("tables:write"));
        try {
          await rejected;
        } finally {
          await f.table.cancelInboxHintStream(
            opened.value.snapshot.membershipId,
            opened.value.cancellationId,
          );
          await reader.cancel().catch(() => {});
        }
      });
    }

    await scenario(
      "fresh authority before emission and invalid attach",
      async () => {
        const f = await fixture();
        assert.deepEqual(
          await f.table.openInboxHintStream(
            f.peer.actor("events:subscribe"),
            f.filter,
            Date.now() + 5_000,
          ),
          { ok: false, code: "TABLE_NOT_FOUND" },
        );
        for (const expiry of [
          NaN,
          Infinity,
          Date.now(),
          Math.floor(Date.now() / 1000),
        ])
          assert.deepEqual(await f.open(expiry), {
            ok: false,
            code: "NOT_AUTHORIZED",
          });
        const opened = await f.open();
        assert(opened.ok);
        const reader = opened.value.stream.getReader();
        const rejected = assert.rejects(reader.read());
        await f.owner.stub.revokeConnection(
          f.owner.session.sessionId,
          f.owner.session.secret,
          f.owner.grant.connectionId,
        );
        await f.table.postMessage(f.peer.actor("tables:write"), {
          request_id: "native_revoked_post_01",
          body: "Never emit a stale hint",
        });
        try {
          await rejected;
        } finally {
          await f.table.cancelInboxHintStream(
            opened.value.snapshot.membershipId,
            opened.value.cancellationId,
          );
          await reader.cancel().catch(() => {});
        }
        assert.deepEqual(await f.open(), { ok: false, code: "NOT_AUTHORIZED" });
      },
    );

    await scenario("slow consumer closes at the TableDO queue", async () => {
      const f = await fixture();
      await env.TABLES.get(
        env.TABLES.idFromName(f.tableId),
      ).slowConsumerForTest(
        f.owner.actor("events:subscribe"),
        f.filter,
        f.peer.actor("tables:write"),
      );
    });
    console.log(
      `Internal Workerd/SQLite scenarios passed: ${passed}. No public MCP or two-edge proof.`,
    );
  },
};
