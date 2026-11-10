import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/auth/guest";
import { RESTORE_QUARANTINE_RECHECK_MS } from "../../src/shared/release-quarantine";
import generatedRestore from "../fixtures/quarantined-restore-generated.json";

describe("generated restore configuration in a constructed Workerd/DO runtime", () => {
  it("installs the generated quarantine mode in the actual Worker and reconstructed Durable Objects", async () => {
    expect(env.RELEASE_ENVIRONMENT).toBe(
      generatedRestore.vars.RELEASE_ENVIRONMENT,
    );
    expect(env.RESTORE_QUARANTINE).toBe("true");
    expect(env.ALLOW_OUTBOUND_NOTIFICATIONS).toBe("false");

    const guestId = crypto.randomUUID();
    const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    const session = await guest.createSession(guestId);
    expect(session.sessionId).toBeTruthy();
    const tableId = crypto.randomUUID();
    const table = env.TABLES.get(env.TABLES.idFromName(tableId));

    await runInDurableObject(table, async (_instance, state) => {
      // Simulate persisted, older private data independently of the restored
      // runtime's public request handler. Do not derive clearance from it.
      state.storage.sql.exec(
        `INSERT INTO table_metadata
         (singleton, table_id, creation_request_id, request_digest,
          creator_guest_id, title, purpose, state, created_at, expires_at,
          closed_at, deleted_at, last_seq)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
        tableId,
        "synthetic_pre_snapshot_request_001",
        "a".repeat(64),
        guestId,
        "Synthetic retained table",
        null,
        "waiting",
        Date.now() - 48 * 60 * 60_000,
        Date.now() - 24 * 60 * 60_000,
      );
    });
    await runInDurableObject(guest, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_sessions SET created_at = ?, expires_at = ? WHERE session_id = ?",
        Date.now() - 48 * 60 * 60_000,
        Date.now() - 24 * 60 * 60_000,
        session.sessionId,
      );
    });

    await evictDurableObject(table);
    await evictDurableObject(guest);

    for (const endpoint of [
      "/health",
      "/guest/me",
      "/guest/connections",
      "/mcp",
      "/oauth/token",
    ]) {
      const response = await SELF.fetch(`http://localhost:8787${endpoint}`, {
        method:
          endpoint === "/mcp" || endpoint === "/oauth/token" ? "POST" : "GET",
      });
      expect(response.status).toBe(503);
    }

    // No test-only instance.env substitution: the constructors must use the
    // same generated settings as the Worker entry.
    await runInDurableObject(table, async (instance, state) => {
      await instance.alarm();
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_metadata")
          .one(),
      ).toEqual({ n: 1 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_tombstones")
          .one(),
      ).toEqual({ n: 0 });
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThan(
        Date.now() + RESTORE_QUARANTINE_RECHECK_MS - 5_000,
      );
    });
    await runInDurableObject(guest, async (instance, state) => {
      await instance.alarm();
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM guest_sessions")
          .one(),
      ).toEqual({ n: 1 });
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThan(
        Date.now() + RESTORE_QUARANTINE_RECHECK_MS - 5_000,
      );
    });
  });
});

describe("unreconciled older snapshot in the generated quarantine runtime", () => {
  it("refuses a seemingly valid old owner session without erasing its private transcript", async () => {
    const guestId = crypto.randomUUID();
    const tableId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    const table = env.TABLES.get(env.TABLES.idFromName(tableId));
    const session = await guest.createSession(guestId);
    const now = Date.now();
    const privateBody = "Synthetic message retained from before restore";
    await runInDurableObject(table, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO table_metadata
         (singleton, table_id, creation_request_id, request_digest,
          creator_guest_id, title, purpose, state, created_at, expires_at,
          closed_at, deleted_at, last_seq)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1)`,
        tableId,
        "synthetic_old_accepted_request_0001",
        "b".repeat(64),
        guestId,
        "Unreconciled private conversation",
        null,
        "open",
        now - 60_000,
        now + 60 * 60_000,
      );
      state.storage.sql.exec(
        `INSERT INTO table_memberships
         (membership_id, table_id, guest_id, seat, role, joined_at, latest_peer_seq)
         VALUES (?, ?, ?, 1, 'creator', ?, 0)`,
        membershipId,
        tableId,
        guestId,
        now - 60_000,
      );
      state.storage.sql.exec(
        `INSERT INTO table_messages
         (seq, message_id, sender_membership_id, body, body_bytes, created_at, reply_to_message_id)
         VALUES (1, ?, ?, ?, ?, ?, NULL)`,
        crypto.randomUUID(),
        membershipId,
        privateBody,
        new TextEncoder().encode(privateBody).byteLength,
        now - 30_000,
      );
    });
    const cookie = `${SESSION_COOKIE_NAME}=v1.${guestId}.${session.sessionId}.${session.secret}`;
    const path = `/guest/table?table_id=${tableId}`;

    // These saved records could be stale after deletion or revocation not
    // represented in the snapshot. They must never authorize clearance.
    await evictDurableObject(table);
    await evictDurableObject(guest);
    for (const endpoint of [path, "/guest/connections", "/mcp"]) {
      const response = await SELF.fetch(`http://localhost:8787${endpoint}`, {
        method: endpoint === "/mcp" ? "POST" : "GET",
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).not.toContain(privateBody);
    }
    await runInDurableObject(table, async (instance, state) => {
      await instance.alarm();
      expect(
        state.storage.sql
          .exec<{ body: string }>("SELECT body FROM table_messages")
          .one().body,
      ).toBe(privateBody);
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_memberships")
          .one(),
      ).toEqual({ n: 1 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_tombstones")
          .one(),
      ).toEqual({ n: 0 });
    });
    await runInDurableObject(guest, async (instance, state) => {
      await instance.alarm();
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM guest_sessions")
          .one(),
      ).toEqual({ n: 1 });
    });
  });
});
