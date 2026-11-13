import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildPilotReport,
  checkObservationReceipts,
  collectEvidenceFragments,
} from "./autonomous-pilot.mjs";

const script = fileURLToPath(
  new URL("./autonomous-pilot.mjs", import.meta.url),
);
const templatePath = new URL(
  "../test/e2e/host/autonomous-evidence.template.json",
  import.meta.url,
);
const directories = [];
const freshTemplate = () => JSON.parse(readFileSync(templatePath, "utf8"));
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-table-pilot-"));
  directories.push(dir);
  return dir;
};
const run = (...args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const fragment = (sections, pilotId = freshTemplate().pilotId) => ({
  schemaVersion: 1,
  pilotId,
  sections,
});
const sectionsOf = (record) =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => !["schemaVersion", "pilotId"].includes(key),
    ),
  );

afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("initialization writes a private not-run record and refuses to overwrite it", () => {
  const output = join(workspace(), "candidate.json");
  const created = run("init", "--output", output);
  assert.equal(created.status, 0);
  const original = readFileSync(output, "utf8");
  assert.deepEqual(JSON.parse(original), freshTemplate());
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(run("init", "--output", output).status, 2);
  assert.equal(readFileSync(output, "utf8"), original);
});

test("initialization explicitly selects the required autonomous responders", () => {
  for (const mode of ["a-only", "bidirectional"]) {
    const output = join(workspace(), "candidate.json");
    const result = run("init", "--mode", mode, "--output", output);
    assert.equal(result.status, 0);
    const record = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(record.acceptanceMode, mode);
    assert.equal(record.evidenceKind, "not-run");
    assert.equal(JSON.parse(result.stdout).acceptanceMode, mode);
    const report = buildPilotReport(record);
    assert.equal(report.acceptanceMode, mode);
    assert.equal(report.target.acceptanceMode, mode);
    assert.deepEqual(
      report.target.requiredAutonomousResponders,
      mode === "a-only" ? ["A"] : ["A", "B"],
    );
    assert.equal(report.completeRecord, false);
  }
});

test("CLI rejects unknown modes and cannot override the scope of collected evidence", () => {
  const dir = workspace();
  assert.equal(
    run("init", "--mode", "either-host", "--output", join(dir, "bad.json"))
      .status,
    2,
  );
  assert.equal(
    run(
      "evaluate",
      "--input",
      fileURLToPath(templatePath),
      "--mode",
      "a-only",
      "--output",
      join(dir, "report.json"),
    ).status,
    2,
  );
  const sections = sectionsOf(freshTemplate());
  assert.throws(
    () =>
      collectEvidenceFragments([
        fragment(sections),
        fragment({ acceptanceMode: "a-only" }),
      ]),
    /more than once/,
  );
});

test("CLI reports the unrun pilot as incomplete and emits the same JSON to file and stdout", () => {
  const output = join(workspace(), "report.json");
  const result = run(
    "evaluate",
    "--input",
    fileURLToPath(templatePath),
    "--output",
    output,
  );
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.structurallyValid, true);
  assert.equal(report.completeRecord, false);
  assert.equal(report.receiptIntegrity.status, "not-checked");
  assert.equal(report.target.pilotId, freshTemplate().pilotId);
  assert.equal(report.target.acceptanceMode, "bidirectional");
  assert.deepEqual(
    report.target.participants[0].host,
    freshTemplate().participants[0].host,
  );
  assert.match(report.target.recordSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), report);
  assert.match(report.interpretation, /hashes do not authenticate/);
});

test("invalid evidence cannot echo secret-bearing unknown keys or values", () => {
  const dir = workspace();
  const input = join(dir, "invalid.json");
  const output = join(dir, "report.json");
  const secret = "sensitive-callback-and-bearer-sentinel";
  const record = freshTemplate();
  record[secret] = { callback: `https://example.invalid/${secret}` };
  writeFileSync(input, JSON.stringify(record));
  const result = run("evaluate", "--input", input, "--output", output);
  assert.equal(result.status, 2);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(readFileSync(output, "utf8").includes(secret), false);
  assert.equal(JSON.parse(result.stdout).completeRecord, false);
});

test("malformed or oversized input fails without leaking parser text or private paths", () => {
  const dir = workspace();
  const input = join(dir, "private-secret-sentinel.json");
  const output = join(dir, "report.json");
  for (const bytes of ['{"secret-value-sentinel":', "x".repeat(1_048_577)]) {
    writeFileSync(input, bytes);
    const result = run("evaluate", "--input", input, "--output", output);
    assert.equal(result.status, 2);
    assert.equal(result.stdout.includes("sentinel"), false);
    assert.equal(result.stderr.includes("sentinel"), false);
  }
});

test("collector joins separate capture sections without replacing previous facts", () => {
  const record = freshTemplate();
  const { observations, ...remaining } = sectionsOf(record);
  const entries = Object.entries(remaining);
  const split = Math.ceil(entries.length / 2);
  const captured = [
    fragment(Object.fromEntries(entries.slice(0, split))),
    fragment(Object.fromEntries(entries.slice(split))),
    fragment({ observations }),
  ];
  assert.deepEqual(collectEvidenceFragments(captured), record);
  assert.throws(
    () =>
      collectEvidenceFragments([
        ...captured,
        fragment({ evidenceKind: "real-host" }),
      ]),
    /more than once/,
  );
  assert.throws(
    () =>
      collectEvidenceFragments([
        captured[0],
        { ...captured[1], pilotId: "different-pilot" },
      ]),
    /different pilots/,
  );
});

test("collector rejects unknown fields, duplicate receipts and missing sections", () => {
  const sections = sectionsOf(freshTemplate());
  assert.throws(
    () =>
      collectEvidenceFragments([
        fragment({ ...sections, accessToken: "do-not-publish" }),
      ]),
    /Unknown evidence section/,
  );
  assert.throws(
    () =>
      collectEvidenceFragments([
        { ...fragment(sections), secret: "do-not-publish" },
      ]),
    /envelope/,
  );
  assert.throws(
    () => collectEvidenceFragments([fragment({ observations: [] })]),
    /safe schema/,
  );
  const observation = { id: "receipt-0001" };
  assert.throws(
    () =>
      collectEvidenceFragments([
        fragment({ ...sections, observations: [observation] }),
        fragment({ observations: [observation] }),
      ]),
    /Duplicate or invalid/,
  );
});

test("retained receipt hashing refuses mutation, missing files, symlinks and traversal", () => {
  const dir = workspace();
  const bytes = '{"redacted":"local independent observation"}\n';
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(dir, "receipt-0001.json"), bytes);
  const record = { observations: [{ id: "receipt-0001", sha256: digest }] };
  assert.deepEqual(checkObservationReceipts(record, dir), {
    status: "checked",
    checked: 1,
    missing: [],
  });
  writeFileSync(join(dir, "receipt-0001.json"), "changed");
  assert.equal(checkObservationReceipts(record, dir).status, "failed");
  record.observations[0].id = "receipt-absent";
  assert.equal(checkObservationReceipts(record, dir).status, "failed");
  symlinkSync(join(dir, "receipt-0001.json"), join(dir, "receipt-link.json"));
  record.observations[0].id = "receipt-link";
  assert.equal(checkObservationReceipts(record, dir).status, "failed");
  record.observations[0].id = "../private-secret";
  const traversal = checkObservationReceipts(record, dir);
  assert.equal(traversal.status, "failed");
  assert.equal(JSON.stringify(traversal).includes("private-secret"), false);
});

test("an empty receipt directory cannot complete an unrun pilot", () => {
  const report = buildPilotReport(freshTemplate(), workspace());
  assert.equal(report.receiptIntegrity.status, "checked");
  assert.equal(report.completeRecord, false);
  assert.ok(report.missing.length > 0);
});

test("nonregular input and receipt FIFOs fail without waiting for a writer", {
  skip: process.platform === "win32",
}, () => {
  const dir = workspace();
  const fifo = join(dir, "receipt-fifo.json");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const result = spawnSync(
    process.execPath,
    [script, "evaluate", "--input", fifo, "--output", join(dir, "report.json")],
    { encoding: "utf8", timeout: 3000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  const record = {
    observations: [{ id: "receipt-fifo", sha256: "a".repeat(64) }],
  };
  assert.equal(checkObservationReceipts(record, dir).status, "failed");
});

test("collect CLI persists safe candidate evidence and a blocked report", () => {
  const dir = workspace();
  const input = join(dir, "fragment.json");
  const output = join(dir, "evidence.json");
  const report = join(dir, "report.json");
  writeFileSync(input, JSON.stringify(fragment(sectionsOf(freshTemplate()))));
  const result = run(
    "collect",
    "--fragment",
    input,
    "--receipt-dir",
    dir,
    "--output",
    output,
    "--report",
    report,
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), freshTemplate());
  assert.deepEqual(
    JSON.parse(readFileSync(report, "utf8")),
    JSON.parse(result.stdout),
  );
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(JSON.parse(result.stdout).completeRecord, false);
});

test("CLI does not overwrite an existing report or accept ambiguous options", () => {
  const dir = workspace();
  const output = join(dir, "report.json");
  writeFileSync(output, "keep this original report");
  assert.equal(
    run("evaluate", "--input", fileURLToPath(templatePath), "--output", output)
      .status,
    2,
  );
  assert.equal(readFileSync(output, "utf8"), "keep this original report");
  assert.equal(
    run(
      "evaluate",
      "--input",
      fileURLToPath(templatePath),
      "--output",
      output,
      "--output",
      join(dir, "other.json"),
    ).status,
    2,
  );
});

test("same-owner initialization is explicit A-only and evaluation cannot override ownership", () => {
  const dir = workspace(),
    input = join(dir, "same-owner.json");
  const result = run(
    "init",
    "--mode",
    "a-only",
    "--ownership-mode",
    "same-owner",
    "--output",
    input,
  );
  assert.equal(result.status, 0);
  const record = JSON.parse(readFileSync(input, "utf8"));
  assert.equal(record.ownershipMode, "same-owner");
  assert.equal(record.evidenceKind, "not-run");
  assert.equal(buildPilotReport(record).target.ownershipMode, "same-owner");
  assert.equal(
    buildPilotReport(freshTemplate()).target.ownershipMode,
    "independent-owners",
  );
  assert.notEqual(
    run(
      "init",
      "--mode",
      "bidirectional",
      "--ownership-mode",
      "same-owner",
      "--output",
      join(dir, "wrong.json"),
    ).status,
    0,
  );
  assert.notEqual(
    run(
      "evaluate",
      "--input",
      input,
      "--ownership-mode",
      "same-owner",
      "--output",
      join(dir, "report.json"),
    ).status,
    0,
  );
});
