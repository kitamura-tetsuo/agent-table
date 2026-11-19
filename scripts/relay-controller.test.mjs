import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRelayApplication } from "./egress-relay-application.mjs";
import { relayMessageSigningBytes } from "./egress-relay-ingress-prototype.mjs";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";
import { relayControl } from "./relay-control.mjs";
import { runRelayController } from "./relay-controller.mjs";
import { loadRelayLaunchConfiguration } from "./relay-launcher.mjs";
import { attemptLocalSteadyRestart } from "./relay-steady-local-adapter.mjs";
import {
  inspectSteadyRestartLedger,
  resumeAuthorizedSteadyRelay,
} from "./relay-steady-restart.mjs";

function fixture(t, environment = "test", publicKey) {
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
    environment,
    serviceId: "synthetic-relay",
    databasePath: join(dir, "state.sqlite"),
    port: 0,
    tlsKeyPath: join(dir, "key"),
    tlsCertPath: join(dir, "cert"),
    callers: [
      {
        callerId: "synthetic-worker-1",
        publicKeySpki:
          publicKey
            ?.export({ format: "der", type: "spki" })
            .toString("base64") ??
          Buffer.from(
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

test("steady restart candidate uses actual private controller and persistent ledger", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const f = fixture(t, "production", keys.publicKey);
  const received = [];
  const key = readFileSync(join(f.dir, "key")),
    cert = readFileSync(join(f.dir, "cert"));
  const receiver = createHttpsServer({ key, cert }, (req, res) => {
    const bytes = [];
    req.on("data", (chunk) => bytes.push(chunk));
    req.on("end", () => {
      received.push(Buffer.concat(bytes).toString("utf8"));
      res.writeHead(204);
      res.end();
    });
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => new Promise((done) => receiver.close(done)));
  const localPost = (port, path, bytes, headers = {}) =>
    new Promise((yes, no) => {
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "POST",
          servername: "relay.example.org",
          ca: cert,
          agent: false,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            yes({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", no);
        },
      );
      req.on("error", no);
      req.setTimeout(3000, () => req.destroy(Error("controlled-test-timeout")));
      req.end(bytes);
    });
  // Module-only controlled HTTPS seam; the Docker CLI never supplies it.
  f.createApplication = (options) =>
    createRelayApplication(options, {
      async messageTransport(destination, _targets, body) {
        assert.equal(destination, "https://callback.example.org/events");
        const observed = await localPost(
          receiver.address().port,
          "/events",
          body,
        );
        return {
          kind: "http",
          status: observed.status,
          retryAfterState: "absent",
        };
      },
    });
  function signedEvent(port, requestId, eventId, signingKey = keys.privateKey) {
    const caller = "synthetic-worker-1";
    const body = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "message",
        audience: "production:synthetic-relay",
        requestId,
        timestamp: Date.now(),
        destination: "https://callback.example.org/events",
        headers: {},
        payload: Buffer.from(JSON.stringify({ eventId })).toString("base64"),
      }),
    );
    return localPost(port, "/relay/v1/message", body, {
      "content-type": "application/json",
      "x-agent-table-caller": caller,
      "x-agent-table-signature": sign(
        null,
        relayMessageSigningBytes(body, caller),
        signingKey,
      ).toString("base64"),
    });
  }
  const ownerDirectory = join(f.dir, "owner");
  mkdirSync(ownerDirectory, { mode: 0o700 });
  writeFileSync(join(ownerDirectory, "inhibit"), "clear\n", { mode: 0o600 });
  f.steadyOwnerDirectory = ownerDirectory;
  let controller = await start(f);
  t.after(async () => {
    controller.signals.emit("SIGTERM");
    await controller.done;
  });
  const initial = inspectSteadyRestartLedger(f.config.databasePath);
  const firstGeneration = controller.receipt.generation;
  assert.equal((await controller.command(1, "enable")).state, "enabled");
  controller.signals.emit("SIGTERM");
  assert.equal(await controller.done, true);
  controller = await start(f);
  assert.notEqual(controller.receipt.generation, firstGeneration);
  const inspect = () => relayControl(f.socketPath, { action: "inspect" });
  const a = {
    mode: "steady",
    environment: "production",
    serviceId: f.config.serviceId,
    imageDigest: "synthetic-fixture-image",
    configurationSha256: controller.receipt.configurationSha256,
    storeId: initial.storeId,
  };
  const observe = async () => ({
    authorization: a,
    operator: { inhibit: "clear" },
    host: {
      ...a,
      ...(await inspect()),
      ...inspectSteadyRestartLedger(f.config.databasePath),
      // Test-only host attestations, not evidence of Docker/tunnel fencing.
      priorTransportsStopped: true,
      namespaceVerified: true,
      tlsVerified: true,
    },
  });
  const claimed = new Set();
  const params = {
    withOwnerLock: (fn) => fn(),
    observe,
    markGenerationAttempted: (id) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    enable: (command) => relayControl(f.socketPath, command),
    inspect,
  };
  const negatives = [
    ({ operator }) => (operator.inhibit = "paused"),
    ({ operator }) => (operator.inhibit = "quarantined"),
    ({ host }) => (host.priorTransportsStopped = false),
    ({ host }) => (host.storeId = "replacement"),
    ({ host }) => (host.configurationSha256 = "different"),
    ({ host }) => (host.activeAdmissions = 1),
    ({ host }) => (host.unresolvedOutcomes = 1),
  ];
  for (const change of negatives) {
    const bad = await observe();
    change(bad);
    assert.deepEqual(
      await resumeAuthorizedSteadyRelay({
        ...params,
        observe: async () => bad,
      }),
      { state: "paused", enabled: false },
    );
  }
  assert.equal((await inspect()).sequence, 0);
  assert.equal(claimed.size, 0);
  assert.equal(
    (
      await signedEvent(
        controller.receipt.port,
        "synthetic-paused-1",
        "while-paused",
      )
    ).status,
    503,
  );
  assert.deepEqual(received, []);
  assert.deepEqual(rows(f.config.databasePath), []);
  const adapter = {
    ownerDirectory,
    socketPath: f.socketPath,
    databasePath: f.config.databasePath,
    readAuthorizedBinding: () => a,
    observeHostBoundary: (identity) => ({
      ...a,
      ...identity,
      priorTransportsStopped: true,
      namespaceVerified: true,
      tlsVerified: true,
    }),
  };
  assert.deepEqual(await attemptLocalSteadyRestart(adapter), {
    state: "enabled",
    enabled: true,
  });
  assert.equal((await inspect()).sequence, 1);
  assert.equal((await inspect()).state, "enabled");
  assert.deepEqual(received, [], "recovery did not replay the paused event");
  const wrongKey = generateKeyPairSync("ed25519").privateKey;
  const rejected = await signedEvent(
    controller.receipt.port,
    "synthetic-rejected-1",
    "invalid-signature",
    wrongKey,
  );
  assert.equal(rejected.status, 401);
  const delivered = await signedEvent(
    controller.receipt.port,
    "synthetic-fresh-1",
    "fresh-after-ready",
  );
  assert.equal(delivered.status, 200);
  assert.equal(JSON.parse(delivered.body).outcome.status, 204);
  assert.deepEqual(received.map(JSON.parse), [
    { eventId: "fresh-after-ready" },
  ]);
  assert.equal(rows(f.config.databasePath).length, 1);
  assert.equal((await attemptLocalSteadyRestart(adapter)).enabled, false);
  assert.equal((await inspect()).sequence, 1);
  assert.equal((await controller.command(2, "pause")).state, "paused");
  assert.equal(
    readFileSync(join(ownerDirectory, "inhibit"), "utf8"),
    "paused\n",
  );
  controller.signals.emit("SIGTERM");
  assert.equal(await controller.done, true);
  controller = await start(f);
  assert.equal((await attemptLocalSteadyRestart(adapter)).enabled, false);
  assert.equal((await inspect()).state, "paused");
  assert.equal((await inspect()).sequence, 0);
  assert.equal(
    (await controller.command(1, "enable")).code,
    "steady-inhibited",
  );
  assert.deepEqual(inspectSteadyRestartLedger(f.config.databasePath), initial);
});
