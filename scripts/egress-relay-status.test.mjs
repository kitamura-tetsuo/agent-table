import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRelayHttpsServer } from "./egress-relay-http.mjs";
import {
  createRelayIngress,
  relayOperationDigest,
  relaySigningBytes,
  relayStatusSigningBytes,
} from "./egress-relay-ingress-prototype.mjs";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";

const callerId = "synthetic-worker-1";
const privateKey = createPrivateKey({
  format: "der",
  type: "pkcs8",
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
});
const publicKey = {
  format: "der",
  type: "spki",
  key: Buffer.from(
    "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
};
const policy = () => ({
  publicKey,
  targets: [{ origin: "https://callback.example.org", pathPrefix: "/events" }],
});
const envelope = () => ({
  version: 1,
  audience: "test:synthetic-relay",
  requestId: "synthetic-request-1",
  timestamp: Date.now(),
  destination: "https://callback.example.org/events",
  headers: { "content-type": "application/json" },
  payload: Buffer.from("synthetic message").toString("base64"),
});
function signed(body, path = "/relay/v1", id = callerId, domain = path) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    path,
    callerId: id,
    bytes,
    signature: sign(
      null,
      domain === "/relay/v1"
        ? relaySigningBytes(bytes, id)
        : relayStatusSigningBytes(bytes, id),
      privateKey,
    ).toString("base64"),
  };
}
const status = (body, changes = {}) => ({
  version: 1,
  audience: body.audience,
  requestId: body.requestId,
  timestamp: Date.now(),
  operationDigest: relayOperationDigest(body, callerId),
  ...changes,
});

test("authenticated status survives actual SQLite restart, pause allows reads only, current revocation denies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-status-test-"));
  let store;
  let enabled = true;
  let reads = true;
  let attempts = 0;
  const callers = new Map([
    [callerId, policy()],
    ["synthetic-worker-2", policy()],
  ]);
  try {
    const open = () =>
      openRelayAdmissionStore(join(dir, "store.sqlite"), {
        environment: "test",
        serviceId: "synthetic-relay",
      });
    store = open();
    const make = () =>
      createRelayIngress({
        callers,
        audience: "test:synthetic-relay",
        admissionStore: store,
        enabled: () => enabled,
        readEnabled: () => reads,
        send: async () => {
          attempts++;
          return {
            status: 204,
            body: Buffer.from("PRIVATE_RESPONSE_SENTINEL"),
          };
        },
      });
    let handler = make();
    const body = envelope();
    assert.equal((await handler(signed(body))).status, 200);
    store.close();
    store = open();
    handler = make();
    enabled = false;
    const request = signed(status(body), "/relay/v1/status");
    assert.deepEqual(await handler(request), {
      status: 200,
      body: {
        state: "completed",
        outcome: { kind: "http", status: 204, retryAfterState: "unknown" },
      },
    });
    assert.equal((await handler(signed(body))).status, 503);
    assert.deepEqual(
      (
        await handler(
          signed(status(body), "/relay/v1/status", "synthetic-worker-2"),
        )
      ).body,
      { state: "unknown" },
    );
    assert.equal(
      (
        await handler(
          signed(
            status(body, { operationDigest: "b".repeat(64) }),
            "/relay/v1/status",
          ),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await handler(
          signed(status(body), "/relay/v1/status", callerId, "/relay/v1"),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await handler(
          signed(
            status(body, { audience: "production:synthetic-relay" }),
            "/relay/v1/status",
          ),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await handler(
          signed(
            status(body, { timestamp: Date.now() - 120000 }),
            "/relay/v1/status",
          ),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await handler(
          signed(status(body, { unexpected: true }), "/relay/v1/status"),
        )
      ).status,
      400,
    );
    assert.equal(
      (await handler({ ...request, bytes: Buffer.alloc(1025) })).status,
      413,
    );
    callers.delete(callerId);
    assert.equal((await handler(request)).status, 401);
    // A changed malformed/non-Ed25519 key fails closed rather than cached-key use.
    callers.set(callerId, {
      ...policy(),
      publicKey: {
        format: "der",
        type: "spki",
        key: Buffer.from(
          "302a300506032b65700321003d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
          "hex",
        ),
      },
    });
    assert.equal((await handler(request)).status, 401);
    callers.set(callerId, { ...policy(), publicKey: "invalid" });
    assert.equal((await handler(request)).status, 401);
    callers.set(callerId, policy());
    reads = false;
    assert.equal((await handler(request)).status, 503);
    assert.equal(attempts, 1);
    assert.ok(
      !readFileSync(join(dir, "store.sqlite"))
        .toString()
        .includes("PRIVATE_RESPONSE_SENTINEL"),
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status read rate and async current caller fences do not reserve or send", async () => {
  const callers = new Map([[callerId, policy()]]);
  let reserves = 0;
  let forwards = 0;
  let reads = 0;
  const admissionStore = {
    acquire: () => {
      reserves++;
    },
    finish: () => {},
    readOutcome: () => {
      reads++;
      return { ok: true, state: "unknown" };
    },
  };
  const handler = createRelayIngress({
    callers,
    audience: "test:synthetic-relay",
    admissionStore,
    readPerMinute: 1,
    send: () => {
      forwards++;
    },
  });
  const req = signed(status(envelope()), "/relay/v1/status");
  assert.equal((await handler(req)).status, 200);
  assert.equal((await handler(req)).status, 429);
  assert.equal(reads, 1);
  assert.equal(reserves, 0);
  assert.equal(forwards, 0);
  let release;
  const delayed = createRelayIngress({
    callers,
    audience: "test:synthetic-relay",
    admissionStore: {
      ...admissionStore,
      readOutcome: () =>
        new Promise((r) => {
          release = r;
        }),
    },
    send: () => {
      forwards++;
    },
  });
  const pending = delayed(req);
  callers.delete(callerId);
  release({
    ok: true,
    state: "completed",
    outcome: { kind: "http", status: 204, retryAfterState: "unknown" },
  });
  assert.equal((await pending).status, 401);
  assert.equal(reserves, 0);
  assert.equal(forwards, 0);
});

test("semantic commitment ignores re-sign timestamp and header ordering, never callback content", () => {
  const a = envelope();
  a.headers = {
    "webhook-id": "synthetic-id",
    "content-type": "application/json",
  };
  const b = {
    ...a,
    timestamp: a.timestamp + 1,
    headers: {
      "content-type": "application/json",
      "webhook-id": "synthetic-id",
    },
  };
  assert.equal(
    relayOperationDigest(a, callerId),
    relayOperationDigest(b, callerId),
  );
  for (const c of [
    { ...b, payload: Buffer.from("changed").toString("base64") },
    { ...b, destination: "https://callback.example.org/events/other" },
    { ...b, requestId: "synthetic-request-2" },
    { ...b, headers: { ...b.headers, "webhook-id": "changed" } },
  ])
    assert.notEqual(
      relayOperationDigest(a, callerId),
      relayOperationDigest(c, callerId),
    );
  assert.notEqual(
    relayOperationDigest(a, callerId),
    relayOperationDigest(a, "synthetic-worker-2"),
  );
});

test("actual localhost HTTPS status path preserves signature binding and 1KiB body limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-status-https-"));
  let listener;
  let store;
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=relay.example.org",
        "-addext",
        "subjectAltName=DNS:relay.example.org",
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(join(dir, "cert.pem"));
    store = openRelayAdmissionStore(join(dir, "store.sqlite"), {
      environment: "test",
      serviceId: "synthetic-relay",
    });
    let attempts = 0;
    const handler = createRelayIngress({
      callers: new Map([[callerId, policy()]]),
      audience: "test:synthetic-relay",
      admissionStore: store,
      enabled: () => false,
      send: () => {
        attempts++;
      },
    });
    listener = createRelayHttpsServer({
      key: readFileSync(join(dir, "key.pem")),
      cert,
      handler,
    });
    await new Promise((resolve) =>
      listener.server.listen(0, "127.0.0.1", resolve),
    );
    const request = async (input) =>
      await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: "127.0.0.1",
            port: listener.server.address().port,
            servername: "relay.example.org",
            ca: cert,
            agent: false,
            method: "POST",
            path: input.path,
            headers: {
              "content-type": "application/json",
              "x-agent-table-caller": input.callerId,
              "x-agent-table-signature": input.signature,
            },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.once("end", () =>
              resolve({
                status: res.statusCode,
                body: JSON.parse(body),
                cache: res.headers["cache-control"],
              }),
            );
          },
        );
        req.once("error", reject);
        req.end(input.bytes);
      });
    const req = signed(status(envelope()), "/relay/v1/status");
    assert.deepEqual(await request(req), {
      status: 200,
      body: { state: "unknown" },
      cache: "no-store",
    });
    assert.equal((await request({ ...req, path: "/relay/v1" })).status, 503);
    assert.equal(
      (await request({ ...req, path: "/relay/v1/status?override=1" })).status,
      404,
    );
    assert.equal(
      (await request({ ...req, bytes: Buffer.alloc(1025) })).status,
      413,
    );
    assert.equal(
      (
        await request(
          signed(status(envelope()), "/relay/v1/status", callerId, "/relay/v1"),
        )
      ).status,
      401,
    );
    assert.equal(attempts, 0);
  } finally {
    if (listener) await listener.close();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("message-only domain preserves known 429 delay; challenge domain cannot invoke status sender", async () => {
  const { relayMessageSigningBytes } = await import(
    "./egress-relay-ingress-prototype.mjs"
  );
  const dir = mkdtempSync(join(tmpdir(), "relay-message-test-"));
  let store;
  let bodyCalls = 0,
    messageCalls = 0;
  try {
    const path = join(dir, "store.sqlite");
    const open = () =>
      openRelayAdmissionStore(path, {
        environment: "test",
        serviceId: "synthetic-relay",
      });
    store = open();
    const outcome = {
      kind: "http",
      status: 429,
      retryAfterState: "known",
      retryAfterSeconds: 120,
      retryAfterObservedAt: 0,
    };
    const make = () =>
      createRelayIngress({
        callers: new Map([[callerId, policy()]]),
        audience: "test:synthetic-relay",
        admissionStore: store,
        send: async () => {
          bodyCalls++;
          return { status: 204, body: new Uint8Array() };
        },
        sendMessage: async () => {
          messageCalls++;
          outcome.retryAfterObservedAt = Date.now();
          return outcome;
        },
      });
    const body = { ...envelope(), kind: "message" };
    const bytes = Buffer.from(JSON.stringify(body));
    const req = {
      method: "POST",
      path: "/relay/v1/message",
      callerId,
      bytes,
      signature: sign(
        null,
        relayMessageSigningBytes(bytes, callerId),
        privateKey,
      ).toString("base64"),
    };
    let handler = make();
    assert.equal(
      (
        await handler({
          ...req,
          signature: sign(
            null,
            relaySigningBytes(bytes, callerId),
            privateKey,
          ).toString("base64"),
        })
      ).status,
      401,
    );
    assert.equal((await handler({ ...req, path: "/relay/v1" })).status, 401);
    assert.deepEqual(await handler(req), {
      status: 200,
      body: { state: "completed", outcome },
    });
    assert.equal(messageCalls, 1);
    assert.equal(bodyCalls, 0);
    store.close();
    store = open();
    handler = make();
    const read = signed(
      status(body, {
        operationDigest: relayOperationDigest(body, callerId, "message"),
      }),
      "/relay/v1/status",
    );
    assert.deepEqual(await handler(read), {
      status: 200,
      body: { state: "completed", outcome },
    });
    assert.equal((await handler(req)).status, 409);
    assert.equal(messageCalls, 1);
    assert.notEqual(
      relayOperationDigest(body, callerId, "message"),
      relayOperationDigest(body, callerId),
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("challenge-only authenticated result commits across restart without body or message-domain confusion", async () => {
  const { relayChallengeSigningBytes } = await import(
    "./egress-relay-ingress-prototype.mjs"
  );
  const { createResultOnlyChallengeVerifier } = await import("./egress-relay-challenge.mjs");
  const challenge = "123e4567-e89b-42d3-a456-426614174000";
  const dir = mkdtempSync(join(tmpdir(), "relay-challenge-test-"));
  let store;
  let bodyCalls = 0,
    messageCalls = 0;
  try {
    const path = join(dir, "store.sqlite");
    const open = () =>
      openRelayAdmissionStore(path, {
        environment: "test",
        serviceId: "synthetic-relay",
      });
    store = open();
    const outcome = {kind:"challenge",verification:"verified"};
    const make = () =>
      createRelayIngress({
        callers: new Map([[callerId, policy()]]),
        audience: "test:synthetic-relay",
        admissionStore: store,
        send: async () => {
          bodyCalls++;
          return { status: 204, body: new Uint8Array() };
        },
        verifyChallenge: createResultOnlyChallengeVerifier(async () => {
          messageCalls++; return {status:200,body:Buffer.from(JSON.stringify({challenge}))};
        }),
      });
    const body = { ...envelope(), kind: "challenge", payload:Buffer.from(JSON.stringify({type:"verification",challenge})).toString("base64") };
    const bytes = Buffer.from(JSON.stringify(body));
    const req = {
      method: "POST",
      path: "/relay/v1/challenge",
      callerId,
      bytes,
      signature: sign(
        null,
        relayChallengeSigningBytes(bytes, callerId),
        privateKey,
      ).toString("base64"),
    };
    let handler = make();
    assert.equal(
      (
        await handler({
          ...req,
          signature: sign(
            null,
            relaySigningBytes(bytes, callerId),
            privateKey,
          ).toString("base64"),
        })
      ).status,
      401,
    );
    assert.equal((await handler({ ...req, path: "/relay/v1" })).status, 401);
    assert.deepEqual(await handler(req), {
      status: 200,
      body: { state: "completed", outcome },
    });
    assert.equal(messageCalls, 1);
    assert.equal(bodyCalls, 0);
    store.close();
    store = open();
    handler = make();
    const read = signed(
      status(body, {
        operationDigest: relayOperationDigest(body, callerId, "challenge"),
      }),
      "/relay/v1/status",
    );
    assert.deepEqual(await handler(read), {
      status: 200,
      body: { state: "completed", outcome },
    });
    assert.equal((await handler(req)).status, 409);
    assert.equal(messageCalls, 1);
    assert.notEqual(
      relayOperationDigest(body, callerId, "challenge"),
      relayOperationDigest(body, callerId),
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("challenge commit failure never claims completion or implicitly repeats a store write", async () => {
 const {relayChallengeSigningBytes}=await import('./egress-relay-ingress-prototype.mjs');
 const {createResultOnlyChallengeVerifier}=await import('./egress-relay-challenge.mjs');
 const challenge='123e4567-e89b-42d3-a456-426614174000';
 const body={...envelope(),kind:'challenge',payload:Buffer.from(JSON.stringify({type:'verification',challenge})).toString('base64')};
 const bytes=Buffer.from(JSON.stringify(body));
 const req={method:'POST',path:'/relay/v1/challenge',callerId,bytes,signature:sign(null,relayChallengeSigningBytes(bytes,callerId),privateKey).toString('base64')};
 for (const throws of [true,false]) {
  let writes=0,sends=0;
  const handler=createRelayIngress({callers:new Map([[callerId,policy()]]),audience:'test:synthetic-relay',admissionStore:{acquire:()=>({ok:true,leaseId:1}),finish:()=>{writes++;if(throws)throw Error('private');return {ok:false,reason:'unavailable'};}},send:async()=>{throw Error('wrong path')},verifyChallenge:createResultOnlyChallengeVerifier(async()=>{sends++;return {status:200,body:Buffer.from(JSON.stringify({challenge}))};})});
  const response=await handler(req);assert.notEqual(response.status,200);assert.equal(response.body.state,undefined);assert.equal(writes,1);assert.equal(sends,1);
 }
});
