/**
 * One explicitly enrolled Linux Docker pair, one bounded recovery attempt.
 * No timer or service is installed. The caller owns enrollment and invocation.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  observePriorContainerRetirement,
  observeSteadyDockerBoundary,
  readLiveContainerIncarnation,
} from "./relay-steady-docker-boundary.mjs";
import {
  sameIncarnation,
  validIncarnation,
} from "./relay-steady-incarnation.mjs";
import { createSteadyOwnerState } from "./relay-steady-owner-state.mjs";
import {
  inspectSteadyRestartLedger,
  resumeAuthorizedSteadyRelay,
} from "./relay-steady-restart.mjs";

const refuse = () => Error("steady-host-supervisor-refused");
const docker = (args, input, timeout = 10_000) =>
  execFileSync(
    "/usr/bin/docker",
    ["--host", "unix:///var/run/docker.sock", ...args],
    { encoding: "utf8", input, timeout, maxBuffer: 1024 * 1024 },
  );

export function readExplicitSteadyEnrollment(path) {
  if (realpathSync(path) !== resolve(path)) throw refuse();
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 16_384
  )
    throw refuse();
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (
    data.version !== 1 ||
    data.mode !== "steady" ||
    data.environment !== "production" ||
    !/^[a-f0-9]{64}$/.test(data.configurationSha256) ||
    !Array.isArray(data.priorIncarnations) ||
    data.priorIncarnations.length !== 2 ||
    !data.priorIncarnations.every(validIncarnation) ||
    typeof data.storeId !== "string" ||
    typeof data.serviceId !== "string" ||
    typeof data.ownerDirectory !== "string" ||
    typeof data.databasePath !== "string"
  )
    throw refuse();
  return data;
}

export function hasEnrolledContainerProgram(relay, ingress, binding) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const expectedRelayCommand = [
    "--config",
    "/config/relay.json",
    "--expected-config-sha256",
    binding.configurationSha256,
    "--socket",
    "/run/agent-table-relay/control.sock",
  ];
  const program = (container, entrypoint, cmd, workdir) =>
    Array.isArray(entrypoint) &&
    entrypoint.length > 0 &&
    Array.isArray(cmd) &&
    same(container?.Config?.Entrypoint, entrypoint) &&
    same(container.Config.Cmd, cmd) &&
    container.Config.WorkingDir === workdir &&
    container.HostConfig?.ReadonlyRootfs === true;
  // Reject overlay mounts that replace the pinned entrypoint or runtime.
  const mounts = (container, allowed) =>
    Array.isArray(container?.Mounts) &&
    container.Mounts.every((m) => allowed.includes(m.Destination));
  const env = relay?.Config?.Env;
  return (
    program(
      relay,
      ["node", "scripts/relay-controller.mjs"],
      expectedRelayCommand,
      "/app",
    ) &&
    program(
      ingress,
      binding.ingressEntrypoint,
      binding.ingressCommand,
      binding.ingressWorkingDir,
    ) &&
    mounts(relay, ["/config", "/state", "/run/agent-table-relay"]) &&
    mounts(ingress, ["/config"]) &&
    Array.isArray(env) &&
    env.filter((value) => value.startsWith("RELAY_STEADY_OWNER_DIR="))
      .length === 1 &&
    env.includes("RELAY_STEADY_OWNER_DIR=/state/steady-owner") &&
    !env.some((value) =>
      /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH)=/.test(value),
    )
  );
}

async function probeRoute(target) {
  const url = new URL(target);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/relay/v1/status" ||
    url.search ||
    url.hash
  )
    throw refuse();
  const output = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (
    output.status !== 404 ||
    !output.headers.get("content-type")?.startsWith("application/json") ||
    !output.headers.get("cache-control")?.includes("no-store") ||
    !output.body
  )
    return false;
  const reader = output.body.getReader();
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += Buffer.from(value).toString("ascii");
      if (body.length > 64) return false;
    }
    return body === '{"code":"unavailable"}';
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function classifyEnrolledPair(states, prior, live, retired) {
  if (!Array.isArray(states) || states.length !== 2)
    return { state: "refused" };
  const living = [];
  for (let index = 0; index < 2; index++) {
    const item = states[index];
    if (!item || item.Restarting) return { state: "refused" };
    if (
      item.Running &&
      item.Status === "running" &&
      sameIncarnation(prior[index], live[index])
    )
      living.push(index);
    else if (
      item.Running ||
      !["exited", "dead"].includes(item.Status) ||
      item.Pid !== 0 ||
      retired[index] !== true
    )
      return { state: "refused" };
  }
  return living.length === 2
    ? { state: "running" }
    : living.length === 1
      ? { state: "partial", survivor: living[0] }
      : { state: "stopped" };
}

export function decideRunningPairRecovery({
  frame,
  saved,
  pending,
  attempted,
  config,
}) {
  if (frame?.ok !== true || frame.configurationSha256 !== config)
    return "refused";
  if (
    saved &&
    (saved.generation !== frame.generation ||
      saved.configurationSha256 !== config)
  )
    return "refused";
  if (pending !== null)
    return saved &&
      pending === frame.generation &&
      attempted &&
      frame.state === "enabled" &&
      frame.sequence === 1
      ? "resolve"
      : "refused";
  if (
    frame.state === "enabled" &&
    Number.isSafeInteger(frame.sequence) &&
    frame.sequence >= 1
  )
    return "already-running";
  if (saved && frame.state === "paused" && frame.sequence === 0 && !attempted)
    return "continue";
  return "refused";
}

export async function recoverEnrolledSteadyDockerPair(
  enrollmentPath,
  { afterInventory, afterEnable } = {},
) {
  const binding = readExplicitSteadyEnrollment(enrollmentPath);
  const owner = createSteadyOwnerState(binding.ownerDirectory);
  let enrolled = binding;
  const [relayId, ingressId] = binding.priorIncarnations.map((p) => p.id);
  function control(command) {
    const args = [
      "exec",
      "-i",
      relayId,
      "node",
      "scripts/relay-control.mjs",
      "--socket",
      "/run/agent-table-relay/control.sock",
    ];
    if (!command) {
      const result = JSON.parse(docker([...args, "--inspect"]));
      if (
        result?.inspectionOnly !== true ||
        result.version !== 1 ||
        !["paused", "enabled"].includes(result.state)
      )
        throw refuse();
      return { ...result, ok: true };
    }
    return JSON.parse(docker([...args, "--stdin"], JSON.stringify(command)));
  }
  return owner.withOwnerLock(async () => {
    if (owner.readInhibit() !== "clear")
      return { enabled: false, state: "inhibited" };
    const saved = owner.readSupervisorInventory();
    if (saved !== null) {
      if (
        !Array.isArray(saved.incarnations) ||
        saved.incarnations.length !== 2 ||
        !saved.incarnations.every(validIncarnation) ||
        saved.incarnations[0].id !== relayId ||
        saved.incarnations[1].id !== ingressId ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
          saved.generation,
        ) ||
        saved.configurationSha256 !== binding.configurationSha256
      )
        throw refuse();
      enrolled = { ...binding, priorIncarnations: saved.incarnations };
    }
    const [relay, ingress] = JSON.parse(
      docker(["inspect", "--type", "container", relayId, ingressId]),
    );
    // Exact enrolled pair only; no container discovery or image replacement.
    for (const [container, id, name, image] of [
      [relay, relayId, binding.relayName, binding.imageDigest],
      [ingress, ingressId, binding.ingressName, binding.ingressImageDigest],
    ]) {
      if (
        container?.Id !== id ||
        container.Name !== "/" + name ||
        container.Image !== image ||
        container.HostConfig.RestartPolicy.Name !== "no"
      )
        throw refuse();
    }
    const hasExactMount = (container, dest, src, rw) =>
      container.Mounts?.filter((m) => m.Destination === dest).length === 1 &&
      container.Mounts.some(
        (m) =>
          m.Type === "bind" &&
          m.Destination === dest &&
          m.Source === src &&
          m.RW === rw,
      );
    if (
      binding.ownerDirectory !== binding.stateSource + "/steady-owner" ||
      !hasExactMount(relay, "/state", binding.stateSource, true) ||
      !hasExactMount(relay, "/config", binding.configSource, false) ||
      !hasExactMount(ingress, "/config", binding.ingressConfigSource, false) ||
      !relay.Config.Env?.includes(
        "RELAY_STEADY_OWNER_DIR=/state/steady-owner",
      ) ||
      ingress.HostConfig.NetworkMode !== "container:" + relayId ||
      relay.HostConfig.NetworkMode === "host" ||
      Object.values(relay.HostConfig.PortBindings ?? {}).some((p) => p?.length)
    )
      throw refuse();
    if (!hasEnrolledContainerProgram(relay, ingress, binding)) throw refuse();
    const relayConfig = join(binding.configSource, "relay.json");
    const configStat = lstatSync(relayConfig);
    if (
      !configStat.isFile() ||
      configStat.size > 65_536 ||
      realpathSync(relayConfig) !== relayConfig
    )
      throw refuse();
    const configBytes = readFileSync(relayConfig);
    if (
      createHash("sha256").update(configBytes).digest("hex") !==
      binding.configurationSha256
    )
      throw refuse();
    const config = JSON.parse(configBytes);
    if (
      config.environment !== binding.environment ||
      config.serviceId !== binding.serviceId ||
      config.startup !== "paused" ||
      config.databasePath !==
        "/state/" +
          binding.databasePath.slice(binding.stateSource.length + 1) ||
      !binding.databasePath.startsWith(binding.stateSource + "/")
    )
      throw refuse();
    const statusUrl = new URL(binding.routeStatusUrl);
    if (
      statusUrl.origin !== binding.routeOrigin ||
      statusUrl.pathname !== "/relay/v1/status"
    )
      throw refuse();
    const pair = [relay, ingress];
    const prior = enrolled.priorIncarnations;
    const readPairState = (items) =>
      classifyEnrolledPair(
        items.map((item) => item.State),
        prior,
        items.map((item) =>
          item.State.Running
            ? readLiveContainerIncarnation(item.State.Pid, item.Id)
            : null,
        ),
        items.map(
          (item, index) =>
            !item.State.Running &&
            observePriorContainerRetirement(prior[index]),
        ),
      );
    const starting = readPairState(pair);
    const pending = owner.readPendingEnable();
    const continuation = starting.state === "running";
    let initial;
    if (continuation) {
      initial = control();
      const disposition = decideRunningPairRecovery({
        frame: initial,
        saved,
        pending,
        attempted: owner.hasGenerationAttempted(initial.generation),
        config: binding.configurationSha256,
      });
      if (disposition === "refused") throw refuse();
      observeSteadyDockerBoundary(enrolled, initial, { continuation: true });
      if (disposition === "resolve") {
        owner.resolveGenerationAttempt(initial.generation);
        return { enabled: true, state: "enabled" };
      }
      if (disposition === "already-running")
        return { enabled: false, state: "already-running" };
    } else if (pending !== null) throw refuse();
    const ledger = inspectSteadyRestartLedger(binding.databasePath);
    if (
      !ledger ||
      ledger.storeId !== binding.storeId ||
      ledger.activeAdmissions !== 0 ||
      ledger.unresolvedOutcomes !== 0
    )
      throw refuse();
    if (!continuation) {
      if (starting.state === "partial") {
        // Stay within exclusive lifecycle ownership: re-observe both before
        // stopping the single exact survivor; never stop a replacement.
        const check = JSON.parse(
          docker(["inspect", "--type", "container", relayId, ingressId]),
        );
        const next = readPairState(check);
        if (next.state !== "partial" || next.survivor !== starting.survivor)
          throw refuse();
        docker(
          ["stop", "--time", "30", pair[starting.survivor].Id],
          undefined,
          45_000,
        );
        const after = JSON.parse(
          docker(["inspect", "--type", "container", relayId, ingressId]),
        );
        if (readPairState(after).state !== "stopped") throw refuse();
        const drained = inspectSteadyRestartLedger(binding.databasePath);
        if (
          !drained ||
          drained.storeId !== binding.storeId ||
          drained.activeAdmissions !== 0 ||
          drained.unresolvedOutcomes !== 0
        )
          throw refuse();
      } else if (starting.state !== "stopped") throw refuse();
      docker(["start", relayId]);
      // A failed start, uncertain command response or listener wait never retries
      // the launch or reports readiness. The opt-in controller starts paused.
      for (let n = 0; n < 30; n++) {
        try {
          initial = control();
          break;
        } catch {
          await new Promise((yes) => setTimeout(yes, 200));
        }
      }
      if (
        initial?.state !== "paused" ||
        initial.sequence !== 0 ||
        initial.configurationSha256 !== binding.configurationSha256
      )
        throw refuse();
      docker(["start", ingressId]);
      observeSteadyDockerBoundary(enrolled, initial);
    }
    // Startup attachment can lag container start. Only the read-only sentinel
    // is polled, with one overall deadline. No activation is repeated.
    const routeDeadline = Date.now() + 12_000;
    let routeVerified = false;
    while (Date.now() < routeDeadline) {
      try {
        routeVerified = await probeRoute(binding.routeStatusUrl);
      } catch {}
      if (routeVerified) break;
      await new Promise((yes) => setTimeout(yes, 250));
    }
    if (!routeVerified) throw refuse();
    const latest = control();
    if (
      latest.state !== "paused" ||
      latest.sequence !== 0 ||
      latest.generation !== initial.generation
    )
      throw refuse();
    const actual = observeSteadyDockerBoundary(enrolled, latest, {
      continuation,
    });
    const [readbackRelay, readbackIngress] = JSON.parse(
      docker(["inspect", "--type", "container", relayId, ingressId]),
    );
    if (!hasEnrolledContainerProgram(readbackRelay, readbackIngress, binding))
      throw refuse();
    // Save machine-observed successor identities before an enable can have an
    // effect, including if its receipt is subsequently lost.
    owner.recordSupervisorInventory({
      incarnations: actual.incarnations,
      generation: latest.generation,
      configurationSha256: latest.configurationSha256,
    });
    // Trusted module-only fault injection for the isolated fixture.
    await afterInventory?.();
    return resumeAuthorizedSteadyRelay({
      withOwnerLock: (fn) => fn(), // Outer deployment owner lock already held.
      markGenerationAttempted: owner.markGenerationAttempted,
      resolveGenerationAttempt: owner.resolveGenerationAttempt,
      observe: () => ({
        authorization: binding,
        operator: { inhibit: owner.readInhibit() },
        host: {
          ...actual,
          ...latest,
          ...inspectSteadyRestartLedger(binding.databasePath),
          environment: binding.environment,
          serviceId: binding.serviceId,
          tlsVerified: true,
        },
      }),
      enable: async (command) => {
        const receipt = control(command);
        await afterEnable?.();
        return receipt;
      },
      inspect: () => control(),
    });
  });
}

export async function watchEnrolledSteadyDockerPair(enrollmentPath, signal) {
  while (!signal.aborted) {
    const result = await recoverEnrolledSteadyDockerPair(enrollmentPath);
    if (
      !signal.aborted &&
      !["enabled", "already-running", "inhibited"].includes(
        result.enabled ? "enabled" : result.state,
      )
    )
      throw refuse();
    await new Promise((yes) => setTimeout(yes, 2000));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (
      process.argv.length === 5 &&
      process.argv[2] === "--watch" &&
      process.argv[3] === "--enrollment"
    ) {
      const stop = new AbortController();
      process.once("SIGTERM", () => stop.abort());
      process.once("SIGINT", () => stop.abort());
      await watchEnrolledSteadyDockerPair(process.argv[4], stop.signal);
    } else {
      if (process.argv.length !== 4 || process.argv[2] !== "--enrollment")
        throw refuse();
      const result = await recoverEnrolledSteadyDockerPair(process.argv[3]);
      process.stdout.write(JSON.stringify(result) + "\n");
      if (!result.enabled) process.exitCode = 1;
    }
  } catch {
    process.stderr.write("STEADY_RESTART_BLOCKED\n");
    process.exitCode = 1;
  }
}
