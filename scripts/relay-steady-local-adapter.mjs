// Integrates real local controller and ledger observations. The deployment
// supervisor must independently supply authenticated host identity/fence facts.
import { relayControl } from "./relay-control.mjs";
import { createSteadyOwnerState } from "./relay-steady-owner-state.mjs";
import {
  inspectSteadyRestartLedger,
  resumeAuthorizedSteadyRelay,
} from "./relay-steady-restart.mjs";

export async function attemptLocalSteadyRestart({
  ownerDirectory,
  socketPath,
  databasePath,
  readAuthorizedBinding,
  observeHostBoundary,
}) {
  const owner = createSteadyOwnerState(ownerDirectory);
  async function inspect() {
    const value = await relayControl(socketPath, { action: "inspect" });
    // The real inspect frame has inspectionOnly, not a command receipt's ok.
    if (
      value?.inspectionOnly !== true ||
      value.version !== 1 ||
      !["paused", "enabled"].includes(value.state)
    )
      throw Error("inspection-unavailable");
    return { ...value, ok: true };
  }
  return resumeAuthorizedSteadyRelay({
    withOwnerLock: owner.withOwnerLock,
    markGenerationAttempted: owner.markGenerationAttempted,
    resolveGenerationAttempt: owner.resolveGenerationAttempt,
    // Correlate the host proof to the same fresh controller generation and
    // config. Never let either provider override the local ledger facts.
    async observe() {
      const inhibit = owner.readInhibit();
      if (inhibit !== "clear") return null;
      const initial = await inspect();
      if (
        initial.ok !== true ||
        initial.state !== "paused" ||
        initial.sequence !== 0
      )
        return null;
      const authorization = await readAuthorizedBinding();
      const boundary = await observeHostBoundary({
        generation: initial.generation,
        configurationSha256: initial.configurationSha256,
      });
      const final = await inspect();
      if (
        final.ok !== true ||
        final.generation !== initial.generation ||
        final.configurationSha256 !== initial.configurationSha256 ||
        final.state !== initial.state ||
        final.sequence !== initial.sequence ||
        boundary?.generation !== final.generation ||
        boundary?.configurationSha256 !== final.configurationSha256
      )
        return null;
      return {
        authorization,
        operator: { inhibit },
        host: {
          ...boundary,
          ...final,
          ...inspectSteadyRestartLedger(databasePath),
        },
      };
    },
    enable: (command) => relayControl(socketPath, command),
    inspect,
  });
}
