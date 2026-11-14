import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyRecoveryIngress } from "./recovery-run.mjs";

test("the live negative oracle checks private browser, OAuth and MCP ingress", async () => {
  const observed = [];
  const config = { vars: { PUBLIC_ORIGIN: "https://staging.service.test" } };
  const deny = async (url, options) => {
    observed.push([new URL(url).pathname, options.method]);
    assert.equal(options.redirect, "error");
    return new Response("Unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  };
  assert.equal(await verifyRecoveryIngress(config, deny), true);
  assert.equal(observed.length, 9);
  assert.ok(
    observed.some(([path, method]) => path === "/mcp" && method === "POST"),
  );
  assert.ok(observed.some(([path]) => path === "/guest/me"));
  assert.ok(observed.some(([path]) => path === "/oauth/token"));
  assert.equal(
    await verifyRecoveryIngress(config, async (url, options) =>
      new URL(url).pathname === "/oauth/token"
        ? new Response("unexpected", { status: 401 })
        : deny(url, options),
    ),
    false,
  );
});
