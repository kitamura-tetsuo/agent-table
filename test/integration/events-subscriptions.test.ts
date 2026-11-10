import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import worker from "../../src/index";
import { authorizeGuestConnection } from "../../src/shared/auth";
import { openSecret } from "../../src/shared/secret-envelope";

const ORIGIN = "http://localhost:8787";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example/callback";
const CALLBACK = "https://events.provider.example.org/callback/test-handler";
const OTHER_CALLBACK =
  "https://events.provider.example.org/callback/other-handler";
const REVIEWED = JSON.stringify([
  { origin: "https://events.provider.example.org", pathPrefix: "/callback" },
]);
const SECRET = `whsec_${btoa("A".repeat(32))}`;
const REPLACEMENT_SECRET = `whsec_${btoa("B".repeat(32))}`;

type GuestStub = ReturnType<Env["GUESTS"]["get"]>;

function dispatch(request: Request, overlay: Env = env) {
  return worker.fetch(
    request as Parameters<typeof worker.fetch>[0],
    overlay,
    createExecutionContext(),
  );
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

async function grantFor(
  guestId: string,
  guest: GuestStub,
  cookie: string,
  scopes: string,
) {
  const registration = await dispatch(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Events integration fixture",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  expect(registration.status).toBe(201);
  const clientId = String((await json(registration)).client_id);
  const verifier = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const authorize = new URL(`${ORIGIN}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: scopes,
    state: "events_fixture_state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  }))
    authorize.searchParams.set(key, value);
  const page = await dispatch(
    new Request(authorize, {
      headers: { Cookie: cookie },
    }),
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  const hidden = (field: string) =>
    new RegExp(`name="${field}" type="hidden" value="([^"]+)"`).exec(html)?.[1];
  const handle = hidden("handle");
  const csrf = hidden("csrf");
  const binding = hidden("binding");
  if (!handle || !csrf || !binding)
    throw new Error("Synthetic consent form incomplete");
  const csrfCookies = page.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]);
  const consent = await dispatch(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: [cookie, ...csrfCookies].join("; "),
      },
      redirect: "manual",
      body: new URLSearchParams([
        ["handle", handle],
        ["csrf", csrf],
        ["guest_id", guestId],
        ["binding", binding],
        ["decision", "approve"],
        ...scopes.split(" ").map((scope): [string, string] => ["scope", scope]),
      ]),
    }),
  );
  expect(consent.status).toBe(302);
  const code = new URL(
    consent.headers.get("Location") ?? REDIRECT,
  ).searchParams.get("code");
  if (!code) throw new Error("Authorization code missing");
  const exchanged = await dispatch(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT,
        code,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    }),
  );
  expect(exchanged.status).toBe(200);
  const token = String((await json(exchanged)).access_token);
  const newCookie =
    consent.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-agent_table_session="))
      ?.split(";")[0] ?? "";
  const parts = newCookie.split("=")[1]?.split(".") ?? [];
  const grants = await guest.listConnections(parts[2] ?? "", parts[3] ?? "");
  expect(grants).not.toBeNull();
  const live = grants?.find(
    (grant) =>
      grant.revokedAt === null &&
      grant.scopes.join(" ") === scopes.split(" ").sort().join(" "),
  );
  return {
    guestId,
    guest,
    token,
    cookie: newCookie,
    connectionId: live?.connectionId ?? "",
  };
}

async function newPrincipal(
  scopes = "tables:read tables:write events:subscribe",
) {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const cookie = `__Host-agent_table_session=v1.${guestId}.${session.sessionId}.${session.secret}`;
  return grantFor(guestId, guest, cookie, scopes);
}

function eventsOverlay(): Env {
  return { ...env, EVENTS_REVIEWED_CALLBACK_TARGETS: REVIEWED };
}

async function clientFor(token: string, overlay: Env = eventsOverlay()) {
  const client = new Client(
    { name: "events-integration", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    authProvider: { token: async () => token },
    fetch: (url, init) => {
      const request = new Request(url, init);
      request.headers.set("Host", new URL(request.url).host);
      return dispatch(request, overlay);
    },
  });
  await client.connect(transport);
  return client;
}

function subscriptionParams(tableId: string, url = CALLBACK, secret = SECRET) {
  return {
    name: "table.message.created",
    arguments: { table_id: tableId },
    delivery: { mode: "webhook", url, secret },
    cursor: null,
  };
}

function unsubscribeParams(tableId: string, url = CALLBACK) {
  return {
    name: "table.message.created",
    arguments: { table_id: tableId },
    delivery: { mode: "webhook", url },
  };
}

async function callEvent(
  client: Client,
  method: string,
  params: Record<string, unknown> = {},
) {
  return client.request({ method, params }, z.unknown());
}

function toolOutput(result: Awaited<ReturnType<Client["callTool"]>>) {
  const block = result.content?.find((content) => content.type === "text");
  if (block?.type !== "text") throw new Error("Expected MCP tool text");
  return JSON.parse(block.text) as Record<string, unknown>;
}

async function createTable(client: Client) {
  const response = await client.callTool({
    name: "create_table",
    arguments: {
      request_id: `event_creation_${crypto.randomUUID()}`,
      title: "Synthetic private Events table",
    },
  });
  expect(response.isError).not.toBe(true);
  return String(toolOutput(response).tableId);
}

function echoReceiver() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const body = JSON.parse(
        new TextDecoder().decode(init?.body as ArrayBuffer),
      );
      expect(body.type).toBe("verification");
      return new Response(JSON.stringify({ challenge: body.challenge }));
    });
}

afterEach(() => vi.restoreAllMocks());

describe("production MCP Events registration, OAuth and TableDO", () => {
  it("atomically records eligible peer events without replay, duplicates, or self events", async () => {
    const owner = await newPrincipal();
    const peer = await newPrincipal();
    const ownerClient = await clientFor(owner.token);
    const peerClient = await clientFor(peer.token);
    const receiver = echoReceiver();
    try {
      const tableId = await createTable(ownerClient);
      const invite = toolOutput(
        await ownerClient.callTool({
          name: "create_invite",
          arguments: { table_id: tableId, request_id: crypto.randomUUID() },
        }),
      );
      const joined = await peerClient.callTool({
        name: "join_table",
        arguments: {
          invitation: invite.invitation,
          request_id: crypto.randomUUID(),
        },
      });
      expect(joined.isError).not.toBe(true);
      const post = (client: Client, requestId: string, body: string) =>
        client.callTool({
          name: "post_message",
          arguments: { table_id: tableId, request_id: requestId, body },
        });
      const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
      const rows = () =>
        runInDurableObject(stub, (_instance, state) =>
          state.storage.sql
            .exec<{
              event_id: string;
              message_id: string;
              message_seq: number;
              recipient_membership_id: string;
              subscription_id: string;
              subscription_generation: number;
              status: string;
              attempt_count: number;
            }>(
              "SELECT event_id, message_id, message_seq, recipient_membership_id, subscription_id, subscription_generation, status, attempt_count FROM table_event_outbox ORDER BY message_seq",
            )
            .toArray(),
        );

      const beforeSubscription = toolOutput(
        await post(ownerClient, crypto.randomUUID(), "No history replay"),
      );
      expect(await rows()).toEqual([]);
      const subscribed = (await callEvent(
        peerClient,
        "events/subscribe",
        subscriptionParams(tableId),
      )) as { id: string };
      const key = crypto.randomUUID();
      const committed = toolOutput(
        await post(ownerClient, key, "Committed peer event"),
      );
      expect(committed.seq).toBe(2);
      const eventRows = await rows();
      expect(eventRows).toHaveLength(1);
      expect(eventRows[0]).toMatchObject({
        message_id: committed.message_id,
        message_seq: committed.seq,
        subscription_id: subscribed.id,
        subscription_generation: 1,
        status: "pending",
        attempt_count: 0,
      });
      expect(eventRows[0].event_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(eventRows[0].recipient_membership_id).not.toBe(
        beforeSubscription.sender_membership_id,
      );
      // Reconstruction must retain exactly the same immutable event identity.
      await evictDurableObject(stub);
      expect(await rows()).toEqual(eventRows);
      expect(
        toolOutput(await post(ownerClient, key, "Committed peer event")),
      ).toEqual(committed);
      const conflicting = await post(
        ownerClient,
        key,
        "Conflicting retry body",
      );
      expect(conflicting.isError).toBe(true);
      expect((await rows()).map((row) => row.event_id)).toEqual([
        eventRows[0].event_id,
      ]);

      await post(peerClient, crypto.randomUUID(), "Peer self message");
      expect(await rows()).toHaveLength(1);
      const refreshed = (await callEvent(
        peerClient,
        "events/subscribe",
        subscriptionParams(tableId, CALLBACK, REPLACEMENT_SECRET),
      )) as { id: string };
      expect(refreshed.id).toBe(subscribed.id);
      const refreshedRows = await rows();
      expect(refreshedRows).toHaveLength(1);
      expect(refreshedRows[0]).toMatchObject({
        event_id: eventRows[0].event_id,
        subscription_generation: 2,
        attempt_count: 0,
      });

      await callEvent(
        peerClient,
        "events/unsubscribe",
        unsubscribeParams(tableId),
      );
      const cancelled = await rows();
      expect(cancelled[0]).toMatchObject({
        status: "cancelled",
        subscription_generation: 2,
      });
      await post(
        ownerClient,
        crypto.randomUUID(),
        "No event after unsubscribe",
      );
      expect(await rows()).toHaveLength(1);
      await callEvent(
        peerClient,
        "events/subscribe",
        subscriptionParams(tableId),
      );
      await post(ownerClient, crypto.randomUUID(), "Pending at table closure");
      const beforeClose = await rows();
      expect(beforeClose).toHaveLength(2);
      expect(beforeClose[0].status).toBe("cancelled");
      expect(beforeClose[1].status).toBe("pending");
      const closed = await ownerClient.callTool({
        name: "close_table",
        arguments: { table_id: tableId, request_id: crypto.randomUUID() },
      });
      expect(closed.isError).not.toBe(true);
      expect((await rows()).map((row) => row.status)).toEqual([
        "cancelled",
        "cancelled",
      ]);
      // These captured requests are subscription-control challenges, never
      // application-message deliveries.
      expect(receiver).toHaveBeenCalledTimes(3);
    } finally {
      await peerClient.close();
      await ownerClient.close();
      vi.restoreAllMocks();
    }
  });

  it("registers, encrypts, refreshes, reconstructs and unsubscribes an owned subscription", async () => {
    const principal = await newPrincipal();
    const client = await clientFor(principal.token);
    const receiver = echoReceiver();
    try {
      expect(client.getServerCapabilities()).not.toHaveProperty("events");
      expect(await callEvent(client, "events/list")).toMatchObject({
        events: [{ name: "table.message.created", delivery: ["webhook"] }],
      });
      expect(
        await callEvent(client, "events/list", {
          cursor: null,
          _meta: { progressToken: "synthetic" },
        }),
      ).toMatchObject({
        events: [{ name: "table.message.created" }],
      });
      await expect(
        callEvent(client, "events/list", { cursor: "forged" }),
      ).rejects.toMatchObject({ code: -32602 });
      const tableId = await createTable(client);
      const first = (await callEvent(
        client,
        "events/subscribe",
        subscriptionParams(tableId),
      )) as {
        id: string;
        refreshBefore: string;
        cursor: null;
        truncated: false;
      };
      expect(first.id).toMatch(/^sub_[A-Za-z0-9_-]+$/);
      expect(first).toMatchObject({ cursor: null, truncated: false });
      expect(Date.parse(first.refreshBefore)).toBeGreaterThan(Date.now());
      expect(Date.parse(first.refreshBefore)).toBeLessThanOrEqual(
        Date.now() + 3_600_000,
      );
      expect(receiver).toHaveBeenCalledTimes(1);
      const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
      const stored = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{
            generation: number;
            status: string;
            secret_envelope: string;
            callback_url: string;
          }>(
            "SELECT generation, status, secret_envelope, callback_url FROM table_event_subscriptions",
          )
          .one(),
      );
      expect(stored.generation).toBe(1);
      expect(stored.status).toBe("active");
      expect(stored.callback_url).toBe(CALLBACK);
      expect(stored.secret_envelope).not.toContain(SECRET);
      const eventGrant = await authorizeGuestConnection(
        env,
        principal.guestId,
        principal.connectionId,
        "events:subscribe",
      );
      expect(eventGrant.allowed).toBe(true);
      if (eventGrant.allowed) {
        expect(
          await stub.authorizeEventAttempt(eventGrant.actor, first.id, 1),
        ).toBe(false);
      }
      expect(
        await openSecret(
          "callback-credential",
          stored.secret_envelope,
          { recordId: `event:${first.id}` },
          env,
        ),
      ).toBe(SECRET);
      const get = toolOutput(
        await client.callTool({
          name: "get_table",
          arguments: { table_id: tableId },
        }),
      );
      expect(get.notifications).toEqual({
        available: false,
        reason: "delivery_not_ready",
        status: "active",
      });
      expect(JSON.stringify(get)).not.toContain(CALLBACK);
      expect(JSON.stringify(get)).not.toContain(SECRET);
      const combined = await clientFor(principal.token, {
        ...eventsOverlay(),
        ENABLE_MCP_SUBSCRIPTIONS: "true",
      });
      try {
        const metadataWithLiveStreams = toolOutput(
          await combined.callTool({
            name: "get_table",
            arguments: { table_id: tableId },
          }),
        );
        expect(metadataWithLiveStreams.notifications).toMatchObject({
          available: true,
          transport: "mcp_subscriptions_listen",
          events: {
            available: false,
            reason: "delivery_not_ready",
            status: "active",
          },
        });
      } finally {
        await combined.close();
      }

      await expect(
        callEvent(
          client,
          "events/subscribe",
          subscriptionParams(tableId, OTHER_CALLBACK),
        ),
      ).rejects.toMatchObject({ code: -32009 });
      const refreshed = (await callEvent(
        client,
        "events/subscribe",
        subscriptionParams(tableId, CALLBACK, REPLACEMENT_SECRET),
      )) as { id: string };
      expect(refreshed.id).toBe(first.id);
      const rotation = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{
            generation: number;
            secret_envelope: string;
            previous_secret_envelope: string;
            rotation_until: number;
          }>(
            "SELECT generation, secret_envelope, previous_secret_envelope, rotation_until FROM table_event_subscriptions",
          )
          .one(),
      );
      expect(rotation.generation).toBe(2);
      expect(rotation.rotation_until).toBeLessThanOrEqual(Date.now() + 300_000);
      expect(
        await openSecret(
          "callback-credential",
          rotation.secret_envelope,
          { recordId: `event:${first.id}` },
          env,
        ),
      ).toBe(REPLACEMENT_SECRET);
      expect(
        await openSecret(
          "callback-credential",
          rotation.previous_secret_envelope,
          { recordId: `event:${first.id}` },
          env,
        ),
      ).toBe(SECRET);

      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_event_subscriptions SET rotation_until = ?",
          Date.now() - 1,
        );
      });
      await runInDurableObject(stub, (instance) => instance.alarm());
      const scrubbed = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{
            generation: number;
            previous_secret_envelope: string | null;
          }>(
            "SELECT generation, previous_secret_envelope FROM table_event_subscriptions",
          )
          .one(),
      );
      expect(scrubbed).toEqual({
        generation: 3,
        previous_secret_envelope: null,
      });

      await evictDurableObject(stub);
      const firstStop = (await callEvent(
        client,
        "events/unsubscribe",
        unsubscribeParams(tableId),
      )) as Record<string, unknown>;
      const repeatedStop = (await callEvent(
        client,
        "events/unsubscribe",
        unsubscribeParams(tableId),
      )) as Record<string, unknown>;
      // The SDK may stamp serverInfo _meta onto otherwise empty results.
      expect(Object.keys(firstStop)).toEqual(["_meta"]);
      expect(Object.keys(repeatedStop)).toEqual(["_meta"]);
      const cleared = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{
            generation: number;
            status: string;
            secret_envelope: string | null;
            callback_url: string | null;
          }>(
            "SELECT generation, status, secret_envelope, callback_url FROM table_event_subscriptions",
          )
          .one(),
      );
      expect(cleared).toMatchObject({
        generation: 4,
        status: "inactive",
        secret_envelope: null,
        callback_url: null,
      });
      const after = toolOutput(
        await client.callTool({
          name: "get_table",
          arguments: { table_id: tableId },
        }),
      );
      expect(after.notifications).toMatchObject({ status: "disabled" });
    } finally {
      await client.close();
    }
  });

  it("rejects ungranted, nonmember, malformed and unreviewed requests without activation", async () => {
    const owner = await newPrincipal();
    const noEvents = await newPrincipal("tables:read tables:write");
    const stranger = await newPrincipal("events:subscribe");
    const client = await clientFor(owner.token);
    const noScopeClient = await clientFor(noEvents.token);
    const nonmemberClient = await clientFor(stranger.token);
    const disabledClient = await clientFor(owner.token, env);
    try {
      const tableId = await createTable(client);
      const receiver = echoReceiver();
      await expect(
        callEvent(noScopeClient, "events/list"),
      ).rejects.toMatchObject({ code: -32001 });
      await expect(
        callEvent(
          nonmemberClient,
          "events/subscribe",
          subscriptionParams(tableId),
        ),
      ).rejects.toMatchObject({ code: -32001 });
      await expect(
        callEvent(client, "events/subscribe", {
          ...subscriptionParams(tableId),
          guest_id: owner.guestId,
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        callEvent(client, "events/unsubscribe", {
          id: "sub_forged",
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        callEvent(
          client,
          "events/subscribe",
          subscriptionParams(crypto.randomUUID()),
        ),
      ).rejects.toMatchObject({
        code: -32001,
      });
      await expect(
        callEvent(
          disabledClient,
          "events/subscribe",
          subscriptionParams(tableId),
        ),
      ).rejects.toMatchObject({
        code: -32015,
      });
      expect(receiver).not.toHaveBeenCalled();
      receiver.mockResolvedValue(
        new Response(
          JSON.stringify({
            challenge: "wrong",
          }),
        ),
      );
      await expect(
        callEvent(client, "events/subscribe", subscriptionParams(tableId)),
      ).rejects.toMatchObject({
        code: -32015,
      });
      const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
      const rows = await runInDurableObject(stub, (_instance, state) => ({
        candidates: state.storage.sql
          .exec("SELECT * FROM table_event_candidates")
          .toArray(),
        active: state.storage.sql
          .exec(
            "SELECT * FROM table_event_subscriptions WHERE status = 'active'",
          )
          .toArray(),
      }));
      expect(rows.candidates).toHaveLength(0);
      expect(rows.active).toHaveLength(0);
    } finally {
      await client.close();
      await noScopeClient.close();
      await nonmemberClient.close();
      await disabledClient.close();
    }
  });

  it("keeps same-guest application connections separate until owner unsubscribes", async () => {
    const first = await newPrincipal();
    const second = await grantFor(
      first.guestId,
      first.guest,
      first.cookie,
      "tables:read tables:write events:subscribe",
    );
    expect(second.connectionId).not.toBe(first.connectionId);
    const a = await clientFor(first.token);
    const b = await clientFor(second.token);
    echoReceiver();
    try {
      const tableId = await createTable(a);
      await callEvent(a, "events/subscribe", subscriptionParams(tableId));
      await expect(
        callEvent(b, "events/subscribe", subscriptionParams(tableId)),
      ).rejects.toMatchObject({ code: -32009 });
      const bView = toolOutput(
        await b.callTool({
          name: "get_table",
          arguments: { table_id: tableId },
        }),
      );
      expect(bView.notifications).toMatchObject({ status: "disabled" });
      await callEvent(a, "events/unsubscribe", unsubscribeParams(tableId));
      const registeredB = (await callEvent(
        b,
        "events/subscribe",
        subscriptionParams(tableId, OTHER_CALLBACK),
      )) as { id: string };
      expect(registeredB.id).toMatch(/^sub_/);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("fences a verification held across owner unsubscribe", async () => {
    const principal = await newPrincipal();
    const client = await clientFor(principal.token);
    try {
      const tableId = await createTable(client);
      let release: (() => void) | undefined;
      let arrived: (() => void) | undefined;
      const waiting = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const body = JSON.parse(
          new TextDecoder().decode(init?.body as ArrayBuffer),
        );
        arrived?.();
        return new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(JSON.stringify({ challenge: body.challenge })),
            );
        });
      });
      const pending = callEvent(
        client,
        "events/subscribe",
        subscriptionParams(tableId),
      );
      await waiting;
      await callEvent(client, "events/unsubscribe", unsubscribeParams(tableId));
      release?.();
      await expect(pending).rejects.toMatchObject({ code: -32001 });
      const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
      const rows = await runInDurableObject(stub, (_instance, state) => ({
        candidates: state.storage.sql
          .exec("SELECT * FROM table_event_candidates")
          .toArray(),
        active: state.storage.sql
          .exec(
            "SELECT * FROM table_event_subscriptions WHERE status = 'active'",
          )
          .toArray(),
      }));
      expect(rows.candidates).toHaveLength(0);
      expect(rows.active).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("rejects held verification after grant revocation or table expiry", async () => {
    for (const intervention of ["revocation", "expiry"] as const) {
      const principal = await newPrincipal();
      const client = await clientFor(principal.token);
      let release: (() => void) | undefined;
      let arrived: (() => void) | undefined;
      const waiting = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      try {
        const tableId = await createTable(client);
        const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
          const body = JSON.parse(
            new TextDecoder().decode(init?.body as ArrayBuffer),
          );
          arrived?.();
          return new Promise<Response>((resolve) => {
            release = () =>
              resolve(
                new Response(JSON.stringify({ challenge: body.challenge })),
              );
          });
        });
        const pending = callEvent(
          client,
          "events/subscribe",
          subscriptionParams(tableId),
        );
        await waiting;
        if (intervention === "revocation") {
          const parts = principal.cookie.split("=")[1]?.split(".") ?? [];
          expect(
            (
              await principal.guest.revokeConnection(
                parts[2] ?? "",
                parts[3] ?? "",
                principal.connectionId,
              )
            ).status,
          ).toBe("revoked");
        } else {
          // Simulate the genuine server-clock terminal boundary in SQLite.
          await runInDurableObject(stub, (_instance, state) => {
            const row = state.storage.sql
              .exec<{ created_at: number }>(
                "SELECT created_at FROM table_metadata",
              )
              .one();
            state.storage.sql.exec(
              "UPDATE table_metadata SET expires_at = ? WHERE singleton = 1",
              row.created_at + 1,
            );
          });
        }
        release?.();
        await expect(pending).rejects.toMatchObject({ code: -32001 });
        const rows = await runInDurableObject(stub, (_instance, state) =>
          state.storage.sql
            .exec(
              "SELECT * FROM table_event_subscriptions WHERE status = 'active'",
            )
            .toArray(),
        );
        expect(rows).toHaveLength(0);
      } finally {
        release?.();
        await client.close();
        vi.restoreAllMocks();
      }
    }
  });

  it("does not let a delayed refresh overwrite the newer verified generation", async () => {
    const principal = await newPrincipal();
    const client = await clientFor(principal.token);
    let release: (() => void) | undefined;
    let arrived: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let challenges = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      challenges++;
      const body = JSON.parse(
        new TextDecoder().decode(init?.body as ArrayBuffer),
      );
      if (challenges === 2) {
        arrived?.();
        return new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(JSON.stringify({ challenge: body.challenge })),
            );
        });
      }
      return new Response(JSON.stringify({ challenge: body.challenge }));
    });
    try {
      const tableId = await createTable(client);
      const first = (await callEvent(
        client,
        "events/subscribe",
        subscriptionParams(tableId),
      )) as { id: string };
      const held = callEvent(
        client,
        "events/subscribe",
        subscriptionParams(tableId, CALLBACK, REPLACEMENT_SECRET),
      );
      await waiting;
      const latest = (await callEvent(
        client,
        "events/subscribe",
        subscriptionParams(tableId, CALLBACK, SECRET),
      )) as { id: string };
      expect(latest.id).toBe(first.id);
      release?.();
      await expect(held).rejects.toMatchObject({ code: -32001 });
      const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
      const state = await runInDurableObject(stub, (_instance, storage) =>
        storage.storage.sql
          .exec<{
            generation: number;
            secret_envelope: string;
          }>(
            "SELECT generation, secret_envelope FROM table_event_subscriptions",
          )
          .one(),
      );
      expect(state.generation).toBe(2);
      expect(
        await openSecret(
          "callback-credential",
          state.secret_envelope,
          { recordId: `event:${first.id}` },
          env,
        ),
      ).toBe(SECRET);
    } finally {
      release?.();
      await client.close();
    }
  });

  it("rejects an in-flight refresh after the original active expiry without an alarm", async () => {
    const principal = await newPrincipal();
    const client = await clientFor(principal.token);
    let release: (() => void) | undefined;
    let arrived: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    try {
      const tableId = await createTable(client);
      let challenges = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const body = JSON.parse(
          new TextDecoder().decode(init?.body as ArrayBuffer),
        );
        challenges++;
        if (challenges === 2) {
          arrived?.();
          return new Promise<Response>((resolve) => {
            release = () =>
              resolve(
                new Response(JSON.stringify({ challenge: body.challenge })),
              );
          });
        }
        return new Response(JSON.stringify({ challenge: body.challenge }));
      });
      await callEvent(client, "events/subscribe", subscriptionParams(tableId));
      const held = callEvent(
        client,
        "events/subscribe",
        subscriptionParams(tableId, CALLBACK, REPLACEMENT_SECRET),
      );
      await waiting;
      const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
      // Simulate the exact expiry boundary without invoking the alarm cleanup.
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_event_subscriptions SET expires_at = ? WHERE status = 'active'",
          Date.now() - 1,
        );
      });
      release?.();
      await expect(held).rejects.toMatchObject({ code: -32001 });
      const state = await runInDurableObject(stub, (_instance, storage) => ({
        subscription: storage.storage.sql
          .exec<{
            status: string;
            secret_envelope: string | null;
            callback_url: string | null;
            generation: number;
          }>(
            "SELECT status, secret_envelope, callback_url, generation FROM table_event_subscriptions",
          )
          .one(),
        candidates: storage.storage.sql
          .exec("SELECT * FROM table_event_candidates")
          .toArray(),
      }));
      expect(state.subscription).toMatchObject({
        status: "expired",
        secret_envelope: null,
        callback_url: null,
        generation: 2,
      });
      expect(state.candidates).toEqual([]);
    } finally {
      release?.();
      await client.close();
      vi.restoreAllMocks();
    }
  });

  it("erases expired active credentials and surfaces only an expired own status", async () => {
    const principal = await newPrincipal();
    const client = await clientFor(principal.token);
    echoReceiver();
    try {
      const tableId = await createTable(client);
      await callEvent(client, "events/subscribe", subscriptionParams(tableId));
      const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_event_subscriptions SET expires_at = ?",
          Date.now() - 1,
        );
      });
      await runInDurableObject(stub, (instance) => instance.alarm());
      const erased = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{
            status: string;
            secret_envelope: string | null;
            callback_url: string | null;
            previous_secret_envelope: string | null;
          }>(
            "SELECT status, secret_envelope, callback_url, previous_secret_envelope FROM table_event_subscriptions",
          )
          .one(),
      );
      expect(erased).toEqual({
        status: "expired",
        secret_envelope: null,
        callback_url: null,
        previous_secret_envelope: null,
      });
      const view = toolOutput(
        await client.callTool({
          name: "get_table",
          arguments: { table_id: tableId },
        }),
      );
      expect(view.notifications).toMatchObject({
        available: false,
        status: "expired",
      });
    } finally {
      await client.close();
    }
  });

  it("expires pending verification and fences its delayed callback response", async () => {
    const principal = await newPrincipal();
    const client = await clientFor(principal.token);
    let release: (() => void) | undefined;
    let arrived: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    try {
      const tableId = await createTable(client);
      const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const body = JSON.parse(
          new TextDecoder().decode(init?.body as ArrayBuffer),
        );
        arrived?.();
        return new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(JSON.stringify({ challenge: body.challenge })),
            );
        });
      });
      const pending = callEvent(
        client,
        "events/subscribe",
        subscriptionParams(tableId),
      );
      await waiting;
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE table_event_candidates SET expires_at = ?",
          Date.now() - 1,
        );
      });
      await runInDurableObject(stub, (instance) => instance.alarm());
      release?.();
      await expect(pending).rejects.toMatchObject({ code: -32001 });
      const erased = await runInDurableObject(stub, (_instance, state) => ({
        candidates: state.storage.sql
          .exec("SELECT * FROM table_event_candidates")
          .toArray(),
        subscriptions: state.storage.sql
          .exec<{ status: string; secret_envelope: string | null }>(
            "SELECT status, secret_envelope FROM table_event_subscriptions",
          )
          .toArray(),
      }));
      expect(erased.candidates).toEqual([]);
      expect(erased.subscriptions).toEqual([
        { status: "inactive", secret_envelope: null },
      ]);
    } finally {
      release?.();
      await client.close();
    }
  });
});
