/**
 * Isolated real-Docker oracle. CI provisions a stopped synthetic pair,
 * trusted local HTTPS and exact enrollment. No production host accepted.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { observeSteadyDockerBoundary } from "./relay-steady-docker-boundary.mjs";
import {
  readExplicitSteadyEnrollment,
  recoverEnrolledSteadyDockerPair,
  watchEnrolledSteadyDockerPair,
} from "./relay-steady-host-supervisor.mjs";
import { createSteadyOwnerState } from "./relay-steady-owner-state.mjs";

const fault = process.argv[3];
if (
  process.argv.length !== 3 &&
  (process.argv.length !== 4 ||
    !["after-inventory", "after-enable"].includes(fault))
)
  throw Error("usage: relay-steady-docker-harness.mjs <fixture enrollment>");
const path = process.argv[2],
  plan = readExplicitSteadyEnrollment(path);
const route = new URL(plan.routeStatusUrl);
assert.equal(route.hostname, "127.0.0.1");
assert.match(plan.relayName, /^at78-fixture-[a-z0-9]+-relay$/);
assert.equal(plan.ingressName, plan.relayName.replace(/-relay$/, "-ingress"));
assert.match(plan.stateSource, /^\/tmp\/at78-fixture-[a-z0-9]+\/state$/);
assert.match(plan.configSource, /^\/tmp\/at78-fixture-[a-z0-9]+\/config$/);
assert.match(
  plan.ingressConfigSource,
  /^\/tmp\/at78-fixture-[a-z0-9]+\/ingress$/,
);
const ids = plan.priorIncarnations.map((item) => item.id);
function docker(args, input) {
  return execFileSync(
    "/usr/bin/docker",
    ["--host", "unix:///var/run/docker.sock", ...args],
    { encoding: "utf8", input, timeout: 20_000 },
  );
}
for (const [index, container] of JSON.parse(
  docker(["inspect", ...ids]),
).entries()) {
  assert.equal(
    container.Config.Labels?.["agent-table.test-scope"],
    "isolated-restart-78",
  );
  assert.equal(
    container.State.Running,
    fault === "after-enable" || index === 1,
  );
}
const prefix = [
  "exec",
  "-i",
  ids[0],
  "node",
  "scripts/relay-control.mjs",
  "--socket",
  "/run/agent-table-relay/control.sock",
];
const state = createSteadyOwnerState(plan.ownerDirectory);
if (fault) {
  const crash = () => process.exit(72);
  await recoverEnrolledSteadyDockerPair(path, {
    ...(fault === "after-inventory"
      ? { afterInventory: crash }
      : { afterEnable: crash }),
  });
  throw Error("expected isolated owner fault did not happen");
}
async function inject(phase) {
  const child = spawn(process.execPath, [process.argv[1], path, phase], {
    stdio: "inherit",
  });
  const [exit, signal] = await once(child, "exit");
  assert.equal(signal, null);
  assert.equal(exit, 72);
}
await inject("after-inventory");
const before = JSON.parse(docker([...prefix, "--inspect"]));
assert.equal(before.state, "paused");
assert.equal(before.sequence, 0);
await state.withOwnerLock(() => {
  assert.equal(state.readSupervisorInventory().generation, before.generation);
  assert.equal(state.readPendingEnable(), null);
  assert.equal(state.hasGenerationAttempted(before.generation), false);
});
await inject("after-enable");
const uncertain = JSON.parse(docker([...prefix, "--inspect"]));
assert.equal(uncertain.state, "enabled");
assert.equal(uncertain.generation, before.generation);
assert.equal(uncertain.sequence, 1);
await state.withOwnerLock(() =>
  assert.equal(state.readPendingEnable(), before.generation),
);
const stop = new AbortController();
let watchFailure;
const watcher = watchEnrolledSteadyDockerPair(path, stop.signal).catch(
  (error) => {
    watchFailure = error;
  },
);
let enabled;
try {
  const deadline = Date.now() + 55_000;
  while (!watchFailure && Date.now() < deadline) {
    try {
      const frame = JSON.parse(docker([...prefix, "--inspect"]));
      if (frame.state === "enabled") {
        enabled = frame;
        break;
      }
    } catch {}
    await new Promise((yes) => setTimeout(yes, 250));
  }
} finally {
  stop.abort();
  await watcher;
}
if (watchFailure) throw watchFailure;
assert.equal(enabled?.state, "enabled");
assert.equal(enabled.sequence, 1);
const boundary = observeSteadyDockerBoundary(plan, enabled);
assert.deepEqual(
  boundary.incarnations.map((item) => item.id),
  ids,
);
assert.equal(
  boundary.incarnations[0].namespace,
  boundary.incarnations[1].namespace,
);
await state.withOwnerLock(() => {
  assert.deepEqual(
    state.readSupervisorInventory().incarnations,
    boundary.incarnations,
  );
  assert.equal(state.readPendingEnable(), null);
  assert.equal(state.hasGenerationAttempted(enabled.generation), true);
});
const paused = JSON.parse(
  docker(
    [...prefix, "--stdin"],
    JSON.stringify({
      version: 1,
      generation: enabled.generation,
      configurationSha256: enabled.configurationSha256,
      sequence: 2,
      action: "pause",
      payload: null,
    }),
  ),
);
assert.equal(paused.state, "paused");
await state.withOwnerLock(() => assert.equal(state.readInhibit(), "paused"));
docker(["stop", ids[1], ids[0]]);
assert.deepEqual(await recoverEnrolledSteadyDockerPair(path), {
  state: "inhibited",
  enabled: false,
});
for (const container of JSON.parse(docker(["inspect", ...ids])))
  assert.equal(container.State.Running, false);
console.log(
  "Isolated Docker restart/namespace/persistent pause oracle passed; no receiver delivery assertion.",
);
