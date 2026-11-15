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
  memoryReplayStoreForTests,
  relaySigningBytes,
} from "./egress-relay-ingress-prototype.mjs";

test("real HTTPS intake authenticates signed bytes, enforces replay and refuses invalid HTTP before forwarding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-http-test-"));
  let listener;
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
    const cert = readFileSync(join(directory, "cert.pem"));
    // Published RFC8032 TEST 1, never a deployed key.
    const privateKey = createPrivateKey({
      format: "der",
      type: "pkcs8",
      key: Buffer.from(
        "302e020100300506032b657004220420" +
          "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
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
    const callerId = "synthetic-worker-1";
    let attempts = 0,
      enabled = true;
    const handler = createRelayIngress({
      audience: "test:synthetic-relay",
      callers: new Map([
        [
          callerId,
          {
            publicKey,
            targets: [
              { origin: "https://callback.example.org", pathPrefix: "/events" },
            ],
          },
        ],
      ]),
      replayStore: memoryReplayStoreForTests(),
      enabled: () => enabled,
      send: async (_url, _targets, body) => {
        attempts++;
        assert.equal(Buffer.from(body).toString(), "synthetic");
        return { status: 204, body: Buffer.from("synthetic-response") };
      },
    });
    listener = createRelayHttpsServer({
      key: readFileSync(join(directory, "key.pem")),
      cert,
      handler,
    });
    await new Promise((resolve) =>
      listener.server.listen(0, "127.0.0.1", resolve),
    );
    const port = listener.server.address().port;
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        audience: "test:synthetic-relay",
        timestamp: Date.now(),
        requestId: "synthetic-request-1",
        destination: "https://callback.example.org/events",
        headers: {},
        payload: Buffer.from("synthetic").toString("base64"),
      }),
    );
    const signature = sign(
      null,
      relaySigningBytes(bytes, callerId),
      privateKey,
    ).toString("base64");
    async function request(overrides = {}) {
      return await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: "127.0.0.1",
            port,
            servername: "relay.example.org",
            ca: cert,
            agent: false,
            method: "POST",
            path: "/relay/v1",
            headers: {
              "content-type": "application/json",
              "x-agent-table-caller": callerId,
              "x-agent-table-signature": signature,
            },
            ...overrides,
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.once("end", () =>
              resolve({
                status: res.statusCode,
                body,
                cacheControl: res.headers["cache-control"],
              }),
            );
          },
        );
        req.once("error", reject);
        req.end(bytes);
      });
    }
    const accepted = await request();
    assert.equal(accepted.status, 200);
    assert.equal(accepted.cacheControl, "no-store");
    assert.equal(
      JSON.parse(accepted.body).payload,
      Buffer.from("synthetic-response").toString("base64"),
    );
    assert.equal((await request()).status, 409);
    assert.equal((await request({ path: "/relay/v1?override=1" })).status, 404);
    assert.equal(
      (await request({ headers: { "content-type": "application/json" } }))
        .status,
      400,
    );
    assert.equal(
      (
        await request({
          headers: {
            "content-type": "application/json",
            "x-agent-table-caller": callerId,
            "x-agent-table-signature": signature,
            "content-length": "32769",
          },
        })
      ).status,
      413,
    );
    enabled = false;
    assert.equal((await request()).status, 503);
    assert.equal(attempts, 1);
  } finally {
    if (listener) await listener.close(1000);
    rmSync(directory, { recursive: true, force: true });
  }
});
