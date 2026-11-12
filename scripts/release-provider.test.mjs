import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeConfig,
  makePrivatePilotFixture,
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

test("legacy staging identity exception only accepts exactly four absent release bindings", async () => {
  const names = [
    "RELEASE_ENVIRONMENT",
    "RELEASE_BUILD_SHA",
    "RELEASE_PROFILE",
    "RESTORE_QUARANTINE",
  ];
  const mock = makeProviderMock(config, peer);
  const prefix = `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}`;
  const settings = mock.routes.get(`${prefix}/settings`);
  const version = mock.routes.get(
    `${prefix}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
  );
  settings.bindings = settings.bindings.filter(
    (value) => !names.includes(value.name),
  );
  version.resources.bindings = version.resources.bindings.filter(
    (value) => !names.includes(value.name),
  );
  await assert.rejects(
    readCloudflareDeployment(config, peer, mock.read),
    /provider-version-config-unverified/,
  );
  const result = await readCloudflareDeployment(config, peer, mock.read, {
    bootstrapStaging: true,
  });
  assert.deepEqual(result.targetState.missingIdentity, names);
  assert.deepEqual(result.peerState.missingIdentity, []);

  settings.bindings = settings.bindings.filter(
    (value) => value.name !== "ALLOW_NEW_TABLES",
  );
  version.resources.bindings = version.resources.bindings.filter(
    (value) => value.name !== "ALLOW_NEW_TABLES",
  );
  await assert.rejects(
    readCloudflareDeployment(config, peer, mock.read, {
      bootstrapStaging: true,
    }),
    /provider-version-config-unverified/,
  );
  const clean = makeProviderMock(config, peer);
  await assert.rejects(
    readCloudflareDeployment(config, peer, clean.read, {
      bootstrapStaging: true,
    }),
    /staging-bootstrap-identity-state-unverified/,
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
  const duplicateDomains = duplicate.routes.get(domainPath);
  duplicateDomains.resultInfo.count = duplicateDomains.result.length;
  duplicateDomains.resultInfo.total_count = duplicateDomains.result.length;
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
  const filler = Array.from({ length: 99 }, (_, index) => ({
    service: `unrelated-worker-${index}`,
    hostname: `unrelated-${index}.example.invalid`,
    enabled: true,
    previews_enabled: false,
  }));
  paginated.routes.set(pageOne, {
    result: [...filler, original.result[0]],
    resultInfo: {
      ...original.resultInfo,
      count: 100,
      total_count: 101,
    },
  });
  paginated.routes.set(pageTwo, {
    result: original.result.slice(1),
    resultInfo: {
      ...original.resultInfo,
      page: 2,
      count: 1,
      total_count: 101,
    },
  });
  const result = await readCloudflareDeployment(config, peer, paginated.read);
  assert.equal(result.peerState.origin, peer.vars.PUBLIC_ORIGIN);

  paginated.routes.get(pageTwo).resultInfo.total_count = 102;
  await assert.rejects(
    readCloudflareDeployment(config, peer, paginated.read),
    /provider-domain-pagination-unverified/,
  );
  paginated.routes.get(pageTwo).resultInfo.total_count = 101;
  paginated.routes.get(pageTwo).resultInfo.page = 1;
  await assert.rejects(
    readCloudflareDeployment(config, peer, paginated.read),
    /provider-domain-pagination-unverified/,
  );
});

test("missing Durable Object namespace listing page fails closed", async () => {
  const mock = makeProviderMock(config, peer);
  const nsPath = `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=1&per_page=100`;
  const first = mock.routes.get(nsPath);
  const filler = Array.from({ length: 100 - first.result.length }, (_, i) => ({
    id: `${String(i % 10).repeat(32)}`,
    class: "Unrelated",
    name: `Unrelated-${i}`,
    script: "unrelated-worker",
    use_sqlite: true,
  }));
  first.result.push(...filler);
  first.resultInfo.count = 100;
  first.resultInfo.total_count = 101;
  mock.routes.set(
    `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=2&per_page=100`,
    {
      result: [filler[0]],
      resultInfo: { page: 1, per_page: 100, count: 1, total_count: 101 },
    },
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

function privateProvider() {
  const fixture = makePrivatePilotFixture();
  const candidate = JSON.parse(fixture.configText);
  const peerConfig = JSON.parse(fixture.peerText);
  const mock = makeProviderMock(candidate, peerConfig);
  const prefix = `/client/v4/accounts/${candidate.account_id}/workers/scripts/${candidate.name}`;
  return {
    candidate,
    peerConfig,
    mock,
    settings: mock.routes.get(`${prefix}/settings`),
    version: mock.routes.get(
      `${prefix}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
    ),
  };
}

test("private policy readback matches active version and settings without entering the receipt", async () => {
  const { candidate, peerConfig, mock } = privateProvider();
  const { targetState } = await readCloudflareDeployment(
    candidate,
    peerConfig,
    mock.read,
  );
  verifyDeployedConfiguration(targetState, candidate);
  assert.equal(
    targetState.textBindings.PRIVATE_PILOT_POLICY,
    candidate.vars.PRIVATE_PILOT_POLICY,
  );
  const serialized = JSON.stringify(
    redactedProviderReceipt(targetState, "staging", "2026-11-11T12:00:00Z"),
  );
  const policy = JSON.parse(candidate.vars.PRIVATE_PILOT_POLICY);
  for (const privateValue of [
    policy.recipientGuestId,
    policy.recipientConnectionId,
    ...policy.tableIds,
    policy.callbackTargets[0].origin,
    policy.callbackTargets[0].pathPrefix,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("missing, divergent, duplicated or secret-typed private policy bindings fail closed", async () => {
  const mutations = [
    ({ settings, version }) => {
      settings.bindings = settings.bindings.filter(
        (binding) => binding.name !== "PRIVATE_PILOT_POLICY",
      );
      version.resources.bindings = version.resources.bindings.filter(
        (binding) => binding.name !== "PRIVATE_PILOT_POLICY",
      );
    },
    ({ settings }) => {
      settings.bindings = settings.bindings.filter(
        (binding) => binding.name !== "PRIVATE_PILOT_POLICY",
      );
    },
    ({ version }) => {
      version.resources.bindings = version.resources.bindings.filter(
        (binding) => binding.name !== "PRIVATE_PILOT_POLICY",
      );
    },
    ({ version }) => {
      version.resources.bindings.find(
        (binding) => binding.name === "PRIVATE_PILOT_POLICY",
      ).text += " ";
    },
    ({ settings }) => {
      const binding = settings.bindings.find(
        (item) => item.name === "PRIVATE_PILOT_POLICY",
      );
      settings.bindings.push(structuredClone(binding));
    },
    ({ version }) => {
      const binding = version.resources.bindings.find(
        (item) => item.name === "PRIVATE_PILOT_POLICY",
      );
      version.resources.bindings.push(structuredClone(binding));
    },
    ({ settings }) => {
      settings.bindings.find(
        (binding) => binding.name === "PRIVATE_PILOT_POLICY",
      ).type = "secret_text";
    },
    ({ settings, version }) => {
      for (const bindings of [settings.bindings, version.resources.bindings]) {
        bindings.find(
          (binding) => binding.name === "PRIVATE_PILOT_POLICY",
        ).text = 7;
      }
    },
  ];
  for (const mutate of mutations) {
    const fixture = privateProvider();
    mutate(fixture);
    await assert.rejects(
      readCloudflareDeployment(
        fixture.candidate,
        fixture.peerConfig,
        fixture.mock.read,
      ),
      /provider-private-pilot-policy-unverified|binding-mismatch/,
    );
  }
});

test("predeploy manual readback is allowed but postdeploy requires exact policy bytes and removal", async () => {
  const privateFixture = privateProvider();
  const manual = makeConfig("staging");
  const manualMock = makeProviderMock(manual, privateFixture.peerConfig);
  const manualState = await readCloudflareDeployment(
    privateFixture.candidate,
    privateFixture.peerConfig,
    manualMock.read,
  );
  assert.equal(
    manualState.targetState.textBindings.PRIVATE_PILOT_POLICY,
    undefined,
  );
  assert.throws(
    () =>
      verifyDeployedConfiguration(
        manualState.targetState,
        privateFixture.candidate,
      ),
    /provider-deployed-config-mismatch|provider-deployed-private-pilot-policy-mismatch/,
  );

  // A manual candidate omits the policy; a retained text binding is not removal.
  for (const response of manualMock.routes.values()) {
    const bindings = response.bindings ?? response.resources?.bindings;
    if (
      bindings?.some(
        (binding) =>
          binding.name === "PUBLIC_ORIGIN" &&
          binding.text === manual.vars.PUBLIC_ORIGIN,
      )
    ) {
      bindings.push({
        name: "PRIVATE_PILOT_POLICY",
        type: "plain_text",
        text: privateFixture.candidate.vars.PRIVATE_PILOT_POLICY,
      });
    }
  }
  const retained = await readCloudflareDeployment(
    manual,
    privateFixture.peerConfig,
    manualMock.read,
  );
  assert.throws(
    () => verifyDeployedConfiguration(retained.targetState, manual),
    /provider-deployed-private-pilot-policy-mismatch/,
  );

  const exact = await readCloudflareDeployment(
    privateFixture.candidate,
    privateFixture.peerConfig,
    privateFixture.mock.read,
  );
  const semanticallyEqual = structuredClone(privateFixture.candidate);
  semanticallyEqual.vars.PRIVATE_PILOT_POLICY += " ";
  assert.throws(
    () => verifyDeployedConfiguration(exact.targetState, semanticallyEqual),
    /provider-deployed-private-pilot-policy-mismatch/,
  );
});
