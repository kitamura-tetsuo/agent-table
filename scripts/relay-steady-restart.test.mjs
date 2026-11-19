import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";
import {
  inspectSteadyRestartLedger,
  resumeAuthorizedSteadyRelay,
} from "./relay-steady-restart.mjs";

function dossier() {
  const authorization = {
    mode: "steady",
    environment: "production",
    serviceId: "relay-test",
    storeId: "store-test",
    imageDigest: "image-test",
    configurationSha256: "a".repeat(64),
  };
  return {
    authorization,
    operator: { inhibit: "clear" },
    host: {
      ...authorization,
      generation: "generation-test",
      state: "paused",
      sequence: 0,
      priorTransportsStopped: true,
      namespaceVerified: true,
      tlsVerified: true,
      activeAdmissions: 0,
      unresolvedOutcomes: 0,
    },
  };
}

test("steady restart refuses partial or inhibited evidence before claiming/sending", async () => {
  for (const change of [
    (d) => {
      d.authorization = null;
    },
    (d) => {
      d.operator.inhibit = "paused";
    },
    (d) => {
      d.operator.inhibit = "quarantined";
    },
    (d) => {
      d.host.tlsVerified = false;
    },
    (d) => {
      d.host.namespaceVerified = false;
    },
    (d) => {
      d.host.priorTransportsStopped = undefined;
    },
    (d) => {
      d.host.storeId = "new-store";
    },
    (d) => {
      d.host.imageDigest = "new-image";
    },
    (d) => {
      d.host.configurationSha256 = "new-config";
    },
    (d) => {
      d.host.activeAdmissions = 1;
    },
    (d) => {
      d.host.unresolvedOutcomes = 1;
    },
    (d) => {
      d.host.sequence = 1;
    },
  ]) {
    const d = dossier();
    change(d);
    const result = await resumeAuthorizedSteadyRelay({
      withOwnerLock: (fn) => fn(),
      observe: () => d,
      markGenerationAttempted: () => assert.fail("claimed"),
      enable: () => assert.fail("sent"),
      inspect: () => assert.fail("inspected"),
    });
    assert.deepEqual(result, { state: "paused", enabled: false });
  }
});

test("lost enable result permits only exact readback, never another send", async () => {
  for (const shift of [false, true]) {
    const d = dossier();
    let holding = false,
      claimed = false,
      sends = 0;
    const params = {
      async withOwnerLock(fn) {
        assert.equal(holding, false);
        holding = true;
        try {
          return await fn();
        } finally {
          holding = false;
        }
      },
      observe() {
        assert(holding);
        return d;
      },
      markGenerationAttempted() {
        assert(holding);
        if (claimed) return false;
        claimed = true;
        return true;
      },
      enable(cmd) {
        assert(holding && claimed);
        assert.equal(cmd.sequence, 1);
        assert.equal(cmd.action, "enable");
        sends++;
        throw Error("unavailable");
      },
      inspect() {
        assert(holding);
        return {
          ok: true,
          state: "enabled",
          sequence: 1,
          configurationSha256: d.host.configurationSha256,
          generation: shift ? "foreign" : d.host.generation,
        };
      },
    };
    const result = await resumeAuthorizedSteadyRelay(params);
    assert.equal(result.state, shift ? "unknown" : "enabled");
    await resumeAuthorizedSteadyRelay(params);
    assert.equal(sends, 1);
  }
});

test("read-only SQLite assessment counts even unexpired active leases and does not create files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-steady-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "existing.sqlite");
  assert.throws(() => inspectSteadyRestartLedger(path));
  const store = openRelayAdmissionStore(path, {
    environment: "production",
    serviceId: "relay-test",
  });
  try {
    const initial = inspectSteadyRestartLedger(path);
    assert.equal(initial.activeAdmissions, 0);
    assert.equal(
      store.acquire({
        callerId: "caller-test-0001",
        requestId: "request-test-0001",
        expiresAt: Date.now() + 60_000,
        operationDigest: "a".repeat(64),
      }).ok,
      true,
    );
    assert.deepEqual(store.listUncertainLeases(), { ok: true, leases: [] });
    assert.deepEqual(
      { ...inspectSteadyRestartLedger(path) },
      { ...initial, activeAdmissions: 1 },
    );
  } finally {
    store.close();
  }
});

test("owner file lock excludes another instance and preserves inhibit and claim", async (t) => {
  const { createSteadyOwnerState } = await import(
    "./relay-steady-owner-state.mjs"
  );
  const dir = mkdtempSync(join(tmpdir(), "relay-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = createSteadyOwnerState(dir),
    b = createSteadyOwnerState(dir);
  const generation = "00000000-0000-4000-8000-000000000001";
  assert.throws(() => a.readInhibit());
  await a.withOwnerLock(async () => {
    assert.equal(a.readInhibit(), "unknown");
    a.recordInhibit("paused");
    assert.equal(a.markGenerationAttempted(generation), true);
    await assert.rejects(b.withOwnerLock(() => assert.fail("lock bypass")));
  });
  await b.withOwnerLock(() => {
    assert.equal(b.readInhibit(), "paused");
    assert.equal(b.markGenerationAttempted(generation), false);
    const next = "00000000-0000-4000-8000-000000000002";
    assert.equal(b.markGenerationAttempted(next), false);
    b.resolveGenerationAttempt(generation);
    assert.equal(b.markGenerationAttempted(next), true);
    assert.throws(() => b.recordInhibit("clear"));
    b.recordInhibit("quarantined");
  });
  await a.withOwnerLock(() => assert.equal(a.readInhibit(), "quarantined"));
});

test("same container ID restart requires retired process incarnation, not a changed name", async () => {
  const { priorIncarnationRetired, sameIncarnation, validIncarnation } =
    await import("./relay-steady-incarnation.mjs");
  const id = "a".repeat(64);
  const previous = {
    id,
    bootId: "00000000-0000-4000-8000-000000000001",
    pid: 1234,
    start: "234",
    cgroup: "0::/system.slice/docker-" + id + ".scope\n",
    namespace: "4:55",
  };
  const current = { ...previous, pid: 2345, start: "456", namespace: "4:77" };
  assert(validIncarnation(previous));
  assert(sameIncarnation(previous, { ...previous }));
  for (const bad of [
    priorIncarnationRetired(previous, previous, { state: "absent" }),
    priorIncarnationRetired(previous, current, { state: "unknown" }),
    priorIncarnationRetired(previous, current, {
      state: "present",
      start: previous.start,
    }),
    priorIncarnationRetired(
      previous,
      { ...current, id: "b".repeat(64) },
      { state: "absent" },
    ),
    priorIncarnationRetired(
      previous,
      { ...current, cgroup: "0::/forged" },
      { state: "absent" },
    ),
  ])
    assert.equal(bad, false);
  assert(priorIncarnationRetired(previous, current, { state: "absent" }));
  assert(
    priorIncarnationRetired(
      previous,
      { ...current, pid: previous.pid },
      { state: "present", start: current.start },
    ),
  );
  assert(
    priorIncarnationRetired(
      previous,
      { ...current, bootId: "00000000-0000-4000-8000-000000000002" },
      null,
    ),
  );
});

test("pinned images cannot stand in for enrolled entrypoint, command, and rootfs", async () => {
  const { hasEnrolledContainerProgram } = await import(
    "./relay-steady-host-supervisor.mjs"
  );
  const binding = {
    configurationSha256: "a".repeat(64),
    ingressEntrypoint: ["cloudflared"],
    ingressCommand: ["tunnel", "run"],
    ingressWorkingDir: "/",
  };
  const relay = {
    Config: {
      Entrypoint: ["node", "scripts/relay-controller.mjs"],
      Cmd: [
        "--config",
        "/config/relay.json",
        "--expected-config-sha256",
        binding.configurationSha256,
        "--socket",
        "/run/agent-table-relay/control.sock",
      ],
      WorkingDir: "/app",
      Env: ["RELAY_STEADY_OWNER_DIR=/state/steady-owner"],
    },
    HostConfig: { ReadonlyRootfs: true },
    Mounts: [{ Destination: "/state" }],
  };
  const ingress = {
    Config: {
      Entrypoint: binding.ingressEntrypoint,
      Cmd: binding.ingressCommand,
      WorkingDir: "/",
    },
    HostConfig: { ReadonlyRootfs: true },
    Mounts: [{ Destination: "/config" }],
  };
  assert.equal(hasEnrolledContainerProgram(relay, ingress, binding), true);
  const changes = [
    (r) => (r.Config.Entrypoint = ["sh"]),
    (r) => (r.Config.Cmd[3] = "different"),
    (r) => (r.Config.WorkingDir = "/other"),
    (r) => r.Config.Env.push("NODE_OPTIONS=--require=/config/override"),
    (r) => r.Mounts.push({ Destination: "/app" }),
    (r) => (r.HostConfig.ReadonlyRootfs = false),
    (r, i) => (i.Config.Cmd = ["other"]),
  ];
  for (const change of changes) {
    const r = structuredClone(relay),
      i = structuredClone(ingress);
    change(r, i);
    assert.equal(hasEnrolledContainerProgram(r, i, binding), false);
  }
});

test("partial crash retires only the exact previously observed survivor", async () => {
  const { classifyEnrolledPair } = await import(
    "./relay-steady-host-supervisor.mjs"
  );
  const [relay, ingress] = ["a", "b"].map((c, i) => ({
    id: c.repeat(64),
    bootId: "00000000-0000-4000-8000-000000000001",
    pid: i + 101,
    start: `31${i}`,
    namespace: "4:55",
    cgroup: `0::/docker/${c.repeat(64)}`,
  }));
  const stopped = {
    Running: false,
    Restarting: false,
    Status: "exited",
    Pid: 0,
  };
  const running = (p) => ({
    Running: true,
    Restarting: false,
    Status: "running",
    Pid: p.pid,
  });
  const prior = [relay, ingress];
  assert.deepEqual(
    classifyEnrolledPair(
      [stopped, running(ingress)],
      prior,
      [null, ingress],
      [true, false],
    ),
    { state: "partial", survivor: 1 },
  );
  assert.deepEqual(
    classifyEnrolledPair(
      [running(relay), stopped],
      prior,
      [relay, null],
      [false, true],
    ),
    { state: "partial", survivor: 0 },
  );
  assert.deepEqual(
    classifyEnrolledPair(
      [stopped, running(ingress)],
      prior,
      [null, ingress],
      [false, false],
    ),
    { state: "refused" },
  );
  assert.deepEqual(
    classifyEnrolledPair(
      [stopped, running(ingress)],
      prior,
      [null, { ...ingress, start: "999" }],
      [true, false],
    ),
    { state: "refused" },
  );
  assert.deepEqual(
    classifyEnrolledPair([running(relay), running(ingress)], prior, prior, [
      false,
      false,
    ]),
    { state: "running" },
  );
  assert.deepEqual(
    classifyEnrolledPair([stopped, stopped], prior, [null, null], [true, true]),
    { state: "stopped" },
  );
});

test("owner-loss continuation reuses exact paused generation only before any attempt", async (t) => {
  const { createSteadyOwnerState } = await import(
    "./relay-steady-owner-state.mjs"
  );
  const { decideRunningPairRecovery } = await import(
    "./relay-steady-host-supervisor.mjs"
  );
  const dir = mkdtempSync(join(tmpdir(), "relay-owner-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const generation = "00000000-0000-4000-8000-000000000001";
  const config = "a".repeat(64);
  const paused = {
    ok: true,
    state: "paused",
    configurationSha256: config,
    sequence: 0,
    generation,
  };
  const first = createSteadyOwnerState(dir);
  // Simulated owner loss immediately after the durable checkpoint.
  await first.withOwnerLock(() =>
    first.recordSupervisorInventory({
      generation,
      configurationSha256: config,
      incarnations: [],
    }),
  );
  const next = createSteadyOwnerState(dir);
  await next.withOwnerLock(() => {
    const decide = (frame) =>
      decideRunningPairRecovery({
        frame,
        saved: next.readSupervisorInventory(),
        config,
        pending: next.readPendingEnable(),
        attempted: next.hasGenerationAttempted(generation),
      });
    assert.equal(decide(paused), "continue");
    assert.equal(next.markGenerationAttempted(generation), true);
    assert.equal(
      decide(paused),
      "refused",
      "an ambiguous enable is not repeated",
    );
    assert.equal(
      decide({ ...paused, state: "enabled", sequence: 2 }),
      "refused",
    );
    assert.equal(
      decide({
        ...paused,
        state: "enabled",
        sequence: 1,
        configurationSha256: "other",
      }),
      "refused",
    );
    assert.equal(
      decide({ ...paused, state: "enabled", sequence: 1, generation: "other" }),
      "refused",
    );
    assert.equal(
      decide({ ...paused, state: "enabled", sequence: 1 }),
      "resolve",
    );
    next.resolveGenerationAttempt(generation);
    assert.equal(
      decide({ ...paused, state: "enabled", sequence: 1 }),
      "already-running",
    );
    assert.equal(
      decide(paused),
      "refused",
      "a spent generation cannot be enabled again",
    );
  });
});
