import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSubscriptionsSchema } from "../../schema/010_event_subscriptions";
import { durableEventOutboxSchema } from "../../schema/011_durable_event_outbox";
import { RESUME_EVENT_NAME } from "../../src/notifications/openai-events";
import {
  authorizeGuestConnection,
  type ConnectionScope,
} from "../../src/shared/auth";

const SECRET = "whsec_" + btoa("S".repeat(32));
const CALLBACK = "https://events.provider.example.org/callback/synthetic";
afterEach(() => vi.useRealTimers());

async function guest(
  scopes: ConnectionScope[] = [
    "tables:read",
    "tables:write",
    "events:subscribe",
  ],
) {
  const id = crypto.randomUUID(),
    stub = env.GUESTS.get(env.GUESTS.idFromName(id)),
    session = await stub.createSession(id);
  const grant = await stub.createConnection(
    session.sessionId,
    session.secret,
    scopes,
    Date.now() + 7 * 86_400_000,
  );
  if (!grant) throw new Error("Missing synthetic connection");
  const actor = async (scope: ConnectionScope) => {
    const result = await authorizeGuestConnection(
      env,
      id,
      grant.connectionId,
      scope,
    );
    if (!result.allowed) throw new Error("Missing synthetic actor");
    return result.actor;
  };
  return { id, stub, session, grant, actor };
}
async function fixture(reusable = true, ttl_seconds?: number) {
  const owner = await guest(),
    peer = await guest();
  const input = {
    request_id: crypto.randomUUID(),
    title: "SYNTHETIC TITLE TO PURGE",
    purpose: "SYNTHETIC PURPOSE",
    reusable,
    ...(ttl_seconds ? { ttl_seconds } : {}),
  };
  const writer = await owner.actor("tables:write"),
    reserved = await owner.stub.reserveCreation(writer, input);
  if (!reserved.ok) throw new Error("Missing reservation");
  const id = reserved.reservation.tableId,
    stub = env.TABLES.get(env.TABLES.idFromName(id));
  const created = await stub.initializeTable(
    writer,
    input,
    reserved.reservation,
  );
  if (!created.ok) throw new Error("Missing table");
  const invite = await stub.issueInvite(writer, crypto.randomUUID());
  if (!invite.ok) throw new Error("Missing invitation");
  const joined = await stub.redeemInvite(
    await peer.actor("tables:write"),
    invite.value.invitation,
    crypto.randomUUID(),
  );
  if (!joined.ok) throw new Error("Missing membership");
  return { owner, peer, id, stub, writer, input, reserved, created, joined };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function start(f: Fixture, generation = 0) {
  const request = {
    request_id: crypto.randomUUID(),
    generation,
    requested_at: Date.now(),
  };
  expect((await f.stub.requestTableResume(f.writer, request)).ok).toBe(true);
  const accepted = await f.stub.respondTableResume(
    await f.peer.actor("tables:write"),
    { request_id: request.request_id, generation, decision: "accept" },
  );
  if (
    !accepted.ok ||
    !accepted.value.sessionId ||
    !accepted.value.sessionGeneration
  )
    throw new Error("Missing accepted session");
  return {
    request,
    receipt: accepted.value,
    fence: {
      session_id: accepted.value.sessionId,
      generation: accepted.value.sessionGeneration,
    },
  };
}
async function subscribe(
  f: Fixture,
  who: Fixture["peer"],
  name: string,
  fence: Record<string, unknown> = {},
) {
  const actor = await who.actor("events:subscribe"),
    params = {
      name,
      arguments: { table_id: f.id, ...fence },
      delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
      cursor: null,
    };
  const candidate = await f.stub.beginEventSubscription(actor, params);
  if (!candidate.ok) throw new Error("Missing candidate:" + candidate.code);
  // Existing trusted service's verified-transport commit seam. No real host contacted.
  const result = await f.stub.commitVerifiedEventSubscription(
    actor,
    candidate.value.candidateId,
  );
  if (!result.ok)
    throw new Error("Missing verified subscription:" + result.code);
  return { actor, params, candidate, result };
}
async function counts(f: Fixture) {
  return runInDurableObject(f.stub, (_instance, state) =>
    Object.fromEntries(
      [
        "table_messages",
        "table_post_receipts",
        "table_event_outbox",
        "table_event_relay_attempts",
        "table_event_candidates",
        "table_memberships",
        "table_channel",
      ].map((name) => [
        name,
        state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) n FROM " + name)
          .one().n,
      ]),
    ),
  );
}
describe("Reusable private channel/session contract in SQLite Workerd", () => {
  it("keeps stable verified membership through two erased sessions and reconstruction, with no peer guest IDs", async () => {
    const f = await fixture();
    expect(f.joined.value).toMatchObject({
      state: "dormant",
      channelMode: "reusable",
      generation: 0,
      session: null,
    });
    const members = f.joined.value.memberships;
    expect(JSON.stringify(f.joined.value)).not.toContain(f.owner.id);
    expect(JSON.stringify(f.joined.value)).not.toContain(f.peer.id);
    for (let generation = 0; generation < 2; generation++) {
      const session = await start(f, generation);
      expect(session.fence.generation).toBe(generation + 1);
      const posted = await f.stub.postMessage(f.writer, {
        ...session.fence,
        request_id: crypto.randomUUID(),
        body: "SYNTHETIC BODY",
      });
      expect(posted).toMatchObject({
        ok: true,
        value: { seq: 1, ...session.fence },
      });
      expect(
        await f.stub.readMessages(
          await f.peer.actor("tables:read"),
          session.fence,
        ),
      ).toMatchObject({
        ok: true,
        value: { ...session.fence, messages: [{ body: "SYNTHETIC BODY" }] },
      });
      const end = { ...session.fence, request_id: crypto.randomUUID() };
      expect(
        await f.stub.endConversation(
          await (generation === 0 ? f.owner : f.peer).actor("tables:write"),
          end,
        ),
      ).toMatchObject({ ok: true, value: { state: "ended" } });
      await evictDurableObject(f.stub);
      expect(await f.stub.endConversation(f.writer, end)).toMatchObject({
        ok: true,
      });
      expect(await counts(f)).toMatchObject({
        table_messages: 0,
        table_post_receipts: 0,
        table_event_outbox: 0,
        table_memberships: 2,
        table_channel: 1,
      });
      const metadata = await f.stub.getMetadata(
        await f.owner.actor("tables:read"),
      );
      expect(metadata).toMatchObject({
        ok: true,
        value: {
          tableId: f.id,
          state: "dormant",
          title: "",
          generation: generation + 1,
          session: null,
          memberships: members,
        },
      });
      expect(
        await f.stub.postMessage(f.writer, {
          ...session.fence,
          request_id: crypto.randomUUID(),
          body: "STALE",
        }),
      ).toEqual({ ok: false, code: "STALE_SESSION" });
    }
  });
  it("bounds one pending request; crossed requests, retries and simultaneous accepts create exactly one epoch", async () => {
    const f = await fixture(),
      request = {
        request_id: crypto.randomUUID(),
        generation: 0,
        requested_at: Date.now(),
      };
    const crossed = { ...request, request_id: crypto.randomUUID() };
    const results = await Promise.all([
      f.stub.requestTableResume(f.writer, request),
      f.stub.requestTableResume(await f.peer.actor("tables:write"), crossed),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, code: "RESUME_CONFLICT" },
    ]);
    const requester = results[0].ok ? f.owner : f.peer,
      recipient = results[0].ok ? f.peer : f.owner,
      winner = results[0].ok ? request : crossed;
    expect(
      await f.stub.requestTableResume(
        await requester.actor("tables:write"),
        winner,
      ),
    ).toEqual(results.find((r) => r.ok));
    expect(
      await f.stub.respondTableResume(await requester.actor("tables:write"), {
        request_id: winner.request_id,
        generation: 0,
        decision: "accept",
      }),
    ).toEqual({ ok: false, code: "NOT_AUTHORIZED" });
    await evictDurableObject(f.stub);
    const decision = {
      request_id: winner.request_id,
      generation: 0,
      decision: "accept" as const,
    };
    const accepts = await Promise.all([
      f.stub.respondTableResume(
        await recipient.actor("tables:write"),
        decision,
      ),
      f.stub.respondTableResume(
        await recipient.actor("tables:write"),
        decision,
      ),
    ]);
    expect(accepts[0]).toEqual(accepts[1]);
    expect(accepts[0]).toMatchObject({
      ok: true,
      value: { sessionGeneration: 1 },
    });
  });
  it("rejects and times out without a transcript, expires requests within five minutes and limits spam", async () => {
    const f = await fixture(),
      request = {
        request_id: crypto.randomUUID(),
        generation: 0,
        requested_at: Date.now(),
      };
    expect((await f.stub.requestTableResume(f.writer, request)).ok).toBe(true);
    const reject = {
      request_id: request.request_id,
      generation: 0,
      decision: "reject" as const,
    };
    expect(
      await f.stub.respondTableResume(
        await f.peer.actor("tables:write"),
        reject,
      ),
    ).toMatchObject({ ok: true, value: { state: "rejected" } });
    expect(
      await f.stub.respondTableResume(
        await f.peer.actor("tables:write"),
        reject,
      ),
    ).toMatchObject({ ok: true });
    const timed = { ...request, request_id: crypto.randomUUID() };
    expect((await f.stub.requestTableResume(f.writer, timed)).ok).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(timed.requested_at + 300_000);
    expect(
      await f.stub.respondTableResume(await f.peer.actor("tables:write"), {
        request_id: timed.request_id,
        generation: 0,
        decision: "accept",
      }),
    ).toEqual({ ok: false, code: "RESUME_EXPIRED" });
    for (let i = 0; i < 8; i++) {
      const next = {
        request_id: crypto.randomUUID(),
        generation: 0,
        requested_at: Date.now(),
      };
      expect((await f.stub.requestTableResume(f.writer, next)).ok).toBe(true);
      expect(
        (
          await f.stub.respondTableResume(await f.peer.actor("tables:write"), {
            request_id: next.request_id,
            generation: 0,
            decision: "reject",
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      await f.stub.requestTableResume(f.writer, {
        request_id: crypto.randomUUID(),
        generation: 0,
        requested_at: Date.now(),
      }),
    ).toEqual({ ok: false, code: "RATE_LIMITED" });
    expect(await counts(f)).toMatchObject({
      table_messages: 0,
      table_post_receipts: 0,
    });
  });
  it("enforces the absolute hour on reads/writes even with late alarms and surviving admission expiry", async () => {
    const f = await fixture(),
      session = await start(f),
      deadline = Date.now() + 3_600_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline - 1000);
    expect(
      (
        await f.stub.postMessage(f.writer, {
          ...session.fence,
          request_id: crypto.randomUUID(),
          body: "near deadline",
        })
      ).ok,
    ).toBe(true);
    vi.setSystemTime(deadline + 1000);
    expect(
      await f.stub.readMessages(
        await f.owner.actor("tables:read"),
        session.fence,
      ),
    ).toEqual({ ok: false, code: "STALE_SESSION" });
    expect(await counts(f)).toMatchObject({
      table_messages: 0,
      table_post_receipts: 0,
    });
    // Original admission lifetime does not terminate the verified reusable pairing.
    vi.setSystemTime(f.reserved.reservation.expiresAt + 1);
    await runInDurableObject(f.stub, (instance) => instance.alarm());
    const next = await start(f, 1);
    expect(next.fence.generation).toBe(2);
    expect(
      await f.stub.getMetadata(await f.peer.actor("tables:read")),
    ).toMatchObject({
      ok: true,
      value: { memberships: f.joined.value.memberships },
    });
  });
  it("fences stale cursor/reply/post receipt, old acceptance and duplicate end from a newer session", async () => {
    const f = await fixture(),
      one = await start(f);
    const post = {
      ...one.fence,
      request_id: crypto.randomUUID(),
      body: "OLD PRIVATE CONTENT",
    };
    const posted = await f.stub.postMessage(f.writer, post);
    if (!posted.ok) throw new Error("Missing post");
    const end = { ...one.fence, request_id: crypto.randomUUID() };
    await f.stub.endConversation(f.writer, end);
    const two = await start(f, 1);
    expect(two.fence.session_id).not.toBe(one.fence.session_id);
    await f.stub.postMessage(f.writer, {
      ...two.fence,
      request_id: crypto.randomUUID(),
      body: "NEW PRIVATE CONTENT",
    });
    expect(await f.stub.postMessage(f.writer, post)).toEqual({
      ok: false,
      code: "STALE_SESSION",
    });
    expect(
      await f.stub.readMessages(await f.peer.actor("tables:read"), {
        ...one.fence,
        after_seq: 0,
        through_seq: 1,
      }),
    ).toEqual({ ok: false, code: "STALE_SESSION" });
    expect(
      await f.stub.readMessages(await f.peer.actor("tables:read"), {}),
    ).toEqual({ ok: false, code: "SESSION_REQUIRED" });
    expect(
      await f.stub.postMessage(f.writer, {
        ...two.fence,
        request_id: crypto.randomUUID(),
        body: "reply",
        reply_to_message_id: posted.value.message_id,
      }),
    ).toEqual({ ok: false, code: "INVALID_REPLY" });
    expect(
      (
        await f.stub.respondTableResume(await f.peer.actor("tables:write"), {
          request_id: one.request.request_id,
          generation: 0,
          decision: "accept",
        })
      ).ok,
    ).toBe(true);
    expect((await f.stub.endConversation(f.writer, end)).ok).toBe(true);
    expect(
      await f.stub.readMessages(await f.peer.actor("tables:read"), two.fence),
    ).toMatchObject({
      ok: true,
      value: { messages: [{ body: "NEW PRIVATE CONTENT" }] },
    });
  });
  it("authorizes membership and current grants for request/respond/read/end; no tableId bearer authority", async () => {
    const f = await fixture(),
      other = await guest(),
      session = await start(f);
    expect(
      await f.stub.requestTableResume(await other.actor("tables:write"), {
        request_id: crypto.randomUUID(),
        generation: 1,
        requested_at: Date.now(),
      }),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    expect(
      await f.stub.endConversation(await other.actor("tables:write"), {
        ...session.fence,
        request_id: crypto.randomUUID(),
      }),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    const stale = await f.peer.actor("tables:write"),
      reader = await f.peer.actor("tables:read");
    await f.peer.stub.revokeConnection(
      f.peer.session.sessionId,
      f.peer.session.secret,
      f.peer.grant.connectionId,
    );
    expect(
      await f.stub.endConversation(stale, {
        ...session.fence,
        request_id: crypto.randomUUID(),
      }),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    expect(await f.stub.readMessages(reader, session.fence)).toEqual({
      ok: false,
      code: "TABLE_NOT_FOUND",
    });
    expect(
      await f.stub.respondTableResume(stale, {
        request_id: session.request.request_id,
        generation: 0,
        decision: "accept",
      }),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
  });
  it("delivers a metadata-only resume to the authenticated peer while dormant via the existing signed outbox", async () => {
    const f = await fixture();
    await subscribe(f, f.peer, RESUME_EVENT_NAME);
    const request = {
      request_id: crypto.randomUUID(),
      generation: 0,
      requested_at: Date.now(),
    };
    expect((await f.stub.requestTableResume(f.writer, request)).ok).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1100);
    await runInDurableObject(f.stub, async (instance) => {
      const bodies: string[] = [];
      const harness = instance as unknown as {
        outboxDispatchEnabled: () => boolean;
        dispatchOutbox: () => Promise<number>;
        sendOutboxWebhook: (
          _url: string,
          request: { body: Uint8Array; headers: Record<string, string> },
        ) => Promise<{ ok: true; status: number }>;
      };
      harness.outboxDispatchEnabled = () => true;
      harness.sendOutboxWebhook = async (_url, request) => {
        const body = new TextDecoder().decode(request.body);
        new Webhook(SECRET).verify(body, request.headers);
        bodies.push(body);
        return { ok: true, status: 202 };
      };
      expect(await harness.dispatchOutbox()).toBe(1);
      expect(bodies).toHaveLength(1);
      const event = JSON.parse(bodies[0]);
      expect(event).toMatchObject({
        name: RESUME_EVENT_NAME,
        data: {
          table_id: f.id,
          request_id: request.request_id,
          generation: 0,
          requester_membership_id: f.created.value.ownMembershipId,
        },
      });
      expect(Object.keys(event.data).sort()).toEqual([
        "expires_at",
        "generation",
        "request_id",
        "requester_membership_id",
        "table_id",
      ]);
      expect(bodies[0]).not.toContain(f.owner.id);
      expect(bodies[0]).not.toContain(f.peer.id);
      expect(bodies[0]).not.toContain(f.input.title);
    });
  });
  it("keeps channel subscription across session end and fences delayed session candidates and outbox", async () => {
    const f = await fixture();
    const channel = await subscribe(f, f.peer, RESUME_EVENT_NAME),
      one = await start(f);
    await subscribe(f, f.peer, "table.message.created", one.fence);
    const pending = await f.stub.beginEventSubscription(channel.actor, {
      name: "table.message.created",
      arguments: { table_id: f.id, ...one.fence },
      delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
      cursor: null,
    });
    expect(pending.ok).toBe(true);
    expect(
      (
        await f.stub.postMessage(f.writer, {
          ...one.fence,
          request_id: crypto.randomUUID(),
          body: "queued content",
        })
      ).ok,
    ).toBe(true);
    await f.stub.endConversation(f.writer, {
      ...one.fence,
      request_id: crypto.randomUUID(),
    });
    if (!pending.ok) throw new Error("Missing candidate");
    expect(
      await f.stub.commitVerifiedEventSubscription(
        channel.actor,
        pending.value.candidateId,
      ),
    ).toMatchObject({ ok: false, code: "STALE" });
    expect(await counts(f)).toMatchObject({
      table_messages: 0,
      table_event_outbox: 0,
      table_event_candidates: 0,
      table_event_relay_attempts: 0,
    });
    expect(
      await f.stub.authorizeEventAttempt(
        channel.actor,
        channel.result.value.id,
        channel.result.value.generation,
      ),
    ).toBe(false); // transport disabled
    const next = {
      request_id: crypto.randomUUID(),
      generation: 1,
      requested_at: Date.now(),
    };
    expect((await f.stub.requestTableResume(f.writer, next)).ok).toBe(true);
    await runInDurableObject(f.stub, (_i, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT event_name FROM table_event_subscriptions WHERE status='active'",
          )
          .toArray(),
      ).toEqual([{ event_name: RESUME_EVENT_NAME }]);
      expect(
        state.storage.sql
          .exec("SELECT event_name,session_generation FROM table_event_outbox")
          .toArray(),
      ).toEqual([{ event_name: RESUME_EVENT_NAME, session_generation: 1 }]);
    });
  });
  it("preserves legacy close terminal behavior and never upgrades or resurrects expired/deleted tables", async () => {
    const old = await fixture(false);
    expect(
      await old.stub.requestTableResume(old.writer, {
        request_id: crypto.randomUUID(),
        generation: 0,
        requested_at: Date.now(),
      }),
    ).toEqual({ ok: false, code: "TABLE_TERMINAL" });
    expect(
      (
        await old.stub.postMessage(old.writer, {
          request_id: crypto.randomUUID(),
          body: "legacy retained until expiry",
        })
      ).ok,
    ).toBe(true);
    await old.stub.closeTable(old.writer, crypto.randomUUID());
    expect(
      await old.stub.readMessages(await old.owner.actor("tables:read"), {}),
    ).toMatchObject({
      ok: true,
      value: { messages: [{ body: "legacy retained until expiry" }] },
    });
    const f = await fixture(),
      session = await start(f);
    await f.stub.closeTable(f.writer, crypto.randomUUID());
    expect(
      await f.stub.requestTableResume(f.writer, {
        request_id: crypto.randomUUID(),
        generation: 1,
        requested_at: Date.now(),
      }),
    ).toEqual({ ok: false, code: "TABLE_TERMINAL" });
    expect(
      await f.stub.endConversation(f.writer, {
        ...session.fence,
        request_id: crypto.randomUUID(),
      }),
    ).toEqual({ ok: false, code: "TABLE_TERMINAL" });
    const deleted = await fixture();
    await deleted.stub.purgeTable(deleted.writer);
    await evictDurableObject(deleted.stub);
    expect(
      await deleted.stub.requestTableResume(deleted.writer, {
        request_id: crypto.randomUUID(),
        generation: 0,
        requested_at: Date.now(),
      }),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
  });
  it("dispatches resume and message work after the original admission expiry, with epoch-specific signed payloads", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.reserved.reservation.expiresAt + 1000);
    await subscribe(f, f.peer, RESUME_EVENT_NAME);
    const req = {
      request_id: crypto.randomUUID(),
      generation: 0,
      requested_at: Date.now(),
    };
    expect((await f.stub.requestTableResume(f.writer, req)).ok).toBe(true);
    const dispatch = async (expectedName: string) => {
      vi.setSystemTime(Date.now() + 1100);
      await runInDurableObject(f.stub, async (instance, state) => {
        const h = instance as unknown as {
          outboxDispatchEnabled: () => boolean;
          dispatchOutbox: () => Promise<number>;
          sendOutboxWebhook: (
            _url: string,
            request: { body: Uint8Array; headers: Record<string, string> },
          ) => Promise<{ ok: true; status: number }>;
        };
        h.outboxDispatchEnabled = () => true;
        const bodies: string[] = [];
        h.sendOutboxWebhook = async (_url, request) => {
          const body = new TextDecoder().decode(request.body);
          new Webhook(SECRET).verify(body, request.headers);
          bodies.push(body);
          return { ok: true, status: 202 };
        };
        expect(await h.dispatchOutbox()).toBe(1);
        expect(bodies).toHaveLength(1);
        expect(JSON.parse(bodies[0]).name).toBe(expectedName);
        expect(
          state.storage.sql
            .exec("SELECT status FROM table_event_outbox")
            .toArray(),
        ).toEqual([{ status: "accepted" }]);
      });
    };
    await dispatch(RESUME_EVENT_NAME);
    const accepted = await f.stub.respondTableResume(
      await f.peer.actor("tables:write"),
      { request_id: req.request_id, generation: 0, decision: "accept" },
    );
    if (!accepted.ok || !accepted.value.sessionId)
      throw new Error("Missing session");
    const fence = { session_id: accepted.value.sessionId, generation: 1 };
    await subscribe(f, f.peer, "table.message.created", fence);
    expect(
      (
        await f.stub.postMessage(f.writer, {
          ...fence,
          request_id: crypto.randomUUID(),
          body: "SYNTHETIC AFTER ADMISSION",
        })
      ).ok,
    ).toBe(true);
    await dispatch("table.message.created");
  });

  it("rechecks grant revocation after scheduler/alarm waits immediately before SQL mutation", async () => {
    const f = await fixture(),
      session = await start(f);
    await runInDurableObject(f.stub, (instance) => {
      const h = instance as unknown as {
        deadlines: { checkpoint: (phase: string) => Promise<void> };
      };
      h.deadlines.checkpoint = async (phase) => {
        if (phase === "after-arm")
          await env.GUESTS.get(
            env.GUESTS.idFromName(f.owner.id),
          ).revokeConnection(
            f.owner.session.sessionId,
            f.owner.session.secret,
            f.owner.grant.connectionId,
          );
      };
    });
    expect(
      await f.stub.postMessage(f.writer, {
        ...session.fence,
        request_id: crypto.randomUUID(),
        body: "MUST NEVER COMMIT",
      }),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    expect(await counts(f)).toMatchObject({
      table_messages: 0,
      table_post_receipts: 0,
    });
  });

  it("a late in-flight callback cannot settle into a session reopened during transport", async () => {
    const f = await fixture(),
      one = await start(f);
    await subscribe(f, f.peer, "table.message.created", one.fence);
    await f.stub.postMessage(f.writer, {
      ...one.fence,
      request_id: crypto.randomUUID(),
      body: "OLD IN FLIGHT",
    });
    const peerWriter = await f.peer.actor("tables:write");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1100);
    await runInDurableObject(f.stub, async (instance, state) => {
      const h = instance as unknown as {
        outboxDispatchEnabled: () => boolean;
        dispatchOutbox: () => Promise<number>;
        sendOutboxWebhook: () => Promise<{ ok: true; status: number }>;
      };
      h.outboxDispatchEnabled = () => true;
      h.sendOutboxWebhook = async () => {
        expect(
          (
            await instance.endConversation(f.writer, {
              ...one.fence,
              request_id: crypto.randomUUID(),
            })
          ).ok,
        ).toBe(true);
        const next = {
          request_id: crypto.randomUUID(),
          generation: 1,
          requested_at: Date.now(),
        };
        expect((await instance.requestTableResume(f.writer, next)).ok).toBe(
          true,
        );
        const accepted = await instance.respondTableResume(peerWriter, {
          request_id: next.request_id,
          generation: 1,
          decision: "accept",
        });
        if (!accepted.ok || !accepted.value.sessionId)
          throw new Error("Missing new session");
        expect(
          (
            await instance.postMessage(f.writer, {
              session_id: accepted.value.sessionId,
              generation: 2,
              request_id: crypto.randomUUID(),
              body: "NEW SESSION ONLY",
            })
          ).ok,
        ).toBe(true);
        return { ok: true, status: 202 };
      };
      expect(await h.dispatchOutbox()).toBe(1);
      expect(
        state.storage.sql.exec("SELECT * FROM table_event_outbox").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT body FROM table_messages").toArray(),
      ).toEqual([{ body: "NEW SESSION ONLY" }]);
      expect(
        state.storage.sql.exec("SELECT generation FROM table_channel").one(),
      ).toEqual({ generation: 2 });
    });
  });

  it("rolls back a failed purge and retries without a half-ended session or terminal marker", async () => {
    const f = await fixture(),
      session = await start(f);
    await f.stub.postMessage(f.writer, {
      ...session.fence,
      request_id: crypto.randomUUID(),
      body: "ATOMIC PURGE FIXTURE",
    });
    await runInDurableObject(f.stub, (_i, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER synthetic_purge_failure BEFORE DELETE ON table_messages BEGIN SELECT RAISE(ABORT,'synthetic-purge-failure'); END",
      );
    });
    const end = { ...session.fence, request_id: crypto.randomUUID() };
    expect(
      await runInDurableObject(f.stub, async (instance) => {
        try {
          await instance.endConversation(f.writer, end);
          return "unexpected-success";
        } catch (error) {
          return String(error);
        }
      }),
    ).toContain("synthetic-purge-failure");
    await runInDurableObject(f.stub, (_i, state) => {
      expect(
        state.storage.sql
          .exec("SELECT * FROM table_session_terminals")
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT session_id FROM table_channel").one(),
      ).toEqual({ session_id: session.fence.session_id });
      state.storage.sql.exec("DROP TRIGGER synthetic_purge_failure");
    });
    expect((await f.stub.endConversation(f.writer, end)).ok).toBe(true);
    expect(await counts(f)).toMatchObject({ table_messages: 0 });
  });
  it("fences session inbox reads/listen cursors and preserves cancellation isolation across epochs", async () => {
    const f = await fixture(),
      one = await start(f),
      reader = await f.peer.actor("tables:read"),
      events = await f.peer.actor("events:subscribe");
    const old = await f.stub.getMetadata(reader);
    if (!old.ok) throw new Error("Missing metadata");
    const filter = { resourceSubscriptions: [old.value.ownInboxUri] };
    expect(
      (await f.stub.checkInboxSubscription(events, filter, Date.now() + 60_000))
        .ok,
    ).toBe(true);
    await f.stub.endConversation(f.writer, {
      ...one.fence,
      request_id: crypto.randomUUID(),
    });
    await start(f, 1);
    expect(await f.stub.readOwnInbox(reader, old.value.ownInboxUri)).toEqual({
      ok: false,
      code: "STALE_SESSION",
    });
    expect(
      await f.stub.checkInboxSubscription(events, filter, Date.now() + 60_000),
    ).toEqual({ ok: false, code: "STALE_SESSION" });
    const current = await f.stub.getMetadata(reader);
    if (!current.ok) throw new Error("Missing metadata");
    expect(current.value.ownInboxUri).not.toBe(old.value.ownInboxUri);
    expect(
      await f.stub.readOwnInbox(reader, current.value.ownInboxUri),
    ).toMatchObject({ ok: true, value: { generation: 2, lastSeq: 0 } });
  });

  it("keeps browser deletion mandatory and retains tombstones beyond live initialization reservations", async () => {
    const f = await fixture(true, 7 * 86_400),
      requestId = crypto.randomUUID();
    const credential = {
      guestId: f.owner.id,
      sessionId: f.owner.session.sessionId,
      secret: f.owner.session.secret,
    };
    expect(
      await f.stub.resolveDeletion(credential, requestId, "approve"),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(
      (await f.stub.requestBrowserDeletion(credential, requestId)).ok,
    ).toBe(true);
    expect(
      await f.stub.resolveDeletion(
        { ...credential, secret: "not-a-browser-secret" },
        requestId,
        "approve",
      ),
    ).toEqual({ ok: false, code: "NOT_AUTHORIZED" });
    expect(
      await f.stub.resolveDeletion(credential, requestId, "approve"),
    ).toEqual({ ok: true, value: { state: "deleted" } });
    await evictDurableObject(f.stub);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    await runInDurableObject(f.stub, (instance) => instance.alarm());
    expect(
      await f.stub.initializeTable(f.writer, f.input, f.reserved.reservation),
    ).toEqual({ ok: false, code: "TABLE_TERMINAL" });
    expect(
      await f.stub.resolveDeletion(credential, requestId, "approve"),
    ).toEqual({ ok: true, value: { state: "deleted" } });
    expect(await counts(f)).toMatchObject({
      table_channel: 0,
      table_memberships: 0,
      table_event_outbox: 0,
    });
  });

  it("migrates populated schema14 subscriptions/outbox without reopening or promoting legacy tables", async () => {
    const f = await fixture(false);
    const sub = await subscribe(f, f.peer, "table.message.created");
    const posted = await f.stub.postMessage(f.writer, {
      request_id: crypto.randomUUID(),
      body: "LEGACY MIGRATION CONTENT",
    });
    expect(posted.ok).toBe(true);
    await runInDurableObject(f.stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE table_session_terminals");
      sql.exec("DROP TABLE table_resume_requests");
      sql.exec("DROP TABLE table_channel");
      const definitions = [
        {
          name: "table_event_subscriptions",
          ddl: eventSubscriptionsSchema.componentStatements.table[0],
          columns:
            "membership_id,generation,fence,status,guest_id,connection_id,subscription_id,callback_url,secret_envelope,previous_secret_envelope,rotation_until,expires_at",
        },
        {
          name: "table_event_candidates",
          ddl: eventSubscriptionsSchema.componentStatements.table[1],
          columns:
            "membership_id,candidate_id,subscription_id,guest_id,connection_id,callback_url,secret_envelope,requested_ttl_ms,fence,expires_at,verification_mode",
        },
        {
          name: "table_event_outbox",
          ddl: durableEventOutboxSchema.componentStatements.table[0],
          columns:
            "event_id,message_id,message_seq,recipient_membership_id,subscription_id,subscription_generation,status,attempt_count,first_attempt_at,next_attempt_at,lease_token,lease_deadline,created_at,expires_at,last_error_category,relay_reconcile_after",
        },
      ];
      for (const def of definitions) {
        sql.exec(
          def.ddl.replace(
            "CREATE TABLE " + def.name + " (",
            "CREATE TABLE " + def.name + "_v14 (",
          ),
        );
        if (def.name === "table_event_candidates")
          sql.exec(
            "ALTER TABLE " +
              def.name +
              "_v14 ADD COLUMN verification_mode TEXT NOT NULL DEFAULT 'native' CHECK(verification_mode IN ('native','relay'))",
          );
        if (def.name === "table_event_outbox")
          sql.exec(
            "ALTER TABLE " +
              def.name +
              "_v14 ADD COLUMN relay_reconcile_after INTEGER",
          );
        sql.exec(
          "INSERT INTO " +
            def.name +
            "_v14 (" +
            def.columns +
            ") SELECT " +
            def.columns +
            " FROM " +
            def.name,
        );
        sql.exec("DROP TABLE " + def.name);
        sql.exec("ALTER TABLE " + def.name + "_v14 RENAME TO " + def.name);
      }
      for (const ddl of [
        ...eventSubscriptionsSchema.componentStatements.table.slice(2),
        ...durableEventOutboxSchema.componentStatements.table.slice(1),
      ])
        sql.exec(ddl);
      sql.exec("UPDATE __agent_table_schema SET version=14");
    });
    await evictDurableObject(f.stub);
    expect(await f.stub.schemaVersion()).toBe(15);
    const metadata = await f.stub.getMetadata(
      await f.owner.actor("tables:read"),
    );
    expect(metadata).toMatchObject({
      ok: true,
      value: { state: "open", title: f.input.title },
    });
    if (!metadata.ok) throw new Error("Missing metadata");
    expect(metadata.value.channelMode).toBeUndefined();
    expect(
      await f.stub.readMessages(await f.peer.actor("tables:read"), {}),
    ).toMatchObject({
      ok: true,
      value: { messages: [{ body: "LEGACY MIGRATION CONTENT" }] },
    });
    await runInDurableObject(f.stub, (_i, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT event_name,subscription_id,status FROM table_event_subscriptions",
          )
          .toArray(),
      ).toEqual([
        {
          event_name: "table.message.created",
          subscription_id: sub.result.value.id,
          status: "active",
        },
      ]);
      expect(
        state.storage.sql
          .exec("SELECT event_name,attempt_count FROM table_event_outbox")
          .toArray(),
      ).toEqual([{ event_name: "table.message.created", attempt_count: 0 }]);
    });
    expect((await f.stub.closeTable(f.writer, crypto.randomUUID())).ok).toBe(
      true,
    );
    await evictDurableObject(f.stub);
    expect(
      await f.stub.requestTableResume(f.writer, {
        request_id: crypto.randomUUID(),
        generation: 0,
        requested_at: Date.now(),
      }),
    ).toEqual({ ok: false, code: "TABLE_TERMINAL" });
  });

  it("bounds and prunes non-content markers and redacts content-derived fingerprints", async () => {
    const f = await fixture(),
      session = await start(f);
    await f.stub.endConversation(f.writer, {
      ...session.fence,
      request_id: crypto.randomUUID(),
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    await runInDurableObject(f.stub, (instance) => instance.alarm());
    await runInDurableObject(f.stub, (_i, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM table_resume_requests").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec("SELECT * FROM table_session_terminals")
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT * FROM table_join_receipts").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT * FROM table_invitations").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec("SELECT title,purpose,request_digest FROM table_metadata")
          .one(),
      ).toEqual({ title: "", purpose: null, request_digest: "0".repeat(64) });
    });
    expect(await f.stub.requestTableResume(f.writer, session.request)).toEqual({
      ok: false,
      code: "RESUME_EXPIRED",
    });
    expect((await start(f, 1)).fence.generation).toBe(2);
  });
  it("rechecks a revoked channel subscription before outbound resume transport", async () => {
    const f = await fixture();
    await subscribe(f, f.peer, RESUME_EVENT_NAME);
    await f.stub.requestTableResume(f.writer, {
      request_id: crypto.randomUUID(),
      generation: 0,
      requested_at: Date.now(),
    });
    await f.peer.stub.revokeConnection(
      f.peer.session.sessionId,
      f.peer.session.secret,
      f.peer.grant.connectionId,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1100);
    await runInDurableObject(f.stub, async (instance, state) => {
      const h = instance as unknown as {
        outboxDispatchEnabled: () => boolean;
        dispatchOutbox: () => Promise<number>;
        sendOutboxWebhook: () => Promise<{ ok: true; status: number }>;
      };
      h.outboxDispatchEnabled = () => true;
      let sends = 0;
      h.sendOutboxWebhook = async () => {
        sends++;
        return { ok: true, status: 202 };
      };
      expect(await h.dispatchOutbox()).toBe(1);
      expect(sends).toBe(0);
      expect(
        state.storage.sql.exec("SELECT status FROM table_event_outbox").one(),
      ).toEqual({ status: "cancelled" });
    });
  });

  it("keeps ordinary operational logs free of conversation content, peer identities and callback credentials", async () => {
    const f = await fixture(),
      logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const session = await start(f);
      await f.stub.postMessage(f.writer, {
        ...session.fence,
        request_id: crypto.randomUUID(),
        body: "SYNTHETIC PRIVACY CANARY 79",
      });
      await f.stub.endConversation(f.writer, {
        ...session.fence,
        request_id: crypto.randomUUID(),
      });
      expect(logs).toHaveBeenCalled();
      const text = JSON.stringify(logs.mock.calls);
      for (const secret of [
        "SYNTHETIC PRIVACY CANARY 79",
        f.input.title,
        f.input.purpose,
        f.owner.id,
        f.peer.id,
        SECRET,
        CALLBACK,
      ])
        expect(text).not.toContain(secret);
    } finally {
      logs.mockRestore();
    }
  });
});
