import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTunnelLogCapture,
  observeReadiness,
  retainObservation,
  sanitizeTunnelLogs,
} from "./relay-readiness-diagnostics.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const secret = "DO_NOT_RETAIN_secret_callback_token_123";
const base = {
  hostname: "fixture.example",
  mode: "fixture",
  tunnelId: id,
  resolve: async () => ["127.0.0.1"],
  tunnelRead: async () => ({ id, status: "healthy", token: secret }),
  logRead: async () =>
    JSON.stringify({
      level: "info",
      message: "Registered tunnel connection",
      authorization: secret,
    }),
};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "relay-readiness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
      "/CN=fixture.example",
      "-addext",
      "subjectAltName=DNS:fixture.example",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(join(dir, "cert.pem")),
    key = await readFile(join(dir, "key.pem"));
  let handler = (_req, res) => {
    res.writeHead(404);
    res.end('{"code":"unavailable"}');
  };
  const server = https.createServer({ cert, key }, (req, res) =>
    handler(req, res),
  );
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    dir,
    cert,
    port: server.address().port,
    setHandler(h) {
      handler = h;
    },
  };
}

test("real isolated TLS/HTTP observation persists safely and cannot claim live acceptance", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  f.setHandler((req, res) => {
    requests++;
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/");
    assert.equal(req.headers.authorization, undefined);
    res.setHeader("set-cookie", secret);
    res.writeHead(404);
    res.end('{"code":"unavailable"}');
  });
  const o = await observeReadiness({ ...base, port: f.port, ca: f.cert });
  assert.equal(o.ready, true);
  assert.equal(o.productionAcceptance, false);
  assert.equal(o.mode, "fixture");
  assert.equal(o.tls.state, "verified");
  assert.equal(o.tls.peerAddress, "127.0.0.1");
  assert.equal(o.http.status, 404);
  assert.equal(o.http.expectedBody, true);
  assert.equal(requests, 1);
  const path = join(f.dir, "observation.json");
  await retainObservation(path, o);
  const raw = await readFile(path, "utf8");
  assert.ok(!raw.includes(secret));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.throws(() => (o.extra = secret));
  await assert.rejects(retainObservation(path, o), { code: "EEXIST" });
  await assert.rejects(
    retainObservation(join(f.dir, "forged.json"), { ...o, extra: secret }),
    /invalid-observation/,
  );
});

test("DNS failure, private/public mixed answers, oversize and late DNS never dial", async () => {
  for (const resolve of [
    async () => {
      throw Object.assign(new Error(secret), { code: "ENOTFOUND" });
    },
    async () => ["1.1.1.1", "127.0.0.1"],
    async () => Array(65).fill("1.1.1.1"),
    () => new Promise((r) => setTimeout(() => r(["1.1.1.1"]), 40)),
  ]) {
    const o = await observeReadiness({
      ...base,
      mode: "approved-live",
      resolve,
      timeoutMs: 10,
    });
    assert.equal(o.ready, false);
    assert.equal(o.http.state, "unknown");
    assert.ok(!JSON.stringify(o).includes(secret));
  }
});

test("TLS untrusted issuer and wrong hostname fail before HTTP", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  f.setHandler((_q, r) => {
    requests++;
    r.end(secret);
  });
  const untrusted = await observeReadiness({ ...base, port: f.port });
  assert.equal(untrusted.ready, false);
  assert.equal(untrusted.http.state, "unknown");
  assert.equal(untrusted.errorCode, "DEPTH_ZERO_SELF_SIGNED_CERT");
  const wrong = await observeReadiness({
    ...base,
    hostname: "wrong.example",
    port: f.port,
    ca: f.cert,
  });
  assert.equal(wrong.ready, false);
  assert.equal(wrong.errorCode, "ERR_TLS_CERT_ALTNAME_INVALID");
  assert.equal(requests, 0);
});

test("redirect, wrong body, oversize, timeout and aborted response remain failed/unknown", async (t) => {
  const f = await fixture(t);
  for (const [name, handler] of [
    [
      "redirect",
      (_q, r) => {
        r.writeHead(302, { location: `https://secret.example/${secret}` });
        r.end();
      },
    ],
    [
      "wrong-body",
      (_q, r) => {
        r.writeHead(404);
        r.end(secret);
      },
    ],
    [
      "oversize",
      (_q, r) => {
        r.writeHead(404);
        r.end("x".repeat(5000) + secret);
      },
    ],
    ["timeout", () => {}],
    [
      "aborted",
      (_q, r) => {
        r.writeHead(404, { "content-length": "100" });
        r.write("x");
        r.destroy();
      },
    ],
  ]) {
    f.setHandler(handler);
    const o = await observeReadiness({
      ...base,
      port: f.port,
      ca: f.cert,
      timeoutMs: 100,
    });
    assert.equal(o.ready, false, name);
    if (name === "redirect") assert.equal(o.http.status, 302);
    if (name === "wrong-body") {
      assert.equal(o.http.status, 404);
      assert.equal(o.http.expectedBody, false);
      assert.equal(o.http.bodySha256, null);
    }
    if (name === "timeout") assert.equal(o.errorCode, "ETIMEDOUT");
    assert.ok(!JSON.stringify(o).includes(secret));
  }
});

test("unknown, foreign, down or unavailable provider/log evidence cannot yield readiness", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { tunnelRead: async () => ({ id: "foreign", status: "healthy", secret }) },
    { tunnelRead: async () => ({ id, status: `invented-${secret}` }) },
    { tunnelRead: async () => ({ id, status: "down" }) },
    {
      tunnelRead: async () => {
        throw new Error(secret);
      },
    },
    { tunnelRead: () => new Promise(() => {}) },
    {
      logRead: async () => {
        throw new Error(secret);
      },
    },
    { logRead: async () => "x".repeat(65537) + secret },
  ]) {
    const o = await observeReadiness({
      ...base,
      port: f.port,
      ca: f.cert,
      timeoutMs: 100,
      ...patch,
    });
    assert.equal(o.ready, false);
    assert.ok(!JSON.stringify(o).includes(secret));
  }
});

test("Tunnel logs retain fixed categories only; raw secrets, control characters and malformed text are dropped", () => {
  const o = sanitizeTunnelLogs(
    [
      JSON.stringify({
        level: "error",
        message: secret,
        Authorization: secret,
        url: `https://u:${secret}@x`,
      }),
      JSON.stringify({
        level: secret,
        message: "Registered tunnel connection",
      }),
      `private ${secret}`,
    ].join("\n"),
  );
  assert.equal(o.state, "observed");
  assert.deepEqual(o.events, [
    { level: "error", event: "unclassified" },
    { level: "unknown", event: "connection_registered" },
    { level: "unknown", event: "unclassified" },
  ]);
  assert.ok(!JSON.stringify(o).includes(secret));
  assert.equal(
    sanitizeTunnelLogs(Array(129).fill("{}").join("\n")).state,
    "unknown",
  );
});

test("malformed target and live fixture privileges are rejected before adapters execute", async () => {
  for (const patch of [
    { hostname: "u:secret@example.org" },
    { hostname: `example.org/?token=${secret}` },
    { hostname: "127.0.0.1" },
    { mode: "approved-live", port: 8443 },
    { mode: "approved-live", ca: "private-ca" },
    { timeoutMs: 10001 },
  ]) {
    let reads = 0;
    await assert.rejects(
      observeReadiness({
        ...base,
        tunnelRead: async () => {
          reads++;
          return {};
        },
        ...patch,
      }),
      /invalid-readiness-input/,
    );
    assert.equal(reads, 0);
  }
});

test("stream log capture handles split records, drops secrets and refuses incomplete/overflow input", () => {
  const capture = createTunnelLogCapture();
  capture.write(Buffer.from('{"level":"info","message":"Registered tunnel '));
  assert.equal(capture.read(), undefined);
  capture.write(Buffer.from(`connection","token":"${secret}"}\n${secret}\n`));
  const logs = sanitizeTunnelLogs(capture.read());
  assert.equal(logs.state, "observed");
  assert.equal(logs.events[0].event, "connection_registered");
  assert.ok(!capture.read().includes(secret));
  capture.write(Buffer.alloc(65537));
  assert.equal(capture.read(), undefined);
  const tooMany = createTunnelLogCapture();
  tooMany.write(Buffer.from(`${Array(129).fill("{}").join("\n")}\n`));
  assert.equal(tooMany.read(), undefined);
});
