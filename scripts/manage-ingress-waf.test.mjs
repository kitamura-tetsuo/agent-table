import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureIngressRule,
  ingressRule,
  parseArguments,
} from "./manage-ingress-waf.mjs";

const hostname = "agent-table-test.outliner-online.com";
const zoneName = "outliner-online.com";
const zoneId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function options(mode) {
  return parseArguments([
    `--mode=${mode}`,
    `--hostname=${hostname}`,
    `--zone-name=${zoneName}`,
    `--zone-id=${zoneId}`,
    ...(mode === "apply" ? [`--confirm-hostname=${hostname}`] : []),
  ]);
}

function response(status, result) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return { success: status >= 200 && status < 300, result };
    },
  };
}

test("the rule is scoped to a single hostname and same-zone Worker traffic", () => {
  assert.deepEqual(ingressRule(hostname, zoneName), {
    action: "block",
    enabled: true,
    description: `agent-table:deny-same-zone-worker:${hostname}`,
    expression: `(http.host eq "${hostname}" and cf.worker.upstream_zone eq "${zoneName}")`,
  });
  for (const invalid of [zoneName, "other.com", 'a".outliner-online.com']) {
    assert.throws(() => ingressRule(invalid, zoneName));
  }
  assert.throws(() =>
    parseArguments([
      `--mode=apply`,
      `--hostname=${hostname}`,
      `--zone-name=${zoneName}`,
      `--zone-id=${zoneId}`,
    ]),
  );
});

test("a plan never contacts Cloudflare", async () => {
  const result = await ensureIngressRule(options("plan"), undefined, () => {
    throw new Error("Unexpected Cloudflare call");
  });
  assert.equal(result.state, "planned");
});

test("read-only check reports a missing rule without writing", async () => {
  const methods = [];
  const result = await ensureIngressRule(
    options("check"),
    "test-token",
    async (_url, init) => {
      methods.push(init.method);
      return response(404);
    },
  );
  assert.equal(result.state, "missing");
  assert.deepEqual(methods, ["GET"]);
});

test("an installed rule is detected without any writes", async () => {
  const methods = [];
  const result = await ensureIngressRule(
    options("apply"),
    "test-token",
    async (_url, init) => {
      methods.push(init.method);
      return response(200, { rules: [ingressRule(hostname, zoneName)] });
    },
  );
  assert.equal(result.state, "installed");
  assert.deepEqual(methods, ["GET"]);
});

test("a missing entrypoint creates only the scoped zone-level ruleset", async () => {
  const rule = ingressRule(hostname, zoneName);
  const calls = [];
  const result = await ensureIngressRule(
    options("apply"),
    "test-token",
    async (_url, init) => {
      calls.push({
        method: init.method,
        body: init.body && JSON.parse(init.body),
      });
      if (calls.length === 1) return response(404);
      if (calls.length === 2) return response(200, {});
      return response(200, { id: "new-ruleset", rules: [rule] });
    },
  );
  assert.equal(result.state, "installed");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "POST", "GET"],
  );
  assert.deepEqual(calls[1].body, {
    name: "Agent Table ingress protection",
    kind: "zone",
    phase: "http_request_firewall_custom",
    rules: [rule],
  });
});

test("an authorization failure cannot trigger a write", async () => {
  const methods = [];
  await assert.rejects(
    ensureIngressRule(options("apply"), "test-token", async (_url, init) => {
      methods.push(init.method);
      return response(403);
    }),
    /HTTP 403/,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("apply adds only the intended rule and verifies it, preserving others", async () => {
  const rule = ingressRule(hostname, zoneName);
  const original = {
    id: "pre-existing",
    action: "block",
    description: "other",
  };
  const calls = [];
  let installed = false;
  const result = await ensureIngressRule(
    options("apply"),
    "test-token",
    async (url, init) => {
      calls.push({
        url,
        method: init.method,
        body: init.body && JSON.parse(init.body),
      });
      if (init.method === "POST") {
        assert.deepEqual(JSON.parse(init.body), {
          ...rule,
          position: { before: "" },
        });
        installed = true;
        return response(200, {});
      }
      return response(200, {
        id: "ruleset",
        rules: installed ? [rule, original] : [original],
      });
    },
  );
  assert.equal(result.state, "installed");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "POST", "GET"],
  );
  assert.match(calls[1].url, /\/rulesets\/ruleset\/rules$/);
});

test("unexpected existing policy fails closed without writing", async () => {
  const rule = ingressRule(hostname, zoneName);
  await assert.rejects(
    ensureIngressRule(options("apply"), "test-token", async (_url, init) => {
      assert.equal(init.method, "GET");
      return response(200, { rules: [{ ...rule, expression: "true" }] });
    }),
    /differs/,
  );
});
