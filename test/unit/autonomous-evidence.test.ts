import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_SCENARIOS,
  type AutonomousEvidence,
  type AutonomousObservation,
  autonomousEvidenceSchema,
  evaluateAutonomousEvidence,
} from "../e2e/host/autonomous-evidence";
import selectedChatPair from "../e2e/host/autonomous-evidence.chatgpt-claude-selected.json";
import template from "../e2e/host/autonomous-evidence.template.json";

// This fixture is invented validator input, never a real compatibility record.
// Changing its kind in a test exercises only the metadata gate's positive branch.
function syntheticFixture(
  acceptanceMode: AutonomousEvidence["acceptanceMode"] = "bidirectional",
): AutonomousEvidence {
  const record = autonomousEvidenceSchema.parse(template);
  record.acceptanceMode = acceptanceMode;
  const aOnly = acceptanceMode === "a-only";
  record.evidenceKind = "synthetic-validator";
  const at = (seconds: number) =>
    new Date(Date.parse("2026-11-12T00:00:00Z") + seconds * 1000).toISOString();
  let nextId = 0;
  const receipt = (source: AutonomousObservation["source"]) => {
    const n = ++nextId;
    const id = `fixture-observation-${n}`;
    record.observations.push({
      id,
      source,
      capturedAt: at(250),
      sha256: n.toString(16).padStart(64, "0"),
    });
    return id;
  };
  record.pilotId = "synthetic-validator-only";
  record.observedAt = at(300);
  record.tableId = "primary-table-0001";
  record.deployment = {
    buildSha: "a".repeat(40),
    configSha256: "b".repeat(64),
    endpointRef: "isolated-endpoint-0001",
    approvalRef: receipt("operator"),
    configurationRef: receipt("operator"),
    isolated: true,
    publicAdvertisement: false,
    protocol: "mcp-2025-11-25",
    profile: "synthetic-events-profile",
  };
  record.participants = record.participants.map((person) => ({
    ...person,
    ownerRef: `fixture-owner-${person.role}`,
    accountRef: `fixture-account-${person.role}`,
    workspaceRef: `fixture-workspace-${person.role}`,
    guestId: `fixture-guest-${person.role}`,
    connectionId: `fixture-connection-${person.role}`,
    membershipId: `fixture-membership-${person.role}`,
    subscriptionId: `fixture-subscription-${person.role}`,
    host: {
      product: `Synthetic Host ${person.role}`,
      surface: "Synthetic private app",
      exposedBuild: "not-exposed-in-tested-host",
      eligibility: "eligible",
      origin: "actual-host",
      runObservation: "provider-audit",
    },
    oauthEvidenceRef: receipt("host-tool"),
    subscription: {
      tableId: record.tableId,
      activeAt: at(1),
      observationRef: receipt("server"),
    },
    consent: {
      approvedAt: at(0),
      observationRef: receipt("owner-consent"),
      instructionsSha256: "c".repeat(64),
      maxReplies: 3,
      syntheticOnly: true,
      readBeforeReply: true,
      reuseMutationKey: true,
      stopOnTerminal: true,
      suppressAcknowledgmentLoops: true,
      askBeforeOutOfScope: true,
    },
  })) as AutonomousEvidence["participants"];
  const [a, b] = record.participants;
  if (aOnly) {
    b.subscriptionId = null;
    b.subscription = { tableId: null, activeAt: null, observationRef: null };
    b.host.runObservation = "unsupported";
  }
  const makeTurn = (
    id: string,
    sender: "A" | "B",
    start: number,
    seq: number,
    scenario: "event-response" | "restart",
  ): AutonomousEvidence["turns"][number] => {
    const from = sender === "A" ? a : b;
    const to = sender === "A" ? b : a;
    const eventId = `${id}-event`;
    const attemptId = `${id}-attempt`;
    const runId = `${id}-run`;
    const post = {
      tableId: record.tableId as string,
      messageId: `${id}-post`,
      seq,
      senderMembershipId: from.membershipId as string,
      committedAt: at(start),
      mutationKeySha256: seq.toString(16).repeat(64),
      observationRef: receipt("server"),
      hostObservationRef: receipt("host-tool"),
    };
    return {
      id,
      scenario,
      sender,
      recipient: sender === "A" ? "B" : "A",
      post,
      event: {
        tableId: post.tableId,
        eventId,
        messageId: post.messageId,
        messageSeq: seq,
        senderMembershipId: post.senderMembershipId,
        recipientMembershipId: to.membershipId as string,
        subscriptionId: to.subscriptionId as string,
        committedAt: at(start),
        observationRef: receipt("server"),
      },
      deliveries: [
        {
          attemptId,
          eventId,
          subscriptionId: to.subscriptionId as string,
          authorizedAt: at(start + 1),
          dispatchedAt: at(start + 2),
          acceptedAt: at(start + 3),
          statusCode: 204,
          observationRef: receipt("server"),
        },
      ],
      idle: {
        observedAt: at(start - 1),
        activeRuns: 0,
        observationRef: receipt("host-audit"),
      },
      run: {
        runId,
        triggeringEventId: eventId,
        deliveryAttemptId: attemptId,
        trigger: "peer-event",
        startedAt: at(start + 4),
        observationRef: receipt("host-audit"),
      },
      read: {
        runId,
        eventId,
        tableId: post.tableId,
        membershipId: to.membershipId as string,
        connectionId: to.connectionId as string,
        afterSeq: seq - 1,
        throughSeq: seq,
        observedMessageIds: [post.messageId],
        readAt: at(start + 5),
        hostObservationRef: receipt("host-tool"),
        serverObservationRef: receipt("server"),
      },
      reply: {
        tableId: post.tableId,
        runId,
        messageId: `${id}-reply`,
        seq: seq + 1,
        senderMembershipId: to.membershipId as string,
        replyToMessageId: post.messageId,
        committedAt: at(start + 6),
        mutationKeySha256: (seq + 1).toString(16).repeat(64),
        observationRef: receipt("server"),
        hostObservationRef: receipt("host-tool"),
      },
    };
  };
  const first = makeTurn(
    "fixture-first",
    aOnly ? "B" : "A",
    10,
    1,
    "event-response",
  );
  const firstReply = first.reply as NonNullable<typeof first.reply>;
  record.turns = [first];
  if (!aOnly) {
    const back = makeTurn("fixture-return", "B", 16, 2, "event-response");
    back.post = {
      tableId: firstReply.tableId,
      messageId: firstReply.messageId,
      seq: firstReply.seq,
      senderMembershipId: firstReply.senderMembershipId,
      committedAt: firstReply.committedAt,
      mutationKeySha256: firstReply.mutationKeySha256,
      observationRef: firstReply.observationRef,
      hostObservationRef: firstReply.hostObservationRef,
    };
    back.event.messageId = back.post.messageId;
    if (back.read) back.read.observedMessageIds = [back.post.messageId];
    (back.reply as NonNullable<typeof back.reply>).replyToMessageId =
      back.post.messageId;
    record.turns.push(back);
  }
  const resumed = makeTurn(
    "fixture-resumed",
    aOnly ? "B" : "A",
    110,
    aOnly ? 3 : 4,
    "restart",
  );
  record.turns.push(resumed);
  record.retry = {
    turnId: first.id,
    originalMutationKeySha256: first.post.mutationKeySha256,
    retryMutationKeySha256: first.post.mutationKeySha256,
    originalPayloadSha256: "1".repeat(64),
    retryPayloadSha256: "1".repeat(64),
    originalMessageId: first.post.messageId,
    retryMessageId: first.post.messageId,
    originalSeq: 1,
    retrySeq: 1,
    beforeCount: aOnly ? 2 : 3,
    afterCount: aOnly ? 2 : 3,
    retriedAt: at(30),
    observationRef: receipt("server"),
  };
  record.duplicateDelivery = {
    turnId: first.id,
    eventId: first.event.eventId,
    acceptedAttemptIds: [first.deliveries[0].attemptId],
    observedRunIds: [first.run?.runId as string],
    acceptedReplyMessageIds: [firstReply.messageId],
    behavior: "not-observed",
    through: at(60),
    hostObservationRef: receipt("host-audit"),
    serverObservationRef: receipt("server"),
  };
  record.cancellation = {
    tableId: "cancellation-table-0001",
    recipient: "A",
    recipientGuestId: a.guestId as string,
    action: "close",
    subscriptionId: "cancellation-subscription-0001",
    pendingEventId: "cancellation-pending-0001",
    pendingAt: at(40),
    decisionAt: at(50),
    observationRef: receipt("server"),
    attempts: [
      {
        attemptId: "cancellation-inflight-0001",
        eventId: "cancellation-pending-0001",
        authorizedAt: at(41),
        dispatchedAt: at(42),
        completedAt: at(55),
      },
    ],
    coverageFrom: at(35),
    coverageThrough: at(70),
    coverageObservationRef: receipt("server"),
    postDecisionProbeAt: at(65),
    refusalObservationRef: receipt("server"),
  };
  const before = {
    storageIdentity: "retained-storage-0001",
    buildSha: record.deployment.buildSha as string,
    configSha256: record.deployment.configSha256 as string,
    retryStateSha256: "2".repeat(64),
    subscriptionIds: aOnly
      ? [a.subscriptionId as string]
      : [a.subscriptionId as string, b.subscriptionId as string],
    observedAt: at(100),
    observationRef: receipt("server"),
  };
  record.restart = {
    mode: "retained-storage",
    tableId: record.tableId,
    startedAt: at(101),
    readyAt: at(102),
    operationRef: receipt("operator"),
    before,
    after: {
      ...before,
      observedAt: at(103),
      observationRef: receipt("server"),
    },
    newTurnId: resumed.id,
    terminalTableId: record.cancellation.tableId,
    terminalSubscriptionId: record.cancellation.subscriptionId,
    terminalStateBefore: "closed",
    terminalStateAfter: "closed",
    terminalCheckAt: at(120),
    terminalDispatchCount: 0,
    terminalObservationRef: receipt("server"),
  };
  for (const person of record.participants) {
    for (const action of [
      "metadata",
      "transcript",
      "inbox",
      "renew-subscription",
      "unsubscribe",
    ] as const) {
      if (
        aOnly &&
        person.role === "B" &&
        (action === "renew-subscription" || action === "unsubscribe")
      )
        continue;
      record.isolation.push({
        action,
        outsiderGuestId: "unaffiliated-guest-0001",
        outsiderConnectionId: "unaffiliated-connection-0001",
        tableId: record.tableId,
        targetMembershipId: person.membershipId as string,
        targetSubscriptionId: person.subscriptionId,
        observedAt: at(80),
        outcome: "denied",
        privateDataReturned: false,
        subscriptionChanged: false,
        clientObservationRef: receipt("host-tool"),
        serverObservationRef: receipt("server"),
      });
    }
  }
  record.disclosure = {
    syntheticPayloadsSha256: "3".repeat(64),
    postedPayloadsSha256: "3".repeat(64),
    scope: "synthetic-only",
    ownerReviewRefs: [receipt("owner-consent"), receipt("owner-consent")],
    transcriptObservationRef: receipt("server"),
  };
  return record;
}

function realHostShapedFixture(
  acceptanceMode: AutonomousEvidence["acceptanceMode"] = "bidirectional",
) {
  const record = syntheticFixture(acceptanceMode);
  record.evidenceKind = "real-host";
  return record;
}

describe("autonomous pilot metadata gate", () => {
  it.each([
    ["generic template", template],
    ["owner-selected ChatGPT and Claude Chat", selectedChatPair],
  ])("keeps the incomplete %s explicit and incomplete", (_name, record) => {
    const result = evaluateAutonomousEvidence(record);
    expect(result.structurallyValid).toBe(true);
    expect(result.completeRecord).toBe(false);
    if (record.evidenceKind === "not-run") {
      expect(Object.values(result.layers)).toEqual([
        "not-run",
        "not-run",
        "not-run",
      ]);
    } else {
      expect(record.evidenceKind).toBe("real-host");
      expect(record.observations.length).toBeGreaterThan(0);
      expect(result.layers.tools).toBe("blocked");
      expect(result.layers.autonomousReply).not.toBe("passed");
    }
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("never turns a complete synthetic fixture into host compatibility evidence", () => {
    const result = evaluateAutonomousEvidence(syntheticFixture());
    expect(result.structurallyValid).toBe(true);
    for (const scenario of AUTONOMOUS_SCENARIOS)
      expect(result.scenarios[scenario]).toBe("passed");
    expect(result.completeRecord).toBe(false);
    expect(result.layers.autonomousReply).toBe("blocked");
  });

  it("accepts a complete real-host-shaped metadata join without authenticating its receipts", () => {
    // Positive validator branch only: this invented record is not saved as evidence.
    const result = evaluateAutonomousEvidence(realHostShapedFixture());
    expect(result.missing).toEqual([]);
    expect(result.completeRecord).toBe(true);
    expect(result.layers).toEqual({
      tools: "passed",
      notificationReceipt: "passed",
      autonomousReply: "passed",
    });
  });

  it.each(["a-only", "bidirectional"] as const)(
    "rejects %s initial responses completed after the pre-restart snapshot",
    (mode) => {
      const record = realHostShapedFixture(mode);
      const restart = record.restart as NonNullable<typeof record.restart>;
      restart.before.observedAt = "2026-11-12T00:00:15Z";

      const result = evaluateAutonomousEvidence(record);
      expect(result.completeRecord).toBe(false);
      expect(result.scenarios.restart).toBe("failed");
      expect(result.missing).toContain(
        "restart: initial event-response messages precede the pre-restart snapshot",
      );
    },
  );

  it.each(["a-only", "bidirectional"] as const)(
    "rejects %s initial responses observed only after restart",
    (mode) => {
      const record = realHostShapedFixture(mode);
      const cancellation = record.cancellation as NonNullable<
        typeof record.cancellation
      >;
      const restart = record.restart as NonNullable<typeof record.restart>;
      Object.assign(cancellation, {
        pendingAt: "2026-11-12T00:00:02Z",
        decisionAt: "2026-11-12T00:00:04Z",
        attempts: [],
        coverageFrom: "2026-11-12T00:00:01Z",
        coverageThrough: "2026-11-12T00:00:06Z",
        postDecisionProbeAt: "2026-11-12T00:00:05Z",
      });
      restart.before.observedAt = "2026-11-12T00:00:06Z";
      restart.startedAt = "2026-11-12T00:00:07Z";
      restart.readyAt = "2026-11-12T00:00:08Z";
      restart.after.observedAt = "2026-11-12T00:00:09Z";

      const result = evaluateAutonomousEvidence(record);
      expect(result.completeRecord).toBe(false);
      expect(result.scenarios.restart).toBe("failed");
      expect(result.missing).toContain(
        "restart: initial event-response messages precede the pre-restart snapshot",
      );
    },
  );

  it("reports tools and receipt separately when receiver 2xx has no observed host run", () => {
    const record = realHostShapedFixture();
    for (const item of record.turns) {
      item.idle = null;
      item.run = null;
      item.read = null;
      item.reply = null;
    }
    const result = evaluateAutonomousEvidence(record);
    expect(result.layers.tools).toBe("passed");
    expect(result.layers.notificationReceipt).toBe("passed");
    expect(result.layers.autonomousReply).toBe("blocked");
    expect(result.completeRecord).toBe(false);
  });

  it("does not certify unsupported run observation from previously verified tools", () => {
    const record = realHostShapedFixture();
    record.participants[1].host.runObservation = "unsupported";
    const result = evaluateAutonomousEvidence(record);
    expect(result.layers.tools).toBe("passed");
    expect(result.layers.notificationReceipt).toBe("passed");
    expect(result.layers.autonomousReply).toBe("blocked");
    expect(result.completeRecord).toBe(false);
  });

  const mutations: [string, (record: AutonomousEvidence) => void][] = [
    [
      "one owner operating both accounts",
      (r) => {
        r.participants[1].ownerRef = r.participants[0].ownerRef;
      },
    ],
    [
      "one grant relabeled as a second participant",
      (r) => {
        r.participants[1].connectionId = r.participants[0].connectionId;
      },
    ],
    [
      "missing independent owner consent",
      (r) => {
        r.participants[1].consent.observationRef = null;
      },
    ],
    [
      "unapproved synthetic disclosure scope",
      (r) => {
        r.participants[1].consent.syntheticOnly = false;
      },
    ],
    [
      "SDK-only replacement",
      (r) => {
        r.participants[1].host.origin = "sdk-only";
      },
    ],
    [
      "unisolated deployment",
      (r) => {
        r.deployment.isolated = false;
      },
    ],
    [
      "public support advertisement during private verification",
      (r) => {
        r.deployment.publicAdvertisement = true;
      },
    ],
    [
      "missing deployed build configuration",
      (r) => {
        r.deployment.configSha256 = null;
      },
    ],
    [
      "another subscription",
      (r) => {
        r.turns[0].event.subscriptionId = "unrelated-subscription";
      },
    ],
    [
      "another event",
      (r) => {
        r.turns[0].deliveries[0].eventId = "unrelated-event-0001";
      },
    ],
    [
      "another committed message",
      (r) => {
        r.turns[0].event.messageId = "unrelated-message-0001";
      },
    ],
    [
      "manual continuation",
      (r) => {
        if (r.turns[0].run) r.turns[0].run.trigger = "manual";
      },
    ],
    [
      "scheduled polling",
      (r) => {
        if (r.turns[0].run) r.turns[0].run.trigger = "polling";
      },
    ],
    [
      "scripted host replacement",
      (r) => {
        if (r.turns[0].run) r.turns[0].run.trigger = "scripted";
      },
    ],
    [
      "model claim replacing host audit",
      (r) => {
        const observation = r.observations.find(
          (item) => item.id === r.turns[0].run?.observationRef,
        );
        if (observation) observation.source = "host-tool";
      },
    ],
    [
      "already active target",
      (r) => {
        if (r.turns[0].idle) r.turns[0].idle.activeRuns = 1;
      },
    ],
    [
      "run before event dispatch",
      (r) => {
        if (r.turns[0].run) r.turns[0].run.startedAt = "2026-11-12T00:00:00Z";
      },
    ],
    [
      "read in unrelated run",
      (r) => {
        if (r.turns[0].read) r.turns[0].read.runId = "unrelated-run-0001";
      },
    ],
    [
      "read using another connection",
      (r) => {
        if (r.turns[0].read)
          r.turns[0].read.connectionId = r.participants[0]
            .connectionId as string;
      },
    ],
    [
      "read before triggering message",
      (r) => {
        if (r.turns[0].read) r.turns[0].read.throughSeq = 0;
      },
    ],
    [
      "empty read at a snapshot upper bound containing the trigger",
      (r) => {
        if (r.turns[0].read) r.turns[0].read.observedMessageIds = [];
      },
    ],
    [
      "read returning only unrelated messages",
      (r) => {
        if (r.turns[0].read)
          r.turns[0].read.observedMessageIds = ["unrelated-message-0001"];
      },
    ],
    [
      "read cursor skipping the triggering message",
      (r) => {
        if (r.turns[0].read) r.turns[0].read.afterSeq = r.turns[0].post.seq;
      },
    ],
    [
      "reply to unrelated message",
      (r) => {
        if (r.turns[0].reply)
          r.turns[0].reply.replyToMessageId = "unrelated-message-0001";
      },
    ],
    [
      "reply using sender membership",
      (r) => {
        if (r.turns[0].reply)
          r.turns[0].reply.senderMembershipId = r.participants[0]
            .membershipId as string;
      },
    ],
    [
      "disconnected return turn",
      (r) => {
        r.turns[1].post.messageId = "disconnected-message-0001";
        r.turns[1].event.messageId = r.turns[1].post.messageId;
        if (r.turns[1].reply)
          r.turns[1].reply.replyToMessageId = r.turns[1].post.messageId;
      },
    ],
    [
      "new mutation key on retry",
      (r) => {
        if (r.retry) r.retry.retryMutationKeySha256 = "9".repeat(64);
      },
    ],
    [
      "changed payload on retry",
      (r) => {
        if (r.retry) r.retry.retryPayloadSha256 = "9".repeat(64);
      },
    ],
    [
      "extra accepted retry message",
      (r) => {
        if (r.retry) r.retry.afterCount += 1;
      },
    ],
    [
      "new retry receipt identity",
      (r) => {
        if (r.retry) r.retry.retryMessageId = "unrelated-message-0001";
      },
    ],
    [
      "unreported duplicate acceptance",
      (r) => {
        if (r.duplicateDelivery)
          r.duplicateDelivery.acceptedAttemptIds.push(
            "unobserved-attempt-0001",
          );
      },
    ],
    [
      "invented exactly-once duplicate behavior",
      (r) => {
        if (r.duplicateDelivery)
          r.duplicateDelivery.behavior = "no-additional-run";
      },
    ],
    [
      "post-terminal delivery authorization",
      (r) => {
        if (r.cancellation)
          r.cancellation.attempts[0].authorizedAt = "2026-11-12T00:00:51Z";
      },
    ],
    [
      "cancellation without pending work",
      (r) => {
        if (r.cancellation) r.cancellation.pendingAt = "2026-11-12T00:01:00Z";
      },
    ],
    [
      "truncated post-terminal coverage",
      (r) => {
        if (r.cancellation)
          r.cancellation.coverageThrough = "2026-11-12T00:00:49Z";
      },
    ],
    [
      "fresh-storage replacement",
      (r) => {
        if (r.restart) r.restart.mode = "fresh-storage";
      },
    ],
    [
      "retry budget reset",
      (r) => {
        if (r.restart) r.restart.after.retryStateSha256 = "9".repeat(64);
      },
    ],
    [
      "replacement active subscription",
      (r) => {
        if (r.restart)
          r.restart.after.subscriptionIds[0] = "replacement-subscription";
      },
    ],
    [
      "replacement table after restart",
      (r) => {
        if (r.restart) r.restart.tableId = "replacement-table-0001";
      },
    ],
    [
      "terminal dispatch resurrection",
      (r) => {
        if (r.restart) r.restart.terminalDispatchCount = 1;
      },
    ],
    [
      "missing fresh real-host resumed turn",
      (r) => {
        r.turns = r.turns.filter((item) => item.scenario !== "restart");
      },
    ],
    [
      "third guest transcript leak",
      (r) => {
        r.isolation[1].privateDataReturned = true;
      },
    ],
    [
      "third guest modifying subscription",
      (r) => {
        r.isolation[3].subscriptionChanged = true;
      },
    ],
    [
      "missing other owner's unsubscribe denial",
      (r) => {
        r.isolation.pop();
      },
    ],
    [
      "member reused as unaffiliated guest",
      (r) => {
        r.isolation[0].outsiderGuestId = r.participants[0].guestId as string;
      },
    ],
    [
      "unapproved content crossing relay",
      (r) => {
        if (r.disclosure) r.disclosure.postedPayloadsSha256 = "9".repeat(64);
      },
    ],
    [
      "missing named external receipt",
      (r) => {
        r.observations.pop();
      },
    ],
    [
      "missing same-run host reply tool receipt",
      (r) => {
        r.observations = r.observations.filter(
          (item) => item.id !== r.turns[0].reply?.hostObservationRef,
        );
      },
    ],
    [
      "missing actual initiating agent post tool receipt",
      (r) => {
        r.observations = r.observations.filter(
          (item) => item.id !== r.turns[0].post.hostObservationRef,
        );
      },
    ],
    [
      "server receipt substituted for host reply tool trace",
      (r) => {
        const observation = r.observations.find(
          (item) => item.id === r.turns[0].reply?.hostObservationRef,
        );
        if (observation) observation.source = "server";
      },
    ],
    [
      "host reply tool trace predating committed reply",
      (r) => {
        const observation = r.observations.find(
          (item) => item.id === r.turns[0].reply?.hostObservationRef,
        );
        if (observation) observation.capturedAt = "2026-11-12T00:00:15Z";
      },
    ],
    [
      "duplicate receipt identifier",
      (r) => {
        r.observations.push({ ...r.observations[0] });
      },
    ],
    [
      "ambiguous undisclosed build",
      (r) => {
        r.participants[0].host.exposedBuild = "not-exposed-unspecified";
      },
    ],
    [
      "idle observed only after the triggering post",
      (r) => {
        if (r.turns[0].idle)
          r.turns[0].idle.observedAt = "2026-11-12T00:00:11Z";
      },
    ],
    [
      "report predating its evidence",
      (r) => {
        r.observedAt = "2026-11-12T00:00:01Z";
      },
    ],
    [
      "host run receipt captured before the run",
      (r) => {
        const observation = r.observations.find(
          (item) => item.id === r.turns[0].run?.observationRef,
        );
        if (observation) observation.capturedAt = "2026-11-12T00:00:01Z";
      },
    ],
    [
      "unrelated cancellation ledger event",
      (r) => {
        if (r.cancellation)
          r.cancellation.attempts[0].eventId = "unrelated-event-0001";
      },
    ],
    [
      "exceeded independently approved reply bound",
      (r) => {
        r.participants[1].consent.maxReplies = 1;
      },
    ],
    [
      "reused event across resumed host turns",
      (r) => {
        r.turns[2].event.eventId = r.turns[0].event.eventId;
        r.turns[2].deliveries[0].eventId = r.turns[0].event.eventId;
        if (r.turns[2].run)
          r.turns[2].run.triggeringEventId = r.turns[0].event.eventId;
        if (r.turns[2].read) r.turns[2].read.eventId = r.turns[0].event.eventId;
      },
    ],
    [
      "reused host run after restart",
      (r) => {
        if (
          r.turns[2].run &&
          r.turns[2].read &&
          r.turns[2].reply &&
          r.turns[0].run
        ) {
          r.turns[2].run.runId = r.turns[0].run.runId;
          r.turns[2].read.runId = r.turns[0].run.runId;
          r.turns[2].reply.runId = r.turns[0].run.runId;
        }
      },
    ],
    [
      "reused delivery attempt after restart",
      (r) => {
        r.turns[2].deliveries[0].attemptId = r.turns[0].deliveries[0].attemptId;
        if (r.turns[2].run)
          r.turns[2].run.deliveryAttemptId = r.turns[0].deliveries[0].attemptId;
      },
    ],
    [
      "same accepted message relabeled as fresh after restart",
      (r) => {
        r.turns[2].post.messageId = r.turns[0].post.messageId;
        r.turns[2].event.messageId = r.turns[0].post.messageId;
        if (r.turns[2].reply)
          r.turns[2].reply.replyToMessageId = r.turns[0].post.messageId;
      },
    ],
    [
      "prior sequence committed only after the restarted peer post",
      (r) => {
        if (r.turns[1].reply)
          r.turns[1].reply.committedAt = "2026-11-12T00:03:20Z";
        if (r.retry) {
          r.retry.beforeCount = 2;
          r.retry.afterCount = 2;
        }
      },
    ],
    [
      "same sender mutation key reused for new post",
      (r) => {
        r.turns[2].post.mutationKeySha256 = r.turns[0].post.mutationKeySha256;
      },
    ],
    [
      "second unvalidated restart turn",
      (r) => {
        r.turns.push({ ...r.turns[2], id: "extra-restart-turn-0001" });
      },
    ],
  ];
  it.each(mutations)("rejects %s", (_name, mutate) => {
    const record = realHostShapedFixture();
    mutate(record);
    const result = evaluateAutonomousEvidence(record);
    expect(result.completeRecord).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("separates pre-decision dispatched traffic from forbidden new authorization", () => {
    const record = realHostShapedFixture();
    expect(record.cancellation?.attempts[0].completedAt).toBe(
      "2026-11-12T00:00:55.000Z",
    );
    expect(evaluateAutonomousEvidence(record).scenarios.cancellation).toBe(
      "passed",
    );
  });

  it("distinguishes failed observed behavior from missing blocked observations", () => {
    const manual = realHostShapedFixture();
    if (manual.turns[0].run) manual.turns[0].run.trigger = "manual";
    expect(evaluateAutonomousEvidence(manual).scenarios.eventResponse).toBe(
      "failed",
    );
    const missing = realHostShapedFixture();
    missing.turns[0].run = null;
    expect(evaluateAutonomousEvidence(missing).scenarios.eventResponse).toBe(
      "blocked",
    );
    const leaked = realHostShapedFixture();
    leaked.isolation[0].outcome = "allowed";
    expect(evaluateAutonomousEvidence(leaked).scenarios.isolation).toBe(
      "failed",
    );
  });

  it("records duplicated delivery with additional observed host runs honestly", () => {
    const record = realHostShapedFixture();
    const first = record.turns[0];
    first.deliveries.push({
      ...first.deliveries[0],
      attemptId: "duplicate-attempt-0002",
    });
    const duplicates = record.duplicateDelivery as NonNullable<
      typeof record.duplicateDelivery
    >;
    duplicates.acceptedAttemptIds.push("duplicate-attempt-0002");
    duplicates.observedRunIds.push("duplicate-host-run-0002");
    duplicates.acceptedReplyMessageIds.push("duplicate-reply-0002");
    duplicates.behavior = "additional-run";
    expect(evaluateAutonomousEvidence(record).scenarios.duplicateDelivery).toBe(
      "passed",
    );
  });

  it("rejects duplicate behavior asserted before the duplicate was accepted", () => {
    const record = realHostShapedFixture();
    const first = record.turns[0];
    first.deliveries.push({
      ...first.deliveries[0],
      attemptId: "late-duplicate-attempt",
      authorizedAt: "2026-11-12T00:03:18Z",
      dispatchedAt: "2026-11-12T00:03:19Z",
      acceptedAt: "2026-11-12T00:03:20Z",
    });
    const duplicates = record.duplicateDelivery as NonNullable<
      typeof record.duplicateDelivery
    >;
    duplicates.acceptedAttemptIds.push("late-duplicate-attempt");
    duplicates.behavior = "no-additional-run";
    const result = evaluateAutonomousEvidence(record);
    expect(result.completeRecord).toBe(false);
    expect(result.scenarios.duplicateDelivery).toBe("failed");
    expect(result.missing).toContain(
      "duplicateDelivery: duplicate observation window covers every included receiver acceptance",
    );
  });

  it("rejects secret-bearing unknown keys without echoing keys, values or URLs", () => {
    const sentinel = "SECRET_DO_NOT_ECHO_123456789";
    const input = {
      ...syntheticFixture(),
      [sentinel]: `https://private.example/${sentinel}`,
    };
    const result = evaluateAutonomousEvidence(input);
    expect(result.structurallyValid).toBe(false);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    const nested = syntheticFixture();
    Object.assign(nested.turns[0].deliveries[0], {
      callbackUrl: `https://private.example/${sentinel}`,
    });
    expect(evaluateAutonomousEvidence(nested).structurallyValid).toBe(false);
  });
});

describe("explicit A-only autonomous acceptance", () => {
  it("selects modes explicitly in both unrun templates", () => {
    expect(template.acceptanceMode).toBe("bidirectional");
    expect(selectedChatPair.acceptanceMode).toBe("a-only");
    expect(selectedChatPair.participants[0].host.product).toBe(
      "OpenAI ChatGPT",
    );
    expect(selectedChatPair.participants[1].host.product).toBe("Claude Chat");
    expect(evaluateAutonomousEvidence(selectedChatPair).acceptanceMode).toBe(
      "a-only",
    );
    expect(evaluateAutonomousEvidence(selectedChatPair).completeRecord).toBe(
      false,
    );
  });

  it("accepts A event responses while B has tools-only manual source capability", () => {
    // Invented metadata exercises the positive branch, not actual host evidence.
    const record = realHostShapedFixture("a-only");
    expect(record.participants[1].host.runObservation).toBe("unsupported");
    expect(record.participants[1].subscriptionId).toBeNull();
    expect(record.participants[1].subscription.activeAt).toBeNull();
    expect(record.turns).toHaveLength(2);
    for (const turn of record.turns) {
      expect(turn.sender).toBe("B");
      expect(turn.recipient).toBe("A");
      expect(turn.run?.trigger).toBe("peer-event");
    }
    const result = evaluateAutonomousEvidence(record);
    expect(result.missing).toEqual([]);
    expect(result.completeRecord).toBe(true);
    expect(result.acceptanceMode).toBe("a-only");
    expect(result.scenarios.eventResponse).toBe("passed");
    expect(result.scenarios).not.toHaveProperty("roundTrip");
    expect(result.layers).toEqual({
      tools: "passed",
      notificationReceipt: "passed",
      autonomousReply: "passed",
    });
  });

  it("never presents an A-only synthetic fixture as actual compatibility", () => {
    const result = evaluateAutonomousEvidence(syntheticFixture("a-only"));
    expect(result.acceptanceMode).toBe("a-only");
    expect(result.completeRecord).toBe(false);
    expect(result.layers.autonomousReply).toBe("blocked");
  });

  it("rejects a missing mode rather than silently falling back", () => {
    const record = realHostShapedFixture("a-only");
    Reflect.deleteProperty(record, "acceptanceMode");
    const result = evaluateAutonomousEvidence(record);
    expect(result.structurallyValid).toBe(false);
    expect(result.acceptanceMode).toBeNull();
    expect(result.completeRecord).toBe(false);
  });

  it("cannot promote A-only evidence to bidirectional acceptance", () => {
    const record = realHostShapedFixture("a-only");
    record.acceptanceMode = "bidirectional";
    const result = evaluateAutonomousEvidence(record);
    expect(result.acceptanceMode).toBe("bidirectional");
    expect(result.completeRecord).toBe(false);
    expect(result.scenarios.eventResponse).not.toBe("passed");
    expect(result.scenarios.restart).not.toBe("passed");
  });

  const mutations: [string, (record: AutonomousEvidence) => void][] = [
    [
      "A manually woken for the primary response",
      (r) => {
        if (r.turns[0].run) r.turns[0].run.trigger = "manual";
      },
    ],
    [
      "A manually woken after restart",
      (r) => {
        if (r.turns[1].run) r.turns[1].run.trigger = "manual";
      },
    ],
    [
      "primary response in the wrong direction",
      (r) => {
        r.turns[0].sender = "A";
        r.turns[0].recipient = "B";
      },
    ],
    [
      "restart response in the wrong direction",
      (r) => {
        r.turns[1].sender = "A";
        r.turns[1].recipient = "B";
      },
    ],
    [
      "a second primary response disguised as A-only",
      (r) => {
        r.turns.push({ ...r.turns[0], id: "extra-response-0001" });
      },
    ],
    [
      "missing A active subscription",
      (r) => {
        r.participants[0].subscriptionId = null;
        r.participants[0].subscription = {
          tableId: null,
          activeAt: null,
          observationRef: null,
        };
      },
    ],
    [
      "unsupported A idle/run observation",
      (r) => {
        r.participants[0].host.runObservation = "unsupported";
      },
    ],
    [
      "missing retained-state restart",
      (r) => {
        r.restart = null;
      },
    ],
    [
      "missing post-restart A response",
      (r) => {
        r.turns = r.turns.filter((item) => item.scenario !== "restart");
      },
    ],
    [
      "another receiver subscription in restart snapshot",
      (r) => {
        if (r.restart)
          r.restart.after.subscriptionIds.push("unexpected-subscription");
      },
    ],
    [
      "replacement A subscription after restart",
      (r) => {
        if (r.restart)
          r.restart.after.subscriptionIds[0] = "replacement-subscription";
      },
    ],
    [
      "cancellation targeting B",
      (r) => {
        if (r.cancellation) {
          r.cancellation.recipient = "B";
          r.cancellation.recipientGuestId = r.participants[1].guestId as string;
        }
      },
    ],
    [
      "A cancellation labeled with B guest identity",
      (r) => {
        if (r.cancellation)
          r.cancellation.recipientGuestId = r.participants[1].guestId as string;
      },
    ],
    [
      "unverified B source host account",
      (r) => {
        r.participants[1].host.eligibility = "unknown";
      },
    ],
    [
      "SDK replacement for the B source host",
      (r) => {
        r.participants[1].host.origin = "sdk-only";
      },
    ],
    [
      "missing B OAuth/tool receipt",
      (r) => {
        r.participants[1].oauthEvidenceRef = null;
      },
    ],
    [
      "missing independent B bounded consent",
      (r) => {
        r.participants[1].consent.observationRef = null;
      },
    ],
    [
      "B consent only after its first post",
      (r) => {
        r.participants[1].consent.approvedAt = "2026-11-12T00:00:11Z";
      },
    ],
    [
      "missing actual B source-post tool receipt",
      (r) => {
        r.observations = r.observations.filter(
          (item) => item.id !== r.turns[0].post.hostObservationRef,
        );
      },
    ],
    [
      "missing private transcript denial for B membership",
      (r) => {
        r.isolation = r.isolation.filter(
          (item) =>
            !(
              item.action === "transcript" &&
              item.targetMembershipId === r.participants[1].membershipId
            ),
        );
      },
    ],
    [
      "missing A subscription-maintenance denial",
      (r) => {
        r.isolation = r.isolation.filter(
          (item) => item.action !== "unsubscribe",
        );
      },
    ],
    [
      "A exceeding its independently approved reply bound",
      (r) => {
        r.participants[0].consent.maxReplies = 1;
      },
    ],
  ];
  it.each(mutations)("rejects %s", (_name, mutate) => {
    const record = realHostShapedFixture("a-only");
    mutate(record);
    const result = evaluateAutonomousEvidence(record);
    expect(result.completeRecord).toBe(false);
    expect(result.acceptanceMode).toBe("a-only");
    expect(result.missing.length).toBeGreaterThan(0);
  });
});

describe("explicit same-owner A-only acceptance", () => {
  it("accepts one owner with distinct host accounts without claiming cross-owner proof", () => {
    const r = realHostShapedFixture("a-only");
    r.ownershipMode = "same-owner";
    r.participants[1].ownerRef = r.participants[0].ownerRef;
    const result = evaluateAutonomousEvidence(r);
    expect(result.completeRecord).toBe(true);
    expect(result.ownershipMode).toBe("same-owner");
  });
  it("keeps omitted ownership mode strict", () => {
    const r = realHostShapedFixture("a-only");
    r.participants[1].ownerRef = r.participants[0].ownerRef;
    expect(evaluateAutonomousEvidence(r).completeRecord).toBe(false);
  });
  it("rejects different owners labeled same-owner", () => {
    const r = realHostShapedFixture("a-only");
    r.ownershipMode = "same-owner";
    expect(evaluateAutonomousEvidence(r).completeRecord).toBe(false);
  });
  it("does not extend the ownership exception to bidirectional mode", () => {
    const r = realHostShapedFixture();
    r.ownershipMode = "same-owner";
    r.participants[1].ownerRef = r.participants[0].ownerRef;
    expect(evaluateAutonomousEvidence(r).completeRecord).toBe(false);
  });
  for (const key of [
    "accountRef",
    "guestId",
    "connectionId",
    "membershipId",
  ] as const)
    it(`still requires distinct ${key}`, () => {
      const r = realHostShapedFixture("a-only");
      r.ownershipMode = "same-owner";
      r.participants[1].ownerRef = r.participants[0].ownerRef;
      r.participants[1][key] = r.participants[0][key];
      expect(evaluateAutonomousEvidence(r).completeRecord).toBe(false);
    });
  it("still requires separately captured host consent", () => {
    const r = realHostShapedFixture("a-only");
    r.ownershipMode = "same-owner";
    r.participants[1].ownerRef = r.participants[0].ownerRef;
    r.participants[1].consent.observationRef =
      r.participants[0].consent.observationRef;
    expect(evaluateAutonomousEvidence(r).completeRecord).toBe(false);
  });
});
