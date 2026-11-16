import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedAgent } from "./egress-relay-prototype.mjs";

/**
 * Actual Node HTTPS/TLS on loopback only. Ephemeral one-day synthetic cert is
 * deleted in finally; never an account credential or a deployed trust anchor.
 * Positive endpoint control + real negative boundary test, NOT public egress
 * acceptance. The production address policy still refuses all loopback IPs.
 */
test("real localhost HTTPS succeeds as control; pinned agent refuses private peer before HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-tls-test-"));
  let server;
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
        "/CN=callback.example.org",
        "-addext",
        "subjectAltName=DNS:callback.example.org",
      ],
      { stdio: "ignore" },
    );
    const key = readFileSync(join(dir, "key.pem"));
    const cert = readFileSync(join(dir, "cert.pem"));
    let requests = 0;
    server = https.createServer({ key, cert }, (req, res) => {
      requests++;
      req.resume();
      res.end("synthetic-challenge");
    });
    server.on("tlsClientError", () => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const control = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port,
          servername: "callback.example.org",
          ca: cert,
          method: "POST",
          agent: false,
        },
        (res) => {
          let text = "";
          res.on("data", (data) => {
            text += data;
          });
          res.on("end", () => resolve(text));
        },
      );
      req.on("error", reject);
      req.end("synthetic-only");
    });
    assert.equal(control, "synthetic-challenge");
    assert.equal(requests, 1);
    for (const hostname of ["callback.example.org", "wrong.example.org"]) {
      const agent = new PinnedAgent(
        { address: "8.8.8.8", hostname },
        (options) =>
          tls.connect({ ...options, host: "127.0.0.1", port, ca: cert }),
      );
      // Only the injected dial is local. Actual socket IP is NOT forged.
      await assert.rejects(
        new Promise((resolve, reject) => {
          const req = https.request(
            { hostname, port: 443, method: "POST", agent },
            resolve,
          );
          req.setTimeout(2000, () => req.destroy(new Error("test timeout")));
          req.once("error", reject);
          req.end("synthetic-must-not-arrive");
        }),
      );
      agent.destroy();
    }
    assert.equal(
      requests,
      1,
      "neither TLS mismatch nor private peer may deliver HTTP",
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
