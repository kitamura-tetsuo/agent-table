import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("all new Durable Object classes use SQLite migrations", () => {
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  const created = new Map();
  for (const migration of config.migrations) {
    assert.equal(
      migration.new_classes,
      undefined,
      "Legacy KV namespaces are not supported",
    );
    for (const name of migration.new_sqlite_classes ?? []) {
      assert.equal(
        created.has(name),
        false,
        `Duplicate Durable Object class: ${name}`,
      );
      created.set(name, migration.tag);
    }
  }
  for (const name of ["TableDO", "GuestDO", "OAuthTokenDO", "AdmissionDO"]) {
    assert.equal(
      created.has(name),
      true,
      `Missing SQLite migration for ${name}`,
    );
  }
  assert.equal(created.get("OAuthTokenDO"), "v2");
});
