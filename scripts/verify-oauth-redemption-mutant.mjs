// Kill-test the OAuth replay oracle using the real provider and workerd.
// The deliberate mutant is never committed: restore the source in finally.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/auth/token-do.ts", import.meta.url));
const original = readFileSync(source, "utf8");
const safeBoundary = "      await before;\n      if (this.probe) this.probe.providerEntries++;";
const unsafeBoundary = "      await Promise.resolve();\n      if (this.probe) this.probe.providerEntries++;";

if (!original.includes(safeBoundary) || original.includes(unsafeBoundary)) {
  throw new Error("Refusing to mutate an unknown OAuth serializer revision");
}

let passed = false;
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
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.replace(
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
  throw new Error("OAuth replay oracle did not kill the no-serialization mutant");
}
console.log("OAuth replay oracle killed the no-serialization mutant");
