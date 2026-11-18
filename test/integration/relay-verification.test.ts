import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RelayVerificationAdapter,
  RelayVerificationOperation,
} from "../../src/notifications/relay-verification";
import { subscribeEvent } from "../../src/services/events";
import { createTable } from "../../src/services/tables";
import { authorizeGuestConnection } from "../../src/shared/auth";

const SECRET = `whsec_${btoa("E".repeat(32))}`;
const CALLBACK = "https://events.provider.example.org/callback/verification";
const overlay = () => ({
  ...env,
  EVENTS_REVIEWED_CALLBACK_TARGETS: JSON.stringify([
    { origin: "https://events.provider.example.org", pathPrefix: "/callback" },
  ]),
});
const configuration = {
  origin: "https://relay.example.org",
  callerId: "synthetic-caller-01",
  audience: "test:synthetic-relay",
  signingKeyPkcs8: "synthetic-unused-seam",
  callbackTargets: [
    { origin: "https://events.provider.example.org", pathPrefix: "/callback" },
  ],
};
async function fixture() {
  const guestId = crypto.randomUUID(),
    guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const grant = await guest.createConnection(
    session.sessionId,
    session.secret,
    ["tables:write", "tables:delete", "events:subscribe"],
    Date.now() + 3600000,
  );
  if (!grant) throw Error("grant");
  const creation = await authorizeGuestConnection(
    env,
    guestId,
    grant.connectionId,
    "tables:write",
  );
  if (!creation.allowed) throw Error("authority");
  const created = await createTable(env, creation.actor, {
    request_id: crypto.randomUUID(),
    title: "Synthetic verification",
  });
  if (!created.ok) throw Error(created.code);
  const decision = await authorizeGuestConnection(
    env,
    guestId,
    grant.connectionId,
    "events:subscribe",
  );
  if (!decision.allowed) throw Error("authority");
  const tableId = created.value.tableId,
    stub = env.TABLES.get(env.TABLES.idFromName(tableId));
  const params = {
    name: "table.message.created",
    arguments: { table_id: tableId },
    delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
    cursor: null,
  };
  const enable = () =>
    runInDurableObject(stub, (instance) => {
      (
        instance as unknown as { outboxDispatchEnabled: () => boolean }
      ).outboxDispatchEnabled = () => true;
    });
  await enable();
  const rows = () =>
    runInDurableObject(stub, (_i, state) => ({
      proof: state.storage.sql
        .exec("SELECT * FROM table_event_relay_verifications")
        .toArray(),
      subscriptions: state.storage.sql
        .exec("SELECT * FROM table_event_subscriptions")
        .toArray(),
      candidates: state.storage.sql
        .exec("SELECT * FROM table_event_candidates")
        .toArray(),
    }));
  const revoke = () =>
    guest.revokeConnection(
      session.sessionId,
      session.secret,
      grant.connectionId,
    );
  const deletion = await authorizeGuestConnection(
    env,
    guestId,
    grant.connectionId,
    "tables:delete",
  );
  if (!deletion.allowed) throw Error("authority");
  return {
    browser: { guestId, sessionId: session.sessionId, secret: session.secret },
    actor: decision.actor,
    writeActor: creation.actor,
    deleteActor: deletion.actor,
    stub,
    params,
    rows,
    revoke,
    enable,
  };
}
function adapter(
  send: RelayVerificationAdapter["send"],
): RelayVerificationAdapter {
  return {
    configuration,
    send,
    read: async () => ({ ok: true, state: "unknown" }),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("candidate-bound relay verification, real service/GuestDO/TableDO; external receiver injected", () => {
  it("reads only the original ambiguous operation once and commits its verified receipt", async () => {
    const f = await fixture();
    let sentId = "",
      reads = 0;
    const relay = adapter(async (_c, op, _d, _r, auth) => {
      sentId = op.requestId;
      expect(await auth()).toBe(true);
      return { ok: false, reason: "transport-error" };
    });
    relay.read = async (_c, op, auth) => {
      reads++;
      expect(op.requestId).toBe(sentId);
      expect(op.operationDigest).toBe(
        (await f.rows()).proof[0].operation_digest,
      );
      expect(await auth()).toBe(true);
      return {
        ok: true,
        state: "completed",
        outcome: { kind: "challenge", verification: "verified" },
      };
    };
    expect(
      (await subscribeEvent(overlay(), f.actor, f.params, undefined, relay)).ok,
    ).toBe(true);
    expect(reads).toBe(1);
    expect((await f.rows()).proof[0].state).toBe("verified");
  });
  it("readback cannot turn stale or revoked candidates active", async () => {
    for (const stale of ["expiry", "revoke", "replacement"] as const) {
      const f = await fixture();
      let reads = 0;
      const relay = adapter(async (_c, _op, _d, _r, auth) => {
        expect(await auth()).toBe(true);
        return { ok: false, reason: "transport-error" };
      });
      relay.read = async (_c, _op, auth) => {
        reads++;
        expect(await auth()).toBe(true);
        if (stale === "expiry") {
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.now() + 16000);
        } else if (stale === "revoke") await f.revoke();
        else await f.stub.beginEventSubscription(f.actor, f.params);
        return {
          ok: true,
          state: "completed",
          outcome: { kind: "challenge", verification: "verified" },
        };
      };
      expect(
        (await subscribeEvent(overlay(), f.actor, f.params, undefined, relay))
          .ok,
      ).toBe(false);
      expect(reads).toBe(1);
      expect(
        (await f.rows()).subscriptions.filter((r) => r.status === "active"),
      ).toHaveLength(0);
      vi.useRealTimers();
    }
  });
  it("pending, unknown and HTTP-only readbacks never prove callback control", async () => {
    for (const receipt of [
      { ok: true, state: "pending" },
      { ok: true, state: "unknown" },
      {
        ok: true,
        state: "completed",
        outcome: { kind: "http", status: 204, retryAfterState: "absent" },
      },
    ] as const) {
      const f = await fixture();
      let reads = 0;
      const relay = adapter(async (_c, _op, _d, _r, auth) => {
        expect(await auth()).toBe(true);
        return { ok: false, reason: "transport-error" };
      });
      relay.read = async () => {
        reads++;
        return receipt as Awaited<ReturnType<RelayVerificationAdapter["read"]>>;
      };
      expect(
        (await subscribeEvent(overlay(), f.actor, f.params, undefined, relay))
          .ok,
      ).toBe(false);
      expect(reads).toBe(1);
      expect((await f.rows()).proof[0].state).toBe("unknown");
    }
  });
  it("persists exact one-shot identity before signed challenge and activates only matching verified result", async () => {
    const f = await fixture();
    let sends = 0;
    const result = await subscribeEvent(
      overlay(),
      f.actor,
      f.params,
      undefined,
      adapter(async (_c, op, _d, request, authorize) => {
        sends++;
        const before = await f.rows();
        expect(before.proof[0].state).toBe("prepared");
        expect(before.proof[0].request_id).toBe(op.requestId);
        const value = new Webhook(SECRET).verify(
          new TextDecoder().decode(request.body),
          { ...request.headers },
        ) as { type: string; challenge: string };
        expect(value.type).toBe("verification");
        expect(value.challenge).toMatch(/^[a-f0-9-]{36}$/);
        expect(await authorize()).toBe(true);
        expect(await authorize()).toBe(false);
        expect((await f.rows()).proof[0].state).toBe("dispatched");
        return {
          ok: true,
          outcome: { kind: "challenge", verification: "verified" },
        };
      }),
    );
    expect(result.ok).toBe(true);
    expect(sends).toBe(1);
    const rows = await f.rows();
    expect(rows.proof[0].state).toBe("verified");
    expect(rows.subscriptions[0].status).toBe("active");
    expect(rows.candidates).toHaveLength(0);
    expect(JSON.stringify(rows.proof)).not.toContain(SECRET);
    expect(JSON.stringify(rows.proof)).not.toContain(CALLBACK);
  });
  it("unknown after send survives reconstruction without native commit bypass or second send", async () => {
    const f = await fixture();
    let sends = 0;
    const result = await subscribeEvent(
      overlay(),
      f.actor,
      f.params,
      undefined,
      adapter(async (_c, _o, _d, _r, authorize) => {
        expect(await authorize()).toBe(true);
        sends++;
        return { ok: false, reason: "transport-error" };
      }),
    );
    expect(result.ok).toBe(false);
    const initial = await f.rows();
    expect(initial.proof[0].state).toBe("unknown");
    const candidateId = String(initial.proof[0].candidate_id);
    await evictDurableObject(f.stub);
    expect((await f.rows()).proof).toEqual(initial.proof);
    expect(
      (await f.stub.commitVerifiedEventSubscription(f.actor, candidateId)).ok,
    ).toBe(false);
    expect(sends).toBe(1);
    expect((await f.rows()).subscriptions[0]?.status).not.toBe("active");
  });
  it("crash after dispatch cannot create an active candidate or replace its operation", async () => {
    const f = await fixture();
    let operation: RelayVerificationOperation | undefined;
    expect(
      (
        await subscribeEvent(
          overlay(),
          f.actor,
          f.params,
          undefined,
          adapter(async (c, op, _d, _r, authorize) => {
            expect(await authorize()).toBe(true);
            const row = (await f.rows()).proof[0];
            operation = {
              requestId: op.requestId,
              issuedAt: op.timestamp,
              acceptanceExpiresAt: op.timestamp + 60000,
              audience: c.audience,
              callerId: c.callerId,
              operationDigest: String(row.operation_digest),
            };
            throw Error("synthetic crash");
          }),
        )
      ).ok,
    ).toBe(false);
    const rows = await f.rows();
    expect(rows.proof[0].state).toBe("dispatched");
    if (!operation) throw Error("missing op");
    expect(
      (
        await f.stub.prepareRelayVerification(
          f.actor,
          String(rows.proof[0].candidate_id),
          { ...operation, requestId: crypto.randomUUID() },
        )
      ).ok,
    ).toBe(false);
    expect((await f.rows()).proof).toEqual(rows.proof);
  });
  it("late verified result cannot activate after candidate expiry, grant revocation, unsubscribe or newer candidate", async () => {
    for (const race of [
      "expiry",
      "revoke",
      "unsubscribe",
      "refresh",
      "close",
      "delete",
    ] as const) {
      const f = await fixture();
      const result = await subscribeEvent(
        overlay(),
        f.actor,
        f.params,
        undefined,
        adapter(async (_c, _o, _d, _r, authorize) => {
          expect(await authorize()).toBe(true);
          if (race === "expiry") {
            const row = (await f.rows()).proof[0];
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(Number(row.candidate_expires_at) + 1);
          }
          if (race === "revoke") await f.revoke();
          if (race === "close")
            expect(
              (await f.stub.closeTable(f.writeActor, crypto.randomUUID())).ok,
            ).toBe(true);
          if (race === "delete") {
            const id = crypto.randomUUID();
            expect((await f.stub.requestDeletion(f.deleteActor, id)).ok).toBe(
              true,
            );
            const deleted = await f.stub.resolveDeletion(
              f.browser,
              id,
              "approve",
            );
            expect(deleted).toMatchObject({
              ok: true,
              value: { state: "deleted" },
            });
            expect((await f.rows()).proof).toEqual([]);
          }
          if (race === "unsubscribe")
            expect(
              (
                await f.stub.unsubscribeEvent(f.actor, {
                  name: f.params.name,
                  arguments: f.params.arguments,
                  delivery: { mode: "webhook", url: CALLBACK },
                })
              ).ok,
            ).toBe(true);
          if (race === "refresh")
            expect(
              (await f.stub.beginEventSubscription(f.actor, f.params)).ok,
            ).toBe(true);
          return {
            ok: true,
            outcome: { kind: "challenge", verification: "verified" },
          };
        }),
      );
      expect(result.ok, race).toBe(false);
      expect((await f.rows()).subscriptions[0]?.status).not.toBe("active");
      vi.useRealTimers();
    }
  });
  it("failed verification never becomes active", async () => {
    const f = await fixture();
    expect(
      (
        await subscribeEvent(
          overlay(),
          f.actor,
          f.params,
          undefined,
          adapter(async (_c, _o, _d, _r, authorize) => {
            expect(await authorize()).toBe(true);
            return {
              ok: true,
              outcome: { kind: "challenge", verification: "failed" },
            };
          }),
        )
      ).ok,
    ).toBe(false);
    const rows = await f.rows();
    expect(rows.proof[0].state).toBe("failed");
    expect(rows.subscriptions[0].status).not.toBe("active");
  });
});

it("persisted verified receipt survives commit interruption but cannot activate another candidate", async () => {
  const f = await fixture();
  const result = await subscribeEvent(
    overlay(),
    f.actor,
    f.params,
    undefined,
    adapter(async (_c, _o, _d, _r, authorize) => {
      expect(await authorize()).toBe(true);
      await runInDurableObject(f.stub, (instance) => {
        instance.commitVerifiedEventSubscription = async () => {
          throw Error("synthetic commit interruption");
        };
      });
      return {
        ok: true,
        outcome: { kind: "challenge", verification: "verified" },
      };
    }),
  );
  expect(result.ok).toBe(false);
  const before = await f.rows();
  expect(before.proof[0].state).toBe("verified");
  expect(before.subscriptions[0].status).toBe("inactive");
  await evictDurableObject(f.stub);
  expect(
    (await f.stub.commitVerifiedEventSubscription(f.actor, crypto.randomUUID()))
      .ok,
  ).toBe(false);
  expect(
    (
      await f.stub.commitVerifiedEventSubscription(
        f.actor,
        String(before.proof[0].candidate_id),
      )
    ).ok,
  ).toBe(true);
  expect((await f.rows()).subscriptions[0].status).toBe("active");
  expect(
    (
      await f.stub.commitVerifiedEventSubscription(
        f.actor,
        String(before.proof[0].candidate_id),
      )
    ).ok,
  ).toBe(false);
});

it("wrong digest and bare HTTP success cannot become verified evidence; table expiry purges metadata", async () => {
  const f = await fixture();
  await subscribeEvent(
    overlay(),
    f.actor,
    f.params,
    undefined,
    adapter(async (_c, _o, _d, _r, authorize) => {
      expect(await authorize()).toBe(true);
      return { ok: false, reason: "transport-error" };
    }),
  );
  const rows = await f.rows(),
    row = rows.proof[0];
  const op = {
    requestId: String(row.request_id),
    issuedAt: Number(row.issued_at),
    acceptanceExpiresAt: Number(row.acceptance_expires_at),
    audience: String(row.audience),
    callerId: String(row.caller_id),
    operationDigest: String(row.operation_digest),
  };
  expect(
    (
      await f.stub.recordRelayVerification(
        f.actor,
        String(row.candidate_id),
        { ...op, operationDigest: "0".repeat(64) },
        { kind: "challenge", verification: "verified" },
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await f.stub.recordRelayVerification(
        f.actor,
        String(row.candidate_id),
        op,
        { kind: "http", status: 200, retryAfterState: "absent" },
      )
    ).ok,
  ).toBe(false);
  expect((await f.rows()).proof).toEqual(rows.proof);
  const expires = await runInDurableObject(
    f.stub,
    (_i, s) =>
      s.storage.sql
        .exec<{ expires_at: number }>("SELECT expires_at FROM table_metadata")
        .one().expires_at,
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(expires + 1);
  await runInDurableObject(f.stub, async (instance) => {
    await instance.alarm();
  });
  expect((await f.rows()).proof).toEqual([]);
  expect((await f.rows()).subscriptions).toEqual([]);
});

it("stored relay mode rejects missing proof even under the original native runtime", async () => {
  const f = await fixture();
  await subscribeEvent(
    overlay(),
    f.actor,
    f.params,
    undefined,
    adapter(async (_c, _o, _d, _r, authorize) => {
      expect(await authorize()).toBe(true);
      return { ok: false, reason: "transport-error" };
    }),
  );
  const before = await f.rows();
  expect(before.candidates[0].verification_mode).toBe("relay");
  await runInDurableObject(f.stub, (_i, state) => {
    state.storage.sql.exec("DELETE FROM table_event_relay_verifications");
  });
  expect(
    (
      await f.stub.commitVerifiedEventSubscription(
        f.actor,
        String(before.candidates[0].candidate_id),
      )
    ).ok,
  ).toBe(false);
  expect((await f.rows()).subscriptions[0].status).not.toBe("active");
});

it("production relay selection missing refuses before candidate or native network fallback", async () => {
  const f = await fixture();
  const network = vi.spyOn(globalThis, "fetch");
  const result = await subscribeEvent(
    { ...overlay(), RELEASE_PROFILE: "production-relay-events" },
    f.actor,
    f.params,
  );
  expect(result).toEqual({ ok: false, reason: "unavailable" });
  expect(network).not.toHaveBeenCalled();
  expect((await f.rows()).candidates).toEqual([]);
  expect((await f.rows()).proof).toEqual([]);
});

it.each(["verified", "lost-response"])(
  "staging selected signed adapter persists %s without native fallback",
  async (outcome) => {
    const f = await fixture();
    const { privateRelayBindings } = await import(
      "../helpers/production-relay-fixture"
    );
    const signed = privateRelayBindings({
      guestId: f.actor.guestId,
      connectionId: f.actor.connectionId,
      tableIds: [f.params.arguments.table_id],
    });
    const config = JSON.parse(signed.EVENTS_RELAY_CONFIGURATION);
    config.environment = "staging";
    config.audience = "test:agent-table";
    const staging: Env = {
      ...env,
      ...signed,
      RELEASE_ENVIRONMENT: "staging",
      EVENTS_RELAY_CONFIGURATION: JSON.stringify(config),
    };
    await runInDurableObject(f.stub, (instance) => {
      (instance as unknown as { env: Env }).env = staging;
      delete (instance as unknown as { outboxDispatchEnabled?: unknown })
        .outboxDispatchEnabled;
    });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const envelope = JSON.parse(
          new TextDecoder().decode(init?.body as Uint8Array),
        );
        expect(envelope.audience).toBe("test:agent-table");
        if (String(url).endsWith("/status")) {
          expect(String(url)).toBe("https://relay.example.org/relay/v1/status");
          const saved = await f.rows();
          expect(envelope.requestId).toBe(saved.proof[0].request_id);
          expect(envelope.operationDigest).toBe(
            saved.proof[0].operation_digest,
          );
          return Response.json({ state: "unknown" });
        }
        expect(String(url)).toBe(
          "https://relay.example.org/relay/v1/challenge",
        );
        const rows = await f.rows();
        expect(rows.proof[0].state).toBe("dispatched");
        expect(rows.proof[0].request_id).toBe(envelope.requestId);
        if (outcome === "lost-response")
          throw Error("controlled response loss");
        return Response.json({
          state: "completed",
          outcome: { kind: "challenge", verification: "verified" },
        });
      });
    const result = await subscribeEvent(staging, f.actor, f.params);
    expect(result.ok).toBe(outcome === "verified");
    expect(network).toHaveBeenCalledTimes(outcome === "verified" ? 1 : 2);
    const saved = await f.rows();
    expect(saved.proof[0].state).toBe(
      outcome === "verified" ? "verified" : "unknown",
    );
    if (outcome === "verified")
      expect(saved.subscriptions[0].status).toBe("active");
    else {
      await evictDurableObject(f.stub);
      await runInDurableObject(f.stub, (instance) => {
        (instance as unknown as { env: Env }).env = staging;
      });
      expect((await f.rows()).proof).toEqual(saved.proof);
      expect(
        (
          await f.stub.commitVerifiedEventSubscription(
            f.actor,
            String(saved.proof[0].candidate_id),
          )
        ).ok,
      ).toBe(false);
      expect(network).toHaveBeenCalledTimes(outcome === "verified" ? 1 : 2);
    }
  },
);
