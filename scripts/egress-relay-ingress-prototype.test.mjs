import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import {
  createRelayIngress,
  memoryReplayStoreForTests,
  relaySigningBytes,
} from "./egress-relay-ingress-prototype.mjs";

// RFC 8032 section 7.1 TEST 1 PUBLIC TEST VECTOR. Not a secret or deployable key.
// No random keys, credentials, network listeners or external requests are made.
const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const publicHex =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const privateKey = createPrivateKey({
  format: "der",
  type: "pkcs8",
  key: Buffer.from("302e020100300506032b657004220420" + seed, "hex"),
});
const publicKey = {
  format: "der",
  type: "spki",
  key: Buffer.from("302a300506032b6570032100" + publicHex, "hex"),
};
const callerId = "synthetic-worker-1";
const targets = [
  { origin: "https://callback.example.org", pathPrefix: "/events" },
];
const base = {
  version: 1,
  requestId: "synthetic-request-1",
  timestamp: 100000,
  destination: "https://callback.example.org/events",
  headers: {},
  payload: "AQI=",
};
function message(changes = {}) {
  const bytes = Buffer.from(JSON.stringify({ ...base, ...changes }));
  return {
    method: "POST",
    path: "/relay/v1",
    callerId,
    bytes,
    signature: sign(
      null,
      relaySigningBytes(bytes, callerId),
      privateKey,
    ).toString("base64"),
  };
}
function setup(overrides = {}) {
  let sent = 0;
  const handler = createRelayIngress({
    callers: new Map([[callerId, { publicKey, targets }]]),
    replayStore: memoryReplayStoreForTests(),
    clock: () => 100000,
    send: async (_destination, _targets, bytes) => {
      sent++;
      assert.deepEqual([...bytes], [1, 2]);
      return { status: 204, body: new Uint8Array([3]) };
    },
    ...overrides,
  });
  return { handler, sent: () => sent };
}
test("actual Ed25519 signature authenticates exact envelope; replay never sends twice", async () => {
  const { handler, sent } = setup();
  assert.deepEqual(await handler(message()), {
    status: 200,
    body: { status: 204, payload: "Aw==" },
  });
  assert.equal((await handler(message())).status, 409);
  assert.equal(sent(), 1);
});
test("tamper, unknown caller, stale time, unreviewed origin and caller Host fail before send", async () => {
  const { handler, sent } = setup();
  const tampered = message();
  tampered.bytes = Buffer.from(JSON.stringify({ ...base, payload: "Aw==" }));
  assert.equal((await handler(tampered)).status, 401);
  assert.equal(
    (await handler({ ...message(), callerId: "unknown-worker-1" })).status,
    401,
  );
  for (const changes of [
    { timestamp: 1 },
    { destination: "https://evil.example.org/events" },
    { headers: { host: "evil.example.org" } },
    { payload: "AQI" },
    { version: 2 },
  ])
    assert.equal((await handler(message(changes))).status, 400);
  assert.equal(sent(), 0);
});
test("concurrent duplicate reserves replay before delivery; capacity bounded", async () => {
  let finish,
    sent = 0;
  const { handler } = setup({
    concurrency: 2,
    send: async () => {
      sent++;
      await new Promise((r) => {
        finish = r;
      });
      return { status: 204, body: new Uint8Array() };
    },
  });
  const first = handler(message());
  await new Promise((r) => setImmediate(r));
  assert.equal((await handler(message())).status, 409);
  finish();
  assert.equal((await first).status, 200);
  assert.equal(sent, 1);
});
test("per caller rate limit and failed-delivery replay are fail closed", async () => {
  const { handler } = setup({
    perMinute: 1,
    send: async () => {
      throw new Error("private data");
    },
  });
  assert.deepEqual(await handler(message()), {
    status: 502,
    body: { code: "delivery-failed" },
  });
  assert.equal(
    (await handler(message({ requestId: "synthetic-request-2" }))).status,
    429,
  );
  const limited = memoryReplayStoreForTests(1);
  assert.equal(await limited.reserve("a", 100, 0), true);
  assert.equal(await limited.reserve("b", 100, 0), false);
  assert.equal(await limited.reserve("b", 200, 101), true);
});
test("replay store unavailable and signature over wrong HTTP domain cannot send", async () => {
  const { handler, sent } = setup({
    replayStore: {
      reserve: async () => {
        throw new Error("store error");
      },
    },
  });
  assert.equal((await handler(message())).status, 502);
  const m = message();
  m.signature = sign(
    null,
    Buffer.concat([Buffer.from("GET\n/relay/v1\n"), m.bytes]),
    privateKey,
  ).toString("base64");
  assert.equal((await handler(m)).status, 401);
  assert.equal(sent(), 0);
});

test("unresponsive replay reservation releases capacity; late success never sends", async () => {
  let late;
  let reservations = 0;
  const { handler, sent } = setup({
    concurrency: 1,
    reserveTimeoutMs: 5,
    replayStore: {
      reserve: () =>
        ++reservations === 1
          ? new Promise((resolve) => {
              late = resolve;
            })
          : Promise.resolve(true),
    },
  });
  assert.equal((await handler(message())).status, 502);
  assert.equal(
    (await handler(message({ requestId: "synthetic-request-2" }))).status,
    200,
  );
  late(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    sent(),
    1,
    "late reservation cannot revive the expired first handler",
  );
});

test("signature cannot be reassigned even when two configured callers share a key", async () => {
  const { handler, sent } = setup({
    callers: new Map([
      [callerId, { publicKey, targets }],
      ["synthetic-worker-2", { publicKey, targets }],
    ]),
  });
  assert.equal(
    (await handler({ ...message(), callerId: "synthetic-worker-2" })).status,
    401,
  );
  assert.equal(sent(), 0);
});
test("global and active admission caps reject before a second send", async () => {
  const global = setup({ perMinute: 10, globalPerMinute: 1 });
  assert.equal((await global.handler(message())).status, 200);
  assert.equal(
    (await global.handler(message({ requestId: "synthetic-request-2" })))
      .status,
    429,
  );
  let release;
  const local = setup({
    concurrency: 1,
    send: async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { status: 204, body: new Uint8Array() };
    },
  });
  const first = local.handler(message());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await local.handler(message({ requestId: "synthetic-request-2" }))).status,
    429,
  );
  release();
  assert.equal((await first).status, 200);
});
