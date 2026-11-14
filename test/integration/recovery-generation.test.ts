import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLICATION_SCHEMA_VERSION } from "../../schema/migrations";
import { GuestDO } from "../../src/objects/guest";
import { TableDO } from "../../src/objects/table";
import {
  recoveryContext,
  recoveryEnvironmentDenied,
  verifyRecoveryAuthorization,
} from "../../src/shared/recovery";
import {
  GUEST_RECOVERY_STORAGE,
  initializeRecoveryFence,
  recoveryObjectDenied,
  recoveryStorageWasVirgin,
} from "../../src/shared/recovery-storage";
import { recoveryFixture } from "../helpers/recovery";

function resetting(fixture: ReturnType<typeof recoveryFixture>) {
  return fixture.authorize(
    { phase: "reset", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    {
      RESTORE_QUARANTINE: "true",
      ALLOW_NEW_GUESTS: "false",
      ALLOW_NEW_TABLES: "false",
      ENABLE_MCP_SUBSCRIPTIONS: "false",
      ENABLE_OPENAI_EVENTS: "false",
      ALLOW_OUTBOUND_NOTIFICATIONS: "false",
    },
  );
}

async function owner() {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const connection = await guest.createConnection(
    session.sessionId,
    session.secret,
    ["tables:read", "tables:write"],
    Date.now() + 60 * 60_000,
  );
  if (!connection) throw new Error("Missing synthetic connection");
  const actor = {
    kind: "verified-connection" as const,
    guestId,
    connectionId: connection.connectionId,
    scope: "tables:write" as const,
    expiresAt: connection.expiresAt,
  };
  return { guestId, guest, session, connection, actor };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("source-bound recovery certificate", () => {
  it("accepts Ed25519 authority in Workerd and keeps legacy compatibility only when all fields are absent", () => {
    const f = recoveryFixture(env);
    expect(recoveryContext(f.env)).toEqual({
      kind: "authorized",
      claims: f.claims,
    });
    expect(recoveryContext(env)).toEqual({ kind: "legacy" });
    expect(recoveryEnvironmentDenied(f.env)).toBe(false);
    for (const name of [
      "RECOVERY_AUTHORIZATION",
      "RECOVERY_VERIFICATION_KEY",
      "RECOVERY_CONFIG_SHA256",
      "RECOVERY_NAMESPACE_IDENTITY",
    ] as const) {
      expect(recoveryContext({ ...f.env, [name]: undefined })).toEqual({
        kind: "denied",
      });
      expect(recoveryContext({ ...env, [name]: "" })).toEqual({
        kind: "denied",
      });
    }
  });

  it("rejects altered signatures, keys, identity, build, config and unsupported claims", () => {
    const f = recoveryFixture(env);
    const changed = `${f.env.RECOVERY_AUTHORIZATION?.slice(0, -2)}AA`;
    for (const patch of [
      { RECOVERY_AUTHORIZATION: changed },
      {
        RECOVERY_VERIFICATION_KEY:
          recoveryFixture(env).env.RECOVERY_VERIFICATION_KEY,
      },
      { RELEASE_BUILD_SHA: "f".repeat(40) },
      { RELEASE_ENVIRONMENT: "production" },
      { RECOVERY_CONFIG_SHA256: "e".repeat(64) },
      {
        RECOVERY_NAMESPACE_IDENTITY: JSON.stringify({
          ...f.claims.namespaceIdentity,
          workerName: "different-worker",
        }),
      },
      { TABLES: env.GUESTS },
    ])
      expect(recoveryContext({ ...f.env, ...patch } as Env)).toEqual({
        kind: "denied",
      });
    for (const claims of [
      { schemaVersion: 13 },
      { evidenceSha256: null },
      { expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { issuedAt: new Date(Date.now() + 60_000).toISOString() },
      { approvalRef: "invalid\nreference" },
      { extra: true },
    ])
      expect(recoveryContext(f.authorize(claims as never))).toEqual({
        kind: "denied",
      });
  });

  it("does not cache reset expiry or treat a reset certificate as serving authority", () => {
    const f = recoveryFixture(env);
    const reset = resetting(f);
    expect(recoveryContext(reset).kind).toBe("authorized");
    expect(recoveryEnvironmentDenied(reset)).toBe(true);
    const claims = verifyRecoveryAuthorization(
      reset.RECOVERY_AUTHORIZATION ?? "",
      reset.RECOVERY_VERIFICATION_KEY ?? "",
    );
    expect(claims?.phase).toBe("reset");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(claims?.expiresAt ?? ""));
    expect(recoveryContext(reset)).toEqual({ kind: "denied" });
  });
});

describe("generation fences and approved in-place reset", () => {
  it("keeps retained and empty preexisting markerless objects denied", async () => {
    const f = recoveryFixture(env);
    const old = await owner();
    await runInDurableObject(old.guest, async (_instance, state) => {
      expect(recoveryStorageWasVirgin(state.storage)).toBe(false);
      const before = state.storage.sql
        .exec("SELECT * FROM guest_sessions")
        .toArray();
      const candidate = new GuestDO(state, f.env);
      expect(
        await candidate.validateSession(
          old.session.sessionId,
          old.session.secret,
        ),
      ).toBeNull();
      expect(
        candidate.authorizeConnection(
          old.guestId,
          old.connection.connectionId,
          "tables:read",
        ),
      ).toEqual({ allowed: false, reason: "unavailable" });
      await candidate.alarm();
      expect(
        state.storage.sql.exec("SELECT * FROM guest_sessions").toArray(),
      ).toEqual(before);
      expect(
        state.storage.sql
          .exec("SELECT * FROM __agent_table_recovery")
          .toArray(),
      ).toEqual([]);
    });
    const empty = env.GUESTS.get(env.GUESTS.idFromName(crypto.randomUUID()));
    await runInDurableObject(empty, async (_instance, state) => {
      const candidate = new GuestDO(state, f.env);
      await expect(
        candidate.createSession(crypto.randomUUID()),
      ).rejects.toThrow("Guest access unavailable during recovery");
      expect(
        state.storage.sql
          .exec("SELECT * FROM __agent_table_recovery")
          .toArray(),
      ).toEqual([]);
    });
  });

  it("resets canonical SQL and DO KV in the same object, then only the matching serving certificate admits fresh sessions", async () => {
    const f = recoveryFixture(env);
    const old = await owner();
    const input = {
      operationId: f.claims.operationId,
      objectId: old.guest.id.toString(),
      requestNonce: "independent-readback-nonce",
    };
    let reset: GuestDO;
    let serving: GuestDO;
    await runInDurableObject(old.guest, async (_instance, state) => {
      await state.storage.put("old-private-diagnostics", {
        privateText: "must-be-erased",
      });
      reset = new GuestDO(state, resetting(f));
      const before = await reset.inspectRecovery(input);
      expect(before.counts.guest_sessions).toBe(1);
      expect(before.kvEntries).toBe(1);
      expect(before.empty).toBe(false);
      expect(JSON.stringify(before)).not.toContain("must-be-erased");
      const receipt = await reset.resetRecovery(input);
      expect(receipt).toMatchObject({
        empty: true,
        kvEntries: 0,
        markerGeneration: f.claims.generation,
        requestNonce: input.requestNonce,
        schemaVersion: APPLICATION_SCHEMA_VERSION,
      });
      expect(Object.values(receipt.counts)).toEqual([0, 0, 0, 0]);
      expect(await reset.resetRecovery(input)).toEqual(receipt);
      serving = new GuestDO(state, f.env);
    });
    // Cross the actual input gate before calling the reconstructed serving
    // instance: its constructor owns a durable scheduler initialization task.
    await runInDurableObject(old.guest, async (_instance, state) => {
      expect(
        await serving.validateSession(
          old.session.sessionId,
          old.session.secret,
        ),
      ).toBeNull();
      const fresh = await serving.createSession(old.guestId);
      expect(
        await serving.validateSession(fresh.sessionId, fresh.secret),
      ).toMatchObject({ guestId: old.guestId });
      const noCertificate = new GuestDO(state, env);
      expect(
        await noCertificate.validateSession(fresh.sessionId, fresh.secret),
      ).toBeNull();
      const wrongGeneration = new GuestDO(
        state,
        f.authorize({ generation: "9".repeat(64) }),
      );
      expect(
        await wrongGeneration.validateSession(fresh.sessionId, fresh.secret),
      ).toBeNull();
      await expect(reset.resetRecovery(input)).rejects.toThrow(
        "Recovery state unavailable",
      );
      expect(
        await serving.validateSession(fresh.sessionId, fresh.secret),
      ).not.toBeNull();
    });
  });

  it("rejects wrong targets, missing quarantine, enabled effects, unknown tables and future schemas without deletion", async () => {
    const f = recoveryFixture(env);
    const old = await owner();
    const input = {
      operationId: f.claims.operationId,
      objectId: old.guest.id.toString(),
    };
    await runInDurableObject(old.guest, async (_instance, state) => {
      const resetEnv = resetting(f);
      for (const config of [
        { ...resetEnv, RESTORE_QUARANTINE: "false" },
        { ...resetEnv, ALLOW_OUTBOUND_NOTIFICATIONS: "true" },
        f.env,
      ]) {
        const candidate = new GuestDO(state, config);
        await expect(candidate.resetRecovery(input)).rejects.toThrow(
          "Recovery state unavailable",
        );
      }
      const reset = new GuestDO(state, resetEnv);
      await expect(
        reset.resetRecovery({ ...input, operationId: crypto.randomUUID() }),
      ).rejects.toThrow("Recovery state unavailable");
      await expect(
        reset.resetRecovery({ ...input, objectId: "0".repeat(64) }),
      ).rejects.toThrow("Recovery state unavailable");
      state.storage.sql.exec(
        "CREATE TABLE unrecognized_private_data(value TEXT)",
      );
      state.storage.sql.exec(
        "INSERT INTO unrecognized_private_data VALUES('preserved')",
      );
      await expect(reset.resetRecovery(input)).rejects.toThrow(
        "Recovery state unavailable",
      );
      expect(
        state.storage.sql
          .exec("SELECT value FROM unrecognized_private_data")
          .one(),
      ).toEqual({ value: "preserved" });
      state.storage.sql.exec(
        "UPDATE __agent_table_schema SET version = ? WHERE singleton = 1",
        APPLICATION_SCHEMA_VERSION + 1,
      );
      expect(() => new GuestDO(state, resetEnv)).toThrow(
        "newer than supported",
      );
      await expect(reset.resetRecovery(input)).rejects.toThrow(
        "Recovery state unavailable",
      );
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM guest_sessions")
          .one(),
      ).toEqual({ n: 1 });
      expect(
        state.storage.sql
          .exec("SELECT * FROM __agent_table_recovery")
          .toArray(),
      ).toEqual([]);
    });
  });

  it("includes all table content and resets zero-usage accounting without deleting its schema", async () => {
    const f = recoveryFixture(env);
    const old = await owner();
    const input = {
      request_id: crypto.randomUUID(),
      title: "Historical private table",
    };
    const reserved = await old.guest.reserveCreation(old.actor, input);
    if (!reserved.ok) throw new Error("Missing reservation");
    const table = env.TABLES.get(
      env.TABLES.idFromName(reserved.reservation.tableId),
    );
    const created = await table.initializeTable(
      old.actor,
      input,
      reserved.reservation,
    );
    expect(created.ok).toBe(true);
    expect(
      (
        await table.postMessage(old.actor, {
          request_id: crypto.randomUUID(),
          body: "private historical message",
        })
      ).ok,
    ).toBe(true);
    const request = {
      operationId: f.claims.operationId,
      objectId: table.id.toString(),
    };
    let serving: TableDO;
    await runInDurableObject(table, async (_instance, state) => {
      await state.storage.put(
        "callback-origin-diagnostic:v1",
        "private origin",
      );
      const reset = new TableDO(state, resetting(f));
      const receipt = await reset.resetRecovery(request);
      expect(receipt.empty).toBe(true);
      expect(receipt.kvEntries).toBe(0);
      expect(receipt.counts.table_messages).toBe(0);
      expect(receipt.counts.table_memberships).toBe(0);
      expect(receipt.counts.table_transcript_usage).toBe(1);
      expect(
        state.storage.sql.exec("SELECT * FROM table_transcript_usage").one(),
      ).toEqual({ singleton: 1, body_bytes: 0 });
      expect(reset.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
      serving = new TableDO(state, f.env);
    });
    await runInDurableObject(table, async (_instance, state) => {
      expect(serving.lifecycleStatus()).toEqual({
        state: "missing",
        canDispatch: false,
      });
      expect(
        await serving.getMetadata({ ...old.actor, scope: "tables:read" }),
      ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
      // This object-level fixture retains a separately authorized GuestDO
      // reservation to exercise fresh table accounting after the purge.
      expect(
        (await serving.initializeTable(old.actor, input, reserved.reservation))
          .ok,
      ).toBe(true);
      const freshBody = "fresh content after approved object reset";
      expect(
        (
          await serving.postMessage(old.actor, {
            request_id: crypto.randomUUID(),
            body: freshBody,
          })
        ).ok,
      ).toBe(true);
      expect(
        state.storage.sql.exec("SELECT body FROM table_messages").toArray(),
      ).toEqual([{ body: freshBody }]);
      expect(
        state.storage.sql
          .exec("SELECT body_bytes FROM table_transcript_usage")
          .one(),
      ).toEqual({ body_bytes: new TextEncoder().encode(freshBody).byteLength });
    });
  });

  it("refuses same-version changes to constraints, types or indexes before erasing rows", async () => {
    const f = recoveryFixture(env);
    for (const drift of [
      "column-type",
      "missing-index",
      "extra-index",
    ] as const) {
      const old = await owner();
      await runInDurableObject(old.guest, async (_instance, state) => {
        const before = state.storage.sql
          .exec("SELECT * FROM guest_sessions")
          .toArray();
        if (drift === "column-type") {
          const definition = state.storage.sql
            .exec<{ sql: string }>(
              "SELECT sql FROM sqlite_master WHERE name = 'guest_sessions'",
            )
            .one().sql;
          state.storage.transactionSync(() => {
            state.storage.sql.exec(
              "CREATE TABLE saved_session_rows AS SELECT * FROM guest_sessions",
            );
            state.storage.sql.exec("DROP TABLE guest_sessions");
            state.storage.sql.exec(
              definition.replace("secret_digest TEXT", "secret_digest BLOB"),
            );
            state.storage.sql.exec(
              "INSERT INTO guest_sessions SELECT * FROM saved_session_rows",
            );
            state.storage.sql.exec("DROP TABLE saved_session_rows");
            state.storage.sql.exec(
              "CREATE INDEX guest_sessions_expiry ON guest_sessions (expires_at)",
            );
          });
        } else if (drift === "missing-index") {
          state.storage.sql.exec("DROP INDEX guest_sessions_expiry");
        } else {
          state.storage.sql.exec(
            "CREATE INDEX unreviewed_private_index ON guest_sessions(secret_digest)",
          );
        }
        const reset = new GuestDO(state, resetting(f));
        const request = {
          operationId: f.claims.operationId,
          objectId: state.id.toString(),
        };
        await expect(reset.resetRecovery(request)).rejects.toThrow(
          "Recovery state unavailable",
        );
        await expect(reset.inspectRecovery(request)).rejects.toThrow(
          "Recovery state unavailable",
        );
        expect(
          state.storage.sql.exec("SELECT * FROM guest_sessions").toArray(),
        ).toEqual(before);
        expect(
          state.storage.sql
            .exec("SELECT * FROM __agent_table_recovery")
            .toArray(),
        ).toEqual([]);
      });
    }
  });

  it("never stamps nonempty SQL or retained DO KV even when a first-use candidate is supplied", async () => {
    const f = recoveryFixture(env);
    const old = await owner();
    await runInDurableObject(old.guest, async (_instance, state) => {
      await expect(
        initializeRecoveryFence(state, f.env, GUEST_RECOVERY_STORAGE, true),
      ).rejects.toThrow("Recovery state unavailable");
      expect(
        state.storage.sql
          .exec("SELECT * FROM __agent_table_recovery")
          .toArray(),
      ).toEqual([]);
    });
    const empty = env.GUESTS.get(env.GUESTS.idFromName(crypto.randomUUID()));
    await runInDurableObject(empty, async (_instance, state) => {
      await state.storage.put("retained-private-value", "hidden");
      await initializeRecoveryFence(state, f.env, GUEST_RECOVERY_STORAGE, true);
      expect(
        recoveryObjectDenied(state.storage, f.env, GUEST_RECOVERY_STORAGE),
      ).toBe(true);
      expect(
        state.storage.sql
          .exec("SELECT * FROM __agent_table_recovery")
          .toArray(),
      ).toEqual([]);
    });
  });

  it("rechecks the durable generation after an asynchronous digest before a session mutation", async () => {
    const f = recoveryFixture(env);
    const old = await owner();
    await runInDurableObject(old.guest, async (_instance, state) => {
      const reset = new GuestDO(state, resetting(f));
      await reset.resetRecovery({
        operationId: f.claims.operationId,
        objectId: state.id.toString(),
      });
      const serving = new GuestDO(state, f.env);
      const original = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "digest").mockImplementation(
        async (algorithm, data) => {
          const value = await original(algorithm, data);
          state.storage.sql.exec(
            "UPDATE __agent_table_recovery SET generation = ? WHERE singleton = 1",
            "e".repeat(64),
          );
          return value;
        },
      );
      await expect(serving.createSession(old.guestId)).rejects.toThrow(
        "Private access unavailable during recovery",
      );
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM guest_sessions")
          .one(),
      ).toEqual({ n: 0 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM guest_identity")
          .one(),
      ).toEqual({ n: 0 });
    });
  });

  it("does not return credentials prepared before an asynchronous durable commit completes", async () => {
    const f = recoveryFixture(env);
    const old = await owner();
    let serving: GuestDO;
    await runInDurableObject(old.guest, async (_instance, state) => {
      const reset = new GuestDO(state, resetting(f));
      await reset.resetRecovery({
        operationId: f.claims.operationId,
        objectId: state.id.toString(),
      });
      serving = new GuestDO(state, f.env);
    });
    await runInDurableObject(old.guest, async (_instance, state) => {
      const scheduler = (
        serving as unknown as {
          deadlines: { checkpoint: (phase: string) => Promise<void> };
        }
      ).deadlines;
      const checkpoint = scheduler.checkpoint;
      scheduler.checkpoint = async (phase) => {
        if (phase === "after-durable-commit") {
          state.storage.sql.exec(
            "UPDATE __agent_table_recovery SET generation = ?",
            "e".repeat(64),
          );
        }
      };
      try {
        await expect(serving.createSession(old.guestId)).rejects.toThrow(
          "Guest access unavailable during recovery",
        );
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS n FROM guest_sessions")
            .one(),
        ).toEqual({ n: 1 });
      } finally {
        scheduler.checkpoint = checkpoint;
      }
    });
  });
});
