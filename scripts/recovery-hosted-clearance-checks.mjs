import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const WORKER = "agent-table-pr51-recovery-staging";
const SOURCE = "3d65b9ace98720afd2ef48275a3bb76a8638f76e";
const RUN = "b1a4ba80-b283-468f-85b3-ca9865c0f7bd";
const OPERATION = "4603a356-06f8-408c-bc13-f94f26484328";
const GENERATION =
  "bbdca17200eeca1428bedb579c3461730ded3bb5155d763f8feaf9a514078ce4";
const CONFIG =
  "58aaf16f7cacf06c3b0b568b4e3858c9c399d86b826348630c99a99f0a2330fa";
const FLAGS = [
  "ALLOW_NEW_GUESTS",
  "ALLOW_NEW_TABLES",
  "ENABLE_MCP_SUBSCRIPTIONS",
  "ENABLE_OPENAI_EVENTS",
  "ALLOW_OUTBOUND_NOTIFICATIONS",
];
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const plain = (value) => JSON.parse(JSON.stringify(value));
const MAX_RESPONSE_BYTES = 65_536;

class PrivateClearanceCheckError extends Error {}
function requireCheck(value, code) {
  if (!value) throw new PrivateClearanceCheckError(code);
}

async function withinDeadline(label, timeoutMs, operation) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PrivateClearanceCheckError(`${label}:deadline`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      operation(controller.signal, deadline),
      deadline,
    ]);
  } catch (error) {
    // Provider errors and JSON parse failures can contain credentials or bodies.
    if (error instanceof PrivateClearanceCheckError) throw error;
    throw new PrivateClearanceCheckError(`${label}:private-check-failed`);
  } finally {
    clearTimeout(timer);
  }
}

async function boundedText(response, deadline) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let completed = false;
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) {
        completed = true;
        break;
      }
      bytes += result.value.byteLength;
      requireCheck(bytes <= MAX_RESPONSE_BYTES, "private-response-too-large");
      chunks.push(result.value);
    }
  } finally {
    // Cancellation itself is untrusted and must not defeat the deadline.
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Call only after approved activation and verified signed/provider config.
 * APPLICATION and CONTROL must be authenticated remote Service bindings.
 * Ordinary requests may create admission-rate metadata in retained storage.
 * No credentials, private row values, cookies or response bodies are reported.
 */
export async function verifyPrivateClearance({
  application,
  control,
  config,
  subject,
  scenario,
  checkTimeoutMs = 15_000,
}) {
  requireCheck(
    Number.isSafeInteger(checkTimeoutMs) &&
      checkTimeoutMs >= 10 &&
      checkTimeoutMs <= 15_000,
    "invalid-private-check-deadline",
  );
  requireCheck(
    config.name === WORKER &&
      subject.namespaceIdentity.workerName === WORKER &&
      subject.sourceSha === SOURCE &&
      subject.schemaVersion === 12 &&
      subject.operationId === OPERATION &&
      subject.generation === GENERATION,
    "wrong-synthetic-clearance-subject",
  );
  requireCheck(
    config.vars.RELEASE_BUILD_SHA === SOURCE &&
      config.vars.RELEASE_ENVIRONMENT === "staging" &&
      config.vars.RESTORE_QUARANTINE === "false" &&
      config.vars.RELEASE_PROFILE === "manual" &&
      config.vars.RECOVERY_CONFIG_SHA256 === CONFIG,
    "wrong-synthetic-clearance-configuration",
  );
  for (const name of FLAGS)
    requireCheck(config.vars[name] === "false", "capability-not-disabled");
  requireCheck(
    config.workers_dev === false &&
      config.preview_urls === false &&
      isDeepStrictEqual(config.routes, []),
    "public-exposure-not-disabled",
  );
  requireCheck(
    config.vars.GUEST_CHALLENGE_MODE === undefined ||
      config.vars.GUEST_CHALLENGE_MODE === "off",
    "unexpected-synthetic-challenge-mode",
  );
  const origin = `https://${WORKER}.kitamura-tetsuo.workers.dev`;
  requireCheck(
    config.vars.PUBLIC_ORIGIN === origin,
    "unexpected-private-origin",
  );
  requireCheck(scenario.runId === RUN, "wrong-synthetic-scenario");
  for (const key of ["guestId", "sessionId", "tableId"])
    requireCheck(UUID.test(scenario[key]), "invalid-synthetic-identifier");
  requireCheck(
    /^[A-Za-z0-9_-]{43}$/.test(scenario.secret),
    "invalid-synthetic-secret",
  );
  requireCheck(
    typeof application.fetch === "function" &&
      typeof control.identity === "function",
    "private-service-bindings-required",
  );

  const identity = await withinDeadline(
    "private-runtime-identity",
    checkTimeoutMs,
    async () => plain(await control.identity()),
  );
  requireCheck(
    Object.keys(identity).sort().join(",") ===
      "buildSha,commitments,environment,schemaVersion" &&
      identity.buildSha === SOURCE &&
      identity.environment === "staging" &&
      identity.schemaVersion === 12 &&
      isDeepStrictEqual(
        identity.commitments,
        subject.namespaceIdentity.commitments,
      ),
    "private-runtime-identity-mismatch",
  );
  const checks = [];
  const sessionCookie = `__Host-agent_table_session=v1.${scenario.guestId}.${scenario.sessionId}.${scenario.secret}`;
  const csrf = randomBytes(32).toString("base64url");
  const csrfCookie = `__Host-agent_table_csrf=${csrf}`;
  async function check(label, path, init, expectedStatus, predicate) {
    const result = await withinDeadline(
      label,
      checkTimeoutMs,
      async (signal, deadline) => {
        const pending = Promise.resolve().then(() =>
          application.fetch(new URL(path, origin).href, {
            ...init,
            redirect: "manual",
            signal,
          }),
        );
        // A late response after timeout must not retain an unread body.
        void pending
          .then((response) => {
            if (signal.aborted)
              void response.body?.cancel().catch(() => undefined);
          })
          .catch(() => undefined);
        const response = await Promise.race([pending, deadline]);
        const body = await boundedText(response, deadline);
        requireCheck(response.status === expectedStatus, `${label}:status`);
        requireCheck(
          response.headers.get("Cache-Control") === "no-store",
          `${label}:cache-policy`,
        );
        requireCheck(predicate(body, response), `${label}:application-result`);
        requireCheck(
          !body.includes(scenario.secret),
          `${label}:secret-reflected`,
        );
        requireCheck(
          !(response.headers.get("Set-Cookie") ?? "").includes(
            "__Host-agent_table_session=",
          ),
          `${label}:session-cookie-issued`,
        );
        return {
          name: label,
          status: response.status,
          noStore: true,
          expectedApplicationResult: true,
        };
      },
    );
    checks.push(result);
  }
  await check("healthy-current-build", "/health", {}, 200, (body) => {
    const value = JSON.parse(body);
    return (
      value.status === "ok" &&
      value.release?.environment === "staging" &&
      value.release?.buildSha === SOURCE &&
      value.release?.profile === "manual"
    );
  });
  await check(
    "historical-session-denied",
    "/guest/me",
    { headers: { Cookie: sessionCookie } },
    401,
    (body) => JSON.parse(body).error === "no-valid-guest-session",
  );
  await check(
    "historical-transcript-denied",
    `/guest/table?table_id=${scenario.tableId}`,
    { headers: { Cookie: sessionCookie } },
    401,
    (body) => body === "Valid guest browser session required",
  );
  await check(
    "ordinary-guest-page-served",
    "/guest",
    {},
    200,
    (body, response) =>
      (response.headers.get("Content-Type") ?? "").includes("text/html") &&
      body.includes("Agent Table"),
  );
  const form = (choice, cookie) => ({
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
    body: new URLSearchParams({ choice, csrf }).toString(),
  });
  await check(
    "new-guest-admission-remains-disabled",
    "/guest/session",
    form("new", csrfCookie),
    503,
    (body) => body === "New guest admission is disabled",
  );
  await check(
    "historical-session-cannot-be-rotated",
    "/guest/session",
    form("reuse", `${csrfCookie}; ${sessionCookie}`),
    401,
    (body) => body === "No valid guest session",
  );
  return {
    format: "agent-table.synthetic-private-clearance-verification.v1",
    checkedAt: new Date().toISOString(),
    transport: "authenticated-private-service-binding",
    identity,
    checks,
    oldSessionDenied: true,
    oldSessionRotationDenied: true,
    historicalTranscriptDenied: true,
    applicationServingVerified: true,
    newGuestAdmissionDisabled: true,
    effects: {
      privateGuestOrTableCreated: false,
      oauthCredentialsCreated: false,
      namespaceChanges: false,
      destructiveReset: false,
      pitr: false,
      admissionRateBucketsMayBeCreatedOrUpdated: true,
    },
    limits: [
      "The table route rejects the historical session before reaching TableDO.",
      "The historical session may also have expired; rejection alone does not isolate expiry, revocation and reset.",
      "The hosted fixture has no previously issued real OAuth token; no token-reuse claim is made.",
      "Successful routed requests imply guarded AdmissionDO processing, not a new valid guest session.",
      "Canonical row readback requires signed same-generation quarantine inspection; it is not performed here.",
    ],
  };
}
