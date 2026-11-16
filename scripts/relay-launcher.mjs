/**
 * Foreground, trusted-stdin operator entry. No network administration endpoint,
 * credential generation, deployment or automatic enablement.
 */
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReviewedCallbackDestination } from "../src/notifications/egress.ts";
import { createRelayApplication } from "./egress-relay-application.mjs";

const MAX = 65536;
const exact = (v, names) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === names.sort().join(",");
const requireValue = (v) => {
  if (!v) throw Error("launcher-refused");
};
function readBounded(path, secret = false) {
  requireValue(typeof path === "string" && isAbsolute(path));
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX);
  if (secret && process.platform !== "win32")
    requireValue((stat.mode & 0o077) === 0 && stat.uid === process.getuid());
  const bytes = readFileSync(path);
  requireValue(bytes.length <= MAX);
  return bytes;
}
export function loadRelayLaunchConfiguration(path, expectedSha256) {
  const bytes = readBounded(path);
  const configurationSha256 = createHash("sha256").update(bytes).digest("hex");
  requireValue(
    /^[a-f0-9]{64}$/.test(expectedSha256) &&
      expectedSha256 === configurationSha256,
  );
  const c = JSON.parse(bytes);
  requireValue(
    exact(c, [
      "version",
      "startup",
      "databasePath",
      "environment",
      "serviceId",
      "port",
      "tlsKeyPath",
      "tlsCertPath",
      "callers",
      "admission",
    ]) &&
      c.version === 1 &&
      c.startup === "paused" &&
      typeof c.databasePath === "string" &&
      isAbsolute(c.databasePath) &&
      ["test", "production"].includes(c.environment) &&
      /^[a-z][a-z0-9-]{2,63}$/.test(c.serviceId) &&
      Number.isInteger(c.port) &&
      c.port >= 0 &&
      c.port <= 65535 &&
      Array.isArray(c.callers) &&
      c.callers.length > 0 &&
      c.callers.length <= 100 &&
      exact(c.admission, [
        "perMinute",
        "globalPerMinute",
        "concurrency",
        "leaseMs",
        "maxReplayMs",
        "maxRecords",
        "busyTimeoutMs",
        "operatorRecoveryPolicy",
      ]) &&
      exact(c.admission.operatorRecoveryPolicy, [
        "planFreshnessMs",
        "receiptRetentionMs",
        "maxReceipts",
      ]),
  );
  const integer = (value, min, max) =>
    Number.isSafeInteger(value) && value >= min && value <= max;
  for (const [name, min, max] of [
    ["perMinute", 1, 1000],
    ["globalPerMinute", 1, 10000],
    ["concurrency", 1, 1000],
    ["leaseMs", 1000, 60000],
    ["maxReplayMs", 1000, 300000],
    ["maxRecords", 1, 1000000],
    ["busyTimeoutMs", 0, 1000],
  ])
    requireValue(integer(c.admission[name], min, max));
  const policy = c.admission.operatorRecoveryPolicy;
  requireValue(
    integer(policy.planFreshnessMs, 1000, 300000) &&
      integer(policy.receiptRetentionMs, 86400000, 2592000000) &&
      integer(policy.maxReceipts, 1, 1000),
  );
  const callers = new Map();
  for (const caller of c.callers) {
    requireValue(
      exact(caller, ["callerId", "publicKeySpki", "targets"]) &&
        /^[A-Za-z0-9_-]{16,128}$/.test(caller.callerId) &&
        !callers.has(caller.callerId) &&
        typeof caller.publicKeySpki === "string" &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(caller.publicKeySpki),
    );
    const key = Buffer.from(caller.publicKeySpki, "base64");
    requireValue(key.toString("base64") === caller.publicKeySpki);
    requireValue(
      createPublicKey({ format: "der", type: "spki", key })
        .asymmetricKeyType === "ed25519" &&
        Array.isArray(caller.targets) &&
        caller.targets.length > 0 &&
        caller.targets.length <= 100 &&
        caller.targets.every(
          (t) =>
            exact(t, ["origin", "pathPrefix"]) &&
            validateReviewedCallbackDestination(t.origin + t.pathPrefix, [t])
              .ok,
        ),
    );
    callers.set(caller.callerId, {
      publicKey: { format: "der", type: "spki", key },
      targets: caller.targets,
    });
  }
  return {
    configurationSha256,
    port: c.port,
    options: {
      databasePath: c.databasePath,
      environment: c.environment,
      serviceId: c.serviceId,
      callers,
      admission: c.admission,
      key: readBounded(c.tlsKeyPath, true),
      cert: readBounded(c.tlsCertPath),
      messageDelivery: true,
      challengeVerification: true,
    },
  };
}

/** Factory injection is a trusted module test seam; the CLI cannot deserialize it. */
export async function runRelayLauncher({
  configuration,
  input = process.stdin,
  output = process.stdout,
  signals = process,
  createApplication = createRelayApplication,
}) {
  const generation = randomUUID();
  const { configurationSha256, options, port } = configuration;
  let app,
    closing = false,
    enabled = false,
    sequence = 0,
    shutdown;
  const emit = (value) => {
    const wire = JSON.stringify({
      version: 1,
      generation,
      configurationSha256,
      ...value,
    });
    requireValue(Buffer.byteLength(wire) <= MAX);
    if (outputUnavailable) return;
    if (!output.write(`${wire}\n`)) onOutputLoss();
  };
  const stop = () => {
    if (shutdown) return shutdown;
    closing = true;
    enabled = false;
    shutdown = (async () => {
      try {
        await app.close();
        emit({ state: "stopped", settled: true });
        return true;
      } catch {
        // No successful stop receipt, no implicit lease release or forced retry.
        emit({ state: "unknown", settled: false });
        return false;
      }
    })();
    return shutdown;
  };
  let outputUnavailable = false;
  const onOutputLoss = () => {
    outputUnavailable = true;
    void stop();
    input.destroy();
  };
  output.on("error", onOutputLoss);
  const onSignal = () => {
    void stop();
    input.destroy();
  };
  try {
    app = createApplication(options);
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(port, "127.0.0.1", resolve);
    });
    signals.on("SIGTERM", onSignal);
    signals.on("SIGINT", onSignal);
    emit({ state: "paused", port: app.server.address().port });
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of input) {
        if (closing) break;
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        requireValue(pending.length <= MAX);
        while (!closing) {
          const end = pending.indexOf(10);
          if (end === -1) break;
          const line = pending.subarray(0, end);
          pending = pending.subarray(end + 1);
          let command;
          try {
            command = JSON.parse(line.toString("utf8"));
            requireValue(
              exact(command, [
                "version",
                "generation",
                "configurationSha256",
                "sequence",
                "action",
                "payload",
              ]) &&
                command.version === 1 &&
                command.generation === generation &&
                command.configurationSha256 === configurationSha256 &&
                Number.isSafeInteger(command.sequence) &&
                command.sequence > sequence,
            );
            // Consume before attempting the effect; never implicitly repeat an
            // enable/mutation whose response was lost.
            sequence = command.sequence;
            const { action, payload } = command;
            let result;
            if (action === "enable") {
              requireValue(payload === null && !enabled);
              app.setEnabled(true);
              enabled = true;
            } else if (action === "pause") {
              requireValue(payload === null);
              app.setEnabled(false);
              enabled = false;
            } else if (action === "status") {
              requireValue(payload === null);
            } else if (action === "plan-recovery") {
              requireValue(payload === null && !enabled);
              result = app.planRecovery();
            } else if (action === "apply-recovery") {
              requireValue(
                !enabled &&
                  payload &&
                  !(
                    payload.ownerRecord?.transportState === "stopped" &&
                    payload.ownerRecord?.processGeneration === generation
                  ),
              );
              result = app.applyRecovery(payload);
            } else if (action === "read-recovery") {
              requireValue(typeof payload === "string");
              result = app.readRecovery(payload);
            } else if (action === "stop") {
              requireValue(payload === null);
              await stop();
              input.destroy();
              break;
            } else throw Error("launcher-refused");
            emit({
              sequence,
              state: enabled ? "enabled" : "paused",
              ok: result?.ok !== false,
              ...(result === undefined ? {} : { result }),
            });
          } catch {
            // Refusal itself pauses intake, including stale/foreign/duplicate
            // enable commands. Never echo raw input, errors, URLs or keys.
            app.setEnabled(false);
            enabled = false;
            emit({
              sequence,
              state: "paused",
              ok: false,
              code: "operator-command-refused",
            });
          }
        }
      }
      requireValue(closing || pending.length === 0);
    } catch {
      if (!closing)
        emit({
          state: "paused",
          ok: false,
          code: "operator-input-unavailable",
        });
    }
    return await stop();
  } catch {
    if (app) await stop();
    throw Error("launcher-unavailable");
  } finally {
    signals.off("SIGTERM", onSignal);
    signals.off("SIGINT", onSignal);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    requireValue(
      process.argv.length === 6 &&
        process.argv[2] === "--config" &&
        process.argv[4] === "--expected-config-sha256",
    );
    const configuration = loadRelayLaunchConfiguration(
      process.argv[3],
      process.argv[5],
    );
    if (!(await runRelayLauncher({ configuration }))) process.exitCode = 1;
  } catch {
    process.stderr.write("RELAY_LAUNCHER_BLOCKED\n");
    process.exitCode = 1;
  }
}
