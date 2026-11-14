import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadObservedTrace,
  verifyObservedTrace,
} from "./pr63-observed-trace.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const fixture = () => structuredClone(loadObservedTrace(repo));
test("actual pilot joins remain bounded and never become strict acceptance", () => {
  const { record, receipts } = fixture();
  const report = verifyObservedTrace(record, receipts);
  assert.equal(report.functionalCorrelation, "verified");
  assert.equal(report.strictAcceptance, false);
  assert.deepEqual(
    report.turns.map((t) => t.responseMs),
    [30086, 35016],
  );
  assert.equal(report.duplicateDelivery, "not-observed-attempt-count-one");
  assert.notEqual(
    report.turns[0].readConnectionId,
    report.turns[1].readConnectionId,
  );
});
for (const [name, corrupt] of [
  [
    "unrelated triggering event",
    (r) => {
      r["native-initial-20261114"].event.data.message_id = "unrelated";
    },
  ],
  [
    "manual continuation",
    (r) => {
      r["native-restart-20261114"].manualInputDuringTurn = true;
    },
  ],
  [
    "retry adds a message",
    (r) => {
      r["exact-retry-20261114"].afterMessageCount = 5;
    },
  ],
  [
    "outsider changes a subscription",
    (r) => {
      r["followup-state-20261114"].after.subscription.generation += 1;
    },
  ],
  [
    "cancelled event was dispatched",
    (r) => {
      r["cancellation-20261114"].checkedEvents[0].attemptCount = 1;
    },
  ],
])
  test(`rejects ${name}`, () => {
    const { record, receipts } = fixture();
    corrupt(receipts);
    assert.throws(() => verifyObservedTrace(record, receipts));
  });
