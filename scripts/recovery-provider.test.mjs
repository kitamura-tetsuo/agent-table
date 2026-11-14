import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMISSION_RECOVERY_STORAGE,
  GUEST_RECOVERY_STORAGE,
  OAUTH_RECOVERY_STORAGE,
  recoveryStorageManifest,
  TABLE_RECOVERY_STORAGE,
} from "../src/shared/recovery-manifests.ts";
import {
  deleteInventoriedOAuthKeys,
  inventoryRecoveryResources,
  recoveryCloudflareClient,
  recoveryInventoryDigest,
  verifyObjectInspectionReceipts,
  verifyObjectResetReceipts,
} from "./recovery-provider.mjs";

const bindings = ["TABLES", "GUESTS", "OAUTH_SERIALIZER", "ADMISSION"];
const classes = ["TableDO", "GuestDO", "OAuthTokenDO", "AdmissionDO"];
const descriptors = [
  TABLE_RECOVERY_STORAGE,
  GUEST_RECOVERY_STORAGE,
  OAUTH_RECOVERY_STORAGE,
  ADMISSION_RECOVERY_STORAGE,
];
const identity = {
  accountId: "1".repeat(32),
  workerName: "agent-table-staging",
  namespaces: {
    TABLES: "2".repeat(32),
    GUESTS: "3".repeat(32),
    OAUTH_SERIALIZER: "4".repeat(32),
    ADMISSION: "5".repeat(32),
    OAUTH_KV: "6".repeat(32),
  },
  commitments: {
    TABLES: "7".repeat(64),
    GUESTS: "8".repeat(64),
    OAUTH_SERIALIZER: "9".repeat(64),
    ADMISSION: "a".repeat(64),
  },
};
const prefix = `/client/v4/accounts/${identity.accountId}`;
const objectPath = (binding) =>
  `${prefix}/workers/durable_objects/namespaces/${identity.namespaces[binding]}/objects`;
const keysPath = `${prefix}/storage/kv/namespaces/${identity.namespaces.OAUTH_KV}/keys`;
function page(result, cursor = "", extra = {}) {
  return { result, resultInfo: { count: result.length, cursor, ...extra } };
}
function fixture() {
  const routes = new Map([
    [
      `${prefix}/workers/durable_objects/namespaces?page=1&per_page=100`,
      {
        result: bindings.map((binding, index) => ({
          id: identity.namespaces[binding],
          script: identity.workerName,
          class: classes[index],
          use_sqlite: true,
        })),
        resultInfo: { page: 1, per_page: 100, count: 4, total_count: 4 },
      },
    ],
    [
      `${prefix}/workers/scripts/${identity.workerName}/settings`,
      {
        bindings: [
          ...bindings.map((name, index) => ({
            name,
            type: "durable_object_namespace",
            class_name: classes[index],
            namespace_id: identity.namespaces[name],
          })),
          {
            name: "OAUTH_KV",
            type: "kv_namespace",
            namespace_id: identity.namespaces.OAUTH_KV,
          },
        ],
      },
    ],
    [
      `${prefix}/storage/kv/namespaces/${identity.namespaces.OAUTH_KV}`,
      { id: identity.namespaces.OAUTH_KV },
    ],
    [
      `${keysPath}?limit=1000`,
      page([
        {
          name: "grant:synthetic",
          expiration: 1_900_000_000,
          metadata: { deliberately: "not copied" },
        },
        { name: "client:synthetic" },
      ]),
    ],
    ...bindings.map((binding, index) => [
      `${objectPath(binding)}?limit=1000`,
      page([{ id: String(index + 1).repeat(64), hasStoredData: index !== 0 }]),
    ]),
  ]);
  const requests = [];
  const client = async (path, options = {}) => {
    requests.push({ path, options });
    assert.ok(routes.has(path), "Unexpected fixture endpoint");
    const result = routes.get(path);
    return structuredClone(
      typeof result === "function" ? await result(options) : result,
    );
  };
  return { routes, client, requests };
}
async function inspected() {
  const mock = fixture();
  const inventory = await inventoryRecoveryResources(identity, mock.client);
  const expected = {
    environment: "staging",
    buildSha: "b".repeat(40),
    configSha256: "c".repeat(64),
    operationId: "11111111-1111-4111-8111-111111111111",
    generation: "d".repeat(64),
    schemaVersion: 12,
    namespaceIdentity: identity,
    requestNonce: "e".repeat(64),
  };
  const receipts = bindings.flatMap((binding, index) =>
    inventory.objects[binding].map((object) => {
      const descriptor = descriptors[index];
      return {
        format: "agent-table.recovery-inspection.v1",
        environment: expected.environment,
        buildSha: expected.buildSha,
        configSha256: expected.configSha256,
        operationId: expected.operationId,
        generation: expected.generation,
        objectId: object.id,
        binding,
        component: descriptor.component,
        schemaVersion: descriptor.schemaVersion,
        manifest: recoveryStorageManifest(descriptor),
        counts: Object.fromEntries(
          descriptor.tables.map((table) => [
            table.name,
            table.name === "table_transcript_usage" ? 1 : 0,
          ]),
        ),
        kvEntries: 0,
        markerGeneration: expected.generation,
        empty: true,
        requestNonce: expected.requestNonce,
      };
    }),
  );
  return { mock, inventory, expected, receipts };
}

test("inventories exact namespaces and every object state, discarding KV metadata", async () => {
  const mock = fixture();
  const first = await inventoryRecoveryResources(identity, mock.client);
  assert.deepEqual(first.counts, {
    TABLES: 1,
    GUESTS: 1,
    OAUTH_SERIALIZER: 1,
    ADMISSION: 1,
    OAUTH_KV: 2,
  });
  assert.equal(first.objects.TABLES[0].hasStoredData, false);
  assert.deepEqual(first.oauthKeys, [
    { name: "client:synthetic", expiration: null },
    { name: "grant:synthetic", expiration: 1_900_000_000 },
  ]);
  const later = {
    ...first,
    startedAt: "2099-01-01T00:00:00.000Z",
    completedAt: "2099-01-01T00:00:01.000Z",
  };
  assert.equal(recoveryInventoryDigest(first), recoveryInventoryDigest(later));
  assert.ok(mock.requests.every(({ path }) => !path.includes("prefix=")));
});

test("continues short and empty cursor pages instead of treating them as completion", async () => {
  const mock = fixture();
  const first = `${objectPath("TABLES")}?limit=1000`;
  mock.routes.set(
    first,
    page([{ id: "a".repeat(64), hasStoredData: false }], "page one"),
  );
  mock.routes.set(`${first}&cursor=page%20one`, page([], "page/two"));
  mock.routes.set(
    `${first}&cursor=page%2Ftwo`,
    page([{ id: "b".repeat(64), hasStoredData: true }]),
  );
  mock.routes.set(`${keysPath}?limit=1000`, page([], "opaque"));
  mock.routes.set(
    `${keysPath}?limit=1000&cursor=opaque`,
    page([{ name: "token:synthetic" }]),
  );
  const inventory = await inventoryRecoveryResources(identity, mock.client);
  assert.equal(inventory.counts.TABLES, 2);
  assert.equal(inventory.counts.OAUTH_KV, 1);
});

test("rejects cursor cycles, duplicates, missing counts and inconsistent terminal totals", async () => {
  for (const mutate of [
    (mock, path) => {
      mock.routes.set(path, page([], "same"));
      mock.routes.set(`${path}&cursor=same`, page([], "same"));
    },
    (mock, path) => {
      const item = { id: "a".repeat(64), hasStoredData: false };
      mock.routes.set(path, page([item], "next"));
      mock.routes.set(`${path}&cursor=next`, page([item]));
    },
    (mock, path) => {
      mock.routes.get(path).resultInfo.count = 0;
    },
    (mock, path) => {
      mock.routes.get(path).resultInfo.total_count = 2;
    },
    (mock, path) => {
      mock.routes.get(path).result[0].hasStoredData = undefined;
    },
    (mock, path) => {
      mock.routes.get(path).resultInfo.cursor = 123;
    },
  ]) {
    const mock = fixture();
    mutate(mock, `${objectPath("TABLES")}?limit=1000`);
    await assert.rejects(
      inventoryRecoveryResources(identity, mock.client),
      /recovery-/,
    );
  }
  const duplicateKey = fixture();
  duplicateKey.routes.set(
    `${keysPath}?limit=1000`,
    page([{ name: "same" }, { name: "same" }]),
  );
  await assert.rejects(
    inventoryRecoveryResources(identity, duplicateKey.client),
    /inventory-duplicate/,
  );
});

test("verifies every namespace ownership page and refuses unknown or substituted resources", async () => {
  for (const mutate of [
    (mock) => {
      mock.routes.get(
        `${prefix}/workers/durable_objects/namespaces?page=1&per_page=100`,
      ).result[0].use_sqlite = false;
    },
    (mock) => {
      const result = mock.routes.get(
        `${prefix}/workers/durable_objects/namespaces?page=1&per_page=100`,
      );
      result.result.push({
        id: "f".repeat(32),
        script: identity.workerName,
        class: "UnknownDO",
        use_sqlite: true,
      });
      result.resultInfo.count = 5;
      result.resultInfo.total_count = 5;
    },
    (mock) => {
      mock.routes.get(
        `${prefix}/workers/scripts/${identity.workerName}/settings`,
      ).bindings[0].script_name = "another-worker";
    },
    (mock) => {
      mock.routes.get(
        `${prefix}/storage/kv/namespaces/${identity.namespaces.OAUTH_KV}`,
      ).id = "f".repeat(32);
    },
    (mock) => {
      mock.routes.get(
        `${prefix}/workers/durable_objects/namespaces?page=1&per_page=100`,
      ).resultInfo.total_count = 101;
    },
  ]) {
    const mock = fixture();
    mutate(mock);
    await assert.rejects(
      inventoryRecoveryResources(identity, mock.client),
      /recovery-/,
    );
  }
  const mock = fixture();
  const initial = mock.routes.get(
    `${prefix}/workers/durable_objects/namespaces?page=1&per_page=100`,
  ).result;
  const unrelated = Array.from({ length: 97 }, (_, index) => ({
    id: (100 + index).toString(16).padStart(32, "0"),
    script: "other-worker",
    class: "OtherDO",
    use_sqlite: true,
  }));
  const all = [...unrelated, ...initial];
  mock.routes.set(
    `${prefix}/workers/durable_objects/namespaces?page=1&per_page=100`,
    {
      result: all.slice(0, 100),
      resultInfo: { page: 1, per_page: 100, count: 100, total_count: 101 },
    },
  );
  mock.routes.set(
    `${prefix}/workers/durable_objects/namespaces?page=2&per_page=100`,
    {
      result: all.slice(100),
      resultInfo: { page: 2, per_page: 100, count: 1, total_count: 101 },
    },
  );
  assert.equal(
    (await inventoryRecoveryResources(identity, mock.client)).counts.TABLES,
    1,
  );
  mock.routes.get(
    `${prefix}/workers/durable_objects/namespaces?page=2&per_page=100`,
  ).resultInfo.total_count = 102;
  await assert.rejects(
    inventoryRecoveryResources(identity, mock.client),
    /namespace-inventory-incomplete/,
  );
});

test("requires one canonical schema receipt for every object including objects without stored data", async () => {
  const { inventory, expected, receipts } = await inspected();
  const summary = verifyObjectResetReceipts(
    inventory,
    [...receipts].reverse(),
    expected,
  );
  assert.equal(summary.totalObjects, 4);
  assert.equal(
    summary.receiptSha256,
    verifyObjectResetReceipts(inventory, receipts, expected).receiptSha256,
  );
  assert.equal(Object.hasOwn(summary, "receipts"), false);
  for (const mutate of [
    (values) => values.pop(),
    (values) => {
      values[1] = values[0];
    },
    (values) => {
      values[0].buildSha = "f".repeat(40);
    },
    (values) => {
      values[0].requestNonce = "f".repeat(64);
    },
    (values) => {
      values[0].generation = "f".repeat(64);
    },
    (values) => {
      values[0].schemaVersion = 13;
    },
    (values) => {
      values[0].manifest.push({ name: "unknown", columns: [] });
    },
    (values) => {
      values[0].manifest[0].columns.push("unknown");
    },
    (values) => {
      values[0].counts.table_messages = 1;
    },
    (values) => {
      values[0].counts.table_transcript_usage = 0;
    },
    (values) => {
      values[0].counts.unknown = 0;
    },
    (values) => {
      values[0].kvEntries = 1;
    },
    (values) => {
      values[0].markerGeneration = null;
    },
    (values) => {
      values[0].empty = false;
    },
  ]) {
    const changed = structuredClone(receipts);
    mutate(changed);
    assert.throws(
      () => verifyObjectResetReceipts(inventory, changed, expected),
      /recovery-/,
    );
  }
});

test("pre-reset inspections prove freeze coverage without claiming private state is empty", async () => {
  const { inventory, expected, receipts } = await inspected();
  receipts[0].counts.table_messages = 3;
  receipts[0].markerGeneration = null;
  receipts[0].empty = false;
  const summary = verifyObjectInspectionReceipts(inventory, receipts, expected);
  assert.equal(summary.format, "agent-table.recovery-inspection-summary.v1");
  assert.throws(
    () => verifyObjectResetReceipts(inventory, receipts, expected),
    /private-state-remains/,
  );
});

test("bulk deletion checks every acknowledgement and returns only counts", async () => {
  const mock = fixture();
  const keys = Array.from({ length: 201 }, (_, index) => ({
    name: `synthetic:${String(index).padStart(3, "0")}`,
  }));
  mock.routes.set(`${keysPath}?limit=1000`, page(keys));
  const inventory = await inventoryRecoveryResources(identity, mock.client);
  const path = `${prefix}/storage/kv/namespaces/${identity.namespaces.OAUTH_KV}/bulk/delete`;
  const received = [];
  mock.routes.set(path, ({ method, body }) => {
    assert.equal(method, "POST");
    received.push(...body);
    return { successful_key_count: body.length, unsuccessful_keys: [] };
  });
  assert.deepEqual(
    await deleteInventoriedOAuthKeys(identity, inventory, mock.client),
    { requested: 201, deleted: 201, batches: 3 },
  );
  assert.deepEqual(
    received,
    keys.map((key) => key.name),
  );
  for (const partial of [
    { successful_key_count: 99, unsuccessful_keys: [] },
    { successful_key_count: 100, unsuccessful_keys: ["synthetic:000"] },
    { successful_key_count: 100 },
  ]) {
    mock.routes.set(path, partial);
    await assert.rejects(
      deleteInventoriedOAuthKeys(identity, inventory, mock.client),
      /delete-incomplete/,
    );
  }
  const substituted = structuredClone(identity);
  substituted.namespaces.OAUTH_KV = "f".repeat(32);
  await assert.rejects(
    deleteInventoriedOAuthKeys(substituted, inventory, mock.client),
    /inventory-substitution/,
  );
});

test("client allows only bounded fixed-origin inventory and inventoried-key deletion endpoints", async () => {
  const calls = [];
  const client = recoveryCloudflareClient(
    "test-token-never-echo",
    async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        success: true,
        result: [],
        result_info: { count: 0, cursor: "" },
      });
    },
  );
  await client(`${objectPath("TABLES")}?limit=1000&cursor=opaque%2Fvalue`, {
    withPageInfo: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer test-token-never-echo",
  );
  assert.equal(calls[0].options.redirect, "error");
  for (const [path, options] of [
    ["https://attacker.invalid/", {}],
    ["//attacker.invalid/", {}],
    [`${objectPath("TABLES")}?limit=1000&prefix=grant`, {}],
    [`${objectPath("TABLES")}?limit=1000&limit=1000`, {}],
    [`${objectPath("TABLES")}?limit=1000`, { method: "DELETE" }],
    [
      `${prefix}/storage/kv/namespaces/${identity.namespaces.OAUTH_KV}/bulk/delete`,
      { method: "POST", body: ["same", "same"] },
    ],
    [`${objectPath("TABLES")}?limit=1000`, { body: "not a GET body" }],
  ])
    await assert.rejects(client(path, options), /recovery-provider-/);
  assert.equal(calls.length, 1);
});

test("client accepts successful Cloudflare envelopes with absent, null or empty errors", async () => {
  const path = `${prefix}/workers/durable_objects/namespaces?page=1&per_page=100`;
  const result = [
    {
      id: identity.namespaces.TABLES,
      script: identity.workerName,
      class: "TableDO",
      use_sqlite: true,
    },
  ];
  const resultInfo = { page: 1, per_page: 100, count: 1, total_count: 1 };
  for (const errors of [undefined, null, []]) {
    const client = recoveryCloudflareClient("test-token-never-echo", async () =>
      Response.json({ success: true, result, errors, result_info: resultInfo }),
    );
    assert.deepEqual(await client(path, { withPageInfo: true }), {
      result,
      resultInfo,
    });
  }
});

test("null errors never substitutes for explicit success or permits invalid error shapes", async () => {
  const path = `${objectPath("TABLES")}?limit=1000`;
  const envelopes = [
    ...[undefined, false, null, "true", 1].map((success) => ({
      success,
      result: [],
      errors: null,
    })),
    ...[{}, "", false, 0, ["DO_NOT_LOG_PRIVATE_DATA"]].map((errors) => ({
      success: true,
      result: [],
      errors,
    })),
  ];
  for (const envelope of envelopes) {
    const client = recoveryCloudflareClient("test-token-never-echo", async () =>
      Response.json(envelope),
    );
    await assert.rejects(
      client(path),
      /^RecoveryProviderError: recovery-provider-result-unverified$/,
    );
  }
});

test("client refuses partial API success and oversized bodies without leaking response text", async () => {
  const path = `${objectPath("TABLES")}?limit=1000`;
  for (const response of [
    new Response("DO_NOT_LOG_PRIVATE_DATA", { status: 403 }),
    Response.json({
      success: false,
      result: [],
      errors: [{ message: "DO_NOT_LOG_PRIVATE_DATA" }],
    }),
    Response.json({
      success: true,
      result: [],
      errors: ["DO_NOT_LOG_PRIVATE_DATA"],
    }),
    new Response("DO_NOT_LOG_PRIVATE_DATA"),
    new Response("x".repeat(1024 * 1024 + 1)),
  ]) {
    const client = recoveryCloudflareClient(
      "test-token-never-echo",
      async () => response,
    );
    await assert.rejects(
      client(path),
      (error) =>
        error.message.startsWith("recovery-provider-") &&
        !error.message.includes("DO_NOT_LOG") &&
        !error.message.includes("never-echo"),
    );
  }
  const broken = recoveryCloudflareClient("test-token-never-echo", async () => {
    throw new Error("test-token-never-echo");
  });
  await assert.rejects(
    broken(path),
    /^RecoveryProviderError: recovery-provider-unreachable$/,
  );
});
