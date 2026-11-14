import { createHash } from "node:crypto";
import { validateRecoveryNamespaceIdentity } from "../src/shared/recovery.ts";

export const RECOVERY_REPOSITORY = "kitamura-tetsuo/agent-table";
export const RECOVERY_RECORD_BRANCH = "recovery-records";
export const EMPTY_RECOVERY_DIGEST = "0".repeat(64);
const API_ORIGIN = "https://api.github.com";
const PREFIX = `/repos/${RECOVERY_REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES = ["prepared", "quarantined", "resetting", "verified", "cleared"];
const FIELDS = [
  "format",
  "environment",
  "revision",
  "state",
  "operationId",
  "generation",
  "buildSha",
  "configSha256",
  "schemaVersion",
  "namespaceIdentity",
  "planSha256",
  "inventorySha256",
  "evidenceSha256",
  "certificateSha256",
  "previousRecordSha256",
  "approvalRef",
  "workflow",
  "updatedAt",
];
const MAX_HISTORY = 512;

export class RecoveryRecordError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "RecoveryRecordError";
    if (status !== undefined) this.status = status;
  }
}

function requireRecord(value, code) {
  if (!value) throw new RecoveryRecordError(code);
}
function exact(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
function validEnvironment(value) {
  return value === "staging" || value === "production";
}
function matches(value, expression) {
  return typeof value === "string" && expression.test(value);
}
function instant(value) {
  if (typeof value !== "string" || value.length !== 24) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}
function boundedRef(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[^\s\p{Cc}]+$/u.test(value)
  );
}

/** Deterministic metadata encoding, shared by hashes and persisted records. */
export function canonicalRecoveryJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalRecoveryJson).join(",")}]`;
  requireRecord(
    value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype,
    "recovery-canonical-value-invalid",
  );
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalRecoveryJson(value[key])}`)
    .join(",")}}`;
}

export function validateRecoveryRecord(value) {
  requireRecord(exact(value, FIELDS), "recovery-record-shape-invalid");
  requireRecord(
    value.format === "agent-table.recovery-record.v1" &&
      validEnvironment(value.environment) &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0 &&
      value.revision <= MAX_HISTORY &&
      STATES.includes(value.state) &&
      matches(value.operationId, UUID) &&
      matches(value.generation, DIGEST) &&
      matches(value.buildSha, SHA) &&
      matches(value.configSha256, DIGEST) &&
      value.schemaVersion === 12 &&
      validateRecoveryNamespaceIdentity(value.namespaceIdentity) &&
      matches(value.planSha256, DIGEST) &&
      matches(value.previousRecordSha256, DIGEST) &&
      boundedRef(value.approvalRef) &&
      instant(value.updatedAt),
    "recovery-record-values-invalid",
  );
  for (const field of [
    "inventorySha256",
    "evidenceSha256",
    "certificateSha256",
  ]) {
    requireRecord(
      value[field] === null ||
        (typeof value[field] === "string" && DIGEST.test(value[field])),
      "recovery-record-digest-invalid",
    );
  }
  requireRecord(
    exact(value.workflow, ["repository", "path", "runId", "runAttempt"]),
    "recovery-record-workflow-invalid",
  );
  requireRecord(
    value.workflow.repository === RECOVERY_REPOSITORY &&
      value.workflow.path ===
        `.github/workflows/recover-${value.environment}.yml` &&
      typeof value.workflow.runId === "string" &&
      /^[1-9]\d{0,19}$/.test(value.workflow.runId) &&
      value.workflow.runAttempt === "1",
    "recovery-record-workflow-invalid",
  );
  requireRecord(
    (value.state !== "prepared" || value.inventorySha256 === null) &&
      (!["prepared", "quarantined", "resetting"].includes(value.state) ||
        value.evidenceSha256 === null) &&
      (value.state === "cleared" || value.certificateSha256 === null) &&
      (!["resetting", "verified", "cleared"].includes(value.state) ||
        value.inventorySha256 !== null) &&
      (!["verified", "cleared"].includes(value.state) ||
        value.evidenceSha256 !== null) &&
      (value.state !== "cleared" || value.certificateSha256 !== null),
    "recovery-record-phase-evidence-invalid",
  );
  return value;
}

export function recoveryRecordDigest(record) {
  validateRecoveryRecord(record);
  return createHash("sha256")
    .update(canonicalRecoveryJson(record))
    .digest("hex");
}

/** Structural CAS policy is not owner approval or proof of a completed reset. */
export function validateRecoveryTransition(previous, next) {
  validateRecoveryRecord(next);
  if (previous === null) {
    requireRecord(
      next.revision === 1 &&
        next.state === "prepared" &&
        next.previousRecordSha256 === EMPTY_RECOVERY_DIGEST,
      "recovery-initial-record-invalid",
    );
    return next;
  }
  validateRecoveryRecord(previous);
  requireRecord(
    next.environment === previous.environment &&
      next.revision === previous.revision + 1 &&
      next.previousRecordSha256 === recoveryRecordDigest(previous) &&
      Date.parse(next.updatedAt) >= Date.parse(previous.updatedAt) &&
      canonicalRecoveryJson(next.namespaceIdentity) ===
        canonicalRecoveryJson(previous.namespaceIdentity),
    "recovery-record-predecessor-mismatch",
  );
  if (
    next.state === "prepared" &&
    (previous.state !== "prepared" ||
      next.operationId !== previous.operationId ||
      next.generation !== previous.generation)
  ) {
    requireRecord(
      next.operationId !== previous.operationId &&
        next.generation !== previous.generation,
      "recovery-new-generation-required",
    );
    return next;
  }
  requireRecord(
    previous.state !== "cleared",
    "recovery-new-generation-required",
  );
  requireRecord(
    next.operationId === previous.operationId &&
      next.generation === previous.generation &&
      next.buildSha === previous.buildSha &&
      next.schemaVersion === previous.schemaVersion &&
      next.planSha256 === previous.planSha256 &&
      (next.configSha256 === previous.configSha256 ||
        (previous.state === "verified" && next.state === "cleared")),
    "recovery-operation-identity-changed",
  );
  const priorIndex = STATES.indexOf(previous.state);
  requireRecord(
    next.state === previous.state ||
      STATES.indexOf(next.state) === priorIndex + 1,
    "recovery-transition-invalid",
  );
  for (const field of [
    "inventorySha256",
    "evidenceSha256",
    "certificateSha256",
  ]) {
    requireRecord(
      previous[field] === null || next[field] === previous[field],
      "recovery-evidence-replaced",
    );
  }
  return next;
}

/** No redirects, arbitrary URLs, secret-bearing responses, or force updates. */
export function githubRecoveryClient(token, fetchImpl = fetch) {
  requireRecord(
    typeof token === "string" && token.length > 10,
    "recovery-github-token-missing",
  );
  return async (path, { method = "GET", body } = {}) => {
    requireRecord(typeof path === "string", "recovery-github-path-invalid");
    const relative = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : "";
    const getAllowed =
      method === "GET" &&
      body === undefined &&
      /^\/git\/(?:ref\/heads\/(?:recovery-records|main)|(?:commits|trees|blobs)\/[a-f0-9]{40})$/.test(
        relative,
      );
    const writeAllowed =
      (method === "POST" &&
        ["/git/blobs", "/git/trees", "/git/commits", "/git/refs"].includes(
          relative,
        )) ||
      (method === "PATCH" &&
        relative === "/git/refs/heads/recovery-records" &&
        body?.force === false);
    requireRecord(getAllowed || writeAllowed, "recovery-github-path-invalid");
    requireRecord(
      method !== "POST" ||
        relative !== "/git/refs" ||
        body?.ref === `refs/heads/${RECOVERY_RECORD_BRANCH}`,
      "recovery-github-ref-invalid",
    );
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    requireRecord(
      serialized === undefined || Buffer.byteLength(serialized) <= 128 * 1024,
      "recovery-github-request-oversized",
    );
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Cache-Control": "no-cache",
          ...(serialized === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new RecoveryRecordError("recovery-github-unreachable");
    }
    if (!response.ok)
      throw new RecoveryRecordError(
        response.status === 404
          ? "recovery-github-not-found"
          : [409, 422].includes(response.status)
            ? "recovery-github-conflict"
            : "recovery-github-refused",
        response.status,
      );
    const reader = response.body?.getReader();
    requireRecord(reader, "recovery-github-body-missing");
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        requireRecord(length <= 1024 * 1024, "recovery-github-body-oversized");
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof RecoveryRecordError) throw error;
      throw new RecoveryRecordError("recovery-github-body-unavailable");
    } finally {
      reader.cancel().catch(() => {});
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new RecoveryRecordError("recovery-github-json-invalid");
    }
  };
}

async function readTree(sha, client) {
  requireRecord(SHA.test(sha), "recovery-tree-sha-invalid");
  const tree = await client(`${PREFIX}/git/trees/${sha}`);
  requireRecord(
    tree?.sha === sha && tree.truncated === false && Array.isArray(tree.tree),
    "recovery-tree-incomplete",
  );
  const paths = new Set();
  for (const item of tree.tree) {
    requireRecord(
      typeof item?.path === "string" &&
        item.path.length > 0 &&
        !item.path.includes("/") &&
        ![".", ".."].includes(item.path) &&
        !paths.has(item.path) &&
        SHA.test(item.sha) &&
        ((item.type === "blob" && item.mode === "100644") ||
          (item.type === "tree" && item.mode === "040000")),
      "recovery-tree-entry-invalid",
    );
    paths.add(item.path);
  }
  return tree.tree;
}

async function readRecordBlob(sha, client) {
  const blob = await client(`${PREFIX}/git/blobs/${sha}`);
  requireRecord(
    blob?.sha === sha &&
      blob.encoding === "base64" &&
      Number.isSafeInteger(blob.size) &&
      blob.size > 0 &&
      blob.size <= 64 * 1024 &&
      typeof blob.content === "string" &&
      /^[A-Za-z0-9+/=\r\n]+$/.test(blob.content),
    "recovery-record-blob-invalid",
  );
  const base64 = blob.content.replace(/[\r\n]/g, "");
  const bytes = Buffer.from(base64, "base64");
  requireRecord(
    bytes.length === blob.size && bytes.toString("base64") === base64,
    "recovery-record-blob-invalid",
  );
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new RecoveryRecordError("recovery-record-json-invalid");
  }
  validateRecoveryRecord(value);
  requireRecord(
    text === `${canonicalRecoveryJson(value)}\n`,
    "recovery-record-noncanonical",
  );
  return value;
}

/** Read both environments from one immutable commit, never from artifact URLs. */
export async function readRecoveryJournals(client) {
  let ref;
  try {
    ref = await client(`${PREFIX}/git/ref/heads/${RECOVERY_RECORD_BRANCH}`);
  } catch (error) {
    if (error instanceof RecoveryRecordError && error.status === 404) {
      // A missing branch and an inaccessible private repository both return 404.
      // Confirm authenticated Git-ref access before recognizing first recovery.
      const main = await client(`${PREFIX}/git/ref/heads/main`);
      requireRecord(
        main?.ref === "refs/heads/main" &&
          main.object?.type === "commit" &&
          matches(main.object.sha, SHA),
        "recovery-journal-absence-unverified",
      );
      return {
        headSha: null,
        rootTreeSha: null,
        environments: {
          staging: { record: null, recordSha256: null, history: [] },
          production: { record: null, recordSha256: null, history: [] },
        },
      };
    }
    throw error;
  }
  requireRecord(
    ref?.ref === `refs/heads/${RECOVERY_RECORD_BRANCH}` &&
      ref.object?.type === "commit" &&
      SHA.test(ref.object.sha),
    "recovery-journal-ref-invalid",
  );
  const headSha = ref.object.sha;
  const commit = await client(`${PREFIX}/git/commits/${headSha}`);
  requireRecord(
    commit?.sha === headSha && SHA.test(commit.tree?.sha),
    "recovery-journal-commit-invalid",
  );
  const root = await readTree(commit.tree.sha, client);
  requireRecord(
    root.every((entry) =>
      ["staging.json", "production.json", "history"].includes(entry.path),
    ) &&
      root.some(
        (entry) =>
          entry.path === "staging.json" || entry.path === "production.json",
      ),
    "recovery-journal-root-unexpected",
  );
  const historyRoot = root.find((entry) => entry.path === "history");
  requireRecord(
    historyRoot === undefined || historyRoot.type === "tree",
    "recovery-history-invalid",
  );
  const historyEnvironments = historyRoot
    ? await readTree(historyRoot.sha, client)
    : [];
  requireRecord(
    historyEnvironments.every(
      (entry) => validEnvironment(entry.path) && entry.type === "tree",
    ),
    "recovery-history-invalid",
  );
  const environments = {};
  for (const environment of ["staging", "production"]) {
    const current = root.find((entry) => entry.path === `${environment}.json`);
    const historyTree = historyEnvironments.find(
      (entry) => entry.path === environment,
    );
    if (!current) {
      requireRecord(!historyTree, "recovery-current-record-missing");
      environments[environment] = {
        record: null,
        recordSha256: null,
        history: [],
      };
      continue;
    }
    requireRecord(
      current.type === "blob" && historyTree,
      "recovery-history-missing",
    );
    const record = await readRecordBlob(current.sha, client);
    requireRecord(
      record.environment === environment,
      "recovery-record-environment-mismatch",
    );
    const digest = recoveryRecordDigest(record);
    const entries = await readTree(historyTree.sha, client);
    requireRecord(
      entries.length === record.revision && entries.length <= MAX_HISTORY,
      "recovery-history-incomplete",
    );
    const revisions = new Set();
    const history = entries
      .map((entry) => {
        const match = /^([1-9]\d*)-([a-f0-9]{64})\.json$/.exec(entry.path);
        requireRecord(
          entry.type === "blob" && match && !revisions.has(Number(match[1])),
          "recovery-history-entry-invalid",
        );
        const revision = Number(match[1]);
        requireRecord(
          Number.isSafeInteger(revision) && revision <= record.revision,
          "recovery-history-entry-invalid",
        );
        revisions.add(revision);
        return { revision, digest: match[2], blobSha: entry.sha };
      })
      .sort((left, right) => left.revision - right.revision);
    requireRecord(
      history.every((entry, index) => entry.revision === index + 1) &&
        history.at(-1).digest === digest &&
        history.at(-1).blobSha === current.sha &&
        record.previousRecordSha256 ===
          (history.at(-2)?.digest ?? EMPTY_RECOVERY_DIGEST),
      "recovery-history-current-mismatch",
    );
    let previous = null;
    const generations = new Set();
    const operations = new Set();
    for (const entry of history) {
      const historical =
        entry.blobSha === current.sha
          ? record
          : await readRecordBlob(entry.blobSha, client);
      requireRecord(
        historical.revision === entry.revision &&
          recoveryRecordDigest(historical) === entry.digest,
        "recovery-history-digest-mismatch",
      );
      validateRecoveryTransition(previous, historical);
      if (
        previous === null ||
        historical.operationId !== previous.operationId
      ) {
        requireRecord(
          !generations.has(historical.generation) &&
            !operations.has(historical.operationId),
          "recovery-generation-reused",
        );
        generations.add(historical.generation);
        operations.add(historical.operationId);
      }
      previous = historical;
    }
    environments[environment] = { record, recordSha256: digest, history };
  }
  return { headSha, rootTreeSha: commit.tree.sha, environments };
}

export async function readRecoveryJournal(environment, client) {
  requireRecord(validEnvironment(environment), "recovery-environment-invalid");
  const all = await readRecoveryJournals(client);
  return {
    headSha: all.headSha,
    rootTreeSha: all.rootTreeSha,
    ...all.environments[environment],
  };
}

/** Git non-force update makes competing sibling commits fail instead of overwrite. */
export async function writeRecoveryJournalCAS(next, expected, client) {
  validateRecoveryRecord(next);
  requireRecord(
    exact(expected, ["headSha", "recordSha256"]) &&
      (expected.headSha === null || matches(expected.headSha, SHA)) &&
      (expected.recordSha256 === null ||
        matches(expected.recordSha256, DIGEST)),
    "recovery-cas-expectation-invalid",
  );
  const current = await readRecoveryJournal(next.environment, client);
  requireRecord(
    current.headSha === expected.headSha &&
      current.recordSha256 === expected.recordSha256,
    "recovery-journal-head-changed",
  );
  validateRecoveryTransition(current.record, next);
  if (current.record && next.operationId !== current.record.operationId) {
    // A protected workflow may supersede a pending operation while frozen.
    // The replacement still needs a generation unused anywhere in this journal.
    const operations = new Map();
    let previous = null;
    for (const entry of current.history) {
      const record = await readRecordBlob(entry.blobSha, client);
      requireRecord(
        recoveryRecordDigest(record) === entry.digest,
        "recovery-history-digest-mismatch",
      );
      validateRecoveryTransition(previous, record);
      requireRecord(
        record.generation !== next.generation &&
          record.operationId !== next.operationId,
        "recovery-generation-reused",
      );
      if (operations.has(record.generation))
        requireRecord(
          operations.get(record.generation) === record.operationId,
          "recovery-history-generation-conflict",
        );
      operations.set(record.generation, record.operationId);
      previous = record;
    }
  }
  const digest = recoveryRecordDigest(next);
  const blob = await client(`${PREFIX}/git/blobs`, {
    method: "POST",
    body: { content: `${canonicalRecoveryJson(next)}\n`, encoding: "utf-8" },
  });
  requireRecord(SHA.test(blob?.sha), "recovery-write-blob-unverified");
  const tree = await client(`${PREFIX}/git/trees`, {
    method: "POST",
    body: {
      ...(current.rootTreeSha === null
        ? {}
        : { base_tree: current.rootTreeSha }),
      tree: [
        {
          path: `${next.environment}.json`,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        },
        {
          path: `history/${next.environment}/${next.revision}-${digest}.json`,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        },
      ],
    },
  });
  requireRecord(SHA.test(tree?.sha), "recovery-write-tree-unverified");
  const commit = await client(`${PREFIX}/git/commits`, {
    method: "POST",
    body: {
      message: `Record ${next.environment} recovery ${next.state} revision ${next.revision}`,
      tree: tree.sha,
      parents: current.headSha === null ? [] : [current.headSha],
    },
  });
  requireRecord(SHA.test(commit?.sha), "recovery-write-commit-unverified");
  const updated =
    current.headSha === null
      ? await client(`${PREFIX}/git/refs`, {
          method: "POST",
          body: {
            ref: `refs/heads/${RECOVERY_RECORD_BRANCH}`,
            sha: commit.sha,
          },
        })
      : await client(`${PREFIX}/git/refs/heads/${RECOVERY_RECORD_BRANCH}`, {
          method: "PATCH",
          body: { sha: commit.sha, force: false },
        });
  requireRecord(
    updated?.ref === `refs/heads/${RECOVERY_RECORD_BRANCH}` &&
      updated.object?.type === "commit" &&
      updated.object.sha === commit.sha,
    "recovery-write-ref-unverified",
  );
  const observed = await readRecoveryJournal(next.environment, client);
  requireRecord(
    observed.recordSha256 === digest,
    "recovery-journal-postwrite-changed",
  );
  return { ...observed, writtenCommitSha: commit.sha };
}
