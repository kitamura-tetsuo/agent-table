// Read-only Linux host observations for the opt-in single-host deployment.
// Local Docker authority is required; never attach its socket to the relay.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import {
  priorIncarnationRetired,
  sameIncarnation,
  validIncarnation,
} from "./relay-steady-incarnation.mjs";

const invalid = () => Error("steady-docker-boundary-unavailable");
const dockerInspect = (ids) =>
  JSON.parse(
    execFileSync(
      "/usr/bin/docker",
      [
        "--host",
        "unix:///var/run/docker.sock",
        "inspect",
        "--type",
        "container",
        ...ids,
      ],
      { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 },
    ),
  );
const idPattern = /^[0-9a-f]{64}$/;
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
function procIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw invalid();
  const base = "/proc/" + pid;
  const stat = readFileSync(base + "/stat", "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(" ");
  const namespace = statSync(base + "/ns/net");
  return {
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pid,
    start: fields[19],
    cgroup: readFileSync(base + "/cgroup", "utf8"),
    namespace: namespace.dev + ":" + namespace.ino,
  };
}
export function readLiveContainerIncarnation(pid, id) {
  const p = { ...procIdentity(pid), id };
  if (!validIncarnation(p)) throw invalid();
  return p;
}
export function observePriorContainerRetirement(prior) {
  if (!validIncarnation(prior)) return false;
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId))
    return false;
  if (bootId !== prior.bootId) return true;
  try {
    return procIdentity(prior.pid).start !== prior.start;
  } catch {
    try {
      statSync("/proc/" + prior.pid);
    } catch (error) {
      return error.code === "ENOENT";
    }
    return false;
  }
}

/**
 * Prior inputs are durable inventory captured before stop by the deployment
 * owner. All previously enrolled transports must still be inspectable as
 * stopped: missing records are not proof. Existing uninstrumented deployments
 * require reviewed initial enrollment; this function does not infer it.
 */
export function observeSteadyDockerBoundary(
  binding,
  current,
  { continuation = false } = {},
) {
  const {
    relayName,
    ingressName,
    imageDigest,
    ingressImageDigest,
    stateSource,
    configSource,
    ingressConfigSource,
    priorIncarnations,
  } = binding;
  if (
    !namePattern.test(relayName) ||
    !namePattern.test(ingressName) ||
    relayName === ingressName ||
    !Array.isArray(priorIncarnations) ||
    priorIncarnations.length !== 2 ||
    !priorIncarnations.every(validIncarnation) ||
    priorIncarnations[0].id === priorIncarnations[1].id ||
    !/^sha256:[0-9a-f]{64}$/.test(imageDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(ingressImageDigest)
  )
    throw invalid();
  const [relay, ingress] = dockerInspect([relayName, ingressName]);
  const mounted = (container, destination, source, writable) =>
    container?.Mounts?.filter((m) => m.Destination === destination).length ===
      1 &&
    container.Mounts.some(
      (m) =>
        m.Type === "bind" &&
        m.Destination === destination &&
        typeof source === "string" &&
        source.startsWith("/") &&
        m.Source === source &&
        m.RW === writable,
    );
  if (
    ![relay?.Id, ingress?.Id].every((id) => idPattern.test(id)) ||
    relay.Name !== "/" + relayName ||
    ingress.Name !== "/" + ingressName ||
    relay.Image !== imageDigest ||
    ingress.Image !== ingressImageDigest ||
    !relay.State.Running ||
    !ingress.State.Running ||
    relay.HostConfig.RestartPolicy.Name !== "no" ||
    ingress.HostConfig.RestartPolicy.Name !== "no" ||
    !mounted(relay, "/state", stateSource, true) ||
    !mounted(relay, "/config", configSource, false) ||
    !mounted(ingress, "/config", ingressConfigSource, false) ||
    ingress.HostConfig.NetworkMode !== "container:" + relay.Id ||
    relay.HostConfig.NetworkMode === "host" ||
    Object.values(relay.HostConfig.PortBindings ?? {}).some(
      (ports) => ports?.length,
    )
  )
    throw invalid();
  const relayProcess = readLiveContainerIncarnation(relay.State.Pid, relay.Id);
  const ingressProcess = readLiveContainerIncarnation(
    ingress.State.Pid,
    ingress.Id,
  );
  const readPrior = (p) => {
    try {
      return { state: "present", ...procIdentity(p.pid) };
    } catch (error) {
      // A missing namespace/cgroup while the PID still exists is not proof.
      try {
        statSync("/proc/" + p.pid);
      } catch (e) {
        if (e.code === "ENOENT") return { state: "absent" };
      }
      return { state: "unknown" };
    }
  };
  if (
    relayProcess.namespace !== ingressProcess.namespace ||
    !priorIncarnations.every((prior, index) =>
      continuation
        ? sameIncarnation(prior, [relayProcess, ingressProcess][index])
        : priorIncarnationRetired(
            prior,
            [relayProcess, ingressProcess][index],
            readPrior(prior),
          ),
    )
  )
    throw invalid();
  const [r, i] = dockerInspect([relayName, ingressName]);
  if (
    r.Id !== relay.Id ||
    i.Id !== ingress.Id ||
    !r.State.Running ||
    !i.State.Running ||
    !sameIncarnation(
      readLiveContainerIncarnation(r.State.Pid, r.Id),
      relayProcess,
    ) ||
    !sameIncarnation(
      readLiveContainerIncarnation(i.State.Pid, i.Id),
      ingressProcess,
    )
  )
    throw invalid();
  return {
    ...current,
    imageDigest: relay.Image,
    priorTransportsStopped: true,
    namespaceVerified: true,
    incarnations: [relayProcess, ingressProcess],
  };
}
