import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { APPLICATION_SCHEMA_VERSION } from "../../schema/migrations";
import { OAuthTokenDO } from "../../src/auth/token-do";
import { GuestDO } from "../../src/objects/guest";
import { TableDO } from "../../src/objects/table";
import type { ConnectionScope } from "../../src/shared/auth";
import { RESTORE_QUARANTINE_RECHECK_MS } from "../../src/shared/release-quarantine";
import generatedRestore from "../fixtures/quarantined-restore-generated.json";

const quarantined: Env = {
  ...env,
  ...generatedRestore.vars,
  // Keep the ordinary staging inspector configured to prove quarantine wins.
  PUBLIC_ORIGIN: "https://agent-table-test.outliner-online.com",
  STAGING_EVIDENCE_MODE: "read-only",
};

const guestTables = [
  "guest_identity",
  "guest_sessions",
  "guest_connections",
  "guest_creation_reservations",
] as const;
const tableTables = [
  "table_metadata",
  "table_memberships",
  "table_messages",
  "table_delete_confirmations",
  "table_event_subscriptions",
  "table_event_candidates",
] as const;

function rows(storage: DurableObjectStorage, names: readonly string[]) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      storage.sql.exec(`SELECT * FROM ${name} ORDER BY rowid`).toArray(),
    ]),
  );
}

async function owner() {
  const guestId = crypto.randomUUID();
  const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await stub.createSession(guestId);
  const grant = await stub.createConnection(
    session.sessionId,
    session.secret,
    ["tables:read", "tables:write", "tables:delete", "events:subscribe"],
    Date.now() + 60 * 60_000,
  );
  if (!grant) throw new Error("Missing synthetic grant");
  const actor = (scope: ConnectionScope) => ({
    kind: "verified-connection" as const,
    guestId,
    connectionId: grant.connectionId,
    scope,
    expiresAt: grant.expiresAt,
  });
  const credential = {
    guestId,
    sessionId: session.sessionId,
    secret: session.secret,
  };
  return { guestId, stub, session, grant, actor, credential };
}

async function reservation(guest: Awaited<ReturnType<typeof owner>>) {
  const input = {
    request_id: crypto.randomUUID(),
    title: "Private recovery boundary fixture",
  };
  const reserved = await guest.stub.reserveCreation(
    guest.actor("tables:write"),
    input,
  );
  if (!reserved.ok) throw new Error("Missing synthetic reservation");
  const tableId = reserved.reservation.tableId;
  const table = env.TABLES.get(env.TABLES.idFromName(tableId));
  return { input, reserved: reserved.reservation, tableId, table };
}

// These focused boundary regressions construct the real classes over retained
// SQL with explicit bindings. The separate restore-runtime and snapshot tests
// exercise binding installation across actual Worker/DO reconstruction.
describe("restore quarantine at direct Durable Object boundaries", () => {
  it("denies guest authority, private reads, mutations and pruning without changing retained rows", async () => {
    const f = await owner();
    const creation = await reservation(f);
    expect(
      await f.stub.validateSession(f.session.sessionId, f.session.secret),
    ).not.toBeNull();
    expect(
      await f.stub.authorizeConnection(
        f.guestId,
        f.grant.connectionId,
        "tables:read",
      ),
    ).toMatchObject({ allowed: true });

    await runInDurableObject(f.stub, async (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "INSERT INTO guest_sessions VALUES (?, ?, ?, ?, NULL)",
        crypto.randomUUID(),
        "a".repeat(64),
        now - 20_000,
        now - 10_000,
      );
      state.storage.sql.exec(
        `INSERT INTO guest_creation_reservations
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
        crypto.randomUUID(),
        f.guestId,
        "b".repeat(64),
        crypto.randomUUID(),
        now - 30_000,
        now - 20_000,
        now - 10_000,
        now - 30_000,
      );
      const before = rows(state.storage, guestTables);
      const recovery = new GuestDO(state, quarantined);
      expect(recovery.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
      expect(
        await recovery.validateSession(f.session.sessionId, f.session.secret),
      ).toBeNull();
      expect(
        recovery.authorizeConnection(
          f.guestId,
          f.grant.connectionId,
          "tables:read",
        ),
      ).toEqual({ allowed: false, reason: "unavailable" });
      expect(
        await recovery.listConnections(f.session.sessionId, f.session.secret),
      ).toBeNull();
      expect(
        await recovery.rotateSession(f.session.sessionId, f.session.secret),
      ).toBeNull();
      expect(
        await recovery.invalidateSession(f.session.sessionId, f.session.secret),
      ).toBe(false);
      expect(
        await recovery.createConnection(
          f.session.sessionId,
          f.session.secret,
          ["tables:read"],
          now + 60_000,
        ),
      ).toBeNull();
      expect(
        await recovery.revokeConnection(
          f.session.sessionId,
          f.session.secret,
          f.grant.connectionId,
        ),
      ).toEqual({ status: "unauthorized" });
      for (const actor of [f.actor("tables:write"), f.credential]) {
        expect(await recovery.reserveCreation(actor, creation.input)).toEqual({
          ok: false,
          code: "UNAUTHORIZED",
        });
        expect(
          await recovery.getCreationReservation(
            actor,
            creation.input.request_id,
          ),
        ).toEqual({ ok: false, code: "UNAUTHORIZED" });
        expect(
          await recovery.recordCreationOutcome(
            actor,
            creation.input.request_id,
            creation.tableId,
            "initialized",
          ),
        ).toEqual({ ok: false, code: "UNAUTHORIZED" });
      }
      expect(recovery.pruneExpiredSessions()).toBe(0);
      expect(recovery.pruneExpiredReservations()).toBe(0);
      expect(
        await recovery.readEventDiagnostics(f.guestId, f.grant.connectionId),
      ).toBeNull();
      await expect(
        recovery.readStagingEvidence(f.guestId, creation.tableId),
      ).rejects.toThrow("Staging evidence is disabled");
      await recovery.alarm();
      expect(rows(state.storage, guestTables)).toEqual(before);
      expect(await state.storage.getAlarm()).toBeGreaterThan(
        Date.now() + RESTORE_QUARANTINE_RECHECK_MS - 5_000,
      );
    });
  });

  it.each(["true", undefined, "invalid"])(
    "refuses new guest creation when quarantine is %s",
    async (mode) => {
      const guestId = crypto.randomUUID();
      const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
      await runInDurableObject(stub, async (_instance, state) => {
        const recovery = new GuestDO(state, {
          ...quarantined,
          RESTORE_QUARANTINE: mode,
        });
        await expect(recovery.createSession(guestId)).rejects.toThrow(
          "Guest access unavailable during recovery",
        );
        expect(rows(state.storage, guestTables)).toEqual({
          guest_identity: [],
          guest_sessions: [],
          guest_connections: [],
          guest_creation_reservations: [],
        });
      });
    },
  );

  it("blocks initialization even when a separate GuestDO still validates the reservation", async () => {
    const f = await owner();
    const creation = await reservation(f);
    expect(
      await f.stub.getCreationReservation(
        f.actor("tables:write"),
        creation.input.request_id,
      ),
    ).toMatchObject({ ok: true, initializationAllowed: true });
    await runInDurableObject(creation.table, async (_instance, state) => {
      const recovery = new TableDO(state, quarantined);
      for (const actor of [f.actor("tables:write"), f.credential]) {
        expect(
          await recovery.initializeTable(
            actor,
            creation.input,
            creation.reserved,
          ),
        ).toEqual({ ok: false, code: "INVALID_RESERVATION" });
      }
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_metadata")
          .one(),
      ).toEqual({ n: 0 });
    });
  });

  it("hides table metadata and prevents deferred candidate cancellation or deletion mutation", async () => {
    const f = await owner();
    const creation = await reservation(f);
    const created = await creation.table.initializeTable(
      f.actor("tables:write"),
      creation.input,
      creation.reserved,
    );
    if (!created.ok) throw new Error("Missing synthetic table");
    const requestId = crypto.randomUUID();
    expect(
      await creation.table.requestBrowserDeletion(f.credential, requestId),
    ).toMatchObject({ ok: true });
    expect(
      await creation.table.deletionView(f.guestId, requestId),
    ).toMatchObject({
      ok: true,
      value: { state: "pending" },
    });
    expect(await creation.table.lifecycleStatus()).toEqual({
      state: "waiting",
      canDispatch: true,
    });
    await runInDurableObject(creation.table, async (_instance, state) => {
      const membershipId = created.value.ownMembershipId;
      const candidateId = crypto.randomUUID();
      const subscriptionId = crypto.randomUUID();
      state.storage.sql.exec(
        `INSERT INTO table_event_subscriptions
         (membership_id, generation, fence, status) VALUES (?, 0, 1, 'inactive')`,
        membershipId,
      );
      state.storage.sql.exec(
        `INSERT INTO table_event_candidates
         (membership_id, candidate_id, subscription_id, guest_id, connection_id,
          callback_url, secret_envelope, requested_ttl_ms, fence, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
        membershipId,
        candidateId,
        subscriptionId,
        f.guestId,
        f.grant.connectionId,
        "https://callbacks.invalid/never-send",
        "synthetic-encrypted-credential",
        Date.now() + 60_000,
      );
      const before = rows(state.storage, tableTables);
      const recovery = new TableDO(state, quarantined);
      expect(recovery.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
      expect(recovery.lifecycleStatus()).toEqual({
        state: "missing",
        canDispatch: false,
      });
      expect(recovery.deletionView(f.guestId, requestId)).toEqual({
        ok: false,
        code: "NOT_FOUND",
      });
      await expect(
        recovery.readStagingEvidence(creation.tableId, f.guestId),
      ).rejects.toThrow("Staging evidence is disabled");
      expect(
        await recovery.readEventDiagnostics(f.actor("events:subscribe")),
      ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
      await recovery.discardEventCandidate(
        f.actor("events:subscribe"),
        candidateId,
      );
      expect(
        await recovery.resolveDeletion(f.credential, requestId, "approve"),
      ).toEqual({ ok: false, code: "NOT_AUTHORIZED" });
      await recovery.alarm();
      expect(rows(state.storage, tableTables)).toEqual(before);
      expect(await state.storage.getAlarm()).toBeGreaterThan(
        Date.now() + RESTORE_QUARANTINE_RECHECK_MS - 5_000,
      );
    });
  });

  it("refuses direct OAuth token and revocation requests before provider entry", async () => {
    const stub = env.OAUTH_SERIALIZER.get(
      env.OAUTH_SERIALIZER.idFromName(crypto.randomUUID()),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const recovery = new OAuthTokenDO(state, {
        ...quarantined,
        PUBLIC_ORIGIN: "http://localhost:8787",
      });
      await recovery.armRedemptionReadProbe();
      for (const path of ["/oauth/token", "/oauth/revoke"]) {
        const response = await recovery.fetch(
          new Request(`http://localhost:8787${path}`, { method: "POST" }),
        );
        expect(response.status).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
      expect(await recovery.redemptionReadProbeState()).toEqual({
        activeRequests: 0,
        requestArrivals: 0,
        grantReads: 0,
        providerEntries: 0,
      });
      await recovery.clearRedemptionReadProbe();
    });
  });
});
