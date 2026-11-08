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

  it("refuses a future version when reconstructing the exported class without clearing storage", async () => {
    const table = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    expect(await table.schemaVersion()).toBe(1);

    await runInDurableObject(table, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE __agent_table_schema SET version = 999 WHERE singleton = 1",
      );
      expect(() => initializeApplicationSchema(state.storage, "table")).toThrow(
        /newer than supported/,
      );
      expect(() => new TableDO(state, env)).toThrow(/newer than supported/);
      expect(
        state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM __agent_table_schema WHERE singleton = 1",
          )
          .one().version,
      ).toBe(999);
    });
  });

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
