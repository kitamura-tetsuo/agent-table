import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-admission-test-"));
  return {
    path: join(directory, "admission.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};
const identity = { environment: "test", serviceId: "synthetic-relay-test" };
const request = (id = "synthetic-request-1", expiresAt = 160000) => ({
  callerId: "synthetic-caller-1",
  requestId: id,
  expiresAt,
});
test("durable replay and configuration identity survive close/reopen", () => {
  const f = fixture();
  let store;
  try {
    store = openRelayAdmissionStore(f.path, {
      ...identity,
      clock: () => 100000,
    });
    const receipt = store.acquire(request());
    assert.equal(receipt.ok, true);
    assert.equal(store.finish(receipt.leaseId).ok, true);
    store.close();
    store = openRelayAdmissionStore(f.path, {
      ...identity,
      clock: () => 100001,
    });
    assert.deepEqual(store.acquire(request()), {
      ok: false,
      reason: "duplicate",
    });
    const bytes = readFileSync(f.path).toString("utf8");
    assert.ok(!bytes.includes("synthetic-caller-1"));
    assert.ok(!bytes.includes("synthetic-request-1"));
    assert.throws(
      () =>
        openRelayAdmissionStore(f.path, {
          ...identity,
          environment: "production",
          clock: () => 100001,
        }),
      /admission-store-unavailable/,
    );
    assert.throws(
      () =>
        openRelayAdmissionStore(f.path, {
          ...identity,
          serviceId: "different-relay",
          clock: () => 100001,
        }),
      /admission-store-unavailable/,
    );
    assert.throws(
      () =>
        openRelayAdmissionStore(f.path, {
          ...identity,
          concurrency: 3,
          clock: () => 100001,
        }),
      /admission-store-unavailable/,
    );
  } finally {
    store?.close();
    f.cleanup();
  }
});

test("rolling rates and active leases are shared across independent connections", () => {
  const f = fixture();
  let a, b;
  try {
    const config = {
      ...identity,
      perMinute: 2,
      globalPerMinute: 2,
      concurrency: 1,
      clock: () => 100000,
    };
    a = openRelayAdmissionStore(f.path, config);
    b = openRelayAdmissionStore(f.path, config);
    const first = a.acquire(request());
    assert.equal(first.ok, true);
    assert.deepEqual(b.acquire(request("synthetic-request-2")), {
      ok: false,
      reason: "capacity",
    });
    assert.equal(a.finish(first.leaseId).ok, true);
    const second = b.acquire(request("synthetic-request-2"));
    assert.equal(second.ok, true);
    assert.equal(b.finish(second.leaseId).ok, true);
    assert.deepEqual(
      a.acquire({
        ...request("synthetic-request-3"),
        callerId: "synthetic-caller-2",
      }),
      { ok: false, reason: "capacity" },
    );
  } finally {
    a?.close();
    b?.close();
    f.cleanup();
  }
});

test("expired uncertain lease remains counted after restart; no false recovery", () => {
  const f = fixture();
  let now = 100000,
    store;
  try {
    const config = { ...identity, concurrency: 1, clock: () => now };
    store = openRelayAdmissionStore(f.path, config);
    const first = store.acquire(request());
    store.close();
    now = 200000;
    store = openRelayAdmissionStore(f.path, config);
    assert.deepEqual(store.listUncertainLeases(), {
      ok: true,
      leases: [
        { leaseId: first.leaseId, admittedAt: 100000, leaseExpiresAt: 115000 },
      ],
    });
    assert.deepEqual(store.acquire(request("synthetic-request-2", 260000)), {
      ok: false,
      reason: "capacity",
    });
    // Test owns the first transport and confirms it stopped before finish.
    assert.equal(store.finish(first.leaseId).ok, true);
    assert.equal(
      store.acquire(request("synthetic-request-2", 260000)).ok,
      true,
    );
  } finally {
    store?.close();
    f.cleanup();
  }
});

test("backward clock refuses mutation and preserves replay; stale finish cannot release new lease", () => {
  const f = fixture();
  let now = 100000,
    store;
  try {
    store = openRelayAdmissionStore(f.path, { ...identity, clock: () => now });
    const first = store.acquire(request("synthetic-request-1", 110000));
    now = 99999;
    assert.deepEqual(store.finish(first.leaseId), {
      ok: false,
      reason: "unavailable",
    });
    assert.deepEqual(store.acquire(request("synthetic-request-2")), {
      ok: false,
      reason: "unavailable",
    });
    now = 100001;
    assert.deepEqual(store.acquire(request("synthetic-request-1", 110000)), {
      ok: false,
      reason: "duplicate",
    });
    store.finish(first.leaseId);
    now = 160001;
    const next = store.acquire(request("synthetic-request-1", 220000));
    assert.equal(next.ok, true);
    assert.notEqual(next.leaseId, first.leaseId);
    assert.deepEqual(store.finish(first.leaseId), {
      ok: false,
      reason: "unknown",
    });
  } finally {
    store?.close();
    f.cleanup();
  }
});

test("busy, foreign/future schema and invalid requests fail closed without clearing data", () => {
  const f = fixture();
  let store, lock;
  try {
    store = openRelayAdmissionStore(f.path, {
      ...identity,
      clock: () => 100000,
      busyTimeoutMs: 5,
    });
    for (const invalid of [
      request("short"),
      request("synthetic-request-1", 99999),
      request("synthetic-request-1", 999999),
      { ...request(), callerId: undefined },
    ])
      assert.equal(store.acquire(invalid).ok, false);
    lock = new DatabaseSync(f.path);
    lock.exec("BEGIN IMMEDIATE");
    assert.deepEqual(store.acquire(request()), {
      ok: false,
      reason: "unavailable",
    });
    lock.exec("ROLLBACK");
    assert.equal(store.acquire(request()).ok, true);
    store.close();
    lock.exec("PRAGMA user_version = 99");
    assert.throws(
      () => openRelayAdmissionStore(f.path, identity),
      /admission-store-unavailable/,
    );
    assert.equal(
      lock.prepare("SELECT COUNT(*) AS n FROM relay_admissions").get().n,
      1,
    );
  } finally {
    store?.close();
    lock?.close();
    f.cleanup();
  }
  const foreign = fixture();
  try {
    const db = new DatabaseSync(foreign.path);
    db.exec(
      "CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep')",
    );
    db.close();
    assert.throws(
      () => openRelayAdmissionStore(foreign.path, identity),
      /admission-store-unavailable/,
    );
    const reread = new DatabaseSync(foreign.path);
    assert.equal(
      reread.prepare("SELECT value FROM unrelated").get().value,
      "keep",
    );
    assert.equal(
      reread.prepare("PRAGMA application_id").get().application_id,
      0,
    );
    reread.close();
  } finally {
    foreign.cleanup();
  }
});

test("record cap refuses instead of evicting live replay entries", () => {
  const f = fixture();
  let store;
  try {
    store = openRelayAdmissionStore(f.path, {
      ...identity,
      clock: () => 100000,
      maxRecords: 1,
    });
    const first = store.acquire(request());
    store.finish(first.leaseId);
    assert.deepEqual(store.acquire(request("synthetic-request-2")), {
      ok: false,
      reason: "capacity",
    });
    assert.deepEqual(store.acquire(request()), {
      ok: false,
      reason: "duplicate",
    });
  } finally {
    store?.close();
    f.cleanup();
  }
});

const exec = promisify(execFile);
const moduleUrl = new URL("./relay-admission-store.mjs", import.meta.url).href;
async function childAcquire(path, requestId, concurrency = 2) {
  const code = `
    import { openRelayAdmissionStore } from ${JSON.stringify(moduleUrl)};
    const store = openRelayAdmissionStore(process.argv[1], {
      environment:"test", serviceId:"synthetic-relay-test", concurrency:${concurrency},
      busyTimeoutMs:1000, clock:()=>100000
    });
    console.log(JSON.stringify(store.acquire({
      callerId:"synthetic-caller-1", requestId:process.argv[2], expiresAt:160000
    })));
    store.close();
  `;
  const output = await exec(process.execPath, [
    "--input-type=module",
    "-e",
    code,
    path,
    requestId,
  ]);
  return JSON.parse(output.stdout);
}
test("actual concurrent processes admit one replay identity exactly once", async () => {
  const f = fixture();
  try {
    const initial = openRelayAdmissionStore(f.path, {
      ...identity,
      clock: () => 100000,
    });
    initial.close();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        childAcquire(f.path, "synthetic-request-1"),
      ),
    );
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => r.reason === "duplicate").length, 7);
  } finally {
    f.cleanup();
  }
});
test("actual concurrent processes share the global active cap", async () => {
  const f = fixture();
  try {
    const initial = openRelayAdmissionStore(f.path, {
      ...identity,
      clock: () => 100000,
    });
    initial.close();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        childAcquire(f.path, `synthetic-request-${i}`),
      ),
    );
    assert.equal(results.filter((r) => r.ok).length, 2);
    assert.equal(results.filter((r) => r.reason === "capacity").length, 6);
  } finally {
    f.cleanup();
  }
});

test("per-caller quota does not masquerade as a global quota", () => {
  const f = fixture();
  let store;
  try {
    store = openRelayAdmissionStore(f.path, {
      ...identity,
      clock: () => 100000,
      perMinute: 2,
      globalPerMinute: 100,
      concurrency: 2,
    });
    for (const id of ["synthetic-request-1", "synthetic-request-2"]) {
      const receipt = store.acquire(request(id));
      assert.equal(receipt.ok, true);
      store.finish(receipt.leaseId);
    }
    assert.deepEqual(store.acquire(request("synthetic-request-3")), {
      ok: false,
      reason: "capacity",
    });
    const other = store.acquire({
      ...request("synthetic-request-3"),
      callerId: "synthetic-caller-2",
    });
    assert.equal(other.ok, true);
  } finally {
    store?.close();
    f.cleanup();
  }
});
