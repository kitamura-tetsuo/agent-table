import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";

// Two separate Workerd lifetimes share only a synthetic local SQLite store.
// This is a configuration-switch rehearsal, not a Cloudflare restore receipt.
const candidate = JSON.parse(
  await readFile(
    new URL(
      "../test/fixtures/quarantined-restore-generated.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const ORIGIN = candidate.vars.PUBLIC_ORIGIN;
const KEYRING = JSON.stringify({
  current: {
    id: "synthetic-transition",
    key: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  },
  previous: [],
});
const privateBody = "Synthetic historical private transcript";
const snapshot = (value) => JSON.parse(JSON.stringify(value));

function workerOptions(quarantined) {
  const vars = quarantined
    ? candidate.vars
    : {
        ...candidate.vars,
        // The synthetic pre-snapshot workload predates the manual-only
        // staging release profile; exercise it under local test authority.
        RELEASE_ENVIRONMENT: "local",
        RESTORE_QUARANTINE: "false",
        ALLOW_NEW_GUESTS: "true",
        ALLOW_NEW_TABLES: "true",
        ENABLE_MCP_SUBSCRIPTIONS: "true",
      };
  return {
    name: candidate.name,
    scriptPath: "bundle/index.js",
    modules: true,
    compatibilityDate: "2026-11-07",
    compatibilityFlags: candidate.compatibility_flags,
    durableObjects: Object.fromEntries(
      candidate.durable_objects.bindings.map(({ name, class_name }) => [
        name,
        { className: class_name, useSQLite: true },
      ]),
    ),
    kvNamespaces: { OAUTH_KV: "synthetic-transition-oauth" },
    bindings: { ...vars, INVITATION_RESPONSE_KEYRING: KEYRING },
  };
}

function runtime(directory, quarantined) {
  return new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      workers: [workerOptions(quarantined)],
      resourcePersistencePath: join(directory, "persistent-storage"),
      unsafeInspectDurableObjects: true,
      log: new Log(LogLevel.ERROR),
    }),
  );
}

async function inspect(mf, className, id, sql, ...params) {
  const storage = await mf.unsafeGetDurableObjectStorage(
    candidate.name,
    className,
    {
      name: id,
    },
  );
  return storage.exec(sql, ...params);
}

test("generated restore configuration preserves historical SQLite but refuses old authority after a real Workerd restart", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-table-restore-transition-"),
  );
  let mf;
  try {
    execFileSync(
      "node_modules/.bin/wrangler",
      ["deploy", "--dry-run", "--outdir", join(directory, "bundle")],
      { stdio: "pipe" },
    );

    mf = runtime(directory, false);
    const oldBindings = await mf.getBindings(candidate.name);
    const guestId = crypto.randomUUID();
    const guest = oldBindings.GUESTS.get(
      oldBindings.GUESTS.idFromName(guestId),
    );
    const session = await guest.createSession(guestId);
    const sessionId = String(session.sessionId);
    const sessionSecret = String(session.secret);
    const connection = await guest.createConnection(
      sessionId,
      sessionSecret,
      ["tables:read", "tables:write", "events:subscribe"],
      Date.now() + 60 * 60_000,
    );
    assert(connection);
    // Materialize primitives before disposing the old Miniflare runtime.
    const connectionId = String(connection.connectionId);
    const actor = (scope) => ({
      kind: "verified-connection",
      guestId,
      connectionId,
      scope,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const input = {
      request_id: "pre_snapshot_reservation_0001",
      title: "Synthetic old private table",
    };
    const reservation = await guest.reserveCreation(
      actor("tables:write"),
      input,
    );
    assert.equal(reservation.ok, true);
    const tableId = reservation.reservation.tableId;
    const table = oldBindings.TABLES.get(
      oldBindings.TABLES.idFromName(tableId),
    );
    const created = await table.initializeTable(
      actor("tables:write"),
      input,
      reservation.reservation,
    );
    assert.equal(created.ok, true);
    const posted = await table.postMessage(actor("tables:write"), {
      request_id: "pre_snapshot_message_00001",
      body: privateBody,
    });
    assert.equal(posted.ok, true);
    assert.equal(
      (await table.readMessages(actor("tables:read"), {})).value.messages[0]
        .body,
      privateBody,
    );
    const filter = { resourceSubscriptions: [created.value.ownInboxUri] };
    assert.equal(
      (
        await table.checkInboxSubscription(
          actor("events:subscribe"),
          filter,
          Date.now() + 30_000,
        )
      ).ok,
      true,
    );
    // Simulate durable, due notification work inherited from the old
    // runtime. No post-snapshot revocation source is available for clearance.
    const [membership] = await inspect(
      mf,
      "TableDO",
      tableId,
      "SELECT membership_id FROM table_memberships",
    );
    const [message] = await inspect(
      mf,
      "TableDO",
      tableId,
      "SELECT message_id FROM table_messages",
    );
    const pendingEventId = crypto.randomUUID();
    const pendingSubscriptionId = crypto.randomUUID();
    const pendingNextAttemptAt = Date.now() - 2_000;
    await inspect(
      mf,
      "TableDO",
      tableId,
      `INSERT INTO table_event_subscriptions
        (membership_id, generation, fence, status, guest_id, connection_id,
         subscription_id, callback_url, secret_envelope, expires_at)
        VALUES (?, 1, 1, 'active', ?, ?, ?, ?, ?, ?)`,
      membership.membership_id,
      guestId,
      connectionId,
      pendingSubscriptionId,
      "https://callbacks.invalid/never-send",
      "synthetic-unreadable-envelope",
      Date.now() + 60 * 60_000,
    );
    await inspect(
      mf,
      "TableDO",
      tableId,
      `INSERT INTO table_event_outbox
        (event_id, message_id, message_seq, recipient_membership_id,
         subscription_id, subscription_generation, status, attempt_count,
         next_attempt_at, created_at, expires_at)
        VALUES (?, ?, 1, ?, ?, 1, 'pending', 0, ?, ?, ?)`,
      pendingEventId,
      message.message_id,
      membership.membership_id,
      pendingSubscriptionId,
      pendingNextAttemptAt,
      Date.now() - 30_000,
      Date.now() + 60 * 60_000,
    );
    const pendingOutboxSql =
      "SELECT status, attempt_count, next_attempt_at, lease_token, lease_deadline FROM table_event_outbox WHERE event_id = ?";
    const unchangedPendingOutbox = [
      {
        status: "pending",
        attempt_count: 0,
        next_attempt_at: pendingNextAttemptAt,
        lease_token: null,
        lease_deadline: null,
      },
    ];
    assert.deepEqual(
      await inspect(mf, "TableDO", tableId, pendingOutboxSql, pendingEventId),
      unchangedPendingOutbox,
    );
    assert.deepEqual(
      await inspect(mf, "TableDO", tableId, "SELECT body FROM table_messages"),
      [{ body: privateBody }],
    );
    assert.deepEqual(
      await inspect(
        mf,
        "GuestDO",
        guestId,
        "SELECT COUNT(*) AS n FROM guest_sessions",
      ),
      [{ n: 1 }],
    );
    await mf.dispose();
    mf = undefined;

    // No independent post-snapshot revocation/deletion/expiry record exists:
    // the exact generated restore candidate must win over the old grant.
    assert.equal(candidate.vars.RESTORE_QUARANTINE, "true");
    assert.equal(candidate.vars.ALLOW_OUTBOUND_NOTIFICATIONS, "false");
    mf = runtime(directory, true);
    const restoredBindings = await mf.getBindings(candidate.name);
    const restoredWorker = await mf.getWorker(candidate.name);
    const restoredTable = restoredBindings.TABLES.get(
      restoredBindings.TABLES.idFromName(tableId),
    );
    const sessionCookie = `__Host-agent_table_session=v1.${guestId}.${sessionId}.${sessionSecret}`;
    for (const endpoint of [
      "/health",
      `/guest/table?table_id=${tableId}`,
      "/mcp",
    ]) {
      const response = await restoredWorker.fetch(
        new Request(new URL(endpoint, ORIGIN), {
          method: endpoint === "/mcp" ? "POST" : "GET",
          headers: { Cookie: sessionCookie },
        }),
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert(!(await response.text()).includes(privateBody));
    }
    assert.deepEqual(
      snapshot(await restoredTable.readMessages(actor("tables:read"), {})),
      { ok: false, code: "TABLE_NOT_FOUND" },
    );
    assert.deepEqual(
      snapshot(
        await restoredTable.postMessage(actor("tables:write"), {
          request_id: "after_restore_message_0001",
          body: "Must not be stored",
        }),
      ),
      { ok: false, code: "TABLE_NOT_FOUND" },
    );
    assert.deepEqual(
      snapshot(
        await restoredTable.checkInboxSubscription(
          actor("events:subscribe"),
          filter,
          Date.now() + 30_000,
        ),
      ),
      { ok: false, code: "TEMPORARILY_UNAVAILABLE" },
    );
    assert.deepEqual(
      snapshot(
        await restoredTable.openInboxHintStream(
          actor("events:subscribe"),
          filter,
          Date.now() + 30_000,
        ),
      ),
      { ok: false, code: "TEMPORARILY_UNAVAILABLE" },
    );
    // The retained due outbox remains pending after Workerd reconstruction.
    // The isolated generated-runtime test separately invokes real DO alarms.
    assert.deepEqual(
      await inspect(mf, "TableDO", tableId, pendingOutboxSql, pendingEventId),
      unchangedPendingOutbox,
    );
    assert.deepEqual(
      await inspect(mf, "TableDO", tableId, "SELECT body FROM table_messages"),
      [{ body: privateBody }],
    );
    assert.deepEqual(
      await inspect(
        mf,
        "GuestDO",
        guestId,
        "SELECT COUNT(*) AS n FROM guest_sessions",
      ),
      [{ n: 1 }],
    );

    // A further process reconstruction must not silently clear quarantine.
    await mf.dispose();
    mf = runtime(directory, true);
    const afterRestart = await mf.getWorker(candidate.name);
    const response = await afterRestart.fetch(
      new Request(new URL("/health", ORIGIN)),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(
      await inspect(mf, "TableDO", tableId, "SELECT body FROM table_messages"),
      [{ body: privateBody }],
    );
    assert.deepEqual(
      await inspect(mf, "TableDO", tableId, pendingOutboxSql, pendingEventId),
      unchangedPendingOutbox,
    );
  } finally {
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
