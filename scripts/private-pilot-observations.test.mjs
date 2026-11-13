import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  collectLive,
  main,
  RECORD_SCHEMA,
  SNAPSHOT_SCHEMA,
  TailCapture,
  validateDiagnostic,
  verifyAgainstSnapshot,
} from "./private-pilot-observations.mjs";

const START = Date.parse("2026-11-13T00:00:00.000Z");
const BUILD = "a".repeat(40);
const APPROVAL = "owner-review-test-1234";
const TABLE = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const MESSAGE = "33333333-3333-4333-8333-333333333333";
const A_MEMBER = "44444444-4444-4444-8444-444444444444";
const B_MEMBER = "55555555-5555-4555-8555-555555555555";
const SUBSCRIPTION = `sub_${"a".repeat(24)}`;
const SECRET_MARKER = "SECRET_DO_NOT_KEEP";

function attempt(kind, observedAt, extra = {}) {
  return {
    schema: RECORD_SCHEMA,
    kind,
    buildSha: BUILD,
    approvalRef: APPROVAL,
    tableId: TABLE,
    observedAt,
    eventId: EVENT,
    messageId: MESSAGE,
    seq: 1,
    membershipId: A_MEMBER,
    subscriptionId: SUBSCRIPTION,
    generation: 1,
    attempt: 1,
    ...extra,
  };
}
function records() {
  return [
    attempt("attempt-authorized", START + 2_100),
    attempt("transport-invoked", START + 2_101),
    attempt("response-headers", START + 2_200, { status: 204 }),
    attempt("attempt-completed", START + 2_201, {
      outcome: "accepted",
      settled: "accepted",
      transportInvoked: true,
      responseObserved: true,
    }),
  ];
}
function frame(items = [], extra = {}) {
  return {
    outcome: "ok",
    logs: items.map((record) => ({
      level: "info",
      message: [JSON.stringify(record)],
      timestamp: record.observedAt,
    })),
    event: {
      request: {
        url: `https://private.example.com/?token=${SECRET_MARKER}`,
        headers: { authorization: `Bearer ${SECRET_MARKER}` },
      },
    },
    exceptions: [{ message: SECRET_MARKER, stack: SECRET_MARKER }],
    ...extra,
  };
}
function capture(items = records()) {
  const collector = new TailCapture({ startedAt: START });
  collector.push(JSON.stringify(frame()), START + 500);
  collector.push(JSON.stringify(frame(items)), START + 3_000);
  return collector.finish("requested-stop", START + 5_000);
}
function snapshot() {
  return {
    schema: SNAPSHOT_SCHEMA,
    buildSha: BUILD,
    approvalRef: APPROVAL,
    capturedAt: START + 6_000,
    retention: "retained",
    table: {
      tableId: TABLE,
      state: "open",
      createdAt: START - 10_000,
      expiresAt: START + 60_000,
      closedAt: null,
      lastSeq: 1,
    },
    subscription: {
      membershipId: A_MEMBER,
      subscriptionId: SUBSCRIPTION,
      generation: 1,
      status: "active",
      expiresAt: START + 60_000,
      recipientConnectionMatches: true,
    },
    messages: [
      {
        messageId: MESSAGE,
        seq: 1,
        senderMembershipId: B_MEMBER,
        createdAt: START + 2_000,
        replyToMessageId: null,
      },
    ],
    outbox: [
      {
        eventId: EVENT,
        messageId: MESSAGE,
        seq: 1,
        membershipId: A_MEMBER,
        subscriptionId: SUBSCRIPTION,
        generation: 1,
        status: "accepted",
        attemptCount: 1,
        firstAttemptAt: START + 2_050,
        nextAttemptAt: null,
        leaseDeadline: null,
        createdAt: START + 2_000,
        expiresAt: START + 60_000,
        lastErrorCategory: null,
      },
    ],
  };
}
function incomplete(value, expectedReason) {
  assert.equal(value.status, "incomplete");
  assert.ok(
    value.reasons.includes(expectedReason),
    JSON.stringify(value.reasons),
  );
  assert.equal(value.hostExecution, "not-established");
}

test("pretty Wrangler frames and NDJSON survive arbitrary chunk boundaries without raw metadata", () => {
  const data =
    JSON.stringify(frame(), null, 4) +
    "\n" +
    JSON.stringify(frame(records()), null, 4) +
    "\n";
  for (const width of [1, 3, 17, 257]) {
    const collector = new TailCapture({ startedAt: START });
    for (let offset = 0; offset < data.length; offset += width)
      assert.equal(
        collector.push(
          Buffer.from(data.slice(offset, offset + width)),
          START + 3_000,
        ),
        true,
      );
    const result = collector.finish("requested-stop", START + 5_000);
    assert.equal(result.completeStream, true);
    assert.deepEqual(result.records, records());
    assert.doesNotMatch(
      JSON.stringify(result),
      /SECRET_DO_NOT_KEEP|authorization|exceptions|private\.example/,
    );
  }
});

test("UTF-8 inside unrelated metadata is safely discarded across split bytes", () => {
  const data = Buffer.from(
    JSON.stringify(frame(records(), { ignored: '日本語 } ] \\"' })),
  );
  const collector = new TailCapture({ startedAt: START });
  for (const byte of data) collector.push(Buffer.from([byte]), START + 3_000);
  assert.deepEqual(
    collector.finish("requested-stop", START + 5_000).records,
    records(),
  );
});

test("a quoted callback origin is retained, while paths, queries, local and port targets are refused", () => {
  const origin = {
    schema: RECORD_SCHEMA,
    kind: "callback-origin",
    buildSha: BUILD,
    approvalRef: APPROVAL,
    tableId: TABLE,
    membershipId: A_MEMBER,
    observedAt: START + 2_100,
    callbackOrigin: "https://callback.example.com",
  };
  assert.deepEqual(validateDiagnostic(origin), origin);
  for (const callbackOrigin of [
    "https://callback.example.com/path",
    "https://callback.example.com?secret=x",
    "https://name:secret@callback.example.com",
    "http://callback.example.com",
    "https://127.0.0.1",
    "https://host.local",
    "https://callback.example.com:444",
    "https://callback.example.com/",
    "https://callback.example.com#secret",
  ])
    assert.equal(validateDiagnostic({ ...origin, callbackOrigin }), null);
});

test("extra fields and invalid private log records fail closed without echoing content", () => {
  for (const bad of [
    { ...records()[0], authorization: SECRET_MARKER },
    { ...records()[0], seq: 13 },
    { ...records()[0], attempt: 9 },
    { ...records()[0], subscriptionId: SECRET_MARKER },
    { ...records()[0], kind: "new-unreviewed-kind" },
    { ...records()[3], responseObserved: true, transportInvoked: false },
  ]) {
    const collector = new TailCapture({ startedAt: START });
    assert.equal(
      collector.push(JSON.stringify(frame([bad])), START + 3_000),
      false,
    );
    const result = collector.finish("requested-stop", START + 5_000);
    assert.ok(result.errors.includes("invalid-diagnostic"));
    assert.doesNotMatch(JSON.stringify(result), /SECRET_DO_NOT_KEEP/);
  }
});

test("a multi-value log cannot disguise unreviewed fields alongside an allowed record", () => {
  const collector = new TailCapture({ startedAt: START });
  collector.push(
    JSON.stringify({
      logs: [{ message: [JSON.stringify(records()[0]), SECRET_MARKER] }],
    }),
    START + 3_000,
  );
  const result = collector.finish("requested-stop", START + 5_000);
  assert.ok(result.errors.includes("invalid-diagnostic"));
  assert.equal(result.records.length, 0);
});

test("framing, UTF-8, truncated objects, byte and record ceilings are categorical failures", () => {
  const cases = [
    ["invalid-framing", "PRIVATE_TOKEN_BANNER", {}],
    ["invalid-json", '{"logs":,}', {}],
    ["invalid-utf8", Buffer.from([0xff]), {}],
    ["object-overflow", `{${" ".repeat(101)}`, { objectBytes: 100 }],
    ["input-overflow", JSON.stringify(frame()), { totalBytes: 10 }],
    ["nesting-overflow", '{"logs":[[[[]]]]}', { depth: 3 }],
    ["record-overflow", JSON.stringify(frame(records())), { records: 1 }],
    ["invalid-tail-frame", '{"error":"PRIVATE_TOKEN_ERROR"}', {}],
  ];
  for (const [reason, input, limits] of cases) {
    const collector = new TailCapture({ startedAt: START, limits });
    collector.push(input, START + 3_000);
    const result = collector.finish("requested-stop", START + 5_000);
    assert.ok(result.errors.includes(reason), JSON.stringify(result.errors));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN/);
  }
  const collector = new TailCapture({ startedAt: START });
  collector.push('{"logs":[', START + 3_000);
  assert.ok(
    collector
      .finish("requested-stop", START + 5_000)
      .errors.includes("truncated-input"),
  );
});

test("unexpected EOF, absent readiness, and unverified stdin are never complete captures", () => {
  const eof = new TailCapture({ startedAt: START });
  eof.push(JSON.stringify(frame()), START + 500);
  assert.ok(
    eof.finish("source-ended", START + 3_000).errors.includes("source-ended"),
  );
  assert.ok(
    new TailCapture({ startedAt: START })
      .finish("requested-stop", START + 3_000)
      .errors.includes("not-ready"),
  );
  const stdin = new TailCapture({ startedAt: START, source: "stdin" });
  stdin.push(JSON.stringify(frame()), START + 500);
  assert.ok(
    stdin
      .finish("requested-stop", START + 3_000)
      .errors.includes("source-unverified"),
  );
});

test("complete conserved records are conditional evidence and establish no host execution", () => {
  const report = verifyAgainstSnapshot(capture(), snapshot());
  assert.equal(report.status, "conditionally-complete");
  assert.equal(report.hostExecution, "not-established");
  assert.match(report.disclaimer, /sampled/);
  assert.equal(report.checkedEvents[0].attemptCount, 1);
});

test("a missing final charge or log stage makes the observation incomplete", () => {
  const state = snapshot();
  state.outbox[0].attemptCount = 2;
  incomplete(verifyAgainstSnapshot(capture(), state), "missing-attempt-stage");
  for (const kind of ["attempt-authorized", "attempt-completed"]) {
    incomplete(
      verifyAgainstSnapshot(
        capture(records().filter((row) => row.kind !== kind)),
        snapshot(),
      ),
      "missing-attempt-stage",
    );
  }
  for (const kind of ["transport-invoked", "response-headers"]) {
    incomplete(
      verifyAgainstSnapshot(
        capture(records().filter((row) => row.kind !== kind)),
        snapshot(),
      ),
      "completion-stage-mismatch",
    );
  }
});

test("explicit no-transport completion can be observed without inventing a dispatch time", () => {
  const data = [
    records()[0],
    attempt("attempt-completed", START + 2_101, {
      outcome: "permanent",
      errorCategory: "payload-rejected",
      settled: "failed",
      transportInvoked: false,
      responseObserved: false,
    }),
  ];
  const state = snapshot();
  state.outbox[0].status = "failed";
  state.outbox[0].lastErrorCategory = "payload-rejected";
  assert.equal(
    verifyAgainstSnapshot(capture(data), state).status,
    "conditionally-complete",
  );
  incomplete(
    verifyAgainstSnapshot(capture([...data, records()[1]]), state),
    "completion-stage-mismatch",
  );
});

test("2xx headers followed by transport/body failure remain distinct from final completion", () => {
  const data = records();
  data[3] = {
    ...data[3],
    outcome: "transient",
    errorCategory: "deadline",
    settled: "pending",
  };
  const state = snapshot();
  state.outbox[0].status = "pending";
  state.outbox[0].lastErrorCategory = "deadline";
  state.outbox[0].nextAttemptAt = START + 10_000;
  assert.equal(
    verifyAgainstSnapshot(capture(data), state).status,
    "conditionally-complete",
  );
});

test("cancellation keeps already invoked completion but refuses a new authorization at closure", () => {
  const data = records();
  data[3].settled = null;
  const state = snapshot();
  state.table.state = "closed";
  state.table.closedAt = START + 2_150;
  state.subscription.status = "inactive";
  state.subscription.generation = 2;
  state.subscription.expiresAt = null;
  state.outbox[0].status = "cancelled";
  assert.equal(
    verifyAgainstSnapshot(capture(data), state).status,
    "conditionally-complete",
  );
  state.table.closedAt = data[0].observedAt;
  incomplete(
    verifyAgainstSnapshot(capture(data), state),
    "authorization-at-or-after-closure",
  );
});

test("zero attempts require a retained pending event and a tail ready before its commit", () => {
  const state = snapshot();
  state.outbox[0].attemptCount = 0;
  state.outbox[0].firstAttemptAt = null;
  state.outbox[0].status = "cancelled";
  assert.equal(
    verifyAgainstSnapshot(capture([]), state).status,
    "conditionally-complete",
  );
  const late = capture([]);
  late.readyAt = START + 2_001;
  incomplete(
    verifyAgainstSnapshot(late, state),
    "event-outside-observed-window",
  );
  state.outbox = [];
  incomplete(verifyAgainstSnapshot(capture([]), state), "no-retained-events");
});

test("deleted rows, stale snapshots, wrong policy and changed event/message joins fail closed", () => {
  const cases = [
    [
      "record-without-retained-row",
      (state) => {
        state.outbox = [];
      },
    ],
    [
      "snapshot-precedes-capture-end",
      (state) => {
        state.capturedAt = START + 4_000;
      },
    ],
    [
      "snapshot-precedes-record",
      (state) => {
        state.capturedAt = START + 2_100;
      },
    ],
    [
      "capture-policy-mismatch",
      (state) => {
        state.approvalRef = "different-review-1234";
      },
    ],
    [
      "attempt-row-mismatch",
      (state) => {
        state.outbox[0].messageId = B_MEMBER;
      },
    ],
    [
      "event-message-mismatch",
      (state) => {
        state.messages[0].senderMembershipId = A_MEMBER;
      },
    ],
    [
      "duplicate-snapshot-identity",
      (state) => {
        state.outbox.push({ ...state.outbox[0] });
      },
    ],
  ];
  for (const [reason, mutate] of cases) {
    const state = snapshot();
    mutate(state);
    incomplete(verifyAgainstSnapshot(capture(), state), reason);
  }
});

test("complete markers cannot conceal invalid capture state", () => {
  for (const mutate of [
    (value) => {
      value.errors = ["source-diagnostic"];
    },
    (value) => {
      value.finishReason = "source-ended";
    },
    (value) => {
      value.source = "stdin";
    },
    (value) => {
      value.records[0].rawSecret = SECRET_MARKER;
    },
    (value) => {
      value.readyAt = null;
    },
  ]) {
    const value = capture();
    mutate(value);
    const report = verifyAgainstSnapshot(value, snapshot());
    incomplete(report, "capture-incomplete-or-invalid");
    assert.doesNotMatch(JSON.stringify(report), /SECRET_DO_NOT_KEEP/);
  }
});

test("duplicates must be identical and each attempt retains its own generation", () => {
  assert.equal(
    verifyAgainstSnapshot(capture([...records(), records()[0]]), snapshot())
      .status,
    "conditionally-complete",
  );
  incomplete(
    verifyAgainstSnapshot(
      capture([...records(), { ...records()[0], observedAt: START + 2_099 }]),
      snapshot(),
    ),
    "conflicting-duplicate-stage",
  );
  const changed = records();
  changed[2].generation = 2;
  const state = snapshot();
  state.outbox[0].generation = 2;
  incomplete(
    verifyAgainstSnapshot(capture(changed), state),
    "attempt-row-mismatch",
  );
});

test("subscription identity and recipient readback are mandatory for retained attempt evidence", () => {
  for (const mutate of [
    (state) => {
      state.subscription.recipientConnectionMatches = false;
    },
    (state) => {
      delete state.subscription.recipientConnectionMatches;
    },
    (state) => {
      state.subscription = null;
    },
    (state) => {
      delete state.subscription;
    },
    (state) => {
      state.subscription.callbackUrl = SECRET_MARKER;
    },
  ]) {
    const state = snapshot();
    mutate(state);
    const result = verifyAgainstSnapshot(capture(), state);
    incomplete(result, "snapshot-invalid");
    assert.doesNotMatch(JSON.stringify(result), /SECRET_DO_NOT_KEEP/);
  }
  for (const mutate of [
    (state) => {
      state.subscription.membershipId = B_MEMBER;
    },
    (state) => {
      state.subscription.subscriptionId = `sub_${"b".repeat(24)}`;
    },
  ]) {
    const state = snapshot();
    mutate(state);
    incomplete(
      verifyAgainstSnapshot(capture(), state),
      "subscription-row-mismatch",
    );
  }
});

test("terminal invalidation preserves older accepted/cancelled outbox identities without reviving pending work", () => {
  for (const status of ["inactive", "expired"]) {
    const state = snapshot();
    state.subscription.status = status;
    state.subscription.expiresAt = null;
    state.subscription.generation = 2;
    assert.equal(
      verifyAgainstSnapshot(capture(), state).status,
      "conditionally-complete",
    );
    const pending = records();
    pending[3].outcome = "transient";
    pending[3].errorCategory = "deadline";
    pending[3].settled = "pending";
    state.outbox[0].status = "pending";
    incomplete(
      verifyAgainstSnapshot(capture(pending), state),
      "subscription-row-mismatch",
    );
  }
  const refreshed = snapshot();
  refreshed.subscription.generation = 2;
  assert.equal(
    verifyAgainstSnapshot(capture(), refreshed).status,
    "conditionally-complete",
  );
});

test("accepted SQL requires the final charged attempt's accepted and settled completion", () => {
  for (const replacement of [
    { outcome: "transient", errorCategory: "deadline", settled: "pending" },
    { outcome: "accepted", settled: null },
  ]) {
    const data = records();
    Object.assign(data[3], replacement);
    incomplete(
      verifyAgainstSnapshot(capture(data), snapshot()),
      "outbox-state-inconsistent",
    );
  }
});

test("final SQL readback follows the entire capture and catches a lost later retry", () => {
  const data = records();
  Object.assign(data[3], {
    outcome: "transient",
    errorCategory: "deadline",
    settled: "pending",
  });
  const earlier = snapshot();
  earlier.outbox[0].status = "pending";
  earlier.outbox[0].lastErrorCategory = "deadline";
  earlier.outbox[0].nextAttemptAt = START + 4_500;
  earlier.capturedAt = START + 4_000;
  incomplete(
    verifyAgainstSnapshot(capture(data), earlier),
    "snapshot-precedes-capture-end",
  );
  const final = structuredClone(earlier);
  final.capturedAt = START + 6_000;
  final.outbox[0].attemptCount = 2;
  final.outbox[0].status = "in_flight";
  final.outbox[0].nextAttemptAt = null;
  final.outbox[0].leaseDeadline = START + 34_500;
  incomplete(
    verifyAgainstSnapshot(capture(data), final),
    "missing-attempt-stage",
  );
  const baseline = verifyAgainstSnapshot(capture(), snapshot());
  assert.equal(baseline.status, "conditionally-complete");
  assert.equal(baseline.checkedThrough, START + 5_000);
  assert.equal(baseline.snapshotCapturedAt, START + 6_000);
  const late = snapshot();
  late.capturedAt = START + 65_001;
  incomplete(
    verifyAgainstSnapshot(capture(), late),
    "snapshot-readback-too-late",
  );
  late.capturedAt = START + 65_000;
  assert.equal(
    verifyAgainstSnapshot(capture(), late).status,
    "conditionally-complete",
  );
});

test("completion and newly created events outside the finished capture remain unobserved", () => {
  const data = records();
  data[3].observedAt = START + 5_001;
  incomplete(
    verifyAgainstSnapshot(capture(data), snapshot()),
    "record-outside-capture",
  );
  const state = snapshot();
  state.outbox[0].createdAt = START + 5_001;
  state.messages[0].createdAt = START + 5_001;
  state.outbox[0].attemptCount = 0;
  state.outbox[0].firstAttemptAt = null;
  state.outbox[0].status = "pending";
  incomplete(
    verifyAgainstSnapshot(capture([]), state),
    "event-outside-observed-window",
  );
});

test("retention, clocks and unavailable rows cannot manufacture a complete window", () => {
  for (const mutate of [
    (state) => {
      state.retention = "unavailable";
    },
    (state) => {
      state.table = null;
    },
    (state) => {
      state.outbox[0].lastErrorCategory = "unknown";
    },
  ]) {
    const state = snapshot();
    mutate(state);
    incomplete(verifyAgainstSnapshot(capture(), state), "snapshot-invalid");
  }
  for (const observedAt of [START - 1, START + 5_001]) {
    const data = records();
    data[0].observedAt = observedAt;
    incomplete(
      verifyAgainstSnapshot(capture(data), snapshot()),
      "record-outside-capture",
    );
  }
});

test("other tables in the same approved capture do not alter this table's checked event list", () => {
  const other = records().map((record) => ({
    ...record,
    tableId: B_MEMBER,
    eventId: A_MEMBER,
  }));
  const report = verifyAgainstSnapshot(
    capture([...records(), ...other]),
    snapshot(),
  );
  assert.equal(report.status, "conditionally-complete");
  assert.deepEqual(
    report.checkedEvents.map((row) => row.eventId),
    [EVENT],
  );
});

test("live collection refuses production, arbitrary workers, and unbounded windows before spawn", async () => {
  for (const options of [
    { worker: "agent-table-production", until: Date.now() + 10_000 },
    { worker: "another-worker", until: Date.now() + 10_000 },
    { worker: "agent-table-staging", until: Date.now() + 3 * 60 * 60_000 },
  ]) {
    let spawned = false;
    await assert.rejects(
      collectLive({
        ...options,
        spawnTail: () => {
          spawned = true;
        },
      }),
      /Invalid bounded collection options/,
    );
    assert.equal(spawned, false);
  }
});

function fakeTail(run) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    queueMicrotask(() =>
      child.emit("close", signal === "SIGINT" ? 0 : null, signal),
    );
    return true;
  };
  let options;
  const spawnTail = (command, args, settings) => {
    options = { command, args, settings };
    queueMicrotask(() => run(child));
    return child;
  };
  return { spawnTail, settings: () => options };
}

test("live wrapper controls both pipes, disables Wrangler disk logs, and records explicit stop", async () => {
  const signalSource = new EventEmitter();
  const fixture = fakeTail((child) => {
    child.stdout.write(JSON.stringify(frame()));
    signalSource.emit("SIGINT");
  });
  const result = await collectLive({
    worker: "agent-table-staging",
    until: Date.now() + 10_000,
    spawnTail: fixture.spawnTail,
    signalSource,
  });
  assert.equal(result.completeStream, true);
  const { command, args, settings } = fixture.settings();
  assert.equal(command, process.execPath);
  assert.equal(settings.shell, false);
  assert.equal(settings.env.WRANGLER_WRITE_LOGS, "false");
  assert.equal(settings.env.WRANGLER_LOG_SANITIZE, "true");
  assert.equal(args.includes("--sampling-rate"), false);
  assert.equal(result.finishReason, "requested-stop");
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
});

test("automatic reconnect warnings and unexpected source exit cannot silently produce complete capture", async () => {
  for (const sourceAction of [
    (child) => child.stderr.write(`Tail reconnecting with ${SECRET_MARKER}`),
    (child) => child.emit("close", 0, null),
    (child) => child.emit("error", new Error(SECRET_MARKER)),
  ]) {
    const fixture = fakeTail((child) => {
      child.stdout.write(JSON.stringify(frame()));
      sourceAction(child);
    });
    const result = await collectLive({
      worker: "agent-table-staging",
      until: Date.now() + 10_000,
      spawnTail: fixture.spawnTail,
      signalSource: new EventEmitter(),
    });
    assert.equal(result.completeStream, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_DO_NOT_KEEP/);
  }
});

test("CLI verification writes exclusive private output and refuses unsafe/unbounded input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pilot-observation-test-"));
  const originalLog = console.log;
  const originalError = console.error;
  const printed = [];
  console.log = (...args) => printed.push(args.join(" "));
  console.error = (...args) => printed.push(args.join(" "));
  try {
    const input = join(directory, "capture.json");
    const state = join(directory, "snapshot.json");
    const output = join(directory, "report.json");
    writeFileSync(input, JSON.stringify(capture()), { mode: 0o600 });
    writeFileSync(state, JSON.stringify(snapshot()), { mode: 0o600 });
    assert.equal(
      await main([
        "verify",
        "--capture",
        input,
        "--snapshot",
        state,
        "--output",
        output,
      ]),
      0,
    );
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(readFileSync(output, "utf8")).status,
      "conditionally-complete",
    );
    assert.equal(
      await main([
        "verify",
        "--capture",
        input,
        "--snapshot",
        state,
        "--output",
        output,
      ]),
      1,
    );
    const link = join(directory, "symlink.json");
    symlinkSync(input, link);
    assert.equal(
      await main([
        "verify",
        "--capture",
        link,
        "--snapshot",
        state,
        "--output",
        join(directory, "refused.json"),
      ]),
      1,
    );
    writeFileSync(input, `{"secret":"${SECRET_MARKER}`);
    assert.equal(
      await main([
        "verify",
        "--capture",
        input,
        "--snapshot",
        state,
        "--output",
        join(directory, "bad.json"),
      ]),
      1,
    );
    assert.doesNotMatch(printed.join("\n"), /SECRET_DO_NOT_KEEP/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    rmSync(directory, { recursive: true, force: true });
  }
});
