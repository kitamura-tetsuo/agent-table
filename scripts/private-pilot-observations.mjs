import { spawn } from "node:child_process";
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

export const RECORD_SCHEMA = "agent-table.private-pilot.v1";
export const CAPTURE_SCHEMA = "agent-table.private-pilot-capture.v1";
export const SNAPSHOT_SCHEMA = "agent-table.private-pilot-snapshot.v1";
export const MAX_READBACK_LAG_MS = 60_000;
export const LIMITS = Object.freeze({
  objectBytes: 1_048_576,
  totalBytes: 32 * 1_048_576,
  records: 2_000,
  fileBytes: 4 * 1_048_576,
  durationMs: 2 * 60 * 60_000 + 60_000,
  depth: 64,
});
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SUBSCRIPTION = /^sub_[A-Za-z0-9_-]{16,64}$/;
const FAILURE = new Set([
  "transport-error",
  "deadline",
  "rate-limited",
  "server-error",
  "receiver-gone",
  "payload-rejected",
  "authorization-revoked",
  "retry-exhausted",
]);
const CAPTURE_FAILURE = new Set([
  "input-overflow",
  "object-overflow",
  "record-overflow",
  "nesting-overflow",
  "invalid-json",
  "invalid-utf8",
  "invalid-framing",
  "truncated-input",
  "invalid-diagnostic",
  "invalid-tail-frame",
  "source-diagnostic",
  "source-ended",
  "source-error",
  "source-exit",
  "source-kill-timeout",
  "source-unverified",
  "not-ready",
]);
const BASE = [
  "schema",
  "kind",
  "buildSha",
  "approvalRef",
  "tableId",
  "observedAt",
];
const ATTEMPT = [
  ...BASE,
  "eventId",
  "messageId",
  "seq",
  "membershipId",
  "subscriptionId",
  "generation",
  "attempt",
];
const DISCLAIMER =
  "Conditional metadata completeness only. Tail logs may be sampled or unavailable; " +
  "local files do not authenticate their origin. Inspect independent server and host " +
  "receipts. No delivery record proves a host run, authenticated read, or reply.";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, keys) {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function time(value) {
  return integer(value, 1, 8_640_000_000_000_000);
}
function nullableTime(value) {
  return value === null || time(value);
}
function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}
function publicOrigin(value) {
  if (typeof value !== "string" || value.length > 261) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hostname.includes(".") &&
      !url.hostname.endsWith(".") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) &&
      ![
        ".localhost",
        ".local",
        ".internal",
        ".home.arpa",
        ".test",
        ".invalid",
      ].some((suffix) => url.hostname.endsWith(suffix)) &&
      url.hostname
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    );
  } catch {
    return false;
  }
}

/** Reject extra fields instead of copying a potentially secret-bearing object. */
export function validateDiagnostic(record) {
  if (
    !object(record) ||
    record.schema !== RECORD_SCHEMA ||
    !matches(SHA, record.buildSha) ||
    !matches(REF, record.approvalRef) ||
    !matches(UUID, record.tableId) ||
    !time(record.observedAt)
  )
    return null;
  if (record.kind === "callback-origin") {
    return exact(record, [...BASE, "membershipId", "callbackOrigin"]) &&
      matches(UUID, record.membershipId) &&
      publicOrigin(record.callbackOrigin)
      ? { ...record }
      : null;
  }
  if (
    ![record.eventId, record.messageId, record.membershipId].every(
      (id) => typeof id === "string" && UUID.test(id),
    ) ||
    !matches(SUBSCRIPTION, record.subscriptionId) ||
    !integer(record.seq, 1, 12) ||
    !integer(record.generation, 1) ||
    !integer(record.attempt, 1, 8)
  )
    return null;
  if (
    record.kind === "attempt-authorized" ||
    record.kind === "transport-invoked"
  )
    return exact(record, ATTEMPT) ? { ...record } : null;
  if (record.kind === "response-headers")
    return exact(record, [...ATTEMPT, "status"]) &&
      integer(record.status, 100, 599)
      ? { ...record }
      : null;
  if (record.kind !== "attempt-completed") return null;
  const extras = ["outcome", "settled", "transportInvoked", "responseObserved"];
  if (record.outcome !== "accepted") extras.push("errorCategory");
  if (
    !exact(record, [...ATTEMPT, ...extras]) ||
    !["accepted", "transient", "permanent"].includes(record.outcome) ||
    (record.outcome !== "accepted" && !FAILURE.has(record.errorCategory)) ||
    !["accepted", "pending", "failed", null].includes(record.settled) ||
    typeof record.transportInvoked !== "boolean" ||
    typeof record.responseObserved !== "boolean" ||
    (record.responseObserved && !record.transportInvoked) ||
    (record.outcome === "accepted" &&
      (!record.transportInvoked || !record.responseObserved))
  )
    return null;
  return { ...record };
}

/**
 * Pinned Wrangler prints one pretty JSON object per tail frame. Parse object
 * boundaries rather than lines; retain no request, exception or raw log text.
 */
export class TailCapture {
  constructor({
    startedAt = Date.now(),
    source = "wrangler-tail",
    limits = LIMITS,
    onReady = () => {},
  } = {}) {
    if (!time(startedAt)) throw new Error("Invalid capture start.");
    this.startedAt = startedAt;
    this.source = source;
    this.limits = { ...LIMITS, ...limits };
    this.onReady = onReady;
    this.readyAt = null;
    this.records = [];
    this.errors = new Set();
    this.totalBytes = 0;
    this.buffer = "";
    this.offset = 0;
    this.depth = 0;
    this.quoted = false;
    this.escaped = false;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.finished = false;
  }

  fail(reason) {
    if (!CAPTURE_FAILURE.has(reason)) reason = "source-error";
    this.errors.add(reason);
    this.buffer = "";
    return false;
  }

  push(chunk, receivedAt = Date.now()) {
    if (this.finished || this.errors.size) return false;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (
      !(bytes instanceof Uint8Array) ||
      !time(receivedAt) ||
      receivedAt < this.startedAt
    )
      return this.fail("invalid-framing");
    this.totalBytes += bytes.byteLength;
    if (this.totalBytes > this.limits.totalBytes)
      return this.fail("input-overflow");
    if (
      Buffer.byteLength(this.buffer) + bytes.byteLength >
      this.limits.objectBytes
    )
      return this.fail("object-overflow");
    try {
      this.buffer += this.decoder.decode(bytes, { stream: true });
    } catch {
      return this.fail("invalid-utf8");
    }
    while (this.offset < this.buffer.length) {
      const character = this.buffer[this.offset++];
      if (this.depth === 0) {
        if (/\s/.test(character)) continue;
        if (character !== "{") return this.fail("invalid-framing");
        this.buffer = this.buffer.slice(this.offset - 1);
        this.offset = 1;
        this.depth = 1;
        continue;
      }
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (character === "\\") this.escaped = true;
        else if (character === '"') this.quoted = false;
        continue;
      }
      if (character === '"') this.quoted = true;
      else if (character === "{" || character === "[") {
        if (++this.depth > this.limits.depth)
          return this.fail("nesting-overflow");
      } else if (character === "}" || character === "]") {
        this.depth--;
        if (this.depth !== 0) continue;
        let frame;
        try {
          frame = JSON.parse(this.buffer.slice(0, this.offset));
        } catch {
          return this.fail("invalid-json");
        }
        this.buffer = this.buffer.slice(this.offset);
        this.offset = 0;
        if (!this.consume(frame, receivedAt)) return false;
      }
    }
    if (this.depth === 0) {
      this.buffer = "";
      this.offset = 0;
    }
    return true;
  }

  consume(frame, receivedAt) {
    if (!object(frame) || !Array.isArray(frame.logs))
      return this.fail("invalid-tail-frame");
    if (this.readyAt === null) {
      this.readyAt = receivedAt;
      try {
        this.onReady(receivedAt);
      } catch {
        return this.fail("source-error");
      }
    }
    for (const log of frame.logs) {
      if (!object(log) || !Array.isArray(log.message)) continue;
      for (const message of log.message) {
        if (
          typeof message !== "string" ||
          !message.includes("agent-table.private-pilot.")
        )
          continue;
        let parsed;
        try {
          parsed = JSON.parse(message);
        } catch {
          return this.fail("invalid-diagnostic");
        }
        const record = validateDiagnostic(parsed);
        if (!record || log.message.length !== 1)
          return this.fail("invalid-diagnostic");
        if (this.records.length >= this.limits.records)
          return this.fail("record-overflow");
        this.records.push(record);
      }
    }
    return true;
  }

  finish(reason = "source-ended", endedAt = Date.now()) {
    if (this.finished) throw new Error("Capture already finished.");
    this.finished = true;
    try {
      if (this.decoder.decode() !== "") this.fail("truncated-input");
    } catch {
      this.fail("invalid-utf8");
    }
    if (this.buffer.trim() || this.depth || this.quoted)
      this.fail("truncated-input");
    if (this.readyAt === null) this.fail("not-ready");
    if (this.source !== "wrangler-tail") this.fail("source-unverified");
    if (!["requested-stop", "window-complete"].includes(reason))
      this.fail(CAPTURE_FAILURE.has(reason) ? reason : "source-error");
    if (!time(endedAt) || endedAt < this.startedAt) this.fail("source-error");
    return {
      schema: CAPTURE_SCHEMA,
      source: this.source,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      endedAt,
      finishReason: reason,
      completeStream: this.errors.size === 0,
      errors: [...this.errors],
      records: this.records,
      disclaimer: DISCLAIMER,
    };
  }
}

function captureValid(capture) {
  return (
    exact(capture, [
      "schema",
      "source",
      "startedAt",
      "readyAt",
      "endedAt",
      "finishReason",
      "completeStream",
      "errors",
      "records",
      "disclaimer",
    ]) &&
    capture.schema === CAPTURE_SCHEMA &&
    capture.source === "wrangler-tail" &&
    time(capture.startedAt) &&
    time(capture.readyAt) &&
    time(capture.endedAt) &&
    capture.startedAt <= capture.readyAt &&
    capture.readyAt <= capture.endedAt &&
    ["requested-stop", "window-complete"].includes(capture.finishReason) &&
    capture.completeStream === true &&
    Array.isArray(capture.errors) &&
    capture.errors.length === 0 &&
    capture.disclaimer === DISCLAIMER &&
    Array.isArray(capture.records) &&
    capture.records.length <= LIMITS.records &&
    capture.records.every((record) => validateDiagnostic(record) !== null)
  );
}

function snapshotValid(snapshot) {
  if (
    !object(snapshot) ||
    snapshot.schema !== SNAPSHOT_SCHEMA ||
    snapshot.retention !== "retained" ||
    !matches(SHA, snapshot.buildSha) ||
    !matches(REF, snapshot.approvalRef) ||
    !time(snapshot.capturedAt) ||
    !object(snapshot.table) ||
    !matches(UUID, snapshot.table.tableId) ||
    !["waiting", "open", "closed"].includes(snapshot.table.state) ||
    !time(snapshot.table.createdAt) ||
    !time(snapshot.table.expiresAt) ||
    !nullableTime(snapshot.table.closedAt) ||
    !integer(snapshot.table.lastSeq, 0, 256) ||
    !Array.isArray(snapshot.messages) ||
    snapshot.messages.length > 256 ||
    !Array.isArray(snapshot.outbox) ||
    snapshot.outbox.length > 24
  )
    return false;
  const subscription = snapshot.subscription;
  if (
    !(subscription === null && snapshot.outbox.length === 0) &&
    (!exact(subscription, [
      "membershipId",
      "subscriptionId",
      "generation",
      "status",
      "expiresAt",
      "recipientConnectionMatches",
    ]) ||
      !matches(UUID, subscription.membershipId) ||
      !matches(SUBSCRIPTION, subscription.subscriptionId) ||
      !integer(subscription.generation, 1) ||
      !["active", "inactive", "expired"].includes(subscription.status) ||
      subscription.recipientConnectionMatches !== true ||
      (subscription.status === "active"
        ? !time(subscription.expiresAt)
        : subscription.expiresAt !== null))
  )
    return false;
  if (
    !snapshot.messages.every(
      (row) =>
        object(row) &&
        matches(UUID, row.messageId) &&
        integer(row.seq, 1, 256) &&
        matches(UUID, row.senderMembershipId) &&
        time(row.createdAt) &&
        (row.replyToMessageId === null || matches(UUID, row.replyToMessageId)),
    )
  )
    return false;
  return snapshot.outbox.every(
    (row) =>
      object(row) &&
      [row.eventId, row.messageId, row.membershipId].every((id) =>
        matches(UUID, id),
      ) &&
      matches(SUBSCRIPTION, row.subscriptionId) &&
      integer(row.generation, 1) &&
      integer(row.seq, 1, 12) &&
      integer(row.attemptCount, 0, 8) &&
      ["pending", "in_flight", "accepted", "failed", "cancelled"].includes(
        row.status,
      ) &&
      time(row.createdAt) &&
      time(row.expiresAt) &&
      row.createdAt < row.expiresAt &&
      ["firstAttemptAt", "nextAttemptAt", "leaseDeadline"].every((key) =>
        nullableTime(row[key]),
      ) &&
      (row.lastErrorCategory === null || FAILURE.has(row.lastErrorCategory)),
  );
}

/**
 * SQL counts are only a conservation check. Missing stages, refunded/abandoned
 * reservations, stale snapshots or lost tail frames must never be reconstructed.
 */
export function verifyAgainstSnapshot(capture, snapshot) {
  const reasons = new Set();
  const fail = (reason) => reasons.add(reason);
  const report = () => ({
    schema: "agent-table.private-pilot-verification.v1",
    status: reasons.size === 0 ? "conditionally-complete" : "incomplete",
    reasons: [...reasons],
    checkedEvents: results,
    checkedThrough:
      object(capture) && time(capture.endedAt) ? capture.endedAt : null,
    snapshotCapturedAt:
      object(snapshot) && time(snapshot.capturedAt)
        ? snapshot.capturedAt
        : null,
    hostExecution: "not-established",
    disclaimer: DISCLAIMER,
  });
  const results = [];
  if (!captureValid(capture)) fail("capture-incomplete-or-invalid");
  if (!snapshotValid(snapshot)) fail("snapshot-invalid");
  if (reasons.size) return report();
  // Read SQL after tail shutdown: an earlier snapshot cannot account for a
  // later charged retry whose tail frame was lost before capture ended.
  if (snapshot.capturedAt < capture.endedAt)
    fail("snapshot-precedes-capture-end");
  if (snapshot.capturedAt > capture.endedAt + MAX_READBACK_LAG_MS)
    fail("snapshot-readback-too-late");
  const rows = new Map(snapshot.outbox.map((row) => [row.eventId, row]));
  const messages = new Map(
    snapshot.messages.map((row) => [row.messageId, row]),
  );
  if (
    rows.size !== snapshot.outbox.length ||
    messages.size !== snapshot.messages.length ||
    new Set(snapshot.messages.map((row) => row.seq)).size !==
      snapshot.messages.length
  )
    fail("duplicate-snapshot-identity");
  const attempts = new Map();
  for (const record of capture.records) {
    if (
      record.buildSha !== snapshot.buildSha ||
      record.approvalRef !== snapshot.approvalRef
    ) {
      fail("capture-policy-mismatch");
      continue;
    }
    if (
      record.observedAt < capture.startedAt ||
      record.observedAt > capture.endedAt
    )
      fail("record-outside-capture");
    if (record.tableId !== snapshot.table.tableId) continue;
    if (record.observedAt > snapshot.capturedAt)
      fail("snapshot-precedes-record");
    if (record.kind === "callback-origin") continue;
    const row = rows.get(record.eventId);
    if (!row) {
      fail("record-without-retained-row");
      continue;
    }
    if (
      ["messageId", "seq", "membershipId", "subscriptionId"].some(
        (key) => record[key] !== row[key],
      ) ||
      record.generation !== row.generation ||
      record.attempt > row.attemptCount ||
      record.observedAt < row.createdAt
    ) {
      fail("attempt-row-mismatch");
      continue;
    }
    const key = `${record.eventId}:${record.attempt}`;
    const stages = attempts.get(key) ?? new Map();
    const duplicate = stages.get(record.kind);
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(record))
      fail("conflicting-duplicate-stage");
    else stages.set(record.kind, record);
    attempts.set(key, stages);
  }
  for (const row of snapshot.outbox) {
    const subscription = snapshot.subscription;
    if (
      row.membershipId !== subscription.membershipId ||
      row.subscriptionId !== subscription.subscriptionId ||
      row.generation > subscription.generation ||
      (["pending", "in_flight"].includes(row.status) &&
        (subscription.status !== "active" ||
          row.generation !== subscription.generation)) ||
      (subscription.status !== "active" &&
        row.generation >= subscription.generation) ||
      (snapshot.table.state === "closed" && subscription.status === "active")
    )
      fail("subscription-row-mismatch");
    if (capture.readyAt > row.createdAt || row.createdAt > capture.endedAt)
      fail("event-outside-observed-window");
    const message = messages.get(row.messageId);
    if (
      !message ||
      message.seq !== row.seq ||
      message.createdAt !== row.createdAt ||
      message.senderMembershipId === row.membershipId
    )
      fail("event-message-mismatch");
    if (
      (row.attemptCount > 0 && row.firstAttemptAt === null) ||
      (row.attemptCount === 0 && row.firstAttemptAt !== null)
    )
      fail("missing-reservation-origin");
    if (
      row.attemptCount === 0 &&
      ["accepted", "in_flight"].includes(row.status)
    )
      fail("outbox-state-inconsistent");
    for (let attempt = 1; attempt <= row.attemptCount; attempt++) {
      const stages = attempts.get(`${row.eventId}:${attempt}`);
      const authorized = stages?.get("attempt-authorized");
      const invoked = stages?.get("transport-invoked");
      const response = stages?.get("response-headers");
      const completed = stages?.get("attempt-completed");
      if (!authorized || !completed) {
        fail("missing-attempt-stage");
        continue;
      }
      if (
        new Set([...stages.values()].map((record) => record.generation))
          .size !== 1
      )
        fail("attempt-generation-mismatch");
      if (
        Boolean(invoked) !== completed.transportInvoked ||
        Boolean(response) !== completed.responseObserved
      )
        fail("completion-stage-mismatch");
      if (
        (invoked && invoked.observedAt < authorized.observedAt) ||
        (response && (!invoked || response.observedAt < invoked.observedAt)) ||
        completed.observedAt < (response ?? invoked ?? authorized).observedAt ||
        authorized.observedAt < row.firstAttemptAt
      )
        fail("attempt-timeline-invalid");
      if (
        completed.outcome === "accepted" &&
        (!response || response.status < 200 || response.status >= 300)
      )
        fail("acceptance-without-2xx");
      if (
        (completed.settled === "accepted" &&
          completed.outcome !== "accepted") ||
        (completed.settled === "pending" &&
          completed.outcome !== "transient") ||
        (completed.settled === "failed" && completed.outcome === "accepted")
      )
        fail("settlement-outcome-mismatch");
      if (
        attempt === row.attemptCount &&
        completed.settled === "accepted" &&
        row.status !== "accepted"
      )
        fail("outbox-state-inconsistent");
      if (
        attempt === row.attemptCount &&
        row.status === "accepted" &&
        (completed.outcome !== "accepted" || completed.settled !== "accepted")
      )
        fail("outbox-state-inconsistent");
      if (
        snapshot.table.closedAt !== null &&
        authorized.observedAt >= snapshot.table.closedAt
      )
        fail("authorization-at-or-after-closure");
    }
    results.push({
      eventId: row.eventId,
      attemptCount: row.attemptCount,
      status: row.status,
    });
  }
  if (!snapshot.outbox.length) fail("no-retained-events");
  return report();
}

/** Bound reads; never include parser or filesystem exception text in output. */
function readJson(path) {
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMITS.fileBytes) throw new Error();
    const bytes = Buffer.alloc(LIMITS.fileBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const size = readSync(fd, bytes, used, bytes.length - used, null);
      if (!size) break;
      used += size;
    }
    if (used > LIMITS.fileBytes) throw new Error();
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)),
    );
  } catch {
    throw new Error("Cannot read bounded JSON input.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function writeJson(path, value) {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * Own both pipes: Wrangler automatically reconnects and reports gaps on stderr.
 * Raw output never reaches disk or the operator terminal. The installed pinned
 * Wrangler supports WRANGLER_WRITE_LOGS=false; console JSON itself is not logged.
 */
export async function collectLive({
  worker,
  until,
  config,
  onReady = () => {},
  spawnTail = spawn,
  now = Date.now,
  wranglerPath = fileURLToPath(
    new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url),
  ),
  signalSource = process,
}) {
  const startedAt = now();
  if (
    worker !== "agent-table-staging" ||
    !time(until) ||
    until <= startedAt ||
    until - startedAt > LIMITS.durationMs ||
    (config !== undefined &&
      (typeof config !== "string" || config.length > 4096))
  )
    throw new Error("Invalid bounded collection options.");
  const collector = new TailCapture({ startedAt, onReady });
  const args = [
    "--no-warnings",
    wranglerPath,
    "tail",
    worker,
    "--format",
    "json",
    "--sampling-rate",
    "1",
  ];
  if (config !== undefined) args.push("--config", resolve(config));
  let child;
  try {
    child = spawnTail(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: {
        ...process.env,
        WRANGLER_WRITE_LOGS: "false",
        WRANGLER_LOG_SANITIZE: "true",
        WRANGLER_LOG: "log",
        WRANGLER_SEND_METRICS: "false",
      },
    });
  } catch {
    collector.fail("source-error");
    return collector.finish("source-error", now());
  }
  return await new Promise((resolveCapture) => {
    let stopReason;
    let done = false;
    let killTimer;
    let finishTimer;
    const cleanup = () => {
      clearTimeout(windowTimer);
      clearTimeout(killTimer);
      clearTimeout(finishTimer);
      signalSource.removeListener("SIGINT", interrupt);
      signalSource.removeListener("SIGTERM", terminate);
    };
    const finish = (reason) => {
      if (done) return;
      done = true;
      cleanup();
      resolveCapture(collector.finish(reason, now()));
    };
    const stop = (reason) => {
      if (stopReason || done) return;
      stopReason = reason;
      try {
        child.kill("SIGINT");
      } catch {
        collector.fail("source-error");
        finish("source-error");
        return;
      }
      if (done) return;
      killTimer = setTimeout(() => {
        collector.fail("source-kill-timeout");
        try {
          child.kill("SIGKILL");
        } catch {
          collector.fail("source-error");
        }
        if (done) return;
        finishTimer = setTimeout(() => finish("source-kill-timeout"), 1_000);
      }, 5_000);
    };
    const interrupt = () => stop("requested-stop");
    const terminate = () => stop("source-error");
    const windowTimer = setTimeout(
      () => stop("window-complete"),
      until - startedAt,
    );
    signalSource.on("SIGINT", interrupt);
    signalSource.on("SIGTERM", terminate);
    child.stdout.on("data", (chunk) => {
      if (!collector.push(chunk, now())) stop("source-error");
    });
    child.stdout.on("error", () => {
      collector.fail("source-error");
      stop("source-error");
    });
    child.stderr.on("data", () => {
      // Any warning might indicate a lost/reconnected tail. Do not copy its text.
      collector.fail("source-diagnostic");
      stop("source-error");
    });
    child.stderr.on("error", () => {
      collector.fail("source-error");
      stop("source-error");
    });
    child.on("error", () => {
      collector.fail("source-error");
      stop("source-error");
    });
    child.on("close", (code, signal) => {
      if (code !== 0 && !(stopReason && signal === "SIGINT"))
        collector.fail("source-exit");
      finish(stopReason ?? "source-ended");
    });
  });
}

function parseArguments(argv) {
  const mode = argv[0];
  if (!["collect", "verify"].includes(mode))
    throw new Error("Unknown command.");
  const allowed =
    mode === "collect"
      ? ["--worker", "--until", "--config", "--output"]
      : ["--capture", "--snapshot", "--output"];
  const result = { mode };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.includes(flag) ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith("--") ||
      Object.hasOwn(result, flag.slice(2))
    )
      throw new Error("Invalid arguments.");
    result[flag.slice(2)] = value;
  }
  const required =
    mode === "collect"
      ? ["worker", "until", "output"]
      : ["capture", "snapshot", "output"];
  if (!required.every((key) => Object.hasOwn(result, key)))
    throw new Error("Missing arguments.");
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.mode === "collect") {
      const until = Date.parse(options.until);
      if (
        !Number.isFinite(until) ||
        new Date(until).toISOString() !== options.until
      )
        throw new Error("Use a canonical UTC end time with milliseconds.");
      const capture = await collectLive({
        worker: options.worker,
        until,
        config: options.config,
        onReady: (at) =>
          console.log(JSON.stringify({ capture: "ready", observedAt: at })),
      });
      writeJson(options.output, capture);
      console.log(
        JSON.stringify({
          capture: capture.completeStream ? "collected" : "incomplete",
          records: capture.records.length,
          errors: capture.errors,
        }),
      );
      return capture.completeStream ? 0 : 2;
    }
    const report = verifyAgainstSnapshot(
      readJson(options.capture),
      readJson(options.snapshot),
    );
    writeJson(options.output, report);
    console.log(
      JSON.stringify({
        verification: report.status,
        reasons: report.reasons,
        checkedEvents: report.checkedEvents.length,
        hostExecution: "not-established",
      }),
    );
    return report.status === "conditionally-complete" ? 0 : 2;
  } catch {
    // Raw parsing, subprocess and filesystem messages may expose private data.
    console.error(
      "Private pilot observation command failed; no raw input was printed.",
    );
    return 1;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
