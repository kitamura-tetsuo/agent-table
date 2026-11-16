import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRelayApplication } from "./egress-relay-application.mjs";
import { relayMessageSigningBytes } from "./egress-relay-ingress-prototype.mjs";
import {
  loadRelayLaunchConfiguration,
  runRelayLauncher,
} from "./relay-launcher.mjs";

const publicKeySpki = Buffer.from(
  "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "hex",
).toString("base64");
const privateKey = createPrivateKey({
  format: "der",
  type: "pkcs8",
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
});
const callerId = "synthetic-worker-1";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-launcher-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key"),
      "-out",
      join(dir, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=relay.example.org",
      "-addext",
      "subjectAltName=DNS:relay.example.org",
    ],
    { stdio: "ignore" },
  );
  const config = {
    version: 1,
    startup: "paused",
    environment: "production",
    serviceId: "synthetic-relay",
    databasePath: join(dir, "store.sqlite"),
    port: 0,
    tlsKeyPath: join(dir, "key"),
    tlsCertPath: join(dir, "cert"),
    callers: [
      {
        callerId,
        publicKeySpki,
        targets: [
          { origin: "https://callback.example.org", pathPrefix: "/events" },
        ],
      },
    ],
    admission: {
      perMinute: 10,
      globalPerMinute: 100,
      concurrency: 2,
      leaseMs: 1000,
      maxReplayMs: 120000,
      maxRecords: 10000,
      busyTimeoutMs: 100,
      operatorRecoveryPolicy: {
        planFreshnessMs: 300000,
        receiptRetentionMs: 604800000,
        maxReceipts: 1000,
      },
    },
  };
  const path = join(dir, "config.json"),
    bytes = JSON.stringify(config);
  writeFileSync(path, bytes, { mode: 0o600 });
  const hash = createHash("sha256").update(bytes).digest("hex");
  const children = [];
  t.after(async () => {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    config,
    path,
    hash,
    bytes,
    children,
    cert: readFileSync(config.tlsCertPath),
  };
}
async function launch(f, { preload, expected = f.hash } = {}) {
  const args = [
    ...(preload ? ["--import", preload] : []),
    "scripts/relay-launcher.mjs",
    "--config",
    f.path,
    "--expected-config-sha256",
    expected,
  ];
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  f.children.push(child);
  const queue = [],
    waiters = [];
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b.toString()));
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    if (waiters.length) waiters.shift()(value);
    else queue.push(value);
  });
  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("launcher-response-timeout")),
            10000,
          );
          waiters.push((v) => {
            clearTimeout(timer);
            resolve(v);
          });
        });
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  let seq = 0,
    ready;
  return {
    child,
    next,
    exit,
    get stderr() {
      return stderr;
    },
    async ready() {
      ready = await next();
      return ready;
    },
    async command(action, payload = null, patch = {}) {
      child.stdin.write(
        `${JSON.stringify({
          version: 1,
          generation: ready.generation,
          configurationSha256: f.hash,
          sequence: ++seq,
          action,
          payload,
          ...patch,
        })}\n`,
      );
      return await next();
    },
  };
}
function sql(f) {
  const db = new DatabaseSync(f.config.databasePath);
  db.exec("PRAGMA busy_timeout=1000");
  return db;
}
function post(f, ready, requestId = "synthetic-request-1") {
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: "message",
      audience: "production:synthetic-relay",
      requestId,
      timestamp: Date.now(),
      destination: "https://callback.example.org/events",
      headers: {},
      payload: "",
    }),
  );
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: "127.0.0.1",
        port: ready.port,
        servername: "relay.example.org",
        ca: f.cert,
        agent: false,
        method: "POST",
        path: "/relay/v1/message",
        headers: {
          "content-type": "application/json",
          "x-agent-table-caller": callerId,
          "x-agent-table-signature": sign(
            null,
            relayMessageSigningBytes(bytes, callerId),
            privateKey,
          ).toString("base64"),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (b) => (body += b));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(body) }),
        );
      },
    );
    r.on("error", reject);
    r.end(bytes);
  });
}
function preload(f, delay = 250) {
  const path = join(f.dir, "dns-test-only.mjs");
  // Trusted test process only: real production sender holds in DNS then throws.
  // No DNS request, remote callback or successful-delivery oracle is substituted.
  writeFileSync(
    path,
    `import dns from "node:dns/promises"; import {syncBuiltinESMExports} from "node:module"; dns.resolve4=async()=>{await new Promise(r=>setTimeout(r,${delay}));throw Error("TEST_DNS_FAILURE");}; syncBuiltinESMExports();`,
  );
  return path;
}
async function waitActive(f) {
  for (let i = 0; i < 200; i++) {
    const db = sql(f);
    const row = db.prepare("SELECT * FROM relay_admissions").get();
    db.close();
    if (row) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("admission-not-observed");
}
test("real CLI binds config/generation, refuses duplicate enable, persists paused startup across restart", async (t) => {
  const f = fixture(t),
    a = await launch(f),
    first = await a.ready();
  assert.equal(first.state, "paused");
  assert.equal((await post(f, first)).status, 503);
  const db = sql(f);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM relay_admissions").get().n,
    0,
  );
  db.close();
  assert.equal(
    (await a.command("enable", null, { generation: "foreign" })).ok,
    false,
  );
  assert.equal(
    (await a.command("enable", null, { configurationSha256: "a".repeat(64) }))
      .ok,
    false,
  );
  assert.equal((await a.command("enable")).state, "enabled");
  assert.equal((await a.command("enable")).ok, false);
  assert.equal((await a.command("status")).state, "paused");
  assert.equal((await a.command("enable")).state, "enabled");
  assert.equal((await a.command("enable", null, { sequence: 1 })).ok, false);
  a.child.stdin.end();
  assert.equal((await a.next()).settled, true);
  assert.equal((await a.exit).code, 0);
  assert.equal(readFileSync(f.path, "utf8"), f.bytes);
  const b = await launch(f),
    second = await b.ready();
  assert.notEqual(second.generation, first.generation);
  assert.equal(second.state, "paused");
  assert.equal(
    (await b.command("enable", null, { generation: first.generation })).ok,
    false,
  );
  assert.equal((await b.command("stop")).settled, true);
  assert.equal((await b.exit).code, 0);
});
test("wrong config hash/startup and oversized control refuse without disclosing configuration", async (t) => {
  const f = fixture(t);
  assert.throws(() => loadRelayLaunchConfiguration(f.path, "0".repeat(64)));
  writeFileSync(f.path, JSON.stringify({ ...f.config, startup: "enabled" }));
  const hash = createHash("sha256").update(readFileSync(f.path)).digest("hex");
  assert.throws(() => loadRelayLaunchConfiguration(f.path, hash));
  writeFileSync(f.path, f.bytes);
  const a = await launch(f, { expected: "0".repeat(64) });
  assert.equal((await a.exit).code, 1);
  assert.equal(a.stderr.trim(), "RELAY_LAUNCHER_BLOCKED");
  const b = await launch(f);
  await b.ready();
  b.child.stdin.write("PRIVATE_SENTINEL".repeat(5000));
  const refusal = await b.next();
  assert.equal(refusal.code, "operator-input-unavailable");
  assert.equal((await b.next()).settled, true);
  assert.equal((await b.exit).code, 0);
  assert.ok(!b.stderr.includes("PRIVATE_SENTINEL"));
});
test("SIGTERM drains actual signed admission; pending local handler forbids recovery and result stays unknown", async (t) => {
  const f = fixture(t),
    a = await launch(f, { preload: preload(f, 700) }),
    ready = await a.ready();
  await a.command("enable");
  const response = post(f, ready);
  const before = await waitActive(f);
  assert.equal(before.state, "active");
  await a.command("pause");
  assert.equal((await a.command("plan-recovery")).ok, false);
  a.child.kill("SIGTERM");
  assert.equal((await a.next()).settled, true);
  assert.equal((await a.exit).code, 0);
  await response.catch(() => null);
  const db = sql(f),
    row = db.prepare("SELECT * FROM relay_admissions").get();
  assert.equal(row.id, before.id);
  assert.equal(row.operation_digest, before.operation_digest);
  assert.equal(row.admitted_ms, before.admitted_ms);
  assert.equal(row.replay_expires_ms, before.replay_expires_ms);
  assert.equal(row.state, "finished");
  assert.equal(row.outcome_kind, "unknown");
  assert.equal(row.http_status, null);
  db.close();
});
test("crash preserves actual admission; paused restart requires exact owner recovery and original-ID receipt readback", async (t) => {
  const f = fixture(t),
    a = await launch(f, { preload: preload(f, 30000) }),
    ready = await a.ready();
  await a.command("enable");
  const pending = post(f, ready).catch(() => null),
    before = await waitActive(f);
  a.child.kill("SIGKILL");
  await a.exit;
  await pending;
  await new Promise((r) => setTimeout(r, 1050));
  const b = await launch(f),
    restart = await b.ready();
  assert.equal(restart.state, "paused");
  assert.equal((await b.command("enable")).ok, false);
  const p = (await b.command("plan-recovery")).result;
  assert.equal(p.ok, true);
  assert.equal(p.plan.leases.length, 1);
  const operationId = `opr_${p.plan.createdAt}_${"b".repeat(32)}`;
  const request = {
    operationId,
    plan: p.plan,
    ownerRecord: {
      ownerId: "synthetic-owner",
      processGeneration: ready.generation,
      observedAt: p.plan.createdAt,
      planSha256: p.planSha256,
      evidenceSha256: "e".repeat(64),
      admissionsPaused: true,
      transportState: "stopped",
    },
  };
  assert.equal(
    (
      await b.command("apply-recovery", {
        ...request,
        ownerRecord: { ...request.ownerRecord, evidenceSha256: "" },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await b.command("apply-recovery", {
        ...request,
        ownerRecord: {
          ...request.ownerRecord,
          processGeneration: restart.generation,
        },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await b.command("apply-recovery", {
        ...request,
        plan: { ...request.plan, serviceId: "foreign-service" },
      })
    ).ok,
    false,
  );
  let db = sql(f);
  assert.equal(
    db.prepare("SELECT state FROM relay_admissions").get().state,
    "active",
  );
  db.close();
  // Deliberately disregard the apply response. Stop/restart and read ORIGINAL ID.
  assert.equal((await b.command("apply-recovery", request)).result.ok, true);
  await b.command("stop");
  await b.exit;
  const c = await launch(f);
  const current = await c.ready();
  const receipt = (await c.command("read-recovery", operationId)).result;
  assert.equal(receipt.state, "committed");
  assert.equal(receipt.receipt.outcome, "unknown");
  assert.equal(receipt.receipt.machineVerifiedTransportStop, false);
  assert.equal(
    (await c.command("apply-recovery", request)).result.receipt.operationId,
    receipt.receipt.operationId,
  );
  assert.equal((await c.command("enable")).state, "enabled");
  assert.equal((await post(f, current)).status, 409);
  assert.equal(
    (await c.command("read-recovery", `opr_1_${"f".repeat(32)}`)).result.state,
    "unknown",
  );
  db = sql(f);
  const after = db.prepare("SELECT * FROM relay_admissions").get();
  for (const k of [
    "id",
    "caller_hash",
    "request_hash",
    "operation_digest",
    "admitted_ms",
    "replay_expires_ms",
    "lease_expires_ms",
  ])
    assert.equal(after[k], before[k]);
  assert.equal(after.state, "finished");
  assert.equal(after.outcome_kind, "unknown");
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM relay_operator_receipts").get().n,
    1,
  );
  db.close();
  await c.command("stop");
  await c.exit;
});

test("control output loss closes admission; no recovery success is inferred from a missing response", async (t) => {
  const f = fixture(t),
    a = await launch(f),
    ready = await a.ready();
  await a.command("enable");
  a.child.stdout.destroy();
  a.child.stdin.write(
    `${JSON.stringify({
      version: 1,
      generation: ready.generation,
      configurationSha256: f.hash,
      sequence: 2,
      action: "status",
      payload: null,
    })}\n`,
  );
  assert.equal((await a.exit).code, 0);
  const b = await launch(f);
  assert.equal((await b.ready()).state, "paused");
  const db = sql(f);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM relay_admissions").get().n,
    0,
  );
  db.close();
  await b.command("stop");
  await b.exit;
});
test("SIGINT and truncated EOF drain paused listeners without treating malformed input as approval", async (t) => {
  const f = fixture(t),
    a = await launch(f);
  await a.ready();
  a.child.kill("SIGINT");
  assert.equal((await a.next()).settled, true);
  assert.equal((await a.exit).code, 0);
  const b = await launch(f);
  await b.ready();
  b.child.stdin.end('{"action":"enable"');
  assert.equal((await b.next()).code, "operator-input-unavailable");
  assert.equal((await b.next()).settled, true);
  assert.equal((await b.exit).code, 0);
  const db = sql(f);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM relay_admissions").get().n,
    0,
  );
  db.close();
});

test("lost close result is unknown after real listener/store shutdown; no successful stop receipt or implicit retry", async (t) => {
  const f = fixture(t),
    input = new PassThrough(),
    output = new PassThrough(),
    messages = [];
  let closes = 0;
  output.on("data", (bytes) => {
    const m = JSON.parse(bytes.toString().trim());
    messages.push(m);
    if (m.state === "paused")
      input.write(
        `${JSON.stringify({
          version: 1,
          generation: m.generation,
          configurationSha256: f.hash,
          sequence: 1,
          action: "stop",
          payload: null,
        })}\n`,
      );
  });
  const stopped = await runRelayLauncher({
    configuration: loadRelayLaunchConfiguration(f.path, f.hash),
    input,
    output,
    signals: new EventEmitter(),
    createApplication: (options) => {
      const app = createRelayApplication(options);
      return {
        ...app,
        async close() {
          closes++;
          await app.close();
          throw Error("PRIVATE_CLOSE_RESULT_LOST");
        },
      };
    },
  });
  assert.equal(stopped, false);
  assert.equal(closes, 1);
  assert.equal(messages.at(-1).state, "unknown");
  assert.equal(messages.at(-1).settled, false);
  assert.ok(messages.every((m) => m.state !== "stopped"));
  assert.ok(!JSON.stringify(messages).includes("PRIVATE_CLOSE"));
  const db = sql(f);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM relay_admissions").get().n,
    0,
  );
  db.close();
});
