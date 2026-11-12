import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  autonomousEvidenceSchema,
  evaluateAutonomousEvidence,
} from "../test/e2e/host/autonomous-evidence.ts";

const MAX_BYTES = 1_048_576;
const MAX_FRAGMENTS = 16;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/;
const TEMPLATE = new URL(
  "../test/e2e/host/autonomous-evidence.template.json",
  import.meta.url,
);
const DISCLAIMER =
  "Metadata correlation and local receipt integrity only. An independent reviewer must inspect the real host/server observations; hashes do not authenticate their origin.";

function invalid(message) {
  throw new Error(message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bound reads and refuse symlinks, devices and directories without logging input. */
function readBounded(path) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      invalid("Input must be a bounded regular file.");
    }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) invalid("Input is too large.");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readBounded(path).toString("utf8"));
  } catch {
    // JSON parser and filesystem error text can contain secrets or private paths.
    invalid("Cannot read bounded JSON input.");
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

/** Join disjoint redacted capture sections; never overwrite a prior observation. */
export function collectEvidenceFragments(fragments) {
  if (
    !Array.isArray(fragments) ||
    !fragments.length ||
    fragments.length > MAX_FRAGMENTS
  ) {
    invalid("Provide between one and sixteen evidence fragments.");
  }
  const allowed = new Set(
    Object.keys(autonomousEvidenceSchema.shape).filter(
      (key) => key !== "schemaVersion" && key !== "pilotId",
    ),
  );
  const joined = Object.create(null);
  const assigned = new Set();
  const observationIds = new Set();
  let pilotId;
  for (const fragment of fragments) {
    if (
      !object(fragment) ||
      Object.keys(fragment).length !== 3 ||
      fragment.schemaVersion !== 1 ||
      typeof fragment.pilotId !== "string" ||
      !object(fragment.sections) ||
      Object.keys(fragment).some(
        (key) => !["schemaVersion", "pilotId", "sections"].includes(key),
      )
    ) {
      invalid("Invalid evidence fragment envelope.");
    }
    if (pilotId !== undefined && pilotId !== fragment.pilotId) {
      invalid("Evidence fragments belong to different pilots.");
    }
    pilotId = fragment.pilotId;
    for (const [key, value] of Object.entries(fragment.sections)) {
      if (!allowed.has(key)) invalid("Unknown evidence section.");
      if (key === "observations") {
        if (!Array.isArray(value)) invalid("Invalid observation registry.");
        for (const observation of value) {
          if (
            !object(observation) ||
            typeof observation.id !== "string" ||
            observationIds.has(observation.id)
          ) {
            invalid("Duplicate or invalid observation reference.");
          }
          observationIds.add(observation.id);
        }
        joined.observations = [...(joined.observations ?? []), ...value];
      } else {
        if (assigned.has(key))
          invalid("An evidence section was supplied more than once.");
        joined[key] = value;
      }
      assigned.add(key);
    }
  }
  const parsed = autonomousEvidenceSchema.safeParse({
    schemaVersion: 1,
    pilotId,
    ...joined,
  });
  if (!parsed.success)
    invalid("Collected evidence does not match the safe schema.");
  return parsed.data;
}

/** Receipt bytes remain local: reports contain only integrity results. */
export function checkObservationReceipts(record, receiptDirectory) {
  if (!receiptDirectory)
    return {
      status: "not-checked",
      checked: 0,
      missing: ["Local redacted receipt hashes were not checked."],
    };
  const missing = [];
  let checked = 0;
  for (const [index, observation] of record.observations.entries()) {
    if (!RECEIPT_ID.test(observation.id) || observation.id.includes("..")) {
      missing.push(`Receipt ${index + 1}: unsafe observation reference.`);
      continue;
    }
    try {
      const bytes = readBounded(
        resolve(receiptDirectory, `${observation.id}.json`),
      );
      // The collector never prints, republishes, or interprets retained receipt text.
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== observation.sha256) {
        missing.push(`Receipt ${index + 1}: digest mismatch.`);
      } else {
        checked += 1;
      }
    } catch {
      missing.push(`Receipt ${index + 1}: unavailable or unsafe file.`);
    }
  }
  return { status: missing.length ? "failed" : "checked", checked, missing };
}

export function buildPilotReport(input, receiptDirectory) {
  const evaluation = evaluateAutonomousEvidence(input);
  const parsed = autonomousEvidenceSchema.safeParse(input);
  const receipts = parsed.success
    ? checkObservationReceipts(parsed.data, receiptDirectory)
    : { status: "not-checked", checked: 0, missing: [] };
  return {
    schemaVersion: 1,
    target: parsed.success
      ? {
          pilotId: parsed.data.pilotId,
          evidenceKind: parsed.data.evidenceKind,
          observedAt: parsed.data.observedAt,
          tableId: parsed.data.tableId,
          deployment: parsed.data.deployment,
          participants: parsed.data.participants.map((person) => ({
            role: person.role,
            ownerRef: person.ownerRef,
            accountRef: person.accountRef,
            workspaceRef: person.workspaceRef,
            host: person.host,
          })),
          recordSha256: createHash("sha256")
            .update(JSON.stringify(parsed.data))
            .digest("hex"),
        }
      : null,
    ...evaluation,
    completeRecord: evaluation.completeRecord && receipts.status === "checked",
    missing: [...evaluation.missing, ...receipts.missing],
    receiptIntegrity: { status: receipts.status, checked: receipts.checked },
    interpretation: DISCLAIMER,
  };
}

function argumentsFor(argv) {
  const [command, ...values] = argv;
  if (!["init", "collect", "evaluate"].includes(command))
    invalid("Expected init, collect or evaluate.");
  const options = { command, fragments: [] };
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!value || value.startsWith("--"))
      invalid("Every option requires a value.");
    if (option === "--fragment") {
      options.fragments.push(value);
      continue;
    }
    if (!["--input", "--output", "--report", "--receipt-dir"].includes(option))
      invalid("Unknown option.");
    if (options[option] !== undefined)
      invalid("An option was supplied more than once.");
    options[option] = value;
  }
  if (!options["--output"]) invalid("An output path is required.");
  if (
    command === "init" &&
    (options.fragments.length ||
      options["--input"] ||
      options["--report"] ||
      options["--receipt-dir"])
  )
    invalid("Init accepts only an output path.");
  if (
    command === "evaluate" &&
    (!options["--input"] || options.fragments.length || options["--report"])
  )
    invalid("Evaluate requires one input and one output.");
  if (
    command === "collect" &&
    (!options.fragments.length ||
      options["--input"] ||
      !options["--report"] ||
      !options["--receipt-dir"])
  )
    invalid(
      "Collect requires fragments, receipt directory, evidence output and report output.",
    );
  return options;
}

export function main(argv) {
  try {
    const options = argumentsFor(argv);
    if (options.command === "init") {
      const template = autonomousEvidenceSchema.parse(readJson(TEMPLATE));
      writeJson(options["--output"], template);
      process.stdout.write(
        `${JSON.stringify({ initialized: true, livePilot: "not-run" })}\n`,
      );
      return 0;
    }
    const evidence =
      options.command === "collect"
        ? collectEvidenceFragments(options.fragments.map(readJson))
        : readJson(options["--input"]);
    const report = buildPilotReport(evidence, options["--receipt-dir"]);
    if (options.command === "collect") {
      if (resolve(options["--output"]) === resolve(options["--report"]))
        invalid("Evidence and report outputs must be distinct.");
      writeJson(options["--output"], evidence);
      writeJson(options["--report"], report);
    } else {
      writeJson(options["--output"], report);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.structurallyValid ? (report.completeRecord ? 0 : 1) : 2;
  } catch {
    // Do not forward input values, OS paths, callback data or provider error text.
    process.stdout.write(
      `${JSON.stringify({ error: "Pilot input/output rejected. Check safe schema, bounded regular files, CLI options and unused output paths." })}\n`,
    );
    return 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
