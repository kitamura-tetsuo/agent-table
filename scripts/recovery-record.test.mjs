import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonicalRecoveryJson,
  EMPTY_RECOVERY_DIGEST,
  githubRecoveryClient,
  RECOVERY_REPOSITORY,
  RecoveryRecordError,
  readRecoveryJournal,
  readRecoveryJournals,
  recoveryRecordDigest,
  validateRecoveryRecord,
  validateRecoveryTransition,
  writeRecoveryJournalCAS,
} from "./recovery-record.mjs";

const prefix = `/repos/${RECOVERY_REPOSITORY}`;
const identity = {
  accountId: "1".repeat(32),
  workerName: "agent-table-staging",
  namespaces: {
    TABLES: "2".repeat(32),
    GUESTS: "3".repeat(32),
    OAUTH_SERIALIZER: "4".repeat(32),
    ADMISSION: "5".repeat(32),
    OAUTH_KV: "6".repeat(32),
  },
  commitments: {
    TABLES: "7".repeat(64),
    GUESTS: "8".repeat(64),
    OAUTH_SERIALIZER: "9".repeat(64),
    ADMISSION: "a".repeat(64),
  },
};
function record(environment = "staging") {
  return {
    format: "agent-table.recovery-record.v1",
    environment,
    revision: 1,
    state: "prepared",
    operationId: "11111111-1111-4111-8111-111111111111",
    generation: "a".repeat(64),
    buildSha: "b".repeat(40),
    configSha256: "c".repeat(64),
    schemaVersion: 12,
    namespaceIdentity: {
      ...structuredClone(identity),
      workerName: `agent-table-${environment}`,
    },
    planSha256: "d".repeat(64),
    inventorySha256: null,
    evidenceSha256: null,
    certificateSha256: null,
    previousRecordSha256: EMPTY_RECOVERY_DIGEST,
    approvalRef:
      "https://github.com/kitamura-tetsuo/agent-table/actions/runs/1234",
    workflow: {
      repository: RECOVERY_REPOSITORY,
      path: `.github/workflows/recover-${environment}.yml`,
      runId: "1234",
      runAttempt: "1",
    },
    updatedAt: "2026-11-14T00:00:00.000Z",
  };
}
function next(previous, state, overrides = {}) {
  return {
    ...structuredClone(previous),
    state,
    revision: previous.revision + 1,
    previousRecordSha256: recoveryRecordDigest(previous),
    updatedAt: new Date(Date.parse(previous.updatedAt) + 1000).toISOString(),
    inventorySha256:
      state === "prepared"
        ? null
        : (previous.inventorySha256 ?? "e".repeat(64)),
    evidenceSha256: ["verified", "cleared"].includes(state)
      ? (previous.evidenceSha256 ?? "f".repeat(64))
      : null,
    certificateSha256: state === "cleared" ? "1".repeat(64) : null,
    ...overrides,
  };
}
function fakeGit() {
  const blobs = new Map();
  const trees = new Map();
  const flatTrees = new Map();
  const commits = new Map();
  const calls = [];
  let head = null;
  let beforeUpdate;
  let mainAvailable = true;
  const sha = (kind, content) =>
    createHash("sha1")
      .update(`${kind}\0${JSON.stringify(content)}`)
      .digest("hex");
  function blob(content) {
    const bytes = Buffer.from(content);
    const id = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    blobs.set(id, {
      sha: id,
      encoding: "base64",
      content: bytes.toString("base64"),
      size: bytes.length,
    });
    return id;
  }
  function tree(flat) {
    const entries = [];
    const groups = new Map();
    for (const [path, blobSha] of flat) {
      if (!path.includes("/"))
        entries.push({ path, sha: blobSha, type: "blob", mode: "100644" });
      else {
        const slash = path.indexOf("/");
        const name = path.slice(0, slash);
        if (!groups.has(name)) groups.set(name, new Map());
        groups.get(name).set(path.slice(slash + 1), blobSha);
      }
    }
    for (const [path, children] of groups)
      entries.push({ path, sha: tree(children), type: "tree", mode: "040000" });
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const id = sha("tree", entries);
    trees.set(id, { sha: id, tree: entries, truncated: false });
    flatTrees.set(id, new Map(flat));
    return id;
  }
  function commit(treeSha, parents, message = "Synthetic journal commit") {
    const id = sha("commit", { treeSha, parents, message });
    commits.set(id, {
      sha: id,
      tree: { sha: treeSha },
      parents: parents.map((parent) => ({ sha: parent })),
      message,
    });
    return id;
  }
  function ref(value) {
    return {
      ref: "refs/heads/recovery-records",
      object: { type: "commit", sha: value },
    };
  }
  function ancestor(older, newer) {
    return (
      older === newer ||
      (commits.get(newer)?.parents ?? []).some((parent) =>
        ancestor(older, parent.sha),
      )
    );
  }
  const client = async (path, options = {}) => {
    const { method = "GET", body } = options;
    calls.push({ path, method, body: structuredClone(body) });
    const route = path.slice(prefix.length);
    if (method === "GET") {
      if (route === "/git/ref/heads/recovery-records") {
        if (head === null)
          throw new RecoveryRecordError("recovery-github-not-found", 404);
        return ref(head);
      }
      if (route === "/git/ref/heads/main") {
        if (!mainAvailable)
          throw new RecoveryRecordError("recovery-github-not-found", 404);
        return {
          ref: "refs/heads/main",
          object: { type: "commit", sha: "0".repeat(40) },
        };
      }
      const match = /^\/git\/(blobs|trees|commits)\/([a-f0-9]{40})$/.exec(
        route,
      );
      assert.ok(match, "Only expected Git object endpoints are read");
      const map = { blobs, trees, commits }[match[1]];
      assert.ok(map.has(match[2]), "Git object exists in fixture");
      return structuredClone(map.get(match[2]));
    }
    if (route === "/git/blobs" && method === "POST")
      return { sha: blob(body.content) };
    if (route === "/git/trees" && method === "POST") {
      const flat = new Map(body.base_tree ? flatTrees.get(body.base_tree) : []);
      for (const item of body.tree) flat.set(item.path, item.sha);
      return { sha: tree(flat) };
    }
    if (route === "/git/commits" && method === "POST")
      return { sha: commit(body.tree, body.parents, body.message) };
    if (route === "/git/refs" && method === "POST") {
      assert.equal(body.ref, "refs/heads/recovery-records");
      if (head !== null)
        throw new RecoveryRecordError("recovery-github-conflict", 422);
      head = body.sha;
      return ref(head);
    }
    if (route === "/git/refs/heads/recovery-records" && method === "PATCH") {
      assert.equal(body.force, false);
      if (beforeUpdate) {
        const hook = beforeUpdate;
        beforeUpdate = undefined;
        await hook(body);
      }
      if (!ancestor(head, body.sha))
        throw new RecoveryRecordError("recovery-github-conflict", 409);
      head = body.sha;
      return ref(head);
    }
    throw new Error("Unexpected Git mutation in fixture");
  };
  return {
    client,
    calls,
    blobs,
    trees,
    commits,
    flatTrees,
    blob,
    tree,
    commit,
    get head() {
      return head;
    },
    set head(value) {
      head = value;
    },
    set beforeUpdate(value) {
      beforeUpdate = value;
    },
    set mainAvailable(value) {
      mainAvailable = value;
    },
  };
}
async function persist(mock, value) {
  const current = await readRecoveryJournal(value.environment, mock.client);
  return writeRecoveryJournalCAS(
    value,
    { headSha: current.headSha, recordSha256: current.recordSha256 },
    mock.client,
  );
}
async function complete(mock, initial = record()) {
  let value = initial;
  await persist(mock, value);
  for (const state of ["quarantined", "resetting", "verified", "cleared"]) {
    value = next(
      value,
      state,
      state === "cleared" ? { configSha256: "2".repeat(64) } : {},
    );
    await persist(mock, value);
  }
  return value;
}

test("strict metadata schema and canonical digests exclude malformed phase authority", () => {
  const initial = record();
  assert.equal(validateRecoveryRecord(initial), initial);
  const reversed = Object.fromEntries(Object.entries(initial).reverse());
  assert.equal(recoveryRecordDigest(initial), recoveryRecordDigest(reversed));
  for (const mutate of [
    (value) => {
      value.extraAuthority = true;
    },
    (value) => {
      delete value.planSha256;
    },
    (value) => {
      value.schemaVersion = 13;
    },
    (value) => {
      value.namespaceIdentity.namespaces.GUESTS =
        value.namespaceIdentity.namespaces.TABLES;
    },
    (value) => {
      value.workflow.path = ".github/workflows/ci.yml";
    },
    (value) => {
      value.workflow.repository = "attacker/repository";
    },
    (value) => {
      value.workflow.runAttempt = "2";
    },
    (value) => {
      value.updatedAt = "2026-11-14T00:00:00Z";
    },
    (value) => {
      value.inventorySha256 = "1".repeat(64);
    },
    (value) => {
      value.evidenceSha256 = "1".repeat(64);
    },
    (value) => {
      value.certificateSha256 = "1".repeat(64);
    },
  ]) {
    const changed = structuredClone(initial);
    mutate(changed);
    assert.throws(() => validateRecoveryRecord(changed), /recovery-/);
  }
  assert.throws(
    () => canonicalRecoveryJson({ unsupported: undefined }),
    /canonical-value-invalid/,
  );
});

test("only sequential fresh generations and exact operation resumes pass transition validation", () => {
  const initial = record();
  validateRecoveryTransition(null, initial);
  const frozen = next(initial, "quarantined");
  validateRecoveryTransition(initial, frozen);
  const resetting = next(frozen, "resetting");
  const resumed = next(resetting, "resetting", {
    workflow: { ...resetting.workflow, runId: "1235" },
  });
  validateRecoveryTransition(resetting, resumed);
  assert.throws(
    () => validateRecoveryTransition(initial, next(initial, "resetting")),
    /recovery-transition-invalid/,
  );
  for (const changed of [
    next(frozen, "resetting", { revision: frozen.revision + 2 }),
    next(frozen, "resetting", { previousRecordSha256: EMPTY_RECOVERY_DIGEST }),
    next(frozen, "resetting", { generation: "f".repeat(64) }),
    next(frozen, "resetting", { buildSha: "f".repeat(40) }),
    next(frozen, "resetting", { configSha256: "f".repeat(64) }),
    next(frozen, "resetting", { planSha256: "f".repeat(64) }),
    next(frozen, "resetting", { inventorySha256: "f".repeat(64) }),
    next(frozen, "resetting", { updatedAt: initial.updatedAt }),
  ])
    assert.throws(
      () => validateRecoveryTransition(frozen, changed),
      /recovery-/,
    );
  const verified = next(resumed, "verified");
  const cleared = next(verified, "cleared", { configSha256: "2".repeat(64) });
  validateRecoveryTransition(verified, cleared);
  assert.throws(
    () => validateRecoveryTransition(cleared, next(cleared, "cleared")),
    /new-generation-required/,
  );
  assert.throws(
    () => validateRecoveryTransition(cleared, next(cleared, "prepared")),
    /new-generation-required/,
  );
  const prepared = next(cleared, "prepared", {
    generation: "3".repeat(64),
    operationId: "22222222-2222-4222-8222-222222222222",
  });
  validateRecoveryTransition(cleared, prepared);
});

test("journal absence requires authenticated access to the fixed repository main ref", async () => {
  const mock = fakeGit();
  const empty = await readRecoveryJournals(mock.client);
  assert.equal(empty.headSha, null);
  assert.equal(empty.environments.staging.record, null);
  assert.ok(
    mock.calls.some((call) => call.path.endsWith("/git/ref/heads/main")),
  );
  mock.mainAvailable = false;
  await assert.rejects(readRecoveryJournals(mock.client), /not-found/);
  await assert.rejects(
    readRecoveryJournals(async () => {
      throw new Error("unverified 404");
    }),
    /unverified 404/,
  );
});

test("persists immutable history outside main and validates all environment records from one commit", async () => {
  const mock = fakeGit();
  const cleared = await complete(mock);
  const beforePeer = await readRecoveryJournal("staging", mock.client);
  assert.equal(beforePeer.record.state, "cleared");
  assert.equal(beforePeer.history.length, 5);
  const production = record("production");
  await persist(mock, production);
  const observed = await readRecoveryJournals(mock.client);
  assert.equal(
    observed.environments.staging.recordSha256,
    recoveryRecordDigest(cleared),
  );
  assert.equal(
    observed.environments.production.recordSha256,
    recoveryRecordDigest(production),
  );
  assert.deepEqual(observed.environments.staging.history, beforePeer.history);
  assert.ok(
    mock.calls
      .filter((call) => call.method === "PATCH")
      .every(
        (call) =>
          call.path.endsWith("/git/refs/heads/recovery-records") &&
          call.body.force === false,
      ),
  );
  assert.ok(
    mock.calls
      .filter(
        (call) => call.path.endsWith("/git/commits") && call.method === "POST",
      )
      .every(
        (call, index) => call.body.parents.length === (index === 0 ? 0 : 1),
      ),
  );
  assert.ok(
    !mock.calls.some(
      (call) => call.method !== "GET" && call.path.includes("heads/main"),
    ),
  );
});

test("stale preflight expectations perform no writes and competing sibling commits cannot overwrite", async () => {
  const mock = fakeGit();
  const initial = record();
  const first = await persist(mock, initial);
  const frozen = next(initial, "quarantined");
  const writesBefore = mock.calls.filter(
    (call) => call.method !== "GET",
  ).length;
  await assert.rejects(
    writeRecoveryJournalCAS(
      frozen,
      { headSha: null, recordSha256: null },
      mock.client,
    ),
    /head-changed/,
  );
  assert.equal(
    mock.calls.filter((call) => call.method !== "GET").length,
    writesBefore,
  );
  let rival;
  mock.beforeUpdate = () => {
    rival = mock.commit(
      first.rootTreeSha,
      [first.headSha],
      "Concurrent unrelated record update",
    );
    mock.head = rival;
  };
  await assert.rejects(
    writeRecoveryJournalCAS(
      frozen,
      { headSha: first.headSha, recordSha256: first.recordSha256 },
      mock.client,
    ),
    /github-conflict/,
  );
  assert.equal(mock.head, rival);
  assert.equal(
    (await readRecoveryJournal("staging", mock.client)).record.state,
    "prepared",
  );
});

test("rejects missing history, hidden extra files and truncated listings", async () => {
  for (const mutate of [
    (_mock, flat) => {
      for (const path of flat.keys())
        if (path.startsWith("history/")) flat.delete(path);
    },
    (mock, flat) => {
      flat.set("unrelated.json", mock.blob("{}\n"));
    },
    (_mock, flat) => {
      flat.delete("staging.json");
    },
  ]) {
    const mock = fakeGit();
    await persist(mock, record());
    const current = mock.commits.get(mock.head);
    const flat = new Map(mock.flatTrees.get(current.tree.sha));
    mutate(mock, flat);
    mock.head = mock.commit(mock.tree(flat), [mock.head]);
    await assert.rejects(
      readRecoveryJournal("staging", mock.client),
      /recovery-/,
    );
  }
  const mock = fakeGit();
  await persist(mock, record());
  mock.trees.get(mock.commits.get(mock.head).tree.sha).truncated = true;
  await assert.rejects(readRecoveryJournals(mock.client), /tree-incomplete/);
});

test("detects malformed current bytes and a corrupted historical record despite a valid latest record", async () => {
  for (const corrupt of [
    (text) => ` ${text}`,
    (text) =>
      text.replace(
        '"state":"prepared"',
        '"state":"prepared","state":"prepared"',
      ),
    (text) =>
      text.replace(
        `"generation":"${"a".repeat(64)}"`,
        `"generation":"${"b".repeat(64)}"`,
      ),
  ]) {
    const mock = fakeGit();
    const initial = record();
    await persist(mock, initial);
    await persist(mock, next(initial, "quarantined"));
    const current = await readRecoveryJournal("staging", mock.client);
    const historical = mock.blobs.get(current.history[0].blobSha);
    const text = corrupt(
      Buffer.from(historical.content, "base64").toString("utf8"),
    );
    historical.content = Buffer.from(text).toString("base64");
    historical.size = Buffer.byteLength(text);
    await assert.rejects(
      readRecoveryJournal("staging", mock.client),
      /recovery-/,
    );
  }
});

test("rejects a structurally valid cleared record that skipped all prior phases", async () => {
  const mock = fakeGit();
  const forged = {
    ...record(),
    state: "cleared",
    inventorySha256: "e".repeat(64),
    evidenceSha256: "f".repeat(64),
    certificateSha256: "1".repeat(64),
  };
  const sha = mock.blob(`${canonicalRecoveryJson(forged)}\n`);
  const flat = new Map([
    ["staging.json", sha],
    [`history/staging/1-${recoveryRecordDigest(forged)}.json`, sha],
  ]);
  mock.head = mock.commit(mock.tree(flat), []);
  await assert.rejects(
    readRecoveryJournal("staging", mock.client),
    /initial-record-invalid/,
  );
});

test("a new recovery cannot reuse any older operation or generation", async () => {
  const mock = fakeGit();
  const first = await complete(mock);
  const secondInitial = next(first, "prepared", {
    generation: "2".repeat(64),
    operationId: "22222222-2222-4222-8222-222222222222",
  });
  const second = await complete(mock, secondInitial);
  for (const override of [
    {
      generation: first.generation,
      operationId: "33333333-3333-4333-8333-333333333333",
    },
    { generation: "3".repeat(64), operationId: first.operationId },
  ])
    await assert.rejects(
      persist(mock, next(second, "prepared", override)),
      /generation-reused/,
    );
  assert.equal(
    (await readRecoveryJournal("staging", mock.client)).record.revision,
    10,
  );
});

test("GitHub client refuses alternate repositories, force pushes and unbounded or secret-bearing errors", async () => {
  const calls = [];
  const client = githubRecoveryClient(
    "test-token-never-echo",
    async (url, options) => {
      calls.push({ url, options });
      return Response.json({ result: "metadata only" });
    },
  );
  await client(`${prefix}/git/ref/heads/main`);
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer test-token-never-echo",
  );
  assert.equal(calls[0].options.redirect, "error");
  for (const [path, options] of [
    ["https://attacker.invalid/", {}],
    ["/repos/attacker/repository/git/ref/heads/recovery-records", {}],
    [
      `${prefix}/git/refs/heads/main`,
      { method: "PATCH", body: { sha: "1".repeat(40), force: false } },
    ],
    [
      `${prefix}/git/refs/heads/recovery-records`,
      { method: "PATCH", body: { sha: "1".repeat(40), force: true } },
    ],
    [
      `${prefix}/git/refs`,
      { method: "POST", body: { ref: "refs/heads/main", sha: "1".repeat(40) } },
    ],
    [`${prefix}/git/ref/heads/main`, { body: "forbidden GET body" }],
    [
      `${prefix}/git/blobs`,
      { method: "POST", body: { content: "x".repeat(128 * 1024 + 1) } },
    ],
  ])
    await assert.rejects(client(path, options), /recovery-github-/);
  assert.equal(calls.length, 1);
  for (const response of [
    new Response("DO_NOT_LOG_PRIVATE_DATA", { status: 403 }),
    new Response("DO_NOT_LOG_PRIVATE_DATA"),
    new Response("x".repeat(1024 * 1024 + 1)),
  ]) {
    const reader = githubRecoveryClient(
      "test-token-never-echo",
      async () => response,
    );
    await assert.rejects(
      reader(`${prefix}/git/ref/heads/main`),
      (error) =>
        error.message.startsWith("recovery-github-") &&
        !error.message.includes("DO_NOT_LOG") &&
        !error.message.includes("never-echo"),
    );
  }
});

test("a newly approved operation can supersede a pending build only with fresh authority", async () => {
  const mock = fakeGit();
  const initial = record();
  await persist(mock, initial);
  const frozen = next(initial, "quarantined");
  await persist(mock, frozen);
  const replacement = next(frozen, "prepared", {
    operationId: "22222222-2222-4222-8222-222222222222",
    generation: "2".repeat(64),
    buildSha: "3".repeat(40),
    configSha256: "4".repeat(64),
    planSha256: "5".repeat(64),
    workflow: { ...frozen.workflow, runId: "1235" },
  });
  await persist(mock, replacement);
  const observed = await readRecoveryJournal("staging", mock.client);
  assert.equal(observed.record.state, "prepared");
  assert.equal(observed.record.buildSha, replacement.buildSha);
  assert.equal(observed.record.evidenceSha256, null);
  assert.equal(observed.record.certificateSha256, null);
  assert.equal(observed.history.length, 3);
  for (const changed of [
    { ...replacement, operationId: frozen.operationId },
    { ...replacement, generation: frozen.generation },
  ])
    assert.throws(
      () => validateRecoveryTransition(frozen, changed),
      /new-generation-required/,
    );
});

test("superseding a pending operation cannot replay any earlier abandoned generation or operation", async () => {
  const mock = fakeGit();
  const first = record();
  await persist(mock, first);
  const second = next(first, "prepared", {
    operationId: "22222222-2222-4222-8222-222222222222",
    generation: "2".repeat(64),
  });
  await persist(mock, second);
  const resetting = next(next(second, "quarantined"), "resetting");
  await persist(mock, next(second, "quarantined"));
  await persist(mock, resetting);
  for (const override of [
    {
      operationId: "33333333-3333-4333-8333-333333333333",
      generation: first.generation,
    },
    { operationId: first.operationId, generation: "3".repeat(64) },
  ])
    await assert.rejects(
      persist(mock, next(resetting, "prepared", override)),
      /generation-reused/,
    );
  assert.equal(
    (await readRecoveryJournal("staging", mock.client)).record.state,
    "resetting",
  );
});
