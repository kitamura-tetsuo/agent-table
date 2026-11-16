import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRelayApplication } from "./egress-relay-application.mjs";
import { createRelayHttpsServer } from "./egress-relay-http.mjs";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "relay-application-test-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=relay.example.org",
      "-addext",
      "subjectAltName=DNS:relay.example.org",
    ],
    { stdio: "ignore" },
  );
  return {
    directory,
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}
function callers() {
  return new Map([
    [
      "synthetic-worker-1",
      {
        publicKey: {
          format: "der",
          type: "spki",
          key: Buffer.from(
            "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
            "hex",
          ),
        },
        targets: [
          { origin: "https://callback.example.org", pathPrefix: "/events" },
        ],
      },
    ],
  ]);
}
function request(server, cert) {
  return https.request({
    hostname: "127.0.0.1",
    port: server.address().port,
    servername: "relay.example.org",
    ca: cert,
    agent: false,
    method: "POST",
    path: "/relay/v1",
    headers: {
      "content-type": "application/json",
      "x-agent-table-caller": "synthetic-worker-1",
      "x-agent-table-signature": "A".repeat(88),
    },
  });
}
test("application starts paused; uncertain leases survive restart and forbid enabling", async () => {
  const f = fixture();
  let app;
  const databasePath = join(f.directory, "admission.sqlite");
  const options = {
    ...f,
    databasePath,
    environment: "test",
    serviceId: "synthetic-relay",
    callers: callers(),
    admission: { leaseMs: 1000 },
  };
  try {
    app = createRelayApplication(options);
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const status = await new Promise((resolve, reject) => {
      const req = request(app.server, f.cert);
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 503);
    app.setEnabled(true);
    app.setEnabled(false);
    await app.close();
    app = null;
    const store = openRelayAdmissionStore(databasePath, {
      environment: "test",
      serviceId: "synthetic-relay",
      leaseMs: 1000,
    });
    const attempt = store.acquire({
      callerId: "synthetic-worker-1",
      requestId: "uncertain-request-1",
      expiresAt: Date.now() + 30000,
    });
    assert.equal(attempt.ok, true);
    store.close();
    await new Promise((r) => setTimeout(r, 1050));
    app = createRelayApplication(options);
    assert.equal(app.inspectUncertainAttempts().leases.length, 1);
    assert.throws(
      () => app.setEnabled(true),
      /uncertain-attempts-require-review/,
    );
  } finally {
    if (app) await app.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("disconnect is not completion; drain preserves unresolved handler evidence", async () => {
  const f = fixture();
  let listener, release, entered;
  const started = new Promise((r) => (entered = r));
  try {
    listener = createRelayHttpsServer({
      ...f,
      handler: async () => {
        entered();
        await new Promise((r) => (release = r));
        return { status: 200, body: { status: 204, payload: "" } };
      },
    });
    await new Promise((r) => listener.server.listen(0, "127.0.0.1", r));
    const req = request(listener.server, f.cert);
    req.on("error", () => {});
    req.end("{}");
    await started;
    req.destroy();
    assert.deepEqual(await listener.close(20), { settled: false });
    release();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await listener.close(1000), { settled: true });
  } finally {
    release?.();
    if (listener) await listener.close(1000);
    rmSync(f.directory, { recursive: true, force: true });
  }
});
