/** PID1/private Unix-socket owner of the existing foreground launcher. */

import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  loadRelayLaunchConfiguration,
  runRelayLauncher,
} from "./relay-launcher.mjs";

import { createSteadyOwnerState } from "./relay-steady-owner-state.mjs";

const MAX = 65536;
const refused = () => new Error("controller-refused");
export async function runRelayController({
  configuration,
  socketPath,
  signals = process,
  output = process.stdout,
  createControlServer = createServer,
  createApplication,
  steadyOwnerDirectory,
}) {
  const steady =
    steadyOwnerDirectory === undefined
      ? null
      : createSteadyOwnerState(steadyOwnerDirectory, { controller: true });
  const parent = dirname(socketPath);
  const stat = lstatSync(parent);
  if (
    !isAbsolute(socketPath) ||
    realpathSync(parent) !== resolve(parent) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    existsSync(socketPath)
  )
    throw refused();
  const input = new PassThrough();
  const launcherOutput = new PassThrough();
  const launcherSignals = new EventEmitter();
  const sockets = new Set();
  let latest,
    pending,
    active,
    ending = false,
    bound = false,
    outputUnavailable = false;
  let bootstrapResolve, bootstrapReject;
  const bootstrap = new Promise((yes, no) => {
    bootstrapResolve = yes;
    bootstrapReject = no;
  });
  let buffered = Buffer.alloc(0);
  const server = createControlServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    let bytes = Buffer.alloc(0),
      submitted = false,
      responseSent = false,
      forwarded = false;
    socket.setTimeout(20000);
    const fail = () => {
      if (forwarded && !responseSent) shutdown();
      socket.destroy();
    };
    socket.on("error", fail);
    socket.on("timeout", fail);
    socket.on("close", () => {
      sockets.delete(socket);
      if (forwarded && !responseSent) shutdown();
    });
    const reply = (value) => {
      if (socket.destroyed || !socket.writable) {
        if (forwarded) shutdown();
        return;
      }
      socket.end(JSON.stringify(value) + "\n", () => {
        responseSent = true;
      });
    };
    socket.on("data", (chunk) => {
      if (submitted || ending) {
        fail();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX) {
        fail();
        return;
      }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      submitted = true;
      if (newline !== bytes.length - 1) {
        fail();
        return;
      }
      let command;
      try {
        command = JSON.parse(bytes.subarray(0, newline).toString());
      } catch {
        fail();
        return;
      }
      if (command?.action === "inspect" && Object.keys(command).length === 1) {
        reply({
          version: 1,
          ...latest,
          state: ending ? "unknown" : latest.state,
          inspectionOnly: true,
        });
        return;
      }
      if (steady && ["enable", "pause", "stop"].includes(command?.action)) {
        // The private owner socket is the single supported operation path.
        // Refuse malformed/stale commands before touching durable intent.
        if (
          Object.keys(command).sort().join(",") !==
            "action,configurationSha256,generation,payload,sequence,version" ||
          command.version !== 1 ||
          command.payload !== null ||
          command.generation !== latest?.generation ||
          command.configurationSha256 !== latest.configurationSha256 ||
          !Number.isSafeInteger(command.sequence) ||
          command.sequence <= latest.sequence
        ) {
          fail();
          return;
        }
        if (command.action === "enable" && steady.readInhibit() !== "clear") {
          reply({ ok: false, state: latest.state, code: "steady-inhibited" });
          return;
        }
        if (command.action !== "enable") {
          try {
            steady.recordInhibit(
              command.action === "stop" ? "quarantined" : "paused",
            );
          } catch {
            shutdown();
            fail();
            return;
          }
          // A competing already-forwarded enable may be committed; drain rather
          // than report that the pause was performed or retry either command.
          if (active) {
            shutdown();
            fail();
            return;
          }
        }
      }
      if (active) {
        reply({
          version: 1,
          state: "unknown",
          ok: false,
          code: "controller-busy",
        });
        return;
      }
      // No sequence, operation, decision or retry is synthesized here.
      active = { socket, reply };
      forwarded = true;
      if (!input.write(bytes)) shutdown();
    });
    socket.on("end", () => {
      if (!submitted) fail();
    });
  });
  const shutdown = () => {
    ending = true;
    if (server.listening) server.close();
    // EOF stops launcher intake and performs its bounded drain. Never enable/retry.
    if (!input.writableEnded && !input.destroyed) input.end();
  };
  server.maxConnections = 16;
  server.on("error", () => shutdown());
  const onSignal = () => shutdown();
  signals.on("SIGTERM", onSignal);
  signals.on("SIGINT", onSignal);
  const onOutputError = () => {
    outputUnavailable = true;
    shutdown();
  };
  output.on("error", onOutputError);
  output.on("close", onOutputError);
  output.on("finish", onOutputError);
  launcherOutput.on("data", (chunk) => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX) throw refused();
      for (;;) {
        const end = buffered.indexOf(10);
        if (end < 0) break;
        const line = buffered.subarray(0, end);
        buffered = buffered.subarray(end + 1);
        const receipt = JSON.parse(line.toString());
        latest = {
          version: 1,
          generation: receipt.generation,
          configurationSha256: receipt.configurationSha256,
          sequence: receipt.sequence ?? latest?.sequence ?? 0,
          state: receipt.state,
          ...(receipt.port === undefined
            ? latest?.port === undefined
              ? {}
              : { port: latest.port }
            : { port: receipt.port }),
          ...(receipt.settled === undefined
            ? {}
            : { settled: receipt.settled }),
        };
        if (!pending) {
          pending = true;
          bootstrapResolve(receipt);
        } else if (active) {
          const request = active;
          active = null;
          request.reply(receipt);
        }
      }
    } catch {
      bootstrapReject(refused());
      shutdown();
    }
  });
  launcherOutput.on("error", shutdown);
  const launched = runRelayLauncher({
    configuration,
    input,
    output: launcherOutput,
    signals: launcherSignals,
    createApplication,
  });
  // Observe termination before bootstrap as well; no unhandled background rejection.
  const settled = launched.then(
    (ok) => {
      bootstrapReject(refused());
      return ok;
    },
    () => {
      bootstrapReject(refused());
      return false;
    },
  );
  try {
    const first = await bootstrap;
    if (ending || first.state !== "paused") throw refused();
    await new Promise((yes, no) => {
      server.once("error", no);
      server.listen(socketPath, () => {
        bound = true;
        if (ending) {
          shutdown();
          no(refused());
        } else yes();
      });
    });
    chmodSync(socketPath, 0o600);
    // This line has identity/state only. Operator payload/results stay private.
    if (
      !output.write(JSON.stringify({ ...latest, controllerReady: true }) + "\n")
    )
      shutdown();
    const ok = await settled;
    shutdown();
    if (active) {
      const request = active;
      active = null;
      request.reply({
        ...latest,
        state: "unknown",
        ok: false,
        code: "controller-operation-unknown",
      });
    }
    for (const socket of sockets) socket.end();
    if (!outputUnavailable && !output.destroyed)
      output.write(
        JSON.stringify({
          ...latest,
          controllerStopped: true,
          settled:
            ok && latest?.state === "stopped" && latest?.settled === true,
        }) + "\n",
      );
    return ok;
  } catch {
    shutdown();
    await settled;
    throw refused();
  } finally {
    shutdown();
    for (const socket of sockets) socket.destroy();
    signals.off("SIGTERM", onSignal);
    signals.off("SIGINT", onSignal);
    output.off("error", onOutputError);
    output.off("close", onOutputError);
    output.off("finish", onOutputError);
    if (bound && existsSync(socketPath)) unlinkSync(socketPath);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (
      process.argv.length !== 8 ||
      process.argv[2] !== "--config" ||
      process.argv[4] !== "--expected-config-sha256" ||
      process.argv[6] !== "--socket"
    )
      throw refused();
    if (process.versions.node !== "24.22.1") throw refused();
    const configuration = loadRelayLaunchConfiguration(
      process.argv[3],
      process.argv[5],
    );
    if (
      !(await runRelayController({
        configuration,
        socketPath: process.argv[7],
        steadyOwnerDirectory: process.env.RELAY_STEADY_OWNER_DIR || undefined,
      }))
    )
      process.exitCode = 1;
  } catch {
    process.stderr.write("RELAY_CONTROLLER_BLOCKED\n");
    process.exitCode = 1;
  }
}
