// Kill-test the OAuth replay oracle using the real provider and workerd.
// The deliberate mutant is never committed: restore the source in finally.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/auth/token-do.ts", import.meta.url));
const original = readFileSync(source, "utf8");
const safeBoundary = [
  "      await before;",
  "      const queuedRefusal = this.refusal();",
  "      if (queuedRefusal) return queuedRefusal;",
  "      if (this.probe) this.probe.providerEntries++;",
  "      const environment = this.observedEnvironment();",
  "      const response = await authorizationServer(environment).fetch(",
  "        request,",
  "        environment,",
  "        this.ctx as unknown as ExecutionContext,",
  "      );",
  "      return this.refusal() ?? response;",
].join("\n");
// Change only the queue wait. Keep the checks after the wait and provider call.
const unsafeBoundary = safeBoundary.replace(
  "      await before;",
  "      await Promise.resolve();",
);

if (
  original.split(safeBoundary).length !== 2 ||
  original.includes(unsafeBoundary)
) {
  throw new Error("Refusing to mutate an unknown OAuth serializer revision");
}

let passed = false;
let output = "";
let exitStatus = null;
let processSignal = null;
let processError = null;
try {
  writeFileSync(source, original.replace(safeBoundary, unsafeBoundary));
  const run = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "test/integration/oauth-flow.test.ts",
      "-t",
      "excludes a second redemption while the real provider's grant read is held",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  exitStatus = run.status;
  processSignal = run.signal;
  processError = run.error?.code ?? null;
  output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.replace(
    /\x1b\[[0-9;]*m/g,
    "",
  );
  // The mutant must be killed by the specific concurrency assertion, not a
  // syntax error, timeout, unrelated failure, or a generic CI failure.
  passed =
    run.status === 1 &&
    output.includes("excludes a second redemption while the real provider's grant read is held") &&
    /expected 2 to be 1/.test(output);
} finally {
  writeFileSync(source, original);
}

if (!passed) {
  // Print only test-status and assertion lines, never raw OAuth exchanges.
  const relevant = output
    .split("\n")
    .filter((line) =>
      /FAIL|AssertionError|expected [0-9]+ to be [0-9]+|Test Files|Tests .*passed|No test files|No tests found/i.test(line),
    )
    .slice(-12);
  console.error(
    JSON.stringify({
      exitStatus,
      signal: processSignal,
      processError,
      resultLines: relevant,
      failureDetail: output
        .split(/Failed Tests [0-9]+/i)
        .slice(-1)[0]
        .slice(0, 1700)
        .replace(/[A-Za-z0-9_-]{64,}/g, "[redacted]"),
    }),
  );
  throw new Error("OAuth replay oracle did not kill the no-serialization mutant");
}
console.log("OAuth replay oracle killed the no-serialization mutant");
