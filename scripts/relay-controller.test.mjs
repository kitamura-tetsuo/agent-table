import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import test from "node:test";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";
import { relayControl } from "./relay-control.mjs";
import { runRelayController } from "./relay-controller.mjs";
import { loadRelayLaunchConfiguration } from "./relay-launcher.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-controller-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
    ],
    { stdio: "ignore" },
  );
  chmodSync(join(dir, "key"), 0o600);
  const config = {
    version: 1,
    startup: "paused",
    environment: "test",
    serviceId: "synthetic-relay",
    databasePath: join(dir, "state.sqlite"),
    port: 0,
    tlsKeyPath: join(dir, "key"),
    tlsCertPath: join(dir, "cert"),
    callers: [
      {
        callerId: "synthetic-worker-1",
        publicKeySpki: Buffer.from(
          "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
          "hex",
        ).toString("base64"),
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
  const text = JSON.stringify(config);
  writeFileSync(join(dir, "relay.json"), text, { mode: 0o600 });
  return {
    dir,
    config,
    configuration: loadRelayLaunchConfiguration(
      join(dir, "relay.json"),
      createHash("sha256").update(text).digest("hex"),
    ),
    socketPath: join(dir, "control.sock"),
  };
}
async function start(f) {
  const output = new PassThrough(),
    signals = new EventEmitter(),
    ready = once(output, "data");
  const done = runRelayController({ ...f, output, signals });
  const [chunk] = await ready;
  const receipt = JSON.parse(chunk.toString().trim());
  return {
    done,
    signals,
    receipt,
    output,
    command: (sequence, action, payload = null) =>
      relayControl(f.socketPath, {
        version: 1,
        generation: receipt.generation,
        configurationSha256: receipt.configurationSha256,
        sequence,
        action,
        payload,
      }),
  };
}
function rows(path) {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT * FROM relay_admissions ORDER BY id").all();
  } finally {
    db.close();
  }
}
test("private controller keeps stdin, requires exact commands, and restarts paused without clearing uncertain identity", async (t) => {
  const f = fixture(t),
    store = openRelayAdmissionStore(f.config.databasePath, {
      ...f.config.admission,
      environment: "test",
      serviceId: f.config.serviceId,
    });
  assert.equal(
    store.acquire({
      callerId: "synthetic-worker-1",
      requestId: "synthetic-unknown-1",
      expiresAt: Date.now() + 60000,
      operationDigest: "b".repeat(64),
    }).ok,
    true,
  );
  store.close();
  const original = rows(f.config.databasePath);
  assert.equal(original.length, 1);
  const c = await start(f);
  assert.equal(c.receipt.state, "paused");
  assert.equal(lstatSync(f.socketPath).mode & 0o777, 0o600);
  assert.equal(
    (await relayControl(f.socketPath, { action: "inspect" })).sequence,
    0,
  );
  await assert.rejects(
    runRelayController({
      ...f,
      signals: new EventEmitter(),
      output: new PassThrough(),
    }),
  );
  assert.equal((await c.command(1, "enable")).state, "enabled");
  assert.equal((await c.command(1, "enable")).ok, false); // duplicate does not auto-resequence
  assert.equal((await c.command(2, "status")).state, "paused");
  assert.equal((await c.command(3, "enable")).state, "enabled");
  c.signals.emit("SIGTERM");
  assert.equal(await c.done, true);
  assert.equal(existsSync(f.socketPath), false);
  assert.deepEqual(rows(f.config.databasePath), original);
  const restarted = await start(f);
  assert.notEqual(restarted.receipt.generation, c.receipt.generation);
  assert.equal(restarted.receipt.state, "paused");
  const foreign = await relayControl(f.socketPath, {
    version: 1,
    generation: c.receipt.generation,
    configurationSha256: c.receipt.configurationSha256,
    sequence: 99,
    action: "enable",
    payload: null,
  });
  assert.equal(foreign.ok, false);
  assert.equal((await restarted.command(1, "status")).state, "paused");
  assert.equal((await restarted.command(2, "stop")).settled, true);
  assert.equal(await restarted.done, true);
  assert.deepEqual(rows(f.config.databasePath), original);
});
test("operator disconnect never automatically retries a command", async (t) => {
  const f = fixture(t),
    c = await start(f);
  const socket = connect(f.socketPath);
  await once(socket, "connect");
  socket.write(
    JSON.stringify({
      version: 1,
      generation: c.receipt.generation,
      configurationSha256: c.receipt.configurationSha256,
      sequence: 1,
      action: "enable",
      payload: null,
    }) + "\n",
  );
  socket.destroy();
  // If effect completed before disconnect, perform an explicit status read; no retry.
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (existsSync(f.socketPath)) {
    const inspected = await relayControl(f.socketPath, { action: "inspect" });
    assert.ok(inspected.sequence <= 1);
    c.signals.emit("SIGTERM");
  }
  assert.equal(await c.done, true);
  assert.equal(existsSync(f.socketPath), false);
});
test("unsafe/shared control directory and stale socket are refused without deleting them", async (t) => {
  const f = fixture(t);
  chmodSync(f.dir, 0o755);
  await assert.rejects(
    runRelayController({
      ...f,
      signals: new EventEmitter(),
      output: new PassThrough(),
    }),
  );
  chmodSync(f.dir, 0o700);
  writeFileSync(f.socketPath, "sentinel");
  await assert.rejects(
    runRelayController({
      ...f,
      signals: new EventEmitter(),
      output: new PassThrough(),
    }),
  );
  assert.equal(readFileSync(f.socketPath, "utf8"), "sentinel");
});
test("Compose has no public control/host port and ingress shares the relay namespace with verified origin TLS", () => {
  const compose = readFileSync("deploy/relay/compose.yml", "utf8"),
    ingress = readFileSync("deploy/relay/cloudflared.example.yml", "utf8"),
    docker = readFileSync("deploy/relay/Dockerfile", "utf8");
  assert.match(compose, /network_mode: service:relay/);
  assert.doesNotMatch(
    compose,
    /ports:|network_mode: host|docker.sock|privileged: true/,
  );
  assert.match(compose, /read_only: true/);
  assert.match(compose, /mode=0700/);
  assert.match(compose, /restart: "no"/);
  assert.match(ingress, /https:\/\/127.0.0.1:9444/);
  assert.match(ingress, /originServerName:/);
  assert.match(ingress, /caPool:/);
  assert.doesNotMatch(ingress, /noTLSVerify/);
  assert.match(ingress, /http_status:404/);
  assert.match(docker, /USER 10001:10001/);
});

test("unavailable controller output drains launcher intake", async (t) => {
  const f = fixture(t),
    c = await start(f);
  assert.equal((await c.command(1, "enable")).state, "enabled");
  c.output.destroy(Error("controlled output loss"));
  assert.equal(await c.done, true);
  assert.equal(existsSync(f.socketPath), false);
});

test("detached-container stdin EOF does not enable or terminate the controller; real SIGTERM drains", async (t) => {
  const f = fixture(t);
  const runtime = join(f.dir, "runtime");
  mkdirSync(runtime);
  for (const name of ["package.json", ".node-version"])
    copyFileSync(name, join(runtime, name));
  for (const [dir, suffix] of [
    ["scripts", ".mjs"],
    ["src", ".ts"],
  ])
    cpSync(dir, join(runtime, dir), {
      recursive: true,
      filter: (path) => statSync(path).isDirectory() || path.endsWith(suffix),
    });
  const child = spawn(
    process.execPath,
    [
      "scripts/relay-controller.mjs",
      "--config",
      join(f.dir, "relay.json"),
      "--expected-config-sha256",
      f.configuration.configurationSha256,
      "--socket",
      f.socketPath,
    ],
    { cwd: runtime, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  let stdout = "",
    stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const ready = new Promise((yes, no) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("\n")) yes(JSON.parse(stdout.split("\n")[0]));
    });
    child.once("exit", () => no(Error("controller exited before readiness")));
  });
  const first = await ready;
  assert.equal(first.state, "paused");
  const command = {
    version: 1,
    generation: first.generation,
    configurationSha256: first.configurationSha256,
    sequence: 1,
    action: "enable",
    payload: null,
  };
  assert.equal((await relayControl(f.socketPath, command)).state, "enabled");
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(existsSync(f.socketPath), false);
  const final = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(final.controllerStopped, true);
  assert.equal(final.settled, true);
  assert.doesNotMatch(stdout, /callback.example|publicKeySpki|tlsKeyPath/);
});

for (const loss of ["close", "finish"])
  test(`controller ${loss} without error stops enabled intake`, async (t) => {
    const f = fixture(t),
      c = await start(f);
    assert.equal((await c.command(1, "enable")).state, "enabled");
    if (loss === "close") c.output.destroy();
    else c.output.end();
    assert.equal(await c.done, true);
    assert.equal(existsSync(f.socketPath), false);
  });
test("SIGTERM during Unix listen does not leave a control listener or enabled launcher", async (t) => {
  const f = fixture(t),
    signals = new EventEmitter();
  let server;
  await assert.rejects(
    runRelayController({
      ...f,
      signals,
      output: new PassThrough(),
      createControlServer: (options, handler) => {
        server = createServer(options, handler);
        server.once("listening", () => signals.emit("SIGTERM"));
        return server;
      },
    }),
  );
  assert.equal(server.listening, false);
  assert.equal(existsSync(f.socketPath), false);
});
