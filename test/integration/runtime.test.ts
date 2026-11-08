import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GuestDO, TableDO } from "../../src/index";
import { initializeApplicationSchema } from "../../src/shared/schema";

describe("actual SQLite-backed Durable Object bindings", () => {
  it("initializes TableDO and GuestDO independently, idempotently and durably", async () => {
    const table = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    const guest = env.GUESTS.get(env.GUESTS.idFromName(crypto.randomUUID()));

    expect(await table.schemaVersion()).toBe(1);
    expect(await guest.schemaVersion()).toBe(1);

    await runInDurableObject(table, async (instance, state) => {
      expect(instance).toBeInstanceOf(TableDO);
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
      expect(
        state.storage.sql
          .exec<{ component: string; version: number }>(
            "SELECT component, version FROM __agent_table_schema WHERE singleton = 1",
          )
          .one(),
      ).toEqual({ component: "table", version: 1 });
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
      ).toEqual({ component: "guest", version: 1 });
      initializeApplicationSchema(state.storage, "guest");
    });

    await evictDurableObject(table);
    await evictDurableObject(guest);
    expect(await table.schemaVersion()).toBe(1);
    expect(await guest.schemaVersion()).toBe(1);
  });

  for (const { component, name, ObjectClass, createStub } of [
    {
      component: "table",
      name: "TableDO",
      ObjectClass: TableDO,
      createStub: () => env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID())),
    },
    {
      component: "guest",
      name: "GuestDO",
      ObjectClass: GuestDO,
      createStub: () => env.GUESTS.get(env.GUESTS.idFromName(crypto.randomUUID())),
    },
  ] as const) {
    it(`refuses an unsafe ${name} schema after binding-driven reconstruction without clearing storage`, async () => {
      const stub = createStub();
      expect(await stub.schemaVersion()).toBe(1);

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

        expect(() => initializeApplicationSchema(state.storage, component)).toThrow(
          /newer than supported/,
        );
        expect(() => new ObjectClass(state, env)).toThrow(/newer than supported/);

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
      // A class-specific reset would otherwise silently return schema version 1.
      await evictDurableObject(stub);
      await expect(stub.schemaVersion()).rejects.toThrow(/newer than supported/);
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
