import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";

// Real Workerd isolates: two distinct public entry Workers and a separate
// authoritative Worker exporting the same SQLite Durable Object classes.
// No Cloudflare account, external network, or production data is used.
const ORIGIN = "http://localhost:8787";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example/callback";
const KEYRING = JSON.stringify({
  current: {
    id: "synthetic-test-2026",
    key: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  },
  previous: [],
});
async function deadline(promise, ms = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Live-stream probe timeout")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const decodeTool = (value) =>
  JSON.parse(value.content.find((entry) => entry.type === "text").text);
const post = (fetcher, path, options) =>
  fetcher.fetch(new Request(new URL(path, ORIGIN), options));

async function tokenForGuest(fetcher, guestNamespace, clientId, scopes) {
  const guestId = crypto.randomUUID();
  const guest = guestNamespace.get(guestNamespace.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const cookie = `__Host-agent_table_session=v1.${guestId}.${session.sessionId}.${session.secret}`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${ORIGIN}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: scopes,
    state: "two_worker_test",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  }))
    url.searchParams.set(key, value);
  const consent = await post(fetcher, url.toString(), {
    headers: { Cookie: cookie },
  });
  assert.equal(consent.status, 200);
  const html = await consent.text();
  const hidden = (name) =>
    new RegExp(`name="${name}" type="hidden" value="([^"]+)"`).exec(html)?.[1];
  const cookies = consent.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]);
  const authorized = await post(fetcher, "/authorize", {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: [cookie, ...cookies].join("; "),
    },
    body: new URLSearchParams([
      ["handle", hidden("handle")],
      ["csrf", hidden("csrf")],
      ["guest_id", guestId],
      ["binding", hidden("binding")],
      ["decision", "approve"],
      ...scopes.split(" ").map((scope) => ["scope", scope]),
    ]),
  });
  assert.equal(authorized.status, 302);
  const code = new URL(authorized.headers.get("location")).searchParams.get(
    "code",
  );
  const redemption = await post(fetcher, "/oauth/token", {
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
  });
  assert.equal(redemption.status, 200);
  const token = (await redemption.json()).access_token;
  const rotated = authorized.headers
    .getSetCookie()
    .find((line) => line.startsWith("__Host-agent_table_session="));
  const parts = rotated?.split(";")[0].split("=")[1].split(".");
  const connection = (await guest.listConnections(parts[2], parts[3]))?.[0];
  assert(connection);
  return { token, guest, guestId, connection, session: parts };
}

async function sdk(fetcher, token, onListenResponse) {
  const client = new Client(
    { name: "two-workerd-edge-probe", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(RESOURCE), {
      authProvider: { token: async () => token },
      fetch: async (url, init) => {
        const request = new Request(url, init);
        request.headers.set("Host", new URL(request.url).host);
        const payload =
          request.method === "POST"
            ? await request
                .clone()
                .json()
                .catch(() => null)
            : null;
        const response = await fetcher.fetch(request);
        return payload?.method === "subscriptions/listen" && onListenResponse
          ? onListenResponse(response)
          : response;
      },
    }),
  );
  return client;
}

function workerOptions(name, scriptPath, core = false) {
  const durableObjects = Object.fromEntries(
    ["TABLES", "GUESTS", "OAUTH_SERIALIZER", "ADMISSION"].map((binding) => [
      binding,
      {
        className: {
          TABLES: "TableDO",
          GUESTS: "GuestDO",
          OAUTH_SERIALIZER: "OAuthTokenDO",
          ADMISSION: "AdmissionDO",
        }[binding],
        ...(core ? {} : { scriptName: "authority" }),
        useSQLite: true,
      },
    ]),
  );
  return {
    name,
    scriptPath,
    modules: true,
    compatibilityDate: "2026-11-07",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    durableObjects,
    kvNamespaces: { OAUTH_KV: "synthetic-oauth-shared-kv" },
    bindings: {
      PUBLIC_ORIGIN: ORIGIN,
      // Explicit normal-mode settings are required on every edge and DO worker.
      RELEASE_ENVIRONMENT: "local",
      RESTORE_QUARANTINE: "false",
      INVITATION_RESPONSE_KEYRING: KEYRING,
      ENABLE_MCP_SUBSCRIPTIONS: "true",
      ENABLE_OPENAI_EVENTS: "false",
      ALLOW_NEW_GUESTS: "false",
      ALLOW_NEW_TABLES: "true",
      ALLOW_OUTBOUND_NOTIFICATIONS: "false",
    },
  };
}

const directory = await mkdtemp(join(tmpdir(), "agent-table-two-edge-"));
let mf;
try {
  execFileSync(
    "node_modules/.bin/wrangler",
    ["deploy", "--dry-run", "--outdir", join(directory, "bundle")],
    { stdio: "pipe" },
  );
  const bundle = "bundle/index.js";
  mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      workers: [
        workerOptions("authority", bundle, true),
        workerOptions("edge-one", bundle),
        workerOptions("edge-two", bundle),
      ],
      log: new Log(LogLevel.ERROR),
      resourcePersistencePath: join(directory, "storage"),
      unsafeInspectDurableObjects: true,
    }),
  );
  const a = await mf.getWorker("edge-one");
  const b = await mf.getWorker("edge-two");
  const bindings = await mf.getBindings("edge-one");

  const registration = await post(a, "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Two-edge SDK probe",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const clientId = (await registration.json()).client_id;
  const owner = await tokenForGuest(
    a,
    bindings.GUESTS,
    clientId,
    "tables:read tables:write events:subscribe",
  );
  const peer = await tokenForGuest(
    b,
    bindings.GUESTS,
    clientId,
    "tables:read tables:write events:subscribe",
  );
  const first = await sdk(a, owner.token);
  const second = await sdk(b, peer.token);
  try {
    assert.equal(first.getServerCapabilities().resources.subscribe, true);
    const created = decodeTool(
      await first.callTool({
        name: "create_table",
        arguments: {
          title: "Two Workerd edge streams",
          request_id: "edge_create_request_0001",
        },
      }),
    );
    assert(created.tableId && created.ownInboxUri);
    const invite = decodeTool(
      await first.callTool({
        name: "create_invite",
        arguments: {
          table_id: created.tableId,
          request_id: "edge_invite_request_0001",
        },
      }),
    );
    const joined = decodeTool(
      await second.callTool({
        name: "join_table",
        arguments: {
          invitation: invite.invitation,
          request_id: "edge_join_request_00001",
        },
      }),
    );
    assert(joined.ownInboxUri);
    const received = [];
    let nextNotification;
    first.setNotificationHandler("notifications/resources/updated", (event) => {
      received.push(event.params.uri);
      nextNotification?.();
    });
    const listen = await deadline(
      first.listen({
        resourceSubscriptions: [created.ownInboxUri],
      }),
    );
    assert.deepEqual(listen.honoredFilter, {
      resourceSubscriptions: [created.ownInboxUri],
    });
    const own = {
      table_id: created.tableId,
      request_id: "edge_self_post_0000001",
      body: "Self",
    };
    await first.callTool({ name: "post_message", arguments: own });
    await first.callTool({ name: "post_message", arguments: own });
    assert.deepEqual(received, []);
    const notified = new Promise((resolve) => {
      nextNotification = resolve;
    });
    const committed = decodeTool(
      await second.callTool({
        name: "post_message",
        arguments: {
          table_id: created.tableId,
          request_id: "edge_peer_post_0000001",
          body: "Committed from independent Worker entry",
        },
      }),
    );
    assert.equal(committed.seq, 2);
    await deadline(notified);
    assert.deepEqual(received, [created.ownInboxUri]);
    const read = decodeTool(
      await first.callTool({
        name: "read_messages",
        arguments: { table_id: created.tableId, after_seq: 1 },
      }),
    );
    assert.deepEqual(
      read.messages.map(({ seq, body }) => ({ seq, body })),
      [{ seq: 2, body: "Committed from independent Worker entry" }],
    );
    console.log(
      "PASS two distinct Worker entries: official SDK ack, peer hint and retained read",
    );

    for (const filter of [
      { resourceSubscriptions: [created.ownInboxUri, joined.ownInboxUri] },
      { resourceSubscriptions: [created.ownInboxUri, created.ownInboxUri] },
      { toolsListChanged: true },
      { resourceSubscriptions: [created.ownInboxUri], toolsListChanged: true },
    ]) {
      await assert.rejects(first.listen(filter), { code: -32602 });
    }
    await assert.rejects(
      first.listen({ resourceSubscriptions: [joined.ownInboxUri] }),
      { code: -32603 },
    );
    console.log("PASS canonical, mixed-filter and foreign-actor rejections");

    const replacement = await deadline(
      first.listen({ resourceSubscriptions: [created.ownInboxUri] }),
    );
    assert.equal(await deadline(listen.closed), "graceful");
    await listen.close();
    const replacementNotice = new Promise((resolve) => {
      nextNotification = resolve;
    });
    await second.callTool({
      name: "post_message",
      arguments: {
        table_id: created.tableId,
        request_id: "edge_peer_post_0000002",
        body: "After replacement",
      },
    });
    await deadline(replacementNotice);
    assert.equal(received.length, 2);
    await replacement.close();
    await second.callTool({
      name: "post_message",
      arguments: {
        table_id: created.tableId,
        request_id: "edge_peer_post_0000003",
        body: "Disconnected retained gap",
      },
    });
    const resumed = await deadline(
      first.listen({ resourceSubscriptions: [created.ownInboxUri] }),
    );
    const gap = decodeTool(
      await first.callTool({
        name: "read_messages",
        arguments: { table_id: created.tableId, after_seq: 3 },
      }),
    );
    assert.deepEqual(
      gap.messages.map(({ seq, body }) => ({ seq, body })),
      [{ seq: 4, body: "Disconnected retained gap" }],
    );
    const resumedNotice = new Promise((resolve) => {
      nextNotification = resolve;
    });
    await second.callTool({
      name: "post_message",
      arguments: {
        table_id: created.tableId,
        request_id: "edge_peer_post_0000004",
        body: "After reconnect and catch-up",
      },
    });
    await deadline(resumedNotice);
    assert.equal(received.length, 3);
    console.log(
      "PASS replacement, cancellation and ack-before-cursor gap recovery",
    );

    const otherInbox = [];
    let otherNotice;
    second.setNotificationHandler(
      "notifications/resources/updated",
      (event) => {
        otherInbox.push(event.params.uri);
        otherNotice?.();
      },
    );
    const peerStream = await deadline(
      second.listen({ resourceSubscriptions: [joined.ownInboxUri] }),
    );
    const fromOwner = new Promise((resolve) => {
      otherNotice = resolve;
    });
    await first.callTool({
      name: "post_message",
      arguments: {
        table_id: created.tableId,
        request_id: "edge_owner_post_000001",
        body: "Only the peer sees this hint",
      },
    });
    await deadline(fromOwner);
    assert.deepEqual(otherInbox, [joined.ownInboxUri]);
    assert.equal(received.length, 3);
    await peerStream.close();

    // Hold the official SDK transport's SSE response unread while a different
    // edge commits a burst. No generic SDK bus may accumulate that burst.
    let releaseResponse;
    let markPrepared;
    const responsePrepared = new Promise((resolve) => {
      markPrepared = resolve;
    });
    const slow = await sdk(
      a,
      owner.token,
      (response) =>
        new Promise((resolve) => {
          releaseResponse = () => resolve(response);
          markPrepared();
        }),
    );
    const slowHints = [];
    slow.setNotificationHandler("notifications/resources/updated", (note) => {
      slowHints.push(note.params.uri);
    });
    // Attach both outcomes immediately: a slow consumer may be closed before
    // the withheld HTTP response reaches the SDK, and Node must not see an
    // unhandled rejection while the peer commits the unread burst.
    const pendingSlow = slow
      .listen({ resourceSubscriptions: [created.ownInboxUri] })
      .then(
        (subscription) => ({ kind: "active", subscription }),
        (error) => ({ kind: "closed", error }),
      );
    await deadline(responsePrepared);
    assert.equal(await deadline(resumed.closed), "graceful");
    for (let i = 0; i < 4; i++) {
      await second.callTool({
        name: "post_message",
        arguments: {
          table_id: created.tableId,
          request_id: `edge_unread_post_00000${i}`,
          body: `Unread ${i}`,
        },
      });
    }
    releaseResponse();
    const slowResult = await deadline(pendingSlow);
    if (slowResult.kind === "active") {
      assert.deepEqual(slowResult.subscription.honoredFilter, {
        resourceSubscriptions: [created.ownInboxUri],
      });
      assert.equal(await deadline(slowResult.subscription.closed), "graceful");
      await slowResult.subscription.close();
    } else {
      // Deliberate response withholding permits the server to close a slow
      // listener before its acknowledgement arrives. Only the SDK's stream-end
      // error is expected; the retained unread gap is verified below.
      assert.match(
        slowResult.error?.message ?? "",
        /^subscriptions\/listen: stream ended$/,
      );
    }
    assert(slowHints.length <= 4, "unread SSE output must remain bounded");
    await slow.close();
    console.log(
      "PASS unread cross-edge consumer: bounded SDK frames and cleanup",
    );

    const afterSlow = await deadline(
      first.listen({ resourceSubscriptions: [created.ownInboxUri] }),
    );
    const slowGap = decodeTool(
      await first.callTool({
        name: "read_messages",
        arguments: { table_id: created.tableId, after_seq: 6 },
      }),
    );
    assert.deepEqual(
      slowGap.messages.map(({ seq, body }) => ({ seq, body })),
      Array.from({ length: 4 }, (_, i) => ({
        seq: i + 7,
        body: `Unread ${i}`,
      })),
    );
    await peer.guest.revokeConnection(
      peer.session[2],
      peer.session[3],
      peer.connection.connectionId,
    );
    assert.equal(received.length, 3);
    const closed = await first.callTool({
      name: "close_table",
      arguments: {
        table_id: created.tableId,
        request_id: "edge_close_table_00001",
      },
    });
    assert.equal(decodeTool(closed).state, "closed");
    assert.equal(await deadline(afterSlow.closed), "graceful");
    console.log("PASS isolated actors and terminal table closure");

    const expiring = decodeTool(
      await first.callTool({
        name: "create_table",
        arguments: {
          title: "Expiry-only live stream",
          request_id: "edge_expiry_create_0001",
        },
      }),
    );
    const expiryStream = await deadline(
      first.listen({ resourceSubscriptions: [expiring.ownInboxUri] }),
    );
    const storage = await mf.unsafeGetDurableObjectStorage(
      "authority",
      "TableDO",
      { name: expiring.tableId },
    );
    // Test-only deadline shortening, never a public mutation path.
    await storage.exec(
      "UPDATE table_metadata SET expires_at = ?",
      Date.now() + 100,
    );
    assert.equal(await deadline(expiryStream.closed, 4_000), "graceful");
    console.log("PASS expired table terminates the public SDK listener");

    const erasing = decodeTool(
      await first.callTool({
        name: "create_table",
        arguments: {
          title: "Deletion-invalidation test",
          request_id: "edge_delete_create_0001",
        },
      }),
    );
    const eraseStream = await deadline(
      first.listen({ resourceSubscriptions: [erasing.ownInboxUri] }),
    );
    const erased = await bindings.TABLES.get(
      bindings.TABLES.idFromName(erasing.tableId),
    ).purgeTable({
      kind: "verified-connection",
      guestId: owner.guestId,
      connectionId: owner.connection.connectionId,
      scope: "tables:write",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(erased.ok, true);
    assert.equal(await deadline(eraseStream.closed), "graceful");
    console.log("PASS test-only approved-delete transition ends public stream");

    const revoking = decodeTool(
      await first.callTool({
        name: "create_table",
        arguments: {
          title: "Idle revocation test",
          request_id: "edge_revoke_create_0001",
        },
      }),
    );
    const revokeStream = await deadline(
      first.listen({ resourceSubscriptions: [revoking.ownInboxUri] }),
    );
    await owner.guest.revokeConnection(
      owner.session[2],
      owner.session[3],
      owner.connection.connectionId,
    );
    assert.equal(await deadline(revokeStream.closed, 4_000), "graceful");
    console.log("PASS idle connection grant revocation ends public stream");
  } finally {
    await first.close();
    await second.close();
  }
} finally {
  await mf?.dispose();
  await rm(directory, { recursive: true, force: true });
}
