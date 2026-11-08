import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { APPLICATION_SCHEMA_VERSION } from "../../schema/migrations";
import { GuestDO, TableDO } from "../../src/index";
import { initializeApplicationSchema } from "../../src/shared/schema";

describe("actual SQLite-backed Durable Object bindings", () => {
  it("migrates an existing version 4 table without fabricating an application table", async () => {
    const table = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    expect(await table.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
    await runInDurableObject(table, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TABLE table_upgrade_sentinel (data TEXT NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO table_upgrade_sentinel (data) VALUES ('retained')",
      );
      state.storage.sql.exec("DROP TABLE table_join_receipts");
      state.storage.sql.exec("DROP TABLE table_invitations");
      state.storage.sql.exec("DROP TABLE table_memberships");
      state.storage.sql.exec("DROP TABLE table_metadata");
      state.storage.sql.exec(
        "UPDATE __agent_table_schema SET version = 4 WHERE singleton = 1",
      );
    });
    await evictDurableObject(table);
    expect(await table.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
    await runInDurableObject(table, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ data: string }>("SELECT data FROM table_upgrade_sentinel")
          .one().data,
      ).toBe("retained");
      expect(
        state.storage.sql.exec("SELECT * FROM table_metadata").toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT * FROM table_memberships").toArray(),
      ).toEqual([]);
    });
  });

  it("migrates an existing guest version 1 object without wiping its other data", async () => {
    const guest = env.GUESTS.get(env.GUESTS.idFromName(crypto.randomUUID()));
    expect(await guest.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
    await runInDurableObject(guest, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TABLE preserved_fixture (value TEXT NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO preserved_fixture (value) VALUES ('old-guest-data')",
      );
      state.storage.sql.exec("DROP TABLE guest_creation_reservations");
      state.storage.sql.exec("DROP TABLE guest_connections");
      state.storage.sql.exec("DROP TABLE guest_sessions");
      state.storage.sql.exec("DROP TABLE guest_identity");
      state.storage.sql.exec(
        "UPDATE __agent_table_schema SET version = 1 WHERE singleton = 1",
      );
    });
    await evictDurableObject(guest);
    expect(await guest.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
    await runInDurableObject(guest, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM preserved_fixture")
          .one().value,
      ).toBe("old-guest-data");
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = 'guest_sessions'",
          )
          .toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = 'guest_connections'",
          )
          .toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = 'guest_creation_reservations'",
          )
          .toArray(),
      ).toHaveLength(1);
    });
  });

  it("initializes TableDO and GuestDO independently, idempotently and durably", async () => {
    const table = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    const guest = env.GUESTS.get(env.GUESTS.idFromName(crypto.randomUUID()));

    expect(await table.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
    expect(await guest.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);

    await runInDurableObject(table, async (instance, state) => {
      expect(instance).toBeInstanceOf(TableDO);
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
      expect(
        state.storage.sql
          .exec<{ component: string; version: number }>(
            "SELECT component, version FROM __agent_table_schema WHERE singleton = 1",
          )
          .one(),
      ).toEqual({ component: "table", version: APPLICATION_SCHEMA_VERSION });
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = 'guest_sessions'",
          )
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = 'table_metadata'",
          )
          .toArray(),
      ).toHaveLength(1);
      initializeApplicationSchema(state.storage, "table");
    });
    await runInDurableObject(guest, async (instance, state) => {
      expect(instance).toBeInstanceOf(GuestDO);
      expect(
        state.storage.sql
          .exec<{ component: string; version: number }>(
            "SELECT component, version FROM __agent_table_schema WHERE singleton = 1",
          )
          .one(),
      ).toEqual({ component: "guest", version: APPLICATION_SCHEMA_VERSION });
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = 'guest_sessions'",
          )
          .toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = 'table_metadata'",
          )
          .toArray(),
      ).toEqual([]);
      initializeApplicationSchema(state.storage, "guest");
    });

    await evictDurableObject(table);
    await evictDurableObject(guest);
    expect(await table.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
    expect(await guest.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);
  });

  for (const { component, name, ObjectClass, createStub } of [
    {
      component: "table",
      name: "TableDO",
      ObjectClass: TableDO,
      createStub: () =>
        env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID())),
    },
    {
      component: "guest",
      name: "GuestDO",
      ObjectClass: GuestDO,
      createStub: () =>
        env.GUESTS.get(env.GUESTS.idFromName(crypto.randomUUID())),
    },
  ] as const) {
    it(`refuses an unsafe ${name} schema after binding-driven reconstruction without clearing storage`, async () => {
      const stub = createStub();
      expect(await stub.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);

      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          "CREATE TABLE future_schema_sentinel (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
        );
        state.storage.sql.exec(
          "INSERT INTO future_schema_sentinel (name, value) VALUES (?, ?)",
          "durable",
          `preserved-${component}`,
        );
        state.storage.sql.exec(
          "UPDATE __agent_table_schema SET version = 999 WHERE singleton = 1",
        );

        expect(() =>
          initializeApplicationSchema(state.storage, component),
        ).toThrow(/newer than supported/);
        expect(() => new ObjectClass(state, env)).toThrow(
          /newer than supported/,
        );

        // The helper and constructor must not rewrite either future metadata or data.
        expect(
          state.storage.sql
            .exec<{ component: string; version: number }>(
              "SELECT component, version FROM __agent_table_schema WHERE singleton = 1",
            )
            .one(),
        ).toEqual({ component, version: 999 });
        expect(
          state.storage.sql
            .exec<{ value: string }>(
              "SELECT value FROM future_schema_sentinel WHERE name = ?",
              "durable",
            )
            .one().value,
        ).toBe(`preserved-${component}`);
      });

      // A binding call, not a direct constructor call, must reject after eviction.
      // A class-specific reset would otherwise silently recreate the schema.
      await evictDurableObject(stub);
      await expect(stub.schemaVersion()).rejects.toThrow(
        /newer than supported/,
      );
    });
  }

  it("does not publish internal storage or enabled admission/notifications", async () => {
    expect(env.ALLOW_NEW_GUESTS).toBe("false");
    expect(env.ENABLE_OPENAI_EVENTS).toBe("false");
    expect(env.ENABLE_MCP_SUBSCRIPTIONS).toBe("false");

    const response = await exports.default.fetch(
      "http://localhost:8787/internal/tables",
    );
    expect(response.status).toBe(404);
  });
});
