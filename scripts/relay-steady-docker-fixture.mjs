/**
 * Provisions and destroys a synthetic, egress-isolated Docker pair.
 * Run only on a dedicated Linux Docker runner; no registry pulls.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupFixtureJournal,
  readFixtureJournal,
  writeFixtureJournal,
} from "./relay-steady-docker-cleanup.mjs";
import { validIncarnation } from "./relay-steady-incarnation.mjs";
import { inspectSteadyRestartLedger } from "./relay-steady-restart.mjs";
import { readPinnedNodeVersion } from "./runtime-updates.mjs";

const [image] = process.argv.slice(2);
assert.equal(
  process.argv.length,
  3,
  "usage: relay-steady-docker-fixture.mjs sha256:<existing fixture image ID>",
);
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const docker = (...args) =>
  execFileSync(
    "/usr/bin/docker",
    ["--host", "unix:///var/run/docker.sock", ...args],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  ).trim();
const [inspectImage] = JSON.parse(docker("image", "inspect", image));
assert.equal(inspectImage.Id, image);
assert.deepEqual(inspectImage.Config.Entrypoint, [
  "node",
  "scripts/relay-controller.mjs",
]);
assert.equal(inspectImage.Config.WorkingDir, "/app");

const token = randomBytes(6).toString("hex"),
  prefix = "at78-fixture-" + token;
const dir = "/tmp/" + prefix,
  state = join(dir, "state");
const config = join(dir, "config"),
  ingressConfig = join(dir, "ingress");
const owner = join(state, "steady-owner"),
  db = join(state, "admission.sqlite");
const relayName = prefix + "-relay",
  ingressName = prefix + "-ingress";
const label = "agent-table.test-scope=isolated-restart-78";
const tokenLabel = `agent-table.fixture-id=${token}`;
const journal = {
  version: 1,
  token,
  primary: "running",
  cleanup: "pending",
  resources: {
    network: { state: "unstarted" },
    relay: { state: "unstarted" },
    ingress: { state: "unstarted" },
  },
};
let journalPath;
function trackCreate(role, create) {
  checkCancelled();
  journal.resources[role] = { state: "pending" };
  writeFixtureJournal(journalPath, journal);
  const id = create();
  assert.match(id, /^[a-f0-9]{64}$/);
  journal.resources[role] = { state: "known", id };
  writeFixtureJournal(journalPath, journal);
  return id;
}
const port = 19444,
  bridgePort = 19445,
  uid = process.getuid(),
  gid = process.getgid();
let network, proxy, proxyDest;
const sockets = new Set();
const timeout = (ms) => new Promise((done) => setTimeout(done, ms));
const scoped = (id) => {
  const [actual] = JSON.parse(docker("inspect", "--type", "container", id));
  assert.equal(actual.Id, id);
  assert.equal(
    actual.Config.Labels?.["agent-table.test-scope"],
    "isolated-restart-78",
  );
  assert.equal(actual.Config.Labels?.["agent-table.fixture-id"], token);
  return actual;
};
function incarnation(id) {
  const actual = scoped(id);
  assert(actual.State.Running);
  const pid = actual.State.Pid,
    proc = "/proc/" + pid;
  const text = readFileSync(proc + "/stat", "utf8");
  const start = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(" ")[19];
  const ns = statSync(proc + "/ns/net");
  const observed = {
    id,
    pid,
    start,
    namespace: ns.dev + ":" + ns.ino,
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    cgroup: readFileSync(proc + "/cgroup", "utf8"),
  };
  assert(validIncarnation(observed));
  return observed;
}

let fixtureFailure,
  cleanupFailed = false;
let child,
  interrupted = false;
function stopFixture() {
  interrupted = true;
  child?.kill("SIGTERM");
}
process.once("SIGTERM", stopFixture);
process.once("SIGINT", stopFixture);
function checkCancelled() {
  if (interrupted) throw Error("isolated fixture interrupted");
}
try {
  mkdirSync(dir, { mode: 0o700 });
  journalPath =
    process.env.AGENT_TABLE_RESTART78_MANIFEST ??
    join(mkdtempSync("/tmp/at78-journal-"), "manifest.json");
  writeFixtureJournal(journalPath, journal, true);
  for (const path of [state, config, ingressConfig, owner])
    mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(owner, "inhibit"), "clear\n", { mode: 0o600 });
  const key = join(config, "origin.key"),
    cert = join(config, "origin.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  chmodSync(key, 0o600);
  const { publicKey } = generateKeyPairSync("ed25519");
  // The private key and public network are not used by this startup oracle.
  const runtime = {
    version: 1,
    startup: "paused",
    environment: "production",
    serviceId: prefix,
    databasePath: "/state/admission.sqlite",
    port,
    tlsKeyPath: "/config/origin.key",
    tlsCertPath: "/config/origin.crt",
    callers: [
      {
        callerId: "isolated-fixture-sender",
        publicKeySpki: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
        targets: [
          { origin: "https://receiver.example.org", pathPrefix: "/events" },
        ],
      },
    ],
    admission: {
      perMinute: 10,
      globalPerMinute: 100,
      concurrency: 2,
      leaseMs: 15000,
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
  const bytes = JSON.stringify(runtime);
  const configHash = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(config, "relay.json"), bytes, { mode: 0o600 });

  network = trackCreate("network", () =>
    docker(
      "network",
      "create",
      "--internal",
      "--label",
      label,
      "--label",
      tokenLabel,
      prefix,
    ),
  );
  const shared = [
    "--label",
    label,
    "--label",
    tokenLabel,
    "--pull",
    "never",
    "--read-only",
    "--restart",
    "no",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    uid + ":" + gid,
  ];
  const relay = trackCreate("relay", () =>
    docker(
      "create",
      ...shared,
      "--name",
      relayName,
      "--network",
      network,
      "--env",
      "RELAY_STEADY_OWNER_DIR=/state/steady-owner",
      "--mount",
      "type=bind,src=" + state + ",dst=/state",
      "--mount",
      "type=bind,src=" + config + ",dst=/config,readonly",
      "--tmpfs",
      "/run/agent-table-relay:rw,noexec,nosuid,nodev,mode=0700,uid=" +
        uid +
        ",gid=" +
        gid,
      image,
      "--config",
      "/config/relay.json",
      "--expected-config-sha256",
      configHash,
      "--socket",
      "/run/agent-table-relay/control.sock",
    ),
  );
  docker("start", relay);
  assert.equal(
    docker("exec", relay, "node", "--version"),
    `v${readPinnedNodeVersion()}`,
  );
  for (let i = 0; !inspectSteadyRestartLedgerIfReady() && i < 40; i++)
    await timeout(150);
  function inspectSteadyRestartLedgerIfReady() {
    try {
      return (
        JSON.parse(
          docker(
            "exec",
            relay,
            "node",
            "scripts/relay-control.mjs",
            "--socket",
            "/run/agent-table-relay/control.sock",
            "--inspect",
          ),
        ).state === "paused"
      );
    } catch {
      return false;
    }
  }
  assert(
    inspectSteadyRestartLedgerIfReady(),
    "original controller did not start paused",
  );
  const forwarding = [
    "const net=require('node:net');",
    "net.createServer(a=>{const b=net.connect(" + port + ",'127.0.0.1');",
    "a.on('error',()=>b.destroy()); b.on('error',()=>a.destroy()); a.pipe(b).pipe(a);})",
    ".listen(" + bridgePort + ",'0.0.0.0');",
  ].join("");
  const ingressCommand = ["-e", forwarding];
  const ingress = trackCreate("ingress", () =>
    docker(
      "create",
      ...shared,
      "--name",
      ingressName,
      "--network",
      "container:" + relay,
      "--entrypoint",
      "node",
      "--mount",
      "type=bind,src=" + ingressConfig + ",dst=/config,readonly",
      image,
      ...ingressCommand,
    ),
  );
  docker("start", ingress);
  const previous = [incarnation(relay), incarnation(ingress)];
  assert.equal(previous[0].namespace, previous[1].namespace);
  const ledger = inspectSteadyRestartLedger(db);
  checkCancelled();
  // Simulate exactly one crash: the old enrolled ingress remains running.
  // The local supervisor must verify and retire it before bringing up the pair.
  docker("kill", "--signal", "KILL", relay);
  assert.equal(scoped(relay).State.Running, false);
  assert.equal(scoped(ingress).State.Running, true);

  // A loopback TCP passthrough reaches only the synthetic Docker bridge and
  // forwards original TLS bytes; no port is published by either container.
  proxy = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    let target;
    try {
      const current = scoped(relay);
      const ip = Object.values(current.NetworkSettings.Networks)[0]?.IPAddress;
      assert(current.State.Running && /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      target = connect(bridgePort, ip);
      sockets.add(target);
      target.once("close", () => sockets.delete(target));
      target.on("error", () => client.destroy());
      client.on("error", () => target.destroy());
      client.pipe(target).pipe(client);
    } catch {
      client.destroy();
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  proxyDest = "https://127.0.0.1:" + proxy.address().port;
  const plan = join(dir, "enrollment.json");
  writeFileSync(
    plan,
    JSON.stringify({
      version: 1,
      mode: "steady",
      environment: "production",
      serviceId: prefix,
      relayName,
      ingressName,
      imageDigest: image,
      ingressImageDigest: image,
      ingressEntrypoint: ["node"],
      ingressCommand,
      ingressWorkingDir: "/app",
      configurationSha256: configHash,
      storeId: ledger.storeId,
      priorIncarnations: previous,
      ownerDirectory: owner,
      databasePath: db,
      stateSource: state,
      configSource: config,
      ingressConfigSource: ingressConfig,
      routeOrigin: proxyDest,
      routeStatusUrl: proxyDest + "/relay/v1/status",
    }),
    { mode: 0o600 },
  );
  const harness = join(
    dirname(fileURLToPath(import.meta.url)),
    "relay-steady-docker-harness.mjs",
  );
  checkCancelled();
  child = spawn(process.execPath, [harness, plan], {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
  });
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null);
  assert.equal(code, 0);
  checkCancelled();
} catch (error) {
  fixtureFailure = error;
} finally {
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise((done) => proxy.close(done));
  if (journalPath) {
    try {
      // Reload durable state first: do not declare an unsaved ID known or
      // overwrite an older, conservative pending checkpoint.
      const saved = readFixtureJournal(journalPath);
      saved.primary = interrupted
        ? "interrupted"
        : fixtureFailure
          ? "failed"
          : "passed";
      writeFixtureJournal(journalPath, saved);
      const result = cleanupFixtureJournal(journalPath);
      console.log(JSON.stringify(result));
      cleanupFailed = result.cleanup !== "complete";
    } catch {
      cleanupFailed = true;
    }
  }
}
if (cleanupFailed)
  throw new AggregateError(
    fixtureFailure ? [fixtureFailure] : [],
    "isolated Docker fixture cleanup incomplete",
  );
process.off("SIGTERM", stopFixture);
process.off("SIGINT", stopFixture);
if (fixtureFailure) throw fixtureFailure;
