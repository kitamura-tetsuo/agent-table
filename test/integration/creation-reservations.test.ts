import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  authorizeGuestConnection,
  type VerifiedConnectionActor,
} from "../../src/shared/auth";
import {
  creationRequestDigest,
  parseCreationRequest,
} from "../../src/shared/creation";
import { CREATION_LIMITS } from "../../src/shared/limits";

const hour = 60 * 60 * 1_000;
const day = 24 * hour;

function key(index: number): string {
  return `creation_${String(index).padStart(16, "0")}`;
}

function request(index: number, overrides: Record<string, unknown> = {}) {
  return {
    request_id: key(index),
    title: `Unmodified title ${index}`,
    purpose: "Keep this text exactly as supplied: é / é",
    ...overrides,
  };
}

async function createGuest() {
  const guestId = crypto.randomUUID();
  const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await stub.createSession(guestId);
  const grant = await stub.createConnection(
    session.sessionId,
    session.secret,
    ["tables:write"],
    Date.now() + day,
  );
  if (!grant) throw new Error("Failed to create test grant");
  const decision = await authorizeGuestConnection(
    env,
    guestId,
    grant.connectionId,
    "tables:write",
  );
  if (!decision.allowed) throw new Error("Test grant was not authorized");
  return { guestId, stub, actor: decision.actor, session, grant };
}

describe("GuestDO creation reservation authority and durability", () => {
  it("uses exact Unicode text, validated defaults and canonical key ordering", async () => {
    const guest = await createGuest();
    const created = await guest.stub.reserveCreation(guest.actor, request(1));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = created.reservation;
    expect(row.outcome).toBe("reserved");
    expect(row.expiresAt - row.createdAt).toBe(day);
    expect(row.retentionUntil - row.createdAt).toBe(8 * day);
    expect(row.chargedAt).toBe(row.createdAt);
    expect(row.tableId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.requestDigest).toMatch(/^[0-9a-f]{64}$/);

    const sameWithReorderedKeys = {
      purpose: request(1).purpose,
      title: request(1).title,
      request_id: key(1),
      ttl_seconds: 86_400,
    };
    expect(
      await guest.stub.reserveCreation(guest.actor, sameWithReorderedKeys),
    ).toEqual(created);
    const parsed = parseCreationRequest(sameWithReorderedKeys);
    expect(await creationRequestDigest(parsed.arguments)).toBe(
      row.requestDigest,
    );

    const changed = await guest.stub.reserveCreation(
      guest.actor,
      request(1, { purpose: "Keep this text exactly as supplied: é / é" }),
    );
    expect(changed).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      await guest.stub.reserveCreation(
        guest.actor,
        request(1, { ttl_seconds: 3_600 }),
      ),
    ).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });

    await runInDurableObject(guest.stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ table_id: string; request_digest: string }>(
          "SELECT table_id, request_digest FROM guest_creation_reservations",
        )
        .toArray();
      expect(rows).toEqual([
        { table_id: row.tableId, request_digest: row.requestDigest },
      ]);
    });
  });

  it("enforces request IDs, code-point boundaries and bounded TTL", async () => {
    const guest = await createGuest();
    for (const invalid of [
      request(2, { request_id: "too-short" }),
      request(2, { request_id: "a".repeat(129) }),
      request(2, { request_id: "é".repeat(16) }),
      request(2, { title: "   " }),
      request(2, { title: "😀".repeat(121) }),
      request(2, { title: "\ud800" }),
      request(2, { purpose: "😀".repeat(2_001) }),
      request(2, { ttl_seconds: 3_599 }),
      request(2, { ttl_seconds: 604_801 }),
      request(2, { ttl_seconds: 3_600.5 }),
      request(2, { unexpected: "unsafe" }),
      { title: "Missing ID" },
    ]) {
      expect(await guest.stub.reserveCreation(guest.actor, invalid)).toEqual({
        ok: false,
        code: "INVALID_REQUEST",
      });
    }
    const min = await guest.stub.reserveCreation(
      guest.actor,
      request(3, { title: "😀".repeat(120), ttl_seconds: 3_600 }),
    );
    const max = await guest.stub.reserveCreation(
      guest.actor,
      request(4, { purpose: "😀".repeat(2_000), ttl_seconds: 604_800 }),
    );
    expect(
      min.ok && min.reservation.expiresAt - min.reservation.createdAt,
    ).toBe(hour);
    expect(
      max.ok && max.reservation.expiresAt - max.reservation.createdAt,
    ).toBe(7 * day);
  });

  it("rechecks the owning write grant and exposes no public reservation route", async () => {
    const owner = await createGuest();
    const outsider = await createGuest();
    expect(
      await owner.stub.reserveCreation(outsider.actor, request(5)),
    ).toEqual({ ok: false, code: "UNAUTHORIZED" });
    const readOnly: VerifiedConnectionActor = {
      ...owner.actor,
      scope: "tables:read",
    };
    expect(await owner.stub.reserveCreation(readOnly, request(5))).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });

    const stored = await owner.stub.reserveCreation(owner.actor, request(5));
    expect(stored.ok).toBe(true);
    expect(
      await owner.stub.getCreationReservation(outsider.actor, key(5)),
    ).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    const revoked = await owner.stub.revokeConnection(
      owner.session.sessionId,
      owner.session.secret,
      owner.grant.connectionId,
    );
    expect(revoked.status).toBe("revoked");
    expect(await owner.stub.reserveCreation(owner.actor, request(5))).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    expect(
      await owner.stub.getCreationReservation(owner.actor, key(5)),
    ).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    expect(
      (
        await exports.default.fetch(
          "http://localhost:8787/internal/reservations",
        )
      ).status,
    ).toBe(404);
  });

  it("recovers a lost response and retained receipt after object reconstruction", async () => {
    const guest = await createGuest();
    const first = await guest.stub.reserveCreation(guest.actor, request(6));
    expect(first.ok).toBe(true);
    await evictDurableObject(guest.stub);
    expect(await guest.stub.reserveCreation(guest.actor, request(6))).toEqual(
      first,
    );
    if (!first.ok) return;

    const result = await guest.stub.recordCreationOutcome(
      guest.actor,
      key(6),
      first.reservation.tableId,
      "initialized",
    );
    expect(result.ok && result.reservation.outcome).toBe("initialized");
    expect(
      await guest.stub.recordCreationOutcome(
        guest.actor,
        key(6),
        first.reservation.tableId,
        "initialized",
      ),
    ).toEqual(result);
    expect(
      await guest.stub.recordCreationOutcome(
        guest.actor,
        key(6),
        first.reservation.tableId,
        "failed",
      ),
    ).toEqual({ ok: false, code: "OUTCOME_CONFLICT" });
    expect(
      await guest.stub.recordCreationOutcome(
        guest.actor,
        key(6),
        crypto.randomUUID(),
        "initialized",
      ),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    await evictDurableObject(guest.stub);
    expect(
      await guest.stub.getCreationReservation(guest.actor, key(6)),
    ).toEqual({
      ok: true,
      reservation: result.ok ? result.reservation : undefined,
      initializationAllowed: true,
    });
  });

  it("refuses initialization after original expiry and safely prunes past retention", async () => {
    const guest = await createGuest();
    const created = await guest.stub.reserveCreation(guest.actor, request(7));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Advance this persisted fixture's original times without a slow wall clock.
    await runInDurableObject(guest.stub, async (_instance, state) => {
      const createdAt = Date.now() - 2 * day;
      state.storage.sql.exec(
        `UPDATE guest_creation_reservations
         SET created_at = ?, charged_at = ?, expires_at = ?
         WHERE request_id = ?`,
        createdAt,
        createdAt,
        createdAt + day,
        key(7),
      );
    });
    expect(await guest.stub.reserveCreation(guest.actor, request(7))).toEqual({
      ok: false,
      code: "TABLE_EXPIRED",
    });
    const retained = await guest.stub.getCreationReservation(
      guest.actor,
      key(7),
    );
    expect(retained.ok && retained.initializationAllowed).toBe(false);
    expect(
      await guest.stub.recordCreationOutcome(
        guest.actor,
        key(7),
        created.reservation.tableId,
        "initialized",
      ),
    ).toEqual({ ok: false, code: "TABLE_EXPIRED" });

    await runInDurableObject(guest.stub, async (_instance, state) => {
      const createdAt = Date.now() - 8 * day - 1_000;
      state.storage.sql.exec(
        `UPDATE guest_creation_reservations
         SET created_at = ?, charged_at = ?, expires_at = ?, retention_until = ?
         WHERE request_id = ?`,
        createdAt,
        createdAt,
        createdAt + day,
        createdAt + 8 * day,
        key(7),
      );
    });
    expect(
      await guest.stub.getCreationReservation(guest.actor, key(7)),
    ).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await guest.stub.pruneExpiredReservations(1)).toBe(1);
    expect(await guest.stub.pruneExpiredReservations(1)).toBe(0);
    const replacement = await guest.stub.reserveCreation(
      guest.actor,
      request(7),
    );
    expect(replacement.ok).toBe(true);
    if (replacement.ok) {
      expect(replacement.reservation.tableId).not.toBe(
        created.reservation.tableId,
      );
    }
  });

  it("holds two contenders at the final quota transaction and charges only one", async () => {
    const guest = await createGuest();
    for (let index = 0; index < 9; index++) {
      expect(
        (await guest.stub.reserveCreation(guest.actor, request(100 + index)))
          .ok,
      ).toBe(true);
    }

    await runInDurableObject(guest.stub, async (instance, state) => {
      let waiting = 0;
      let release: () => void = () => {};
      let bothArrived: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        bothArrived = resolve;
      });
      const internal = instance as unknown as {
        beforeReservationDecision: () => Promise<void>;
      };
      const original = internal.beforeReservationDecision;
      internal.beforeReservationDecision = async () => {
        waiting++;
        if (waiting === 2) bothArrived();
        await gate;
      };
      try {
        const first = instance.reserveCreation(guest.actor, request(200));
        const second = instance.reserveCreation(guest.actor, request(201));
        await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("Reservation boundary not reached")),
              5_000,
            ),
          ),
        ]);
        expect(waiting).toBe(2);
        release();
        const results = await Promise.all([first, second]);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toEqual([
          expect.objectContaining({ ok: false, code: "LIMIT_REACHED" }),
        ]);
      } finally {
        release();
        internal.beforeReservationDecision = original;
      }
      const rows = state.storage.sql
        .exec<{ request_id: string; table_id: string }>(
          "SELECT request_id, table_id FROM guest_creation_reservations",
        )
        .toArray();
      expect(rows).toHaveLength(CREATION_LIMITS.maxReservationsPerWindow);
      expect(new Set(rows.map((row) => row.table_id)).size).toBe(10);
    });

    const denied = await guest.stub.reserveCreation(guest.actor, request(202));
    expect(denied).toEqual({
      ok: false,
      code: "LIMIT_REACHED",
      retryAfterMs: expect.any(Number),
    });
    if (!denied.ok) expect(denied.retryAfterMs).toBeGreaterThan(0);

    // An old charge falls out of the rolling window without a refund.
    await runInDurableObject(guest.stub, async (_instance, state) => {
      const prior = Date.now() - day - 1;
      state.storage.sql.exec(
        `UPDATE guest_creation_reservations
         SET charged_at = ?, created_at = ? WHERE request_id = ?`,
        prior,
        prior,
        key(100),
      );
    });
    expect(
      (await guest.stub.reserveCreation(guest.actor, request(203))).ok,
    ).toBe(true);
  });
});
