import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupFixtureJournal,
  readFixtureJournal,
  writeFixtureJournal,
} from "./relay-steady-docker-cleanup.mjs";

const token = "f7180462a21b",
  relay = "a".repeat(64),
  ingress = "b".repeat(64);
const fixture = (t, resources) => {
  const directory = mkdtempSync("/tmp/at78-journal-test-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json");
  writeFixtureJournal(
    path,
    {
      version: 1,
      token,
      primary: "failed",
      cleanup: "pending",
      resources: {
        network: { state: "unstarted" },
        relay: { state: "unstarted" },
        ingress: { state: "unstarted" },
        ...resources,
      },
    },
    true,
  );
  return path;
};
const missing = (kind, id) =>
  Object.assign(Error("docker"), {
    status: 1,
    stderr: `Error: No such ${kind}: ${id}\n`,
  });
const record = (id, role, value = token) =>
  JSON.stringify([
    {
      Id: id,
      Name: `/at78-fixture-${token}-${role}`,
      Config: {
        Labels: {
          "agent-table.test-scope": "isolated-restart-78",
          "agent-table.fixture-id": value,
        },
      },
    },
  ]);

test("cleanup validates immutable ID and fixture label and preserves primary failure", (t) => {
  const path = fixture(t, { relay: { state: "known", id: relay } });
  let removed = false,
    calls = 0;
  const result = cleanupFixtureJournal(path, {
    docker: (args, timeout) => {
      calls++;
      assert(timeout <= 3000);
      assert.equal(args.at(-1), relay);
      if (args[0] === "rm") {
        removed = true;
        throw Error("lost removal response");
      }
      if (!removed) return record(relay, "relay");
      throw missing("container", relay);
    },
  });
  assert.deepEqual(result, {
    primary: "failed",
    cleanup: "complete",
    unresolved: [],
  });
  assert.equal(calls, 3);
  assert.deepEqual(readFixtureJournal(path).resources.relay, {
    state: "removed",
    id: relay,
  });
  assert.equal(
    cleanupFixtureJournal(path, {
      docker: () => assert.fail("already verified"),
    }).cleanup,
    "complete",
  );
});

test("unknown IDs, foreign labels and daemon errors never permit removal", (t) => {
  const path = fixture(t, {
    relay: { state: "pending" },
    ingress: { state: "known", id: ingress },
  });
  const result = cleanupFixtureJournal(path, {
    docker: (args) => {
      assert.equal(args[0], "inspect");
      return record(ingress, "ingress", "a".repeat(12));
    },
  });
  assert.equal(result.cleanup, "incomplete");
  assert(result.unresolved.includes("relay:create-outcome-unknown"));
  const again = cleanupFixtureJournal(path, {
    docker: () => {
      throw Object.assign(Error("daemon unavailable"), {
        status: 1,
        stderr: "cannot connect",
      });
    },
  });
  assert.equal(again.cleanup, "incomplete");
  assert.equal(readFixtureJournal(path).resources.ingress.state, "known");
});

test("symlink journal and elapsed overall budget fail closed", (t) => {
  const path = fixture(t, { relay: { state: "known", id: relay } });
  symlinkSync(path, path + ".bad");
  assert.throws(() => readFixtureJournal(path + ".bad"));
  let n = 0;
  const result = cleanupFixtureJournal(path, {
    clock: () => n++ * 40_000,
    docker: () => assert.fail("overall deadline"),
  });
  assert.equal(result.cleanup, "incomplete");
});

const network = "c".repeat(64);
const networkRecord = () =>
  JSON.stringify([
    {
      Id: network,
      Name: `at78-fixture-${token}`,
      Labels: {
        "agent-table.test-scope": "isolated-restart-78",
        "agent-table.fixture-id": token,
      },
    },
  ]);
const exactNetworkList = [
  "network",
  "ls",
  "--no-trunc",
  "--filter",
  `id=${network}`,
  "--format",
  "{{.ID}}",
];

test("network removal uses positive exact-ID absence, even when rm response is lost", (t) => {
  const path = fixture(t, { network: { state: "known", id: network } });
  let calls = 0;
  const result = cleanupFixtureJournal(path, {
    docker: (args) => {
      if (++calls === 1) {
        assert.deepEqual(args, ["inspect", "--type", "network", network]);
        return networkRecord();
      }
      if (calls === 2) {
        assert.deepEqual(args, ["network", "rm", network]);
        throw Error("lost remove response");
      }
      assert.deepEqual(args, exactNetworkList);
      return "";
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.cleanup, "complete");
  assert.deepEqual(readFixtureJournal(path).resources.network, {
    state: "removed",
    id: network,
  });
});

test("network already absent uses list despite daemon-specific typed inspect text", (t) => {
  const path = fixture(t, { network: { state: "known", id: network } });
  let calls = 0;
  const result = cleanupFixtureJournal(path, {
    docker: (args) => {
      if (++calls === 1) {
        assert.deepEqual(args, ["inspect", "--type", "network", network]);
        throw Object.assign(Error("not found"), {
          status: 1,
          stderr: `Error response from daemon: network ${network} not found\n`,
        });
      }
      assert.deepEqual(args, exactNetworkList);
      return "";
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.cleanup, "complete");
});

test("a remaining network is distinct from unavailable or malformed readback", (t) => {
  for (const [list, reason] of [
    [() => network + "\n", "network:cleanup-still-present"],
    [() => relay + "\n", "network:cleanup-unverified"],
    [
      () => {
        throw Error("daemon unavailable");
      },
      "network:cleanup-unverified",
    ],
  ]) {
    const path = fixture(t, { network: { state: "known", id: network } });
    let removals = 0;
    const result = cleanupFixtureJournal(path, {
      docker: (args) => {
        if (args[0] === "inspect") return networkRecord();
        if (args[1] === "rm") {
          removals++;
          assert.equal(args[2], network);
          return network;
        }
        assert.deepEqual(args, exactNetworkList);
        return list();
      },
    });
    assert.equal(removals, 1);
    assert.equal(result.cleanup, "incomplete");
    assert.deepEqual(result.unresolved, [reason]);
    assert.equal(readFixtureJournal(path).resources.network.state, "known");
  }
});
