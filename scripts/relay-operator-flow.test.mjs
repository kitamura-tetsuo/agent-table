import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPrivateKey, createHash, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { DatabaseSync } from "node:sqlite";
import { createRelayApplication } from "./egress-relay-application.mjs";
import { createRelayHttpsServer } from "./egress-relay-http.mjs";
import {
  createRelayIngress,
  relayMessageSigningBytes,
  relayStatusSigningBytes,
  relayOperationDigest,
} from "./egress-relay-ingress-prototype.mjs";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";
import {
  planUncertainRecovery,
  applyUncertainRecovery,
  readUncertainRecovery,
} from "./relay-uncertain-reconciliation.mjs";
import { relayAttemptLedgerSchema } from "../schema/013_relay_attempt_ledger.ts";
import {
  prepareRelayAttempt,
  markRelayDispatched,
  markRelayUnknown,
  recordRelayReceipt,
} from "../src/notifications/relay-attempt-ledger.ts";
import {
  reserveOutboxAttempt,
  reconcileRelayOutboxAttempt,
  settleOutboxAttempt,
} from "../src/notifications/outbox.ts";

const callerId = "synthetic-worker-1",
  audience = "test:synthetic-relay";
const privateKey = createPrivateKey({
  format: "der",
  type: "pkcs8",
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
});
const callers = () =>
  new Map([
    [
      callerId,
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
const policy = {
  planFreshnessMs: 300000,
  receiptRetentionMs: 604800000,
  maxReceipts: 1000,
};
function sqlAdapter(db) {
  return {
    exec(query, ...params) {
      const rows = db.prepare(query).all(...params);
      return {
        toArray: () => rows,
        one: () => {
          assert.equal(rows.length, 1);
          return rows[0];
        },
      };
    },
  };
}
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
}
function http(server, cert, path, body, signature) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        servername: "relay.example.org",
        ca: cert,
        agent: false,
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          "x-agent-table-caller": callerId,
          "x-agent-table-signature": signature,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
          assert.ok(text.length < 4096);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: text ? JSON.parse(text) : null,
          }),
        );
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error("test deadline")));
    req.on("error", reject);
    req.end(body);
  });
}
function signed(server, cert, path, envelope) {
  const raw = Buffer.from(JSON.stringify(envelope));
  const bytes = path.endsWith("status")
    ? relayStatusSigningBytes(raw, callerId)
    : relayMessageSigningBytes(raw, callerId);
  return http(
    server,
    cert,
    path,
    raw,
    sign(null, bytes, privateKey).toString("base64"),
  );
}

test("signed local intake, operator recovery, real application resume and Worker next ordinal preserve unknown evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-operator-flow-"));
  let ingress, app, store, receiver;
  const worker = new DatabaseSync(":memory:");
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
    const key = readFileSync(join(dir, "key.pem")),
      cert = readFileSync(join(dir, "cert.pem")),
      path = join(dir, "admission.sqlite");
    let now = Date.now(),
      attempts = 0,
      completedOriginal = false;
    const config = {
      environment: "test",
      serviceId: "synthetic-relay",
      leaseMs: 1000,
      clock: () => now,
      operatorRecoveryPolicy: policy,
    };
    store = openRelayAdmissionStore(path, config);
    worker.exec(
      `CREATE TABLE table_metadata(state TEXT,expires_at INTEGER); CREATE TABLE table_event_subscriptions(membership_id TEXT,subscription_id TEXT,generation INTEGER,status TEXT,expires_at INTEGER); CREATE TABLE table_event_outbox(event_id TEXT PRIMARY KEY,subscription_id TEXT,recipient_membership_id TEXT,subscription_generation INTEGER,status TEXT,attempt_count INTEGER,first_attempt_at INTEGER,next_attempt_at INTEGER,lease_token TEXT,lease_deadline INTEGER,last_error_category TEXT,expires_at INTEGER);`,
    );
    for (const statement of relayAttemptLedgerSchema.componentStatements.table)
      worker.exec(statement);
    worker
      .prepare("INSERT INTO table_metadata VALUES (?,?)")
      .run("open", now + 3600000);
    worker
      .prepare("INSERT INTO table_event_subscriptions VALUES (?,?,?,?,?)")
      .run("member", "synthetic-subscription-1", 1, "active", now + 3600000);
    worker
      .prepare(
        "INSERT INTO table_event_outbox(event_id,subscription_id,recipient_membership_id,subscription_generation,status,attempt_count,first_attempt_at,next_attempt_at,lease_token,lease_deadline,relay_reconcile_after,last_error_category,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "synthetic-event-1",
        "synthetic-subscription-1",
        "member",
        1,
        "pending",
        0,
        null,
        now,
        null,
        null,
        null,
        null,
        now + 3600000,
      );
    const sql = sqlAdapter(worker),
      lease1 = transaction(worker, () =>
        reserveOutboxAttempt(sql, "synthetic-event-1", 1, now),
      );
    assert.equal(lease1.attemptCount, 1);
    const envelope = (requestId, timestamp) => ({
      version: 1,
      kind: "message",
      audience,
      requestId,
      timestamp,
      destination: "https://callback.example.org/events",
      headers: { "content-type": "application/json" },
      payload: Buffer.from(
        JSON.stringify({ eventId: "synthetic-event-1" }),
      ).toString("base64"),
    });
    const first = envelope("synthetic-request-0001", now);
    const identity = (lease, e) => ({
      requestId: e.requestId,
      eventId: lease.eventId,
      subscriptionId: "synthetic-subscription-1",
      generation: lease.generation,
      ordinal: lease.attemptCount,
      leaseToken: lease.leaseToken,
      firstAttemptAt: lease.firstAttemptAt,
      leaseDeadline: lease.leaseDeadline,
      audience,
      callerId,
      issuedAt: e.timestamp,
      acceptanceExpiresAt: e.timestamp + 60000,
      operationDigest: relayOperationDigest(e, callerId, "message"),
    });
    const i1 = identity(lease1, first);
    assert.equal(
      transaction(worker, () => prepareRelayAttempt(sql, i1, now)).ok,
      true,
    );
    assert.equal(
      transaction(worker, () => markRelayDispatched(sql, i1, now)).ok,
      true,
    );
    const handler = createRelayIngress({
      send: async () => {
        throw new Error("unused legacy path");
      },
      audience,
      callers: callers(),
      admissionStore: store,
      clock: () => now,
      enabled: () => true,
      sendMessage: async () => {
        attempts++;
        completedOriginal = true;
        return { kind: "http", status: 204, retryAfterState: "absent" };
      },
    });
    const faultDb = new DatabaseSync(path);
    faultDb.exec(
      "CREATE TRIGGER test_finish_fault BEFORE UPDATE OF state ON relay_admissions BEGIN SELECT RAISE(ABORT,'synthetic disk transaction failure'); END",
    );
    faultDb.close();
    ingress = createRelayHttpsServer({ key, cert, handler });
    await listen(ingress.server);
    assert.equal(
      (await signed(ingress.server, cert, "/relay/v1/message", first)).status,
      503,
    );
    assert.equal(attempts, 1);
    assert.equal(completedOriginal, true);
    transaction(worker, () => markRelayUnknown(sql, i1));
    const originalWorker = worker
      .prepare("SELECT * FROM table_event_relay_attempts")
      .get();
    const originalSql = new DatabaseSync(path);
    const originalAdmission = originalSql
      .prepare("SELECT * FROM relay_admissions")
      .get();
    originalSql.close();
    await ingress.close(1000);
    ingress = null;
    store.close();
    store = null;
    const repairDb = new DatabaseSync(path);
    repairDb.exec("DROP TRIGGER test_finish_fault");
    repairDb.close();
    now = lease1.leaseDeadline + 1;
    app = createRelayApplication({
      databasePath: path,
      environment: "test",
      serviceId: "synthetic-relay",
      callers: callers(),
      key,
      cert,
      admission: {
        leaseMs: 1000,
        clock: () => now,
        operatorRecoveryPolicy: policy,
      },
      messageDelivery: true,
    });
    await listen(app.server);
    assert.throws(() => app.setEnabled(true), /uncertain/);
    store = openRelayAdmissionStore(path, config);
    const planned = planUncertainRecovery(store);
    assert.equal(planned.ok, true);
    assert.equal(planned.plan.leases.length, 1);
    const request = {
      operationId: `opr_${planned.plan.createdAt}_${"b".repeat(32)}`,
      plan: planned.plan,
      ownerRecord: {
        ownerId: "synthetic-owner-reviewed",
        processGeneration: "synthetic-old-listener-1",
        observedAt: now,
        planSha256: planned.planSha256,
        evidenceSha256: createHash("sha256")
          .update(
            "fixture awaited old listener close and original transport settled",
          )
          .digest("hex"),
        admissionsPaused: true,
        transportState: "completed",
      },
    };
    assert.equal(completedOriginal, true);
    assert.equal(ingress, null); // Concrete fixture evidence, not inferred from expiry.
    assert.equal(applyUncertainRecovery(store, request).ok, true);
    store.close();
    store = openRelayAdmissionStore(path, config);
    const recovered = readUncertainRecovery(store, request.operationId);
    assert.equal(recovered.state, "committed");
    assert.equal(recovered.receipt.outcome, "unknown");
    assert.equal(recovered.receipt.machineVerifiedTransportStop, false);
    assert.equal(applyUncertainRecovery(store, request).ok, true);
    app.setEnabled(true);
    const status = await signed(app.server, cert, "/relay/v1/status", {
      version: 1,
      audience,
      requestId: i1.requestId,
      operationDigest: i1.operationDigest,
      timestamp: Date.now(),
    });
    assert.deepEqual(status, { status: 200, body: { state: "unknown" } });
    assert.equal(
      (await signed(app.server, cert, "/relay/v1/message", first)).status,
      409,
    );
    assert.equal(attempts, 1);
    await app.close();
    app = null;
    assert.equal(
      transaction(worker, () =>
        reconcileRelayOutboxAttempt(sql, lease1, now, {
          kind: "transient",
          category: "transport-error",
        }),
      ),
      "pending",
    );
    now = worker
      .prepare("SELECT next_attempt_at FROM table_event_outbox")
      .get().next_attempt_at;
    const lease2 = transaction(worker, () =>
      reserveOutboxAttempt(sql, i1.eventId, 1, now),
    );
    assert.equal(lease2.attemptCount, 2);
    assert.equal(lease2.firstAttemptAt, lease1.firstAttemptAt);
    const second = envelope("synthetic-request-0002", now),
      i2 = identity(lease2, second);
    assert.equal(
      transaction(worker, () => prepareRelayAttempt(sql, i2, now)).ok,
      true,
    );
    assert.equal(
      transaction(worker, () => markRelayDispatched(sql, i2, now)).ok,
      true,
    );
    let receiverCalls = 0;
    receiver = https.createServer({ key, cert }, (req, res) => {
      let text = "";
      req.on("data", (b) => (text += b));
      req.on("end", () => {
        receiverCalls++;
        assert.deepEqual(JSON.parse(text), { eventId: "synthetic-event-1" });
        res.writeHead(204);
        res.end();
      });
    });
    await listen(receiver);
    const resumed = createRelayIngress({
      send: async () => {
        throw new Error("unused legacy path");
      },
      audience,
      callers: callers(),
      admissionStore: store,
      clock: () => now,
      enabled: () => true,
      sendMessage: async (_destination, _targets, body) => {
        // Controlled external transport boundary: localhost TLS only, no public DNS/dial.
        attempts++;
        return new Promise((resolve, reject) => {
          const req = https.request(
            {
              hostname: "127.0.0.1",
              port: receiver.address().port,
              servername: "relay.example.org",
              ca: cert,
              agent: false,
              method: "POST",
            },
            (res) => {
              res.resume();
              res.on("end", () =>
                resolve({
                  kind: "http",
                  status: res.statusCode,
                  retryAfterState: "absent",
                }),
              );
            },
          );
          req.setTimeout(3000, () => req.destroy(new Error("test deadline")));
          req.on("error", reject);
          req.end(body);
        });
      },
    });
    ingress = createRelayHttpsServer({ key, cert, handler: resumed });
    await listen(ingress.server);
    const result = await signed(
      ingress.server,
      cert,
      "/relay/v1/message",
      second,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.state, "completed");
    assert.equal(result.body.outcome.status, 204);
    assert.equal(receiverCalls, 1);
    assert.equal(attempts, 2);
    assert.equal(
      transaction(worker, () =>
        recordRelayReceipt(sql, i2, result.body.outcome),
      ).ok,
      true,
    );
    assert.equal(
      transaction(worker, () =>
        settleOutboxAttempt(sql, lease2, now, { kind: "accepted" }),
      ),
      "accepted",
    );
    assert.deepEqual(
      worker
        .prepare("SELECT * FROM table_event_relay_attempts WHERE request_id=?")
        .get(i1.requestId),
      originalWorker,
    );
    assert.deepEqual(
      worker
        .prepare(
          "SELECT event_id,attempt_count,first_attempt_at,status FROM table_event_outbox",
        )
        .get(),
      {
        __proto__: null,
        event_id: i1.eventId,
        attempt_count: 2,
        first_attempt_at: lease1.firstAttemptAt,
        status: "accepted",
      },
    );
    const finalSql = new DatabaseSync(path);
    const old = finalSql
      .prepare("SELECT * FROM relay_admissions WHERE id=?")
      .get(originalAdmission.id);
    assert.equal(old.operation_digest, originalAdmission.operation_digest);
    assert.equal(old.admitted_ms, originalAdmission.admitted_ms);
    assert.equal(old.replay_expires_ms, originalAdmission.replay_expires_ms);
    assert.equal(old.outcome_kind, "unknown");
    finalSql.close();
  } finally {
    if (ingress) await ingress.close(1000);
    if (app) await app.close();
    if (receiver) await new Promise((r) => receiver.close(r));
    store?.close();
    worker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
