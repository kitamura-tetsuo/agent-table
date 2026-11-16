// Local-only synthetic harness. No operational configuration or credentials.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createResultOnlyChallengeVerifier } from "./egress-relay-challenge.mjs";
import { createRelayHttpsServer } from "./egress-relay-http.mjs";
import { createRelayIngress } from "./egress-relay-ingress-prototype.mjs";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";
import {
  applyUncertainRecovery,
  planUncertainRecovery,
  readUncertainRecovery,
} from "./relay-uncertain-reconciliation.mjs";

const dir = mkdtempSync(join(tmpdir(), "operator-workerd-"));
let store, listener, bridge;
const listen = (s) =>
  new Promise((r) => (s.server ?? s).listen(0, "127.0.0.1", r));
const close = (s) => (s.server ? s.close() : new Promise((r) => s.close(r)));
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
  const key = readFileSync(join(dir, "key")),
    cert = readFileSync(join(dir, "cert")),
    file = join(dir, "store.sqlite");
  let now = Date.now(),
    enabled = true,
    completed = 0,
    recovered = false;
  const messages = [];
  let currentRequestId;
  const config = {
    environment: "production",
    serviceId: "agent-table",
    leaseMs: 1000,
    clock: () => now,
    operatorRecoveryPolicy: {
      planFreshnessMs: 300000,
      receiptRetentionMs: 604800000,
      maxReceipts: 1000,
    },
  };
  const callers = new Map([
    [
      "synthetic_caller_123",
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
          {
            origin: "https://events.provider.example.org",
            pathPrefix: "/callback",
          },
        ],
      },
    ],
  ]);
  store = openRelayAdmissionStore(file, config);
  const handler = () =>
    createRelayIngress({
      audience: "production:agent-table",
      callers,
      admissionStore: store,
      clock: () => now,
      enabled: () => enabled,
      send: async () => {
        throw Error("unused");
      },
      verifyChallenge: createResultOnlyChallengeVerifier(
        async (_url, _targets, bytes) => ({
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              challenge: JSON.parse(Buffer.from(bytes).toString()).challenge,
            }),
          ),
        }),
      ),
      sendMessage: async (_destination, _targets, payload) => {
        messages.push({
          requestId: currentRequestId,
          payload: Buffer.from(payload).toString("base64"),
        });
        completed++;
        return {
          kind: "http",
          status: completed <= 2 ? 204 : 503,
          retryAfterState: "absent",
        };
      },
    });
  listener = createRelayHttpsServer({ key, cert, handler: handler() });
  await listen(listener);
  const proxy = (path, headers, bytes) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: listener.server.address().port,
          servername: "relay.example.org",
          ca: cert,
          path,
          method: "POST",
          headers,
        },
        (res) => {
          let body = "";
          res.on("data", (b) => (body += b));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end(bytes);
    });
  bridge = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const b of req) {
        raw += b;
        if (raw.length > 50000) throw Error("oversize");
      }
      if (raw.length > 50000) throw Error("oversize");
      const input = JSON.parse(raw || "{}");
      let result;
      if (req.url === "/recover") {
        enabled = false;
        await close(listener);
        listener = null;
        if (completed !== 1) throw Error("transport-not-completed");
        now = input.now;
        const db = new DatabaseSync(file);
        db.exec("DROP TRIGGER test_finish_fault");
        db.close();
        store.close();
        store = openRelayAdmissionStore(file, config);
        const plan = planUncertainRecovery(store);
        if (!plan.ok || plan.plan.leases.length !== 1)
          throw Error("invalid-plan");
        const operationId = `opr_${plan.plan.createdAt}_${"b".repeat(32)}`;
        const request = {
          operationId,
          plan: plan.plan,
          ownerRecord: {
            ownerId: "synthetic-owner",
            processGeneration: "closed-listener-1",
            observedAt: now,
            planSha256: plan.planSha256,
            evidenceSha256: createHash("sha256")
              .update("awaited closed listener and completed transport")
              .digest("hex"),
            admissionsPaused: true,
            transportState: "completed",
          },
        };
        if (!applyUncertainRecovery(store, request).ok) throw Error("recovery");
        store.close();
        store = openRelayAdmissionStore(file, config);
        const receipt = readUncertainRecovery(store, operationId);
        if (receipt.state !== "committed") throw Error("receipt");
        recovered = true;
        enabled = true;
        listener = createRelayHttpsServer({ key, cert, handler: handler() });
        await listen(listener);
        result = {
          recovered: true,
          outcome: receipt.receipt.outcome,
          machineVerifiedTransportStop:
            receipt.receipt.machineVerifiedTransportStop,
        };
      } else if (req.url === "/inspect") {
        result = { messages, completed, recovered };
      } else if (req.url === "/relay") {
        now = input.now;
        currentRequestId = JSON.parse(
          Buffer.from(input.body, "base64").toString(),
        ).requestId;
        if (input.path === "/relay/v1/message" && completed === 0) {
          const db = new DatabaseSync(file);
          db.exec(
            "CREATE TRIGGER test_finish_fault BEFORE UPDATE OF state ON relay_admissions BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END",
          );
          db.close();
        }
        const forwarded = await proxy(
          input.path,
          input.headers,
          Buffer.from(input.body, "base64"),
        );
        res.writeHead(forwarded.status, { "content-type": "application/json" });
        res.end(forwarded.body);
        return;
      } else throw Error("path");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(500);
      res.end("{}");
    }
  });
  await listen(bridge);
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "test/integration/events-subscriptions.test.ts",
      "--config",
      "vitest.operator.config.ts",
      "-t",
      "actual operator recovery from MCP producer",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        OPERATOR_BRIDGE: `http://127.0.0.1:${bridge.address().port}`,
      },
    },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60000);
  process.exitCode = await new Promise((r) =>
    child.on("exit", (c) => r(c ?? 1)),
  );
  clearTimeout(deadline);
  // A renamed/skipped test must never make this dedicated CI stage green.
  if (process.exitCode === 0 && (!recovered || completed !== 11))
    process.exitCode = 1;
} finally {
  if (bridge) await close(bridge);
  if (listener) await close(listener);
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}
