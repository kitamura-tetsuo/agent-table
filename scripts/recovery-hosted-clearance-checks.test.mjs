import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { verifyPrivateClearance } from "./recovery-hosted-clearance-checks.mjs";

const proposal = JSON.parse(
  await readFile(
    new URL(
      "../docs/issue51-synthetic-clearance-proposal-v2.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function fixture() {
  return {
    config: structuredClone(
      proposal.intendedServingConfiguration.configuration,
    ),
    subject: structuredClone(proposal.subject),
    scenario: {
      runId: "b1a4ba80-b283-468f-85b3-ca9865c0f7bd",
      guestId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      tableId: "33333333-3333-4333-8333-333333333333",
      secret: "a".repeat(43),
    },
    control: {
      identity: async () => ({
        buildSha: proposal.subject.sourceSha,
        environment: "staging",
        schemaVersion: 12,
        commitments: proposal.subject.namespaceIdentity.commitments,
      }),
    },
    application: {
      fetch: async () => {
        throw new Error("Unexpected request");
      },
    },
    checkTimeoutMs: 20,
  };
}

test("private verification refuses an out-of-scope Worker before invoking bindings", async () => {
  const input = fixture();
  input.config.name = "agent-table-staging";
  input.control.identity = async () => {
    assert.fail("Must not contact a runtime for the wrong Worker");
  };
  await assert.rejects(
    verifyPrivateClearance(input),
    /wrong-synthetic-clearance-subject/,
  );
});

test("private verification bounds a stalled identity RPC without leaking errors", async () => {
  const input = fixture();
  input.control.identity = () => new Promise(() => undefined);
  await assert.rejects(
    verifyPrivateClearance(input),
    /private-runtime-identity:deadline/,
  );
});

test("private verification bounds fetch headers and aborts the request", async () => {
  const input = fixture();
  let signal;
  input.application.fetch = (_url, init) => {
    signal = init.signal;
    return new Promise(() => undefined);
  };
  await assert.rejects(
    verifyPrivateClearance(input),
    /healthy-current-build:deadline/,
  );
  assert.equal(signal.aborted, true);
});

test("a stalled response body and stalled cancellation cannot hold verification", async () => {
  const input = fixture();
  let cancelled = false;
  input.application.fetch = async () =>
    new Response(
      new ReadableStream({
        pull: () => new Promise(() => undefined),
        cancel: () => {
          cancelled = true;
          return new Promise(() => undefined);
        },
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  await assert.rejects(
    verifyPrivateClearance(input),
    /healthy-current-build:deadline/,
  );
  assert.equal(cancelled, true);
});

test("private verification refuses oversized bodies before parsing", async () => {
  const input = fixture();
  input.application.fetch = async () =>
    new Response("x".repeat(65_537), {
      headers: { "Cache-Control": "no-store" },
    });
  await assert.rejects(
    verifyPrivateClearance(input),
    /private-response-too-large/,
  );
});

test("private binding errors and response bodies are not copied into failures", async () => {
  const input = fixture();
  input.application.fetch = async () => {
    throw new Error(input.scenario.secret);
  };
  await assert.rejects(verifyPrivateClearance(input), (error) => {
    assert.equal(error.message, "healthy-current-build:private-check-failed");
    assert.equal(error.message.includes(input.scenario.secret), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  input.application.fetch = async () =>
    new Response(input.scenario.secret, {
      headers: { "Cache-Control": "no-store" },
    });
  await assert.rejects(verifyPrivateClearance(input), (error) => {
    assert.equal(error.message, "healthy-current-build:private-check-failed");
    assert.equal(error.message.includes(input.scenario.secret), false);
    return true;
  });
});
