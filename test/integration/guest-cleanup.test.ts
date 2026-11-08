import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authorizeGuestConnection } from "../../src/shared/auth";
import { DEADLINE_POLICY } from "../../src/shared/deadlines";

const day = 24 * 60 * 60 * 1_000;

describe("GuestDO retained-state cleanup through real alarms", () => {
  it("repairs a missing alarm from retained guest rows after reconstruction", async () => {
    const guestId = crypto.randomUUID();
    const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    const session = await stub.createSession(guestId);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(session.expiresAt);
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBe(null);
    });
    await evictDurableObject(stub);
    expect(await stub.schemaVersion()).toBeGreaterThan(0);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(session.expiresAt);
      expect(
        state.storage.sql.exec("SELECT * FROM guest_identity").toArray(),
      ).toHaveLength(1);
    });
  });

  it("drains bounded batches across eviction without removing live identity, grants, or reservations", async () => {
    const guestId = crypto.randomUUID();
    const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    const live = await stub.createSession(guestId);
    const grant = await stub.createConnection(
      live.sessionId,
      live.secret,
      ["tables:write"],
      Date.now() + day,
    );
    if (!grant) throw new Error("Test grant creation failed");
    const decision = await authorizeGuestConnection(
      env,
      guestId,
      grant.connectionId,
      "tables:write",
    );
    if (!decision.allowed) throw new Error("Missing write grant");
    const expiredKey = "guest_cleanup_expired_0001";
    const liveKey = "guest_cleanup_live_0000001";
    for (const key of [expiredKey, liveKey]) {
      expect(
        (
          await stub.reserveCreation(decision.actor, {
            request_id: key,
            title: key,
          })
        ).ok,
      ).toBe(true);
    }

    const extraExpiredSessions = DEADLINE_POLICY.maxDrainBatch + 20;
    await runInDurableObject(stub, async (_instance, state) => {
      const createdAt = Date.now() - 30 * day - 1_000;
      for (let index = 0; index < extraExpiredSessions; index++) {
        state.storage.sql.exec(
          `INSERT INTO guest_sessions
           (session_id, secret_digest, created_at, expires_at, invalidated_at)
           VALUES (?, ?, ?, ?, NULL)`,
          crypto.randomUUID(),
          index.toString(16).padStart(64, "0"),
          createdAt,
          createdAt + 30 * day,
        );
      }
      const reservationStart = Date.now() - 8 * day - 1_000;
      state.storage.sql.exec(
        `UPDATE guest_creation_reservations
         SET created_at = ?, charged_at = ?, expires_at = ?, retention_until = ?
         WHERE request_id = ?`,
        reservationStart,
        reservationStart,
        reservationStart + day,
        reservationStart + 8 * day,
        expiredKey,
      );
      // The fixture models a previously stored deadline that has just become due.
      await state.storage.setAlarm(Date.now() + 10_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM guest_sessions WHERE expires_at <= ?",
            Date.now(),
          )
          .one().count,
      ).toBe(20);
      expect(await state.storage.getAlarm()).not.toBe(null);
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM guest_sessions WHERE expires_at <= ?",
            Date.now(),
          )
          .one().count,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM guest_creation_reservations",
          )
          .one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM guest_sessions",
          )
          .one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM guest_connections",
          )
          .one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ guest_id: string }>(
            "SELECT guest_id FROM guest_identity WHERE singleton = 1",
          )
          .one().guest_id,
      ).toBe(guestId);
      const next = await state.storage.getAlarm();
      expect(next).not.toBe(null);
      expect(next).toBeGreaterThan(Date.now());
    });

    // Replayed alarm calls cannot shorten the lifetime or erase live state.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.validateSession(live.sessionId, live.secret)).not.toBe(
      null,
    );
    expect(
      (
        await authorizeGuestConnection(
          env,
          guestId,
          grant.connectionId,
          "tables:write",
        )
      ).allowed,
    ).toBe(true);
    expect(
      (await stub.getCreationReservation(decision.actor, liveKey)).ok,
    ).toBe(true);
    expect(
      await stub.getCreationReservation(decision.actor, expiredKey),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});
