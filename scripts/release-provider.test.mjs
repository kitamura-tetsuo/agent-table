import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeConfig,
  makeProviderMock,
} from "../test/helpers/release-fixtures.mjs";
import {
  cloudflareReader,
  inspectWorker,
  ProviderVerificationError,
  readCloudflareDeployment,
  receiptDigest,
  redactedProviderReceipt,
  verifyDeployedConfiguration,
} from "./release-provider.mjs";

const config = makeConfig("staging");
const peer = makeConfig("production");

test("authenticated readback joins a Worker, SQLite DOs, KV, secrets, origin and deployed version", async () => {
  const mock = makeProviderMock(config, peer);
  const { targetState, peerState } = await readCloudflareDeployment(
    config,
    peer,
    mock.read,
  );
  assert.equal(targetState.workerName, "agent-table-staging");
  assert.notDeepEqual(targetState.doNamespaces, peerState.doNamespaces);
  assert.equal(targetState.kvId, config.kv_namespaces[0].id);
  assert.equal(targetState.secretNames.length, 2);
  verifyDeployedConfiguration(targetState, config);
  const receipt = redactedProviderReceipt(
    targetState,
    "staging",
    "2026-11-11T12:00:00Z",
  );
  assert.match(receiptDigest(receipt), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /NEVER_ECHO_ME|secretNames|textBindings/,
  );
});

test("does not accept fabricated target or peer resource ownership", async () => {
  const checks = [
    [
      "/settings",
      (value) =>
        (value.bindings = value.bindings.filter(
          (binding) => binding.name !== "TABLES",
        )),
      "binding-mismatch",
    ],
    [
      "/settings",
      (value) =>
        (value.bindings.find(
          (binding) => binding.name === "OAUTH_KV",
        ).namespace_id = "f".repeat(32)),
      "provider-kv-ownership-unverified",
    ],
    [
      "/settings",
      (value) =>
        (value.bindings.find(
          (binding) => binding.name === "TABLES",
        ).namespace_id = "a".repeat(32)),
      "provider-do-ownership-unverified",
    ],
    [
      "/settings",
      (value) =>
        (value.bindings.find(
          (binding) => binding.name === "TABLES",
        ).environment = "unreviewed"),
      "provider-do-ownership-unverified",
    ],
    [
      "/subdomain",
      (value) => (value.previews_enabled = true),
      "provider-public-subdomain-enabled",
    ],
    ["/secrets", (value) => value.pop(), "provider-required-secret-missing"],
    [
      "/deployments",
      (value) => (value.deployments[0].versions[0].percentage = 70),
      "provider-traffic-split-unverified",
    ],
    [
      "/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      (value) =>
        (value.resources.script_runtime.exports.GuestDO.storage = "legacy-kv"),
      "provider-sqlite-class-unverified",
    ],
    [
      "/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      (value) => (value.resources.script_runtime.migration_tag = "v2"),
      "provider-migration-tag-unverified",
    ],
    [
      "/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      (value) =>
        (value.resources.script.named_handlers =
          value.resources.script.named_handlers.filter(
            (entry) => entry.name !== "GuestDO",
          )),
      "provider-class-export-unverified",
    ],
    [
      "/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      (value) =>
        (value.resources.bindings.find(
          (entry) => entry.name === "TABLES",
        ).namespace_id = "e".repeat(32)),
      "provider-version-do-binding-mismatch",
    ],
    [
      "/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      (value) =>
        (value.resources.bindings.find(
          (entry) => entry.name === "RELEASE_BUILD_SHA",
        ).text = "b".repeat(40)),
      "provider-version-config-unverified",
    ],
  ];
  for (const [suffix, mutation, code] of checks) {
    const mock = makeProviderMock(config, peer);
    const path = [...mock.routes.keys()].find(
      (name) => name.includes("/agent-table-staging") && name.endsWith(suffix),
    );
    const value = mock.routes.get(path);
    mutation(value);
    await assert.rejects(
      readCloudflareDeployment(config, peer, mock.read),
      (error) =>
        error instanceof ProviderVerificationError && error.message === code,
      code,
    );
  }
});

test("Cloudflare versions without optional declarative exports still prove live classes and SQLite identity", async () => {
  const mock = makeProviderMock(config, peer);
  for (const worker of [config, peer]) {
    const version = mock.routes.get(
      `/client/v4/accounts/${worker.account_id}/workers/scripts/${worker.name}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
    );
    delete version.resources.script_runtime.exports;
  }
  const result = await readCloudflareDeployment(config, peer, mock.read);
  assert.equal(result.targetState.doNamespaces.TABLES.length, 32);
});

test("mismatched public origin and recycled peer namespace deny release", async () => {
  const mock = makeProviderMock(config, peer);
  const domainPath = `/client/v4/accounts/${config.account_id}/workers/domains?page=1&per_page=100`;
  const domains = mock.routes.get(domainPath).result;
  domains[0].hostname = "unreviewed.example.net";
  await assert.rejects(
    readCloudflareDeployment(config, peer, mock.read),
    /provider-origin-not-exclusive/,
  );
  const duplicate = makeProviderMock(config, peer);
  duplicate.routes.get(domainPath).result.push({
    service: "unexpected-worker",
    hostname: new URL(config.vars.PUBLIC_ORIGIN).hostname,
    enabled: true,
    previews_enabled: false,
  });
  await assert.rejects(
    readCloudflareDeployment(config, peer, duplicate.read),
    /provider-origin-not-exclusive/,
  );
  const reused = makeProviderMock(config, peer);
  const targetSettings = reused.routes.get(
    `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}/settings`,
  );
  const peerSettings = reused.routes.get(
    `/client/v4/accounts/${peer.account_id}/workers/scripts/${peer.name}/settings`,
  );
  peerSettings.bindings.find((value) => value.name === "TABLES").namespace_id =
    targetSettings.bindings.find(
      (value) => value.name === "TABLES",
    ).namespace_id;
  const peerVersion = reused.routes.get(
    `/client/v4/accounts/${peer.account_id}/workers/scripts/${peer.name}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
  );
  peerVersion.resources.bindings.find(
    (value) => value.name === "TABLES",
  ).namespace_id = peerSettings.bindings.find(
    (value) => value.name === "TABLES",
  ).namespace_id;
  const nsPath = `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=1&per_page=100`;
  const namespaces = reused.routes.get(nsPath).result;
  namespaces.find(
    (value) => value.script === peer.name && value.class === "TableDO",
  ).id = namespaces.find(
    (value) => value.script === config.name && value.class === "TableDO",
  ).id;
  await assert.rejects(
    readCloudflareDeployment(config, peer, reused.read),
    /provider-environment-shared-do/,
  );
});

test("post-deploy readback must match all exact release vars", async () => {
  const mock = makeProviderMock(config, peer);
  const state = await inspectWorker(
    config,
    mock.read,
    mock.routes.get(
      `/client/v4/accounts/${config.account_id}/workers/domains?page=1&per_page=100`,
    ).result,
    mock.routes.get(
      `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=1&per_page=100`,
    ).result,
  );
  state.textBindings.RELEASE_BUILD_SHA = "b".repeat(40);
  assert.throws(
    () => verifyDeployedConfiguration(state, config),
    /provider-deployed-config-mismatch/,
  );
});

test("DO ownership is read from the account namespace list if settings omit its ID", async () => {
  const mock = makeProviderMock(config, peer);
  const settings = mock.routes.get(
    `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}/settings`,
  );
  delete settings.bindings.find((binding) => binding.name === "TABLES")
    .namespace_id;
  const result = await readCloudflareDeployment(config, peer, mock.read);
  assert.equal(result.targetState.doNamespaces.TABLES.length, 32);

  const nsPath = `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=1&per_page=100`;
  const listEntry = mock.routes
    .get(nsPath)
    .result.find(
      (item) => item.script === config.name && item.class === "TableDO",
    );
  listEntry.use_sqlite = false;
  await assert.rejects(
    readCloudflareDeployment(config, peer, mock.read),
    /provider-do-ownership-unverified/,
  );
});

test("domain readback requires all pages and refuses incomplete pagination", async () => {
  const pageOne = `/client/v4/accounts/${config.account_id}/workers/domains?page=1&per_page=100`;
  const pageTwo = `/client/v4/accounts/${config.account_id}/workers/domains?page=2&per_page=100`;
  const paginated = makeProviderMock(config, peer);
  const original = paginated.routes.get(pageOne);
  paginated.routes.set(pageOne, {
    result: original.result.slice(0, 1),
    resultInfo: { ...original.resultInfo, total_pages: 2 },
  });
  paginated.routes.set(pageTwo, {
    result: original.result.slice(1),
    resultInfo: { ...original.resultInfo, page: 2, total_pages: 2 },
  });
  const result = await readCloudflareDeployment(config, peer, paginated.read);
  assert.equal(result.peerState.origin, peer.vars.PUBLIC_ORIGIN);

  paginated.routes.get(pageTwo).resultInfo.page = 1;
  await assert.rejects(
    readCloudflareDeployment(config, peer, paginated.read),
    /provider-domain-pagination-unverified/,
  );
});

test("missing Durable Object namespace listing page fails closed", async () => {
  const mock = makeProviderMock(config, peer);
  const nsPath = `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=1&per_page=100`;
  mock.routes.get(nsPath).resultInfo.total_pages = 2;
  mock.routes.set(
    `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=2&per_page=100`,
    { result: [], resultInfo: { page: 1, total_pages: 2 } },
  );
  await assert.rejects(
    readCloudflareDeployment(config, peer, mock.read),
    /provider-do-pagination-unverified/,
  );
});

test("network reader is GET-only, fixed-origin, bounded and never echoes secrets", async () => {
  const seen = [];
  const reader = cloudflareReader(
    "this-is-a-synthetic-token",
    async (url, options) => {
      seen.push({ url, options });
      return new Response(
        JSON.stringify({ success: true, result: { id: "ok" } }),
      );
    },
  );
  assert.deepEqual(await reader("/client/v4/accounts/abc/workers/domains"), {
    id: "ok",
  });
  assert.equal(seen[0].options.method, "GET");
  assert.equal(seen[0].options.redirect, "error");
  assert.equal(new URL(seen[0].url).origin, "https://api.cloudflare.com");
  await assert.rejects(
    reader("https://evil.example/"),
    /provider-path-invalid/,
  );
  const refused = cloudflareReader(
    "this-is-a-synthetic-token",
    async () => new Response("TOP_SECRET", { status: 403 }),
  );
  await assert.rejects(
    refused("/client/v4/accounts/abc/workers/domains"),
    (error) => {
      assert.equal(error.message, "provider-read-refused");
      assert.doesNotMatch(error.message, /TOP_SECRET/);
      return true;
    },
  );
  const oversized = cloudflareReader(
    "this-is-a-synthetic-token",
    async () => new Response("x".repeat(130 * 1024)),
  );
  await assert.rejects(
    oversized("/client/v4/accounts/abc/workers/domains"),
    /provider-body-oversized/,
  );
});
