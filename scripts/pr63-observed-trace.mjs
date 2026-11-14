import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This pilot-specific check does not relax the general acceptance evaluator.
export function verifyObservedTrace(record, receipts) {
  const get = (id) => {
    assert(receipts[id], `Missing receipt: ${id}`);
    return receipts[id];
  };
  assert.equal(record.evidenceKind, "real-host");
  assert.equal(record.acceptanceMode, "a-only");
  assert.equal(record.ownershipMode, "same-owner");
  const approval = get("bounded-approval-20261114");
  assert.equal(approval.strictEvaluatorUnchanged, true);
  const participants = record.participants;
  const a = participants.find((p) => p.role === "A");
  const b = participants.find((p) => p.role === "B");
  assert.equal(a.ownerRef, b.ownerRef);
  for (const key of ["accountRef", "guestId", "connectionId", "membershipId"])
    assert.notEqual(a[key], b[key], key);
  const initial = get("initial-sql-20261114");
  const final = get("restart-sql-20261114");
  assert.equal(initial.table.tableId, record.tableId);
  assert.equal(final.table.tableId, record.tableId);
  assert.deepEqual(initial.subscription, final.subscription);
  const turns = ["initial", "restart"].map((label) => {
    const native = get(`native-${label}-20261114`);
    const tools = get(`tools-${label}-20261114`);
    const event = native.event;
    assert.equal(event.name, "table.message.created");
    assert.equal(event.data.table_id, record.tableId);
    assert.equal(native.manualInputDuringTurn, false);
    const peer = tools.observedMessages.find(
      (m) => m.message_id === event.data.message_id,
    );
    assert(peer);
    assert.equal(peer.seq, event.data.seq);
    assert.equal(peer.sender_membership_id, b.membershipId);
    assert.equal(tools.afterSeq, 0);
    assert(tools.throughSeq >= peer.seq);
    assert.equal(tools.replyParent, peer.message_id);
    const reply = tools.postResult;
    assert.equal(reply.persisted, true);
    assert.equal(reply.sender_membership_id, a.membershipId);
    assert.equal(reply.table_id, record.tableId);
    assert(reply.seq > peer.seq);
    assert(Date.parse(native.firstClock) >= Date.parse(peer.created_at));
    assert(Date.parse(native.firstClock) <= Date.parse(reply.created_at));
    const committed = final.messages.find(
      (m) => m.messageId === reply.message_id,
    );
    assert.equal(committed.replyToMessageId, peer.message_id);
    assert.equal(committed.seq, reply.seq);
    const delivery = final.outbox.find((x) => x.eventId === event.eventId);
    assert(delivery);
    assert.equal(delivery.messageId, peer.message_id);
    assert.equal(delivery.seq, peer.seq);
    assert.equal(delivery.membershipId, a.membershipId);
    assert.equal(delivery.subscriptionId, a.subscriptionId);
    assert.equal(delivery.status, "accepted");
    assert.equal(delivery.attemptCount, 1);
    return {
      eventId: event.eventId,
      peerSeq: peer.seq,
      replySeq: reply.seq,
      responseMs: Date.parse(reply.created_at) - Date.parse(peer.created_at),
      readConnectionId: tools.readConnectionId,
    };
  });
  assert.deepEqual(
    turns.map((t) => [t.peerSeq, t.replySeq]),
    [
      [1, 2],
      [3, 4],
    ],
  );
  const identity = get("a-read-identity-20261114").identity;
  assert.equal(identity.guestId, a.guestId);
  assert(identity.scopes.includes("tables:read"));
  assert(identity.scopes.includes("tables:write"));
  assert.equal(turns[0].readConnectionId, a.connectionId);
  assert.equal(turns[1].readConnectionId, identity.connectionId);
  const retry = get("exact-retry-20261114");
  assert.equal(retry.sameInputAndRequestKey, true);
  assert.equal(retry.transcriptUnchanged, true);
  assert.deepEqual(retry.originalResult, retry.retryResult);
  assert.equal(retry.beforeMessageCount, 4);
  assert.equal(retry.afterMessageCount, 4);
  assert.equal(retry.beforeThroughSeq, retry.afterThroughSeq);
  assert.equal(retry.retryResult.seq, 4);
  const restart = get("retained-redeploy-20261114");
  assert.equal(restart.verifiedProviderReadback, true);
  assert.equal(restart.retainedStateExact, true);
  assert.equal(restart.versionChanged, true);
  assert(
    Date.parse(restart.afterAt) <
      Date.parse(get("native-restart-20261114").event.timestamp),
  );
  const cancellation = get("cancellation-20261114");
  assert.equal(cancellation.status, "conditionally-complete");
  assert.equal(cancellation.checkedEvents.length, 1);
  assert.equal(cancellation.checkedEvents[0].status, "cancelled");
  assert.equal(cancellation.checkedEvents[0].attemptCount, 0);
  const outsider = get("outsider-c-followup-20261114");
  assert.notEqual(outsider.guestId, a.guestId);
  assert.notEqual(outsider.guestId, b.guestId);
  assert.equal(outsider.review.actualCAuthenticated, true);
  assert.equal(outsider.review.targetsUnchanged, true);
  assert.equal(outsider.review.checks.length, 12);
  assert(outsider.review.checks.every((c) => c.passed));
  for (const kind of [
    "metadata",
    "transcript",
    "inbox",
    "unsubscribe",
    "subscribe-authorization",
  ])
    assert(outsider.review.checks.some((c) => c.kind === kind));
  assert.equal(outsider.results.length, 12);
  for (const result of outsider.results) {
    const kind = result.name.split(":")[0];
    assert.equal(
      result.code,
      ["metadata", "transcript"].includes(kind)
        ? "TABLE_NOT_FOUND"
        : kind === "inbox"
          ? -32603
          : -32001,
    );
    if (["unsubscribe", "subscribe-authorization"].includes(kind))
      assert.equal(result.message, "Subscription unavailable");
  }
  const pair = get("capture-pair-20261114");
  assert.equal(pair.status, "conditionally-complete");
  assert.equal(pair.checkedEvents.length, 2);
  for (const turn of turns)
    assert(
      pair.checkedEvents.some(
        (x) => x.eventId === turn.eventId && x.status === "accepted",
      ),
    );
  const state = get("followup-state-20261114");
  for (const [before, after] of [
    [state.before, state.after],
    [state.controlBefore, state.controlAfter],
  ])
    for (const key of ["table", "subscription", "messages", "outbox"])
      assert.deepEqual(before[key], after[key]);
  const disclosure = get("synthetic-disclosure-20261114");
  assert.equal(disclosure.allMessagesReviewed, true);
  assert.equal(disclosure.messageCount, 4);
  assert.equal(disclosure.onlyApprovedSyntheticCorpus, true);
  assert.equal(disclosure.personalContextPresent, false);
  return {
    schemaVersion: 1,
    scope: "owner-approved-native-trace-same-owner-a-only",
    functionalCorrelation: "verified",
    strictAcceptance: false,
    turns,
    exactRetry: "unchanged",
    retainedStateRedeploy: "verified",
    pendingCancellation: "zero-attempt-cancelled",
    outsiderAuthorization: "denied-targets-unchanged",
    disclosure: "approved-synthetic-corpus-only",
    duplicateDelivery: "not-observed-attempt-count-one",
    limitations: [
      "Pre-event idle state and internal run IDs unverified; owner-approved native trace alternative only.",
      "Work UI insertion visibility unverified; table replies are committed.",
      "Retained-state Worker redeploy, not an independently traced per-DO eviction.",
      "C authorization-boundary refusal, not original callback compound-key renewal.",
      "No public, cross-owner, bidirectional, dot or exactly-once-reasoning claim.",
      "General strict evaluator remains incomplete; exact workspace/protocol negotiation and original dated consent fields are not invented.",
      "Receipt hashes check local integrity, not origin authenticity; source review remains required.",
    ],
  };
}

export function loadObservedTrace(repo) {
  const record = JSON.parse(
    fs.readFileSync(
      path.join(
        repo,
        "test/e2e/host/autonomous-evidence.chatgpt-claude-selected.json",
      ),
    ),
  );
  const dir = path.join(repo, "test/e2e/host/receipts/pr63-20261114");
  const receipts = {};
  for (const item of record.observations) {
    assert(/^[a-z0-9-]+$/.test(item.id));
    const raw = fs.readFileSync(path.join(dir, `${item.id}.json`));
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      item.sha256,
      item.id,
    );
    receipts[item.id] = JSON.parse(raw);
  }
  return { record, receipts };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const { record, receipts } = loadObservedTrace(repo);
  process.stdout.write(
    `${JSON.stringify(verifyObservedTrace(record, receipts), null, 2)}\n`,
  );
}
