import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  authorizeGuestConnection,
  type ConnectionScope,
  type VerifiedConnectionActor,
} from "../../src/shared/auth";
import { CREATION_LIMITS, TABLE_LIMITS } from "../../src/shared/limits";
import { parseOwnInboxUri } from "../../src/shared/resources";

const day = 24 * 60 * 60 * 1_000;
const creation = {
  request_id: "initialize_table_request_001",
  title: "Original title with é and emoji 😀",
  purpose: "Preserve  whitespace  and accents é",
  ttl_seconds: CREATION_LIMITS.defaultTtlSeconds,
};

async function makeGuest() {
  const guestId = crypto.randomUUID();
  const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await stub.createSession(guestId);
  const grant = await stub.createConnection(
    session.sessionId,
    session.secret,
    ["tables:read", "tables:write"],
    Date.now() + day,
  );
  if (!grant) throw new Error("Test connection not created");
  async function actor(scope: ConnectionScope) {
    const decision = await authorizeGuestConnection(
      env,
      guestId,
      grant?.connectionId ?? "",
      scope,
    );
    if (!decision.allowed) throw new Error("Missing test grant");
    return decision.actor;
  }
  return { guestId, stub, session, grant, actor };
}

async function makeReservedTable(input: typeof creation = creation) {
  const owner = await makeGuest();
  const write = await owner.actor("tables:write");
  const result = await owner.stub.reserveCreation(write, input);
  if (!result.ok) throw new Error("Test reservation not created");
  const table = env.TABLES.get(
    env.TABLES.idFromName(result.reservation.tableId),
  );
  return { owner, write, table, reservation: result.reservation, input };
}

describe("private TableDO initialization and membership authority", () => {
  it("initializes one waiting table and creator seat from a real durable reservation", async () => {
    const fixture = await makeReservedTable();
    const first = await fixture.table.initializeTable(
      fixture.write,
      fixture.input,
      fixture.reservation,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toMatchObject({
      tableId: fixture.reservation.tableId,
      title: creation.title,
      purpose: creation.purpose,
      state: "waiting",
      createdAt: new Date(fixture.reservation.createdAt).toISOString(),
      expiresAt: new Date(fixture.reservation.expiresAt).toISOString(),
      limits: {
        participants: 2,
        ttlDefaultSeconds: 86_400,
        ttlMinSeconds: 3_600,
        ttlMaxSeconds: 604_800,
        maxMessages: TABLE_LIMITS.maxMessages,
      },
    });
    expect(first.value.memberships).toHaveLength(1);
    expect(first.value.memberships[0]).toMatchObject({
      role: "creator",
      seat: 1,
      membershipId: first.value.ownMembershipId,
    });
    expect(parseOwnInboxUri(first.value.ownInboxUri)).toEqual({
      tableId: fixture.reservation.tableId,
      membershipId: first.value.ownMembershipId,
    });
    expect(JSON.stringify(first)).not.toContain(fixture.owner.guestId);
    expect(JSON.stringify(first)).not.toContain(
      fixture.owner.grant.connectionId,
    );

    await runInDurableObject(fixture.table, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ table_id: string; state: string; last_seq: number }>(
            "SELECT table_id, state, last_seq FROM table_metadata",
          )
          .toArray(),
      ).toEqual([
        {
          table_id: fixture.reservation.tableId,
          state: "waiting",
          last_seq: 0,
        },
      ]);
      expect(
        state.storage.sql
          .exec<{ guest_id: string; seat: number; latest_peer_seq: number }>(
            "SELECT guest_id, seat, latest_peer_seq FROM table_memberships",
          )
          .toArray(),
      ).toEqual([
        { guest_id: fixture.owner.guestId, seat: 1, latest_peer_seq: 0 },
      ]);
    });

    await evictDurableObject(fixture.table);
    expect(
      await fixture.table.initializeTable(
        fixture.write,
        fixture.input,
        fixture.reservation,
      ),
    ).toEqual(first);
    expect(
      await fixture.table.getMetadata(await fixture.owner.actor("tables:read")),
    ).toEqual(first);
    const inbox = await fixture.table.readOwnInbox(
      await fixture.owner.actor("tables:read"),
      first.value.ownInboxUri,
    );
    expect(inbox).toEqual({
      ok: true,
      value: {
        tableId: fixture.reservation.tableId,
        membershipId: first.value.ownMembershipId,
        state: "waiting",
        lastSeq: 0,
        latestPeerSeq: 0,
        expiresAt: first.value.expiresAt,
      },
    });
  });

  it("rejects forged, relocated, expired and changed reservations without writes", async () => {
    const fixture = await makeReservedTable();
    const outsider = await makeGuest();
    const relocated = env.TABLES.get(
      env.TABLES.idFromName(crypto.randomUUID()),
    );
    expect(
      await relocated.initializeTable(
        fixture.write,
        fixture.input,
        fixture.reservation,
      ),
    ).toEqual({ ok: false, code: "INVALID_RESERVATION" });
    expect(
      await fixture.table.initializeTable(
        await outsider.actor("tables:write"),
        fixture.input,
        fixture.reservation,
      ),
    ).toEqual({ ok: false, code: "INVALID_RESERVATION" });
    expect(
      await fixture.table.initializeTable(fixture.write, fixture.input, {
        ...fixture.reservation,
        createdAt: fixture.reservation.createdAt + 1,
      }),
    ).toEqual({ ok: false, code: "INVALID_RESERVATION" });
    expect(
      await fixture.table.initializeTable(
        fixture.write,
        { ...fixture.input, purpose: "Changed purpose" },
        fixture.reservation,
      ),
    ).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      await fixture.table.initializeTable(
        fixture.write,
        { ...fixture.input, ttl_seconds: 3_600 },
        fixture.reservation,
      ),
    ).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      await fixture.table.initializeTable(
        fixture.write,
        { ...fixture.input, sender_id: crypto.randomUUID() },
        fixture.reservation,
      ),
    ).toEqual({ ok: false, code: "INVALID_RESERVATION" });
    await runInDurableObject(fixture.table, async (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
      ).toEqual([]);
    });

    // A retained reservation can no longer authorize a fresh TableDO after
    // its original expiry, despite the still-present operation receipt.
    await runInDurableObject(fixture.owner.stub, async (_instance, state) => {
      const createdAt = Date.now() - 2 * day;
      state.storage.sql.exec(
        `UPDATE guest_creation_reservations
         SET created_at = ?, charged_at = ?, expires_at = ?
         WHERE request_id = ?`,
        createdAt,
        createdAt,
        createdAt + day,
        fixture.input.request_id,
      );
    });
    const persisted = await fixture.owner.stub.getCreationReservation(
      fixture.write,
      fixture.input.request_id,
    );
    expect(persisted.ok && persisted.initializationAllowed).toBe(false);
    // Use the now-authoritative receipt so the test reaches the expiry gate.
    expect(
      await fixture.table.initializeTable(
        fixture.write,
        fixture.input,
        persisted.ok ? persisted.reservation : fixture.reservation,
      ),
    ).toEqual({ ok: false, code: "TABLE_EXPIRED" });
  });

  it("gives unknown and foreign members identical non-disclosing failures", async () => {
    const owner = await makeGuest();
    const stranger = await makeGuest();
    const unknown = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    const ownerRead = await owner.actor("tables:read");
    expect(await unknown.getMetadata(ownerRead)).toEqual({
      ok: false,
      code: "TABLE_NOT_FOUND",
    });
    await runInDurableObject(unknown, async (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
      ).toEqual([]);
    });

    const fixture = await makeReservedTable();
    const initialized = await fixture.table.initializeTable(
      fixture.write,
      fixture.input,
      fixture.reservation,
    );
    if (!initialized.ok) throw new Error("Table not initialized");
    const strangerRead = await stranger.actor("tables:read");
    const spoof: VerifiedConnectionActor = {
      ...strangerRead,
      guestId: fixture.owner.guestId,
    };
    const parallel = await Promise.all([
      fixture.table.getMetadata(await fixture.owner.actor("tables:read")),
      fixture.table.getMetadata(strangerRead),
      fixture.table.getMetadata(spoof),
    ]);
    expect(parallel[0].ok).toBe(true);
    expect(parallel.slice(1)).toEqual([
      { ok: false, code: "TABLE_NOT_FOUND" },
      { ok: false, code: "TABLE_NOT_FOUND" },
    ]);
    for (const inbox of [
      initialized.value.ownInboxUri,
      `${initialized.value.ownInboxUri}?unsafe=1`,
      `agent-table://tables/${fixture.reservation.tableId}/inbox/${crypto.randomUUID()}`,
    ]) {
      expect(await fixture.table.readOwnInbox(strangerRead, inbox)).toEqual({
        ok: false,
        code: "TABLE_NOT_FOUND",
      });
    }
    expect(
      await fixture.table.readOwnInbox(
        await fixture.owner.actor("tables:read"),
        `${initialized.value.ownInboxUri}?unsafe=1`,
      ),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    expect(
      (await exports.default.fetch("http://localhost:8787/internal/tables"))
        .status,
    ).toBe(404);

    const authorizedBeforeRevocation = await fixture.owner.actor("tables:read");
    const revoked = await fixture.owner.stub.revokeConnection(
      fixture.owner.session.sessionId,
      fixture.owner.session.secret,
      fixture.owner.grant.connectionId,
    );
    expect(revoked.status).toBe("revoked");
    expect(await fixture.table.getMetadata(authorizedBeforeRevocation)).toEqual(
      {
        ok: false,
        code: "TABLE_NOT_FOUND",
      },
    );
  });

  it("only exposes a member's own inbox when a second membership exists", async () => {
    const fixture = await makeReservedTable();
    const second = await makeGuest();
    const first = await fixture.table.initializeTable(
      fixture.write,
      fixture.input,
      fixture.reservation,
    );
    if (!first.ok) throw new Error("Missing first seat");
    const secondMembershipId = crypto.randomUUID();

    // This is a downstream-invitation fixture, not a second-seat producer.
    await runInDurableObject(fixture.table, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO table_memberships
         (membership_id, table_id, guest_id, seat, role, joined_at, latest_peer_seq)
         VALUES (?, ?, ?, 2, 'invitee', ?, 0)`,
        secondMembershipId,
        fixture.reservation.tableId,
        second.guestId,
        Date.now(),
      );
      state.storage.sql.exec(
        "UPDATE table_metadata SET state = 'open' WHERE singleton = 1",
      );
    });
    const secondMetadata = await fixture.table.getMetadata(
      await second.actor("tables:read"),
    );
    expect(secondMetadata.ok).toBe(true);
    if (!secondMetadata.ok) return;
    expect(secondMetadata.value.memberships).toHaveLength(2);
    expect(secondMetadata.value.ownMembershipId).toBe(secondMembershipId);
    expect(secondMetadata.value.ownInboxUri).not.toBe(first.value.ownInboxUri);
    expect(JSON.stringify(secondMetadata)).not.toContain(fixture.owner.guestId);
    expect(
      await fixture.table.readOwnInbox(
        await second.actor("tables:read"),
        first.value.ownInboxUri,
      ),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
    const own = await fixture.table.readOwnInbox(
      await second.actor("tables:read"),
      secondMetadata.value.ownInboxUri,
    );
    expect(own).toMatchObject({
      ok: true,
      value: { membershipId: secondMembershipId, lastSeq: 0, latestPeerSeq: 0 },
    });
  });

  it("refuses later initialization over terminal state and expiry", async () => {
    const fixture = await makeReservedTable();
    expect(
      (
        await fixture.table.initializeTable(
          fixture.write,
          fixture.input,
          fixture.reservation,
        )
      ).ok,
    ).toBe(true);
    await runInDurableObject(fixture.table, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE table_metadata SET state = 'closed', closed_at = ? WHERE singleton = 1",
        Date.now(),
      );
    });
    expect(
      await fixture.table.initializeTable(
        fixture.write,
        fixture.input,
        fixture.reservation,
      ),
    ).toEqual({ ok: false, code: "TABLE_TERMINAL" });
    const closed = await fixture.table.getMetadata(
      await fixture.owner.actor("tables:read"),
    );
    expect(closed.ok && closed.value.state).toBe("closed");
    await runInDurableObject(fixture.table, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE table_metadata SET state = 'deleted', deleted_at = ? WHERE singleton = 1",
        Date.now(),
      );
    });
    expect(
      await fixture.table.getMetadata(await fixture.owner.actor("tables:read")),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });

    const fresh = await makeReservedTable({
      ...creation,
      request_id: "initialize_table_request_002",
    });
    const started = await fresh.table.initializeTable(
      fresh.write,
      fresh.input,
      fresh.reservation,
    );
    if (!started.ok) throw new Error("Second table not initialized");
    await runInDurableObject(fresh.table, async (_instance, state) => {
      const createdAt = Date.now() - 2 * day;
      state.storage.sql.exec(
        "UPDATE table_metadata SET created_at = ?, expires_at = ? WHERE singleton = 1",
        createdAt,
        createdAt + day,
      );
    });
    expect(
      await fresh.table.getMetadata(await fresh.owner.actor("tables:read")),
    ).toEqual({ ok: false, code: "TABLE_EXPIRED" });
  });
});
