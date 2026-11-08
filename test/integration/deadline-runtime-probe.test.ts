import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("pinned workerd alarm and SQL transaction behavior", () => {
  it("commits alarm plus SQL together and rolls both back on failure", async () => {
    const table = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    expect(await table.schemaVersion()).toBeGreaterThan(0);
    await runInDurableObject(table, async (_instance, state) => {
      const when = Date.now() + 60_000;
      const storage = state.storage;
      storage.sql.exec("CREATE TABLE alarm_probe (id INTEGER PRIMARY KEY)");
      await storage.transaction(async (txn) => {
        await txn.setAlarm(when);
        storage.transactionSync(() => {
          storage.sql.exec("INSERT INTO alarm_probe (id) VALUES (1)");
        });
      });
      expect(await storage.getAlarm()).toBe(when);
      expect(storage.sql.exec("SELECT id FROM alarm_probe").toArray()).toEqual([
        { id: 1 },
      ]);

      await expect(
        storage.transaction(async (txn) => {
          await txn.setAlarm(when + 60_000);
          storage.transactionSync(() => {
            storage.sql.exec("INSERT INTO alarm_probe (id) VALUES (2)");
          });
          throw new Error("intentional transaction abort");
        }),
      ).rejects.toThrow("intentional transaction abort");
      expect(await storage.getAlarm()).toBe(when);
      expect(storage.sql.exec("SELECT id FROM alarm_probe").toArray()).toEqual([
        { id: 1 },
      ]);
    });
  });
});
