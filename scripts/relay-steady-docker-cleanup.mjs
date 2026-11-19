// Fixture-only journal. Never discover/delete Docker objects by name or prune.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants as C,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const roles = ["ingress", "relay", "network"];
const states = ["unstarted", "pending", "known", "removed"];
const idPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^[a-f0-9]{12}$/;
const fixtureLabel = "agent-table.fixture-id";
const scopeLabel = "agent-table.test-scope";
const scopedValue = "isolated-restart-78";
const refusal = () => Error("isolated fixture cleanup journal invalid");

function privateParent(path) {
  const dir = dirname(path),
    stat = lstatSync(dir);
  if (
    !isAbsolute(path) ||
    !stat.isDirectory() ||
    realpathSync(dir) !== dir ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw refusal();
  return dir;
}
function validate(journal) {
  if (
    journal?.version !== 1 ||
    !tokenPattern.test(journal.token) ||
    !["running", "passed", "failed", "interrupted"].includes(journal.primary) ||
    !["pending", "complete", "incomplete"].includes(journal.cleanup) ||
    Object.keys(journal.resources ?? {})
      .sort()
      .join(",") !== "ingress,network,relay"
  )
    throw refusal();
  for (const role of roles) {
    const item = journal.resources[role];
    if (
      !item ||
      !states.includes(item.state) ||
      (["known", "removed"].includes(item.state)
        ? !idPattern.test(item.id) || Object.keys(item).length !== 2
        : Object.keys(item).length !== 1)
    )
      throw refusal();
  }
  const ids = roles.map((role) => journal.resources[role].id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw refusal();
  return journal;
}
export function readFixtureJournal(path) {
  privateParent(path);
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      (s.mode & 0o077) !== 0 ||
      s.size > 4096
    )
      throw refusal();
    return validate(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}
export function writeFixtureJournal(path, journal, first = false) {
  validate(journal);
  const dir = privateParent(path);
  if (!first && readFixtureJournal(path).token !== journal.token)
    throw refusal();
  const pending = first ? path : join(dir, ".fixture-" + randomUUID());
  const fd = openSync(
    pending,
    C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, JSON.stringify(journal) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!first) renameSync(pending, path);
    const dirFd = openSync(dir, C.O_RDONLY | C.O_DIRECTORY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (!first) {
      try {
        unlinkSync(pending);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT")
          throw new AggregateError([error, cleanupError]);
      }
    }
    throw error;
  }
}
function realDocker(args, timeout) {
  return execFileSync(
    "/usr/bin/docker",
    ["--host", "unix:///var/run/docker.sock", ...args],
    {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    },
  );
}
// Docker's typed network inspect propagates daemon/version-specific missing
// text. Use successful exact-ID list output as positive readback instead.
function networkPresent(id, call) {
  const output = call([
    "network",
    "ls",
    "--no-trunc",
    "--filter",
    `id=${id}`,
    "--format",
    "{{.ID}}",
  ]).trim();
  if (output === "") return false;
  if (output === id) return true;
  throw refusal(); // A different/ambiguous output cannot prove absence.
}
function inspect(role, id, call) {
  const kind = role === "network" ? "network" : "container";
  try {
    const output = JSON.parse(call(["inspect", "--type", kind, id]));
    if (!Array.isArray(output) || output.length !== 1) throw refusal();
    return output[0];
  } catch (error) {
    // Transport timeout, daemon loss, unexpected error or malformed JSON are
    // unknown, not proof of absence.
    if (
      error.status === 1 &&
      typeof error.stderr === "string" &&
      error.stderr.trim() === `Error: No such ${kind}: ${id}`
    )
      return null;
    if (
      error.status === 1 &&
      typeof error.stderr === "string" &&
      error.stderr.trim() ===
        `Error response from daemon: No such ${kind}: ${id}`
    )
      return null;
    if (role === "network" && !networkPresent(id, call)) return null;
    throw error;
  }
}
function verify(role, item, id, token) {
  const labels = role === "network" ? item.Labels : item.Config?.Labels;
  const name = `at78-fixture-${token}`;
  return (
    item.Id === id &&
    labels?.[scopeLabel] === scopedValue &&
    labels?.[fixtureLabel] === token &&
    item.Name === (role === "network" ? name : `/${name}-${role}`)
  );
}
export function cleanupFixtureJournal(
  path,
  { docker = realDocker, clock = Date.now } = {},
) {
  const journal = readFixtureJournal(path);
  const deadline = clock() + 32_000;
  const call = (args) => {
    const remaining = deadline - clock();
    if (remaining <= 0) throw Error("fixture cleanup deadline exhausted");
    return docker(args, Math.min(3000, remaining));
  };
  const unresolved = [];
  for (const role of roles) {
    const item = journal.resources[role];
    if (item.state === "unstarted" || item.state === "removed") continue;
    if (item.state === "pending") {
      // The daemon might have accepted create; without a recorded immutable
      // ID no resource can be safely attributed to this operation.
      unresolved.push(`${role}:create-outcome-unknown`);
      continue;
    }
    try {
      const object = inspect(role, item.id, call);
      if (object !== null) {
        if (!verify(role, object, item.id, journal.token)) {
          unresolved.push(`${role}:cleanup-identity-mismatch`);
          continue;
        }
        try {
          call(
            role === "network"
              ? ["network", "rm", item.id]
              : ["rm", "-f", item.id],
          );
        } catch {
          // An unknown removal may have taken effect. Verify once; no retry.
        }
        const present =
          role === "network"
            ? networkPresent(item.id, call)
            : inspect(role, item.id, call) !== null;
        if (present) {
          unresolved.push(`${role}:cleanup-still-present`);
          continue;
        }
      }
      journal.resources[role] = { state: "removed", id: item.id };
      writeFixtureJournal(path, journal);
    } catch {
      unresolved.push(`${role}:cleanup-unverified`);
    }
  }
  if (!unresolved.length) {
    const dir = `/tmp/at78-fixture-${journal.token}`;
    try {
      const s = lstatSync(dir);
      if (
        !s.isDirectory() ||
        realpathSync(dir) !== dir ||
        s.uid !== process.getuid() ||
        (s.mode & 0o077) !== 0
      )
        throw refusal();
      // Never recursively remove the directory that contains the journal.
      if (dirname(path) !== dir && !path.startsWith(dir + "/"))
        rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT")
        unresolved.push("fixture-path:cleanup-unverified");
    }
  }
  journal.cleanup = unresolved.length ? "incomplete" : "complete";
  writeFixtureJournal(path, journal);
  return { primary: journal.primary, cleanup: journal.cleanup, unresolved };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3) throw refusal();
    const result = cleanupFixtureJournal(process.argv[2]);
    console.log(JSON.stringify(result));
    if (result.cleanup !== "complete") process.exitCode = 1;
  } catch {
    console.error(
      "fixture cleanup incomplete: journal/daemon evidence unavailable",
    );
    process.exitCode = 1;
  }
}
