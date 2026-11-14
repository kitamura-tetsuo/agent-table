import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyRehearsalCheckouts } from "./recovery-hosted-rehearsal.mjs";

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function commit(root, path, content) {
  await writeFile(join(root, path), content);
  git(root, "add", "--", path);
  git(
    root,
    "-c",
    "user.name=Recovery fixture",
    "-c",
    "user.email=recovery-fixture@example.invalid",
    "commit",
    "-qm",
    "Fixture revision",
  );
  return git(root, "rev-parse", "HEAD");
}
async function checkouts(t) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "recovery-checkouts-")),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sourceRoot = join(parent, "source");
  const operatorRoot = join(parent, "operator");
  await mkdir(sourceRoot);
  git(sourceRoot, "init", "-q");
  for (const path of ["src", "schema", "test/recovery-hosted", "scripts"])
    await mkdir(join(sourceRoot, path), { recursive: true });
  for (const path of [
    "src/index.ts",
    "schema/migrations.ts",
    "test/recovery-hosted/worker.ts",
    "package.json",
    "package-lock.json",
    "wrangler.jsonc",
    "tsconfig.json",
    "scripts/recovery-hosted-rehearsal.mjs",
    "scripts/recovery-provider.mjs",
  ])
    await writeFile(join(sourceRoot, path), "reviewed fixture\n");
  git(sourceRoot, "add", ".");
  git(
    sourceRoot,
    "-c",
    "user.name=Recovery fixture",
    "-c",
    "user.email=recovery-fixture@example.invalid",
    "commit",
    "-qm",
    "Pinned source",
  );
  const sourceSha = git(sourceRoot, "rev-parse", "HEAD");
  git(parent, "clone", "-q", "--no-hardlinks", sourceRoot, operatorRoot);
  const expectedOperatorSha = await commit(
    operatorRoot,
    "scripts/recovery-provider.mjs",
    "reviewed operator fix\n",
  );
  return { sourceRoot, operatorRoot, sourceSha, expectedOperatorSha };
}

test("a separately pinned operator fix retains the exact application input tree", async (t) => {
  const inputs = await checkouts(t);
  const result = await verifyRehearsalCheckouts(inputs);
  assert.equal(result.sourceSha, inputs.sourceSha);
  assert.equal(result.operatorSha, inputs.expectedOperatorSha);
  assert.match(result.comparedInputsSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(result.sourceSha, result.operatorSha);
});

test("a runner cannot substitute its own unselected commit", async (t) => {
  const inputs = await checkouts(t);
  await assert.rejects(
    verifyRehearsalCheckouts({
      ...inputs,
      expectedOperatorSha: inputs.sourceSha,
    }),
    /checkout-head-mismatch/,
  );
});

test("runtime, fixture, configuration and dependency changes require a new application source", async (t) => {
  const inputs = await checkouts(t);
  for (const path of [
    "src/index.ts",
    "schema/migrations.ts",
    "test/recovery-hosted/worker.ts",
    "package-lock.json",
    "wrangler.jsonc",
    "tsconfig.json",
  ]) {
    inputs.expectedOperatorSha = await commit(
      inputs.operatorRoot,
      path,
      "different runtime input\n",
    );
    await assert.rejects(
      verifyRehearsalCheckouts(inputs),
      /pinned-runtime-inputs-changed/,
    );
    inputs.expectedOperatorSha = await commit(
      inputs.operatorRoot,
      path,
      "reviewed fixture\n",
    );
  }
});

test("untracked runtime inputs and tracked edits cannot enter the pinned build", async (t) => {
  const inputs = await checkouts(t);
  await writeFile(
    join(inputs.sourceRoot, "src/untracked.ts"),
    "unexpected module\n",
  );
  await assert.rejects(verifyRehearsalCheckouts(inputs), /checkout-is-dirty/);
  await rm(join(inputs.sourceRoot, "src/untracked.ts"));
  await writeFile(
    join(inputs.operatorRoot, "scripts/recovery-provider.mjs"),
    "unreviewed edit\n",
  );
  await assert.rejects(verifyRehearsalCheckouts(inputs), /checkout-is-dirty/);
});
