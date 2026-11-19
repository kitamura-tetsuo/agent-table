// Local owner-only coordination. No Docker, network or authorization changes.
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export function createSteadyOwnerState(dir, { controller = false } = {}) {
  const owner = (s) => s.uid === process.getuid() && (s.mode & 0o077) === 0;
  if (
    !isAbsolute(dir) ||
    realpathSync(dir) !== dir ||
    !lstatSync(dir).isDirectory() ||
    !owner(lstatSync(dir))
  )
    throw Error("owner-directory-unavailable");
  const file = (name, flags) =>
    openSync(join(dir, name), flags | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
  const syncDir = () => {
    const fd = openSync(dir, C.O_RDONLY | C.O_DIRECTORY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  let held = false;
  function assertHeld() {
    if (!held) throw Error("owner-lock-required");
  }
  function writeNew(name, text) {
    const fd = file(name, C.O_WRONLY | C.O_CREAT | C.O_EXCL);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  function replaceDurably(name, text) {
    const temp = `${name}-${randomUUID()}`;
    const fd = file(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL);
    try {
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(join(dir, temp), join(dir, name));
      syncDir();
    } catch (error) {
      try {
        unlinkSync(join(dir, temp));
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT")
          throw new AggregateError(
            [error, cleanupError],
            "owner-state-write-failed",
          );
      }
      throw error;
    }
  }
  function readInhibit() {
    try {
      const fd = file("inhibit", C.O_RDONLY);
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || !owner(s) || s.size > 32) return "unknown";
        const value = readFileSync(fd, "utf8");
        return ["clear\n", "paused\n", "quarantined\n"].includes(value)
          ? value.trim()
          : "unknown";
      } finally {
        closeSync(fd);
      }
    } catch {
      return "unknown";
    }
  }
  function recordInhibit(state) {
    if (!["paused", "quarantined"].includes(state))
      throw Error("invalid-inhibit");
    replaceDurably("inhibit", `${state}\n`);
  }
  // Controller-local synchronous primitives: in opt-in mode the controller
  // validates inhibit immediately before forwarding enable, and persists an
  // inhibit before forwarding pause/stop. These never clear authorization.
  if (controller) return { readInhibit, recordInhibit };
  return {
    async withOwnerLock(fn) {
      if (held) throw Error("owner-lock-busy");
      const fd = file("owner.lock", C.O_RDWR | C.O_CREAT);
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || !owner(s)) throw Error("owner-lock-unavailable");
        // The parent retains the locked open file description after flock exits.
        execFileSync("/usr/bin/flock", ["--nonblock", "3"], {
          stdio: ["ignore", "ignore", "ignore", fd],
        });
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      } finally {
        closeSync(fd);
      }
    },
    readInhibit() {
      assertHeld();
      return readInhibit();
    },
    recordInhibit(state) {
      assertHeld();
      return recordInhibit(state);
    },
    readSupervisorInventory() {
      assertHeld();
      let fd;
      try {
        fd = file("supervisor-inventory", C.O_RDONLY);
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || !owner(s) || s.size > 16_384)
          throw Error("inventory-unavailable");
        return JSON.parse(readFileSync(fd, "utf8"));
      } finally {
        closeSync(fd);
      }
    },
    recordSupervisorInventory(data) {
      assertHeld();
      replaceDurably("supervisor-inventory", `${JSON.stringify(data)}\n`);
    },
    readPendingEnable() {
      assertHeld();
      let fd;
      try {
        fd = file("pending-enable", C.O_RDONLY);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || !owner(s) || s.size !== 37)
          throw Error("unknown-generation");
        const data = readFileSync(fd, "utf8");
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\n$/.test(data))
          throw Error("unknown-generation");
        return data.slice(0, -1);
      } finally {
        closeSync(fd);
      }
    },
    hasGenerationAttempted(generation) {
      assertHeld();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(generation))
        throw Error("invalid-generation");
      let fd;
      try {
        fd = file(`attempt-${generation}`, C.O_RDONLY);
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
      try {
        const s = fstatSync(fd);
        if (
          !s.isFile() ||
          !owner(s) ||
          s.size !== 37 ||
          readFileSync(fd, "utf8") !== `${generation}\n`
        )
          throw Error("unknown-generation");
        return true;
      } finally {
        closeSync(fd);
      }
    },
    resolveGenerationAttempt(generation) {
      assertHeld();
      const fd = file("pending-enable", C.O_RDONLY);
      try {
        const s = fstatSync(fd);
        if (
          !s.isFile() ||
          !owner(s) ||
          s.size !== 37 ||
          readFileSync(fd, "utf8") !== generation + "\n"
        )
          throw Error("unknown-generation");
      } finally {
        closeSync(fd);
      }
      unlinkSync(join(dir, "pending-enable"));
      syncDir();
    },
    markGenerationAttempted(generation) {
      assertHeld();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(generation))
        throw Error("invalid-generation");
      try {
        lstatSync(join(dir, "attempt-" + generation));
        return false;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      try {
        writeNew("pending-enable", generation + "\n");
        syncDir();
        writeNew("attempt-" + generation, generation + "\n");
      } catch (e) {
        if (e.code === "EEXIST") return false;
        throw e;
      }
      syncDir();
      return true;
    },
  };
}
