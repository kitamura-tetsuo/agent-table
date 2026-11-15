import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFixture } from "../test/helpers/release-fixtures.mjs";
import { validateRelease } from "./release-preflight.mjs";

test("offline production relay release is explicitly blocked, never promoted by arbitrary evidence", () => {
  const f = makeFixture();
  assert.throws(
    () =>
      validateRelease({
        ...f,
        environment: "production",
        profile: "production-relay-events",
        secrets: f.inventory,
      }),
    /production-relay-integration-incomplete/,
  );
});
