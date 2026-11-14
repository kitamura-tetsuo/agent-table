import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";

// All identities, credentials and transcripts are synthetic. The copied SQLite
// directory is an actual local snapshot, never a Cloudflare recovery approval.
const candidate = JSON.parse(
  await readFile(
    new URL(
      "../test/fixtures/quarantined-restore-generated.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
// Browser traffic is strictly local; only the restored bindings retain the
// generated staging identity, whose quarantine gate rejects every request.
const ORIGIN = "http://localhost:8787";
const KEYRING = JSON.stringify({
  current: {
    id: "synthetic-snapshot",
    key: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  },
  previous: [],
});
const PRIVATE_BODY = "Synthetic content deleted after snapshot A";
const plain = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let directory;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-table-snapshot-rehearsal-"));
  execFileSync(
    "node_modules/.bin/wrangler",
    ["deploy", "--dry-run", "--outdir", join(directory, "bundle")],
    { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function runtime(persistence, quarantined, outbound) {
  const vars = quarantined
    ? candidate.vars
    : {
        ...candidate.vars,
        RELEASE_ENVIRONMENT: "local",
        PUBLIC_ORIGIN: ORIGIN,
        RESTORE_QUARANTINE: "false",
        ALLOW_NEW_GUESTS: "true",
        ALLOW_NEW_TABLES: "true",
        ENABLE_MCP_SUBSCRIPTIONS: "true",
      };
  return new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      workers: [
        {
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
          kvNamespaces: { OAUTH_KV: "synthetic-snapshot-oauth" },
          bindings: { ...vars, INVITATION_RESPONSE_KEYRING: KEYRING },
          outboundService: () => {
            outbound.push("unexpected-outbound-request");
            return new Response(null, { status: 503 });
          },
        },
      ],
      resourcePersistencePath: persistence,
      unsafeInspectDurableObjects: true,
      log: new Log(LogLevel.ERROR),
    }),
  );
}

async function sql(mf, className, id, statement, ...params) {
  const storage = await mf.unsafeGetDurableObjectStorage(
    candidate.name,
    className,
    { name: id },
  );
  return storage.exec(statement, ...params);
}

async function filesDigest(root) {
  const paths = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
  return Promise.all(
    paths.map(async (path) => [path, sha256(await readFile(join(root, path)))]),
  );
}

// Inspection happens only after Workerd has stopped, through read-only SQLite.
// It remains usable even when a future schema correctly prevents DO startup.
async function canonicalDatabases(root) {
  const result = {};
  for (const relative of (await readdir(root, { recursive: true })).sort()) {
    if (!relative.endsWith(".sqlite")) continue;
    const database = new DatabaseSync(join(root, relative), { readOnly: true });
    try {
      const tables = database
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all();
      if (!tables.some(({ name }) => name === "__agent_table_schema")) continue;
      result[relative] = tables
        .filter(
          ({ name }) => !name.startsWith("_cf_") && name !== "sqlite_sequence",
        )
        .map(({ name, sql: definition }) => ({
          name,
          definition,
          rows: database
            .prepare(
              `SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
            )
            .all(),
        }));
    } finally {
      database.close();
    }
  }
  return plain(result);
}

// Workerd's pinned SQLite alarm queue stores nanosecond deadlines separately
// from each object's private tables. Inspect it read-only after full shutdown.
async function alarmDeadlines(root) {
  const result = [];
  for (const relative of await readdir(root, { recursive: true })) {
    if (!relative.endsWith(".sqlite")) continue;
    const database = new DatabaseSync(join(root, relative), { readOnly: true });
    try {
      if (
        !database
          .prepare("SELECT 1 FROM sqlite_master WHERE name = '_cf_ALARM'")
          .get()
      )
        continue;
      const statement = database.prepare(
        "SELECT actor_id, scheduled_time FROM _cf_ALARM",
      );
      statement.setReadBigInts(true);
      for (const row of statement.all()) {
        result.push({
          id: row.actor_id,
          scheduledAt: Number(row.scheduled_time / 1_000_000n),
        });
      }
    } finally {
      database.close();
    }
  }
  return result;
}

async function seed(mf, { shortExpiry = false } = {}) {
  const bindings = await mf.getBindings(candidate.name);
  const guestId = crypto.randomUUID();
  const guest = bindings.GUESTS.get(bindings.GUESTS.idFromName(guestId));
  const session = plain(await guest.createSession(guestId));
  const connection = plain(
    await guest.createConnection(
      session.sessionId,
      session.secret,
      ["tables:read", "tables:write", "tables:delete", "events:subscribe"],
      Date.now() + 60 * 60_000,
    ),
  );
  assert(connection);
  const actor = (scope) => ({
    kind: "verified-connection",
    guestId,
    connectionId: connection.connectionId,
    scope,
    expiresAt: connection.expiresAt,
  });
  const input = {
    request_id: "snapshot_create_request_0001",
    title: "Synthetic snapshot table",
  };
  const reservation = plain(
    await guest.reserveCreation(actor("tables:write"), input),
  );
  assert.equal(reservation.ok, true);
  const tableId = reservation.reservation.tableId;
  const table = bindings.TABLES.get(bindings.TABLES.idFromName(tableId));
  const created = plain(
    await table.initializeTable(
      actor("tables:write"),
      input,
      reservation.reservation,
    ),
  );
  assert.equal(created.ok, true);
  assert.equal(
    (
      await table.postMessage(actor("tables:write"), {
        request_id: "snapshot_message_request_0001",
        body: PRIVATE_BODY,
      })
    ).ok,
    true,
  );
  assert.equal(
    (await table.readMessages(actor("tables:read"), {})).value.messages[0].body,
    PRIVATE_BODY,
  );
  const invite = plain(
    await table.issueInvite(
      actor("tables:write"),
      "snapshot_invite_request_0001",
    ),
  );
  assert.equal(invite.ok, true);
  const expiring = shortExpiry
    ? plain(
        await guest.createConnection(
          session.sessionId,
          session.secret,
          ["tables:read"],
          Date.now() + 20_000,
        ),
      )
    : null;
  if (shortExpiry) assert(expiring);
  return {
    bindings,
    guest,
    table,
    guestId,
    tableId,
    tableObjectId: String(bindings.TABLES.idFromName(tableId)),
    guestObjectId: String(bindings.GUESTS.idFromName(guestId)),
    session,
    connection,
    actor,
    invite: invite.value,
    expiring,
    inbox: created.value.ownInboxUri,
  };
}

async function browserDelete(worker, fixture, session) {
  const sessionCookie = `__Host-agent_table_session=v1.${fixture.guestId}.${session.sessionId}.${session.secret}`;
  const first = await worker.fetch(
    new Request(`${ORIGIN}/guest/delete?table_id=${fixture.tableId}`, {
      headers: { Cookie: sessionCookie },
    }),
  );
  assert.equal(first.status, 200);
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(
    await first.text(),
  )?.[1];
  const csrfCookie = first.headers.get("Set-Cookie")?.split(";")[0];
  assert(csrf && csrfCookie);
  assert.equal(csrfCookie.split("=")[1], csrf);
  const cookie = `${sessionCookie}; ${csrfCookie}`;
  const headers = {
    Cookie: cookie,
    Origin: ORIGIN,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const pending = await worker.fetch(
    new Request(`${ORIGIN}/guest/delete`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: new URLSearchParams({
        table_id: fixture.tableId,
        csrf,
        decision: "request",
      }),
    }),
  );
  assert.equal(pending.status, 303, await pending.clone().text());
  const confirmation = new URL(pending.headers.get("Location"), ORIGIN);
  assert.equal(confirmation.origin, ORIGIN);
  const preview = await worker.fetch(
    new Request(confirmation, { headers: { Cookie: cookie } }),
  );
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Permanently delete shared content/);
  const approved = await worker.fetch(
    new Request(`${ORIGIN}/guest/delete`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: new URLSearchParams({
        table_id: fixture.tableId,
        request_id: confirmation.searchParams.get("request_id"),
        csrf,
        decision: "approve",
      }),
    }),
  );
  assert.equal(approved.status, 200);
  assert.match(await approved.text(), /Deletion committed/);
}

async function assertRestoredDenial(mf, fixture) {
  const bindings = await mf.getBindings(candidate.name);
  const guest = bindings.GUESTS.get(
    bindings.GUESTS.idFromName(fixture.guestId),
  );
  const table = bindings.TABLES.get(
    bindings.TABLES.idFromName(fixture.tableId),
  );
  const worker = await mf.getWorker(candidate.name);
  const cookie = `__Host-agent_table_session=v1.${fixture.guestId}.${fixture.session.sessionId}.${fixture.session.secret}`;
  for (const path of [
    "/health",
    "/guest/me",
    "/guest/connections",
    `/guest/table?table_id=${fixture.tableId}`,
    "/mcp",
    "/oauth/token",
  ]) {
    const response = await worker.fetch(
      new Request(new URL(path, ORIGIN), {
        method: path === "/mcp" || path === "/oauth/token" ? "POST" : "GET",
        headers: { Cookie: cookie },
      }),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert(!(await response.text()).includes(PRIVATE_BODY));
  }
  assert.equal(
    await guest.validateSession(
      fixture.session.sessionId,
      fixture.session.secret,
    ),
    null,
  );
  assert.equal(
    (
      await guest.authorizeConnection(
        fixture.guestId,
        fixture.connection.connectionId,
        "tables:read",
      )
    ).allowed,
    false,
  );
  assert.equal(
    (
      await guest.authorizeConnection(
        fixture.guestId,
        fixture.expiring.connectionId,
        "tables:read",
      )
    ).allowed,
    false,
  );
  assert.deepEqual(
    plain(await table.readMessages(fixture.actor("tables:read"), {})),
    { ok: false, code: "TABLE_NOT_FOUND" },
  );
  assert.deepEqual(
    plain(
      await table.postMessage(fixture.actor("tables:write"), {
        request_id: "restored_forbidden_message_0001",
        body: "Must never persist",
      }),
    ),
    { ok: false, code: "TABLE_NOT_FOUND" },
  );
  assert.equal(
    (
      await table.issueInvite(
        fixture.actor("tables:write"),
        "restored_forbidden_invite_0001",
      )
    ).ok,
    false,
  );
  const filter = { resourceSubscriptions: [fixture.inbox] };
  assert.deepEqual(
    plain(
      await table.checkInboxSubscription(
        fixture.actor("events:subscribe"),
        filter,
        Date.now() + 30_000,
      ),
    ),
    { ok: false, code: "TEMPORARILY_UNAVAILABLE" },
  );
  assert.deepEqual(
    plain(
      await table.openInboxHintStream(
        fixture.actor("events:subscribe"),
        filter,
        Date.now() + 30_000,
      ),
    ),
    { ok: false, code: "TEMPORARILY_UNAVAILABLE" },
  );
}

test("an actual SQLite snapshot predating revocation, browser deletion and expiry never restores access", {
  timeout: 60_000,
}, async () => {
  const persistence = join(directory, "snapshot-target");
  const snapshotA = join(directory, "independent-snapshot-A");
  const observationsPath = join(directory, "post-snapshot-observations.json");
  const outbound = [];
  let mf;
  try {
    mf = runtime(persistence, false, outbound);
    const fixture = await seed(mf, { shortExpiry: true });
    const eventId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const [member] = await sql(
      mf,
      "TableDO",
      fixture.tableId,
      "SELECT membership_id FROM table_memberships",
    );
    const [message] = await sql(
      mf,
      "TableDO",
      fixture.tableId,
      "SELECT message_id FROM table_messages",
    );
    await sql(
      mf,
      "TableDO",
      fixture.tableId,
      `INSERT INTO table_event_subscriptions
      (membership_id, generation, fence, status, guest_id, connection_id, subscription_id, callback_url, secret_envelope, expires_at)
      VALUES (?, 1, 1, 'active', ?, ?, ?, ?, ?, ?)`,
      member.membership_id,
      fixture.guestId,
      fixture.connection.connectionId,
      subscriptionId,
      "https://callbacks.invalid/never-send",
      "synthetic-unreadable-envelope",
      fixture.expiring.expiresAt,
    );
    await sql(
      mf,
      "TableDO",
      fixture.tableId,
      `INSERT INTO table_event_outbox
      (event_id, message_id, message_seq, recipient_membership_id, subscription_id, subscription_generation, status, attempt_count, next_attempt_at, created_at, expires_at)
      VALUES (?, ?, 1, ?, ?, 1, 'pending', 0, ?, ?, ?)`,
      eventId,
      message.message_id,
      member.membership_id,
      subscriptionId,
      Date.now() - 1_000,
      Date.now(),
      fixture.expiring.expiresAt,
    );
    const outboxSql =
      "SELECT event_id, status, attempt_count, next_attempt_at, expires_at, lease_token, lease_deadline FROM table_event_outbox";
    const pendingOutbox = await sql(mf, "TableDO", fixture.tableId, outboxSql);
    await fixture.bindings.OAUTH_KV.put(
      "synthetic-pre-snapshot-token",
      "synthetic-private-oauth-state",
    );
    const schema = await fixture.table.schemaVersion();
    await mf.dispose();
    mf = undefined;
    assert(
      Date.now() < fixture.expiring.expiresAt,
      "Snapshot must precede the actual expiry deadline",
    );
    await cp(persistence, snapshotA, { recursive: true, errorOnExist: true });
    const savedDigest = await filesDigest(snapshotA);
    assert.deepEqual(await filesDigest(persistence), savedDigest);
    assert(
      Date.now() < fixture.expiring.expiresAt,
      "Snapshot copy must complete before expiry",
    );
    assert(
      savedDigest.some(([path]) => path.endsWith(".sqlite")),
      "Snapshot must contain real SQLite files",
    );

    mf = runtime(persistence, false, outbound);
    const current = await mf.getBindings(candidate.name);
    const guest = current.GUESTS.get(
      current.GUESTS.idFromName(fixture.guestId),
    );
    const revoked = plain(
      await guest.revokeConnection(
        fixture.session.sessionId,
        fixture.session.secret,
        fixture.connection.connectionId,
      ),
    );
    assert.equal(revoked.status, "revoked");
    assert.equal(
      (
        await guest.authorizeConnection(
          fixture.guestId,
          fixture.connection.connectionId,
          "tables:read",
        )
      ).allowed,
      false,
    );
    assert.equal(
      await guest.validateSession(
        fixture.session.sessionId,
        fixture.session.secret,
      ),
      null,
    );
    await browserDelete(
      await mf.getWorker(candidate.name),
      fixture,
      revoked.session,
    );
    await current.OAUTH_KV.delete("synthetic-pre-snapshot-token");
    const [revokedRow] = await sql(
      mf,
      "GuestDO",
      fixture.guestId,
      "SELECT revoked_at FROM guest_connections WHERE connection_id = ?",
      fixture.connection.connectionId,
    );
    const [invalidatedRow] = await sql(
      mf,
      "GuestDO",
      fixture.guestId,
      "SELECT invalidated_at FROM guest_sessions WHERE session_id = ?",
      fixture.session.sessionId,
    );
    const tombstones = await sql(
      mf,
      "TableDO",
      fixture.tableId,
      "SELECT terminal_state FROM table_tombstones",
    );
    assert.equal(typeof revokedRow.revoked_at, "number");
    assert.equal(typeof invalidatedRow.invalidated_at, "number");
    assert.deepEqual(tombstones, [{ terminal_state: "deleted" }]);
    assert.deepEqual(
      await sql(
        mf,
        "TableDO",
        fixture.tableId,
        "SELECT body FROM table_messages",
      ),
      [],
    );
    assert.deepEqual(
      await sql(
        mf,
        "TableDO",
        fixture.tableId,
        "SELECT invite_id FROM table_invitations",
      ),
      [],
    );
    await delay(Math.max(0, fixture.expiring.expiresAt - Date.now() + 30));
    const expiryDecision = plain(
      await guest.authorizeConnection(
        fixture.guestId,
        fixture.expiring.connectionId,
        "tables:read",
      ),
    );
    assert.equal(expiryDecision.allowed, false);
    assert(["expired", "missing"].includes(expiryDecision.reason));
    const expiryRows = await sql(
      mf,
      "GuestDO",
      fixture.guestId,
      "SELECT expires_at FROM guest_connections WHERE connection_id = ?",
      fixture.expiring.connectionId,
    );
    assert(expiryRows.length === 0 || expiryRows[0].expires_at <= Date.now());
    const observations = JSON.stringify({
      source: "separate-live-local-runtime",
      observedAt: Date.now(),
      guestId: fixture.guestId,
      tableId: fixture.tableId,
      schema,
      revokedAt: revokedRow.revoked_at,
      oldSessionInvalidatedAt: invalidatedRow.invalidated_at,
      tombstones,
      expiredGrant: {
        connectionId: fixture.expiring.connectionId,
        deadline: fixture.expiring.expiresAt,
        decision: expiryDecision,
        rows: expiryRows,
      },
    });
    await writeFile(observationsPath, observations, {
      flag: "wx",
      mode: 0o600,
    });
    const observationDigest = sha256(observations);
    await mf.dispose();
    mf = undefined;
    assert.notDeepEqual(await filesDigest(persistence), savedDigest);

    // Restore bytes to the same namespace identities and physical target path.
    // Post-snapshot observations remain outside the restored directory.
    await rm(persistence, { recursive: true });
    await cp(snapshotA, persistence, { recursive: true, errorOnExist: true });
    assert.deepEqual(await filesDigest(persistence), savedDigest);
    assert.equal(sha256(await readFile(observationsPath)), observationDigest);
    assert.equal(candidate.vars.RESTORE_QUARANTINE, "true");
    const restoredAt = Date.now();
    mf = runtime(persistence, true, outbound);
    await assertRestoredDenial(mf, fixture);
    assert.deepEqual(
      await sql(
        mf,
        "GuestDO",
        fixture.guestId,
        "SELECT revoked_at FROM guest_connections WHERE connection_id = ?",
        fixture.connection.connectionId,
      ),
      [{ revoked_at: null }],
    );
    assert.deepEqual(
      await sql(
        mf,
        "GuestDO",
        fixture.guestId,
        "SELECT invalidated_at FROM guest_sessions WHERE session_id = ?",
        fixture.session.sessionId,
      ),
      [{ invalidated_at: null }],
    );
    assert.deepEqual(
      await sql(
        mf,
        "TableDO",
        fixture.tableId,
        "SELECT body FROM table_messages",
      ),
      [{ body: PRIVATE_BODY }],
    );
    assert.deepEqual(
      await sql(
        mf,
        "TableDO",
        fixture.tableId,
        "SELECT terminal_state FROM table_tombstones",
      ),
      [],
    );
    assert.deepEqual(
      await sql(
        mf,
        "TableDO",
        fixture.tableId,
        "SELECT invite_id FROM table_invitations",
      ),
      [{ invite_id: fixture.invite.inviteId }],
    );
    assert.deepEqual(
      await sql(mf, "TableDO", fixture.tableId, outboxSql),
      pendingOutbox,
    );
    assert.equal(
      await (await mf.getBindings(candidate.name)).OAUTH_KV.get(
        "synthetic-pre-snapshot-token",
      ),
      "synthetic-private-oauth-state",
    );
    // Expired records and due outbox work survive reconstruction untouched.
    // Actual handler invocation is covered by the generated-runtime suite;
    // waiting here would not prove that a six-hour parked alarm executed.
    assert.deepEqual(
      await sql(mf, "TableDO", fixture.tableId, outboxSql),
      pendingOutbox,
    );
    assert.deepEqual(
      await sql(
        mf,
        "GuestDO",
        fixture.guestId,
        "SELECT expires_at FROM guest_connections WHERE connection_id = ?",
        fixture.expiring.connectionId,
      ),
      [{ expires_at: fixture.expiring.expiresAt }],
    );
    assert.deepEqual(outbound, []);
    await mf.dispose();
    mf = undefined;
    const retained = await canonicalDatabases(persistence);
    assert.equal(Object.keys(retained).length, 2);
    const alarms = await alarmDeadlines(persistence);
    for (const id of [fixture.tableObjectId, fixture.guestObjectId]) {
      const alarm = alarms.find((row) => row.id === id);
      assert(alarm, "Restored object must retain a durable alarm");
      assert(alarm.scheduledAt >= restoredAt + 6 * 60 * 60_000);
      assert(alarm.scheduledAt <= Date.now() + 6 * 60 * 60_000);
    }
    mf = runtime(persistence, true, outbound);
    await assertRestoredDenial(mf, fixture);
    assert.deepEqual(outbound, []);
    await mf.dispose();
    mf = undefined;
    assert.deepEqual(await canonicalDatabases(persistence), retained);
    assert.equal(sha256(await readFile(observationsPath)), observationDigest);
    assert.deepEqual(await filesDigest(snapshotA), savedDigest);
  } finally {
    await mf?.dispose();
  }
});

test("an older Worker refuses a newer stored SQL schema through repeated reconstruction without erasure", {
  timeout: 30_000,
}, async () => {
  const persistence = join(directory, "future-schema-target");
  const outbound = [];
  let mf;
  let phase = "seed";
  try {
    mf = runtime(persistence, false, outbound);
    const fixture = await seed(mf);
    const supported = Number(await fixture.table.schemaVersion());
    assert.equal(await fixture.guest.schemaVersion(), supported);
    for (const [component, id] of [
      ["TableDO", fixture.tableId],
      ["GuestDO", fixture.guestId],
    ]) {
      phase = `create future sentinel ${component}`;
      await sql(
        mf,
        component,
        id,
        "CREATE TABLE future_private_sentinel (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
      );
      await sql(
        mf,
        component,
        id,
        "INSERT INTO future_private_sentinel VALUES (1, ?)",
        "Synthetic unknown future-schema private content",
      );
      phase = `upgrade schema ${component}`;
      // The inspector may reconstruct immediately after the committed write.
      // Stored SQL below independently proves the upgrade even in that case.
      await sql(
        mf,
        component,
        id,
        "UPDATE __agent_table_schema SET version = ? WHERE singleton = 1",
        supported + 1,
      ).catch((error) => {
        assert.match(error.message, /newer than supported/);
      });
    }
    phase = "dispose upgraded runtime";
    await mf.dispose();
    mf = undefined;
    phase = "read canonical upgraded disk";
    const retained = await canonicalDatabases(persistence);
    assert.equal(Object.keys(retained).length, 2);
    for (const tables of Object.values(retained)) {
      assert.equal(
        tables.find(({ name }) => name === "__agent_table_schema").rows[0]
          .version,
        supported + 1,
      );
      assert.equal(
        tables.find(({ name }) => name === "future_private_sentinel").rows
          .length,
        1,
      );
    }
    for (let reconstruction = 0; reconstruction < 2; reconstruction++) {
      mf = runtime(persistence, true, outbound);
      phase = "read bindings after reconstruction";
      const bindings = await mf.getBindings(candidate.name);
      for (const [binding, id] of [
        [bindings.TABLES, fixture.tableId],
        [bindings.GUESTS, fixture.guestId],
      ]) {
        phase = "assert unsupported schema refusal";
        await assert.rejects(
          async () => binding.get(binding.idFromName(id)).schemaVersion(),
          /newer than supported/,
        );
      }
      phase = "worker denial";
      const response = await (await mf.getWorker(candidate.name)).fetch(
        new Request(`${ORIGIN}/guest/table?table_id=${fixture.tableId}`),
      );
      assert.equal(response.status, 503);
      assert(!(await response.text()).includes(PRIVATE_BODY));
      phase = "dispose upgraded runtime";
      await mf.dispose();
      mf = undefined;
      assert.deepEqual(await canonicalDatabases(persistence), retained);
      assert.deepEqual(outbound, []);
    }
  } catch (error) {
    throw new Error(`Unexpected failure during ${phase}: ${error.message}`, {
      cause: error,
    });
  } finally {
    await mf?.dispose();
  }
});
