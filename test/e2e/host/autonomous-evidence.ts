import { z } from "zod";

// Only redacted identifiers and metadata belong here. Receipts are retained
// separately; neither a well-formed record nor its digest authenticates them.
const ref = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/)
  .refine((value) => !value.includes(".."));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const buildSha = z.string().regex(/^[a-f0-9]{40}$/);
const time = z.string().datetime({ offset: true });
const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}$/);
const role = z.enum(["A", "B"]);

export const autonomousObservationSchema = z.strictObject({
  id: ref,
  source: z.enum([
    "owner-consent",
    "host-audit",
    "host-tool",
    "server",
    "operator",
    "browser",
  ]),
  capturedAt: time,
  sha256: digest,
});

const participant = z.strictObject({
  role,
  ownerRef: ref.nullable(),
  accountRef: ref.nullable(),
  workspaceRef: ref.nullable(),
  guestId: ref.nullable(),
  connectionId: ref.nullable(),
  membershipId: ref.nullable(),
  subscriptionId: ref.nullable(),
  host: z.strictObject({
    product: label,
    surface: label,
    exposedBuild: label,
    eligibility: z.enum(["unknown", "eligible", "ineligible"]),
    origin: z.enum(["not-tested", "actual-host", "sdk-only", "simulated"]),
    runObservation: z.enum(["unsupported", "host-ui", "provider-audit"]),
  }),
  oauthEvidenceRef: ref.nullable(),
  subscription: z.strictObject({
    tableId: ref.nullable(),
    activeAt: time.nullable(),
    observationRef: ref.nullable(),
  }),
  consent: z.strictObject({
    approvedAt: time.nullable(),
    observationRef: ref.nullable(),
    instructionsSha256: digest.nullable(),
    maxReplies: z.number().int().min(1).max(12).nullable(),
    syntheticOnly: z.boolean().nullable(),
    readBeforeReply: z.boolean().nullable(),
    reuseMutationKey: z.boolean().nullable(),
    stopOnTerminal: z.boolean().nullable(),
    suppressAcknowledgmentLoops: z.boolean().nullable(),
    askBeforeOutOfScope: z.boolean().nullable(),
  }),
});

const committedMessage = z.strictObject({
  tableId: ref,
  messageId: ref,
  seq: z.number().int().positive(),
  senderMembershipId: ref,
  committedAt: time,
  mutationKeySha256: digest,
  observationRef: ref,
  hostObservationRef: ref,
});
const delivery = z.strictObject({
  attemptId: ref,
  eventId: ref,
  subscriptionId: ref,
  authorizedAt: time,
  dispatchedAt: time,
  acceptedAt: time.nullable(),
  statusCode: z.number().int().min(100).max(599).nullable(),
  observationRef: ref,
});
const turn = z.strictObject({
  id: ref,
  scenario: z.enum(["event-response", "restart"]),
  sender: role,
  recipient: role,
  post: committedMessage,
  event: z.strictObject({
    tableId: ref,
    eventId: ref,
    messageId: ref,
    messageSeq: z.number().int().positive(),
    senderMembershipId: ref,
    recipientMembershipId: ref,
    subscriptionId: ref,
    committedAt: time,
    observationRef: ref,
  }),
  deliveries: z.array(delivery).max(20),
  idle: z
    .strictObject({
      observedAt: time,
      activeRuns: z.number().int().nonnegative(),
      observationRef: ref,
    })
    .nullable(),
  run: z
    .strictObject({
      runId: ref,
      triggeringEventId: ref,
      deliveryAttemptId: ref,
      trigger: z.enum([
        "peer-event",
        "manual",
        "polling",
        "scripted",
        "unknown",
      ]),
      startedAt: time,
      observationRef: ref,
    })
    .nullable(),
  read: z
    .strictObject({
      runId: ref,
      eventId: ref,
      tableId: ref,
      membershipId: ref,
      connectionId: ref,
      afterSeq: z.number().int().nonnegative(),
      throughSeq: z.number().int().nonnegative(),
      observedMessageIds: z.array(ref).max(200),
      readAt: time,
      hostObservationRef: ref,
      serverObservationRef: ref,
    })
    .nullable(),
  reply: committedMessage
    .extend({
      runId: ref,
      replyToMessageId: ref,
    })
    .nullable(),
});

const snapshot = z.strictObject({
  storageIdentity: ref,
  buildSha,
  configSha256: digest,
  retryStateSha256: digest,
  subscriptionIds: z.array(ref).min(1).max(2),
  observedAt: time,
  observationRef: ref,
});
const cancellationAttempt = z.strictObject({
  attemptId: ref,
  eventId: ref,
  authorizedAt: time,
  dispatchedAt: time.nullable(),
  completedAt: time.nullable(),
});

export const autonomousEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  acceptanceMode: z.enum(["a-only", "bidirectional"]),
  pilotId: ref,
  evidenceKind: z.enum(["not-run", "real-host", "synthetic-validator"]),
  observedAt: time.nullable(),
  tableId: ref.nullable(),
  deployment: z.strictObject({
    buildSha: buildSha.nullable(),
    configSha256: digest.nullable(),
    endpointRef: ref.nullable(),
    approvalRef: ref.nullable(),
    configurationRef: ref.nullable(),
    isolated: z.boolean().nullable(),
    publicAdvertisement: z.boolean().nullable(),
    protocol: label.nullable(),
    profile: label.nullable(),
  }),
  participants: z.tuple([participant, participant]),
  turns: z.array(turn).max(12),
  retry: z
    .strictObject({
      turnId: ref,
      originalMutationKeySha256: digest,
      retryMutationKeySha256: digest,
      originalPayloadSha256: digest,
      retryPayloadSha256: digest,
      originalMessageId: ref,
      retryMessageId: ref,
      originalSeq: z.number().int().positive(),
      retrySeq: z.number().int().positive(),
      beforeCount: z.number().int().positive(),
      afterCount: z.number().int().positive(),
      retriedAt: time,
      observationRef: ref,
    })
    .nullable(),
  duplicateDelivery: z
    .strictObject({
      turnId: ref,
      eventId: ref,
      acceptedAttemptIds: z.array(ref).min(1).max(20),
      observedRunIds: z.array(ref).min(1).max(20),
      acceptedReplyMessageIds: z.array(ref).min(1).max(20),
      behavior: z.enum(["not-observed", "no-additional-run", "additional-run"]),
      through: time,
      hostObservationRef: ref,
      serverObservationRef: ref,
    })
    .nullable(),
  cancellation: z
    .strictObject({
      tableId: ref,
      recipient: role,
      recipientGuestId: ref,
      action: z.enum(["close", "unsubscribe"]),
      subscriptionId: ref,
      pendingEventId: ref,
      pendingAt: time,
      decisionAt: time,
      observationRef: ref,
      attempts: z.array(cancellationAttempt).max(20),
      coverageFrom: time,
      coverageThrough: time,
      coverageObservationRef: ref,
      postDecisionProbeAt: time,
      refusalObservationRef: ref,
    })
    .nullable(),
  restart: z
    .strictObject({
      mode: z.enum(["retained-storage", "fresh-storage", "unknown"]),
      tableId: ref,
      startedAt: time,
      readyAt: time,
      operationRef: ref,
      before: snapshot,
      after: snapshot,
      newTurnId: ref,
      terminalTableId: ref,
      terminalSubscriptionId: ref,
      terminalStateBefore: z.enum([
        "closed",
        "deleted",
        "expired",
        "unsubscribed",
      ]),
      terminalStateAfter: z.enum([
        "closed",
        "deleted",
        "expired",
        "unsubscribed",
      ]),
      terminalCheckAt: time,
      terminalDispatchCount: z.number().int().nonnegative(),
      terminalObservationRef: ref,
    })
    .nullable(),
  isolation: z
    .array(
      z.strictObject({
        action: z.enum([
          "metadata",
          "transcript",
          "inbox",
          "renew-subscription",
          "unsubscribe",
        ]),
        outsiderGuestId: ref,
        outsiderConnectionId: ref,
        tableId: ref,
        targetMembershipId: ref,
        targetSubscriptionId: ref.nullable(),
        observedAt: time,
        outcome: z.enum(["denied", "allowed", "unknown"]),
        privateDataReturned: z.boolean(),
        subscriptionChanged: z.boolean(),
        clientObservationRef: ref,
        serverObservationRef: ref,
      }),
    )
    .max(20),
  disclosure: z
    .strictObject({
      syntheticPayloadsSha256: digest,
      postedPayloadsSha256: digest,
      scope: z.enum(["synthetic-only", "unknown", "other-content"]),
      ownerReviewRefs: z.tuple([ref, ref]),
      transcriptObservationRef: ref,
    })
    .nullable(),
  observations: z.array(autonomousObservationSchema).max(250),
});

export type AutonomousEvidence = z.infer<typeof autonomousEvidenceSchema>;
export type AutonomousObservation = z.infer<typeof autonomousObservationSchema>;
export type EvidenceStatus = "not-run" | "blocked" | "failed" | "passed";
export const AUTONOMOUS_SCENARIOS = [
  "setup",
  "eventResponse",
  "exactRetry",
  "duplicateDelivery",
  "cancellation",
  "restart",
  "isolation",
  "disclosure",
] as const;
type Scenario = (typeof AUTONOMOUS_SCENARIOS)[number];
export interface AutonomousEvidenceResult {
  acceptanceMode: AutonomousEvidence["acceptanceMode"] | null;
  structurallyValid: boolean;
  completeRecord: boolean;
  missing: string[];
  layers: {
    tools: EvidenceStatus;
    notificationReceipt: EvidenceStatus;
    autonomousReply: EvidenceStatus;
  };
  scenarios: Record<Scenario, EvidenceStatus>;
}

const milliseconds = (value: string | null) =>
  value === null ? Number.NaN : Date.parse(value);
const isKnown = (value: string) =>
  !/^(unknown|unavailable|not.selected|not.available|not.exposed)$/i.test(
    value,
  );
const knownBuild = (value: string) =>
  value === "not-exposed-in-tested-host" ||
  (isKnown(value) &&
    !/^(unknown|unavailable|not.exposed|not.available)/i.test(value));
const unique = (values: unknown[]) => new Set(values).size === values.length;

/**
 * Check completeness and causal joins in redacted observations, not their
 * authenticity. The CLI separately verifies local receipt digests. A reviewer
 * must still inspect independently captured owner, host and server evidence.
 */
export function evaluateAutonomousEvidence(
  input: unknown,
): AutonomousEvidenceResult {
  const parsed = autonomousEvidenceSchema.safeParse(input);
  const scenarios = Object.fromEntries(
    AUTONOMOUS_SCENARIOS.map((name) => [name, "not-run"]),
  ) as Record<Scenario, EvidenceStatus>;
  const layers: AutonomousEvidenceResult["layers"] = {
    tools: "not-run",
    notificationReceipt: "not-run",
    autonomousReply: "not-run",
  };
  if (!parsed.success) {
    // Even unknown field names can contain secrets; never echo schema input.
    return {
      acceptanceMode: null,
      structurallyValid: false,
      completeRecord: false,
      missing: [
        "Invalid autonomous evidence schema; inspect the input locally.",
      ],
      layers,
      scenarios,
    };
  }

  const record = parsed.data;
  const missing: string[] = [];
  const issues = new Map<Scenario, string[]>();
  const failed = new Set<Scenario>();
  const observations = new Map(
    record.observations.map((item) => [item.id, item]),
  );
  const check = (
    scenario: Scenario,
    condition: unknown,
    detail: string,
    observedFailure = false,
  ) => {
    if (condition) return true;
    const message = `${scenario}: ${detail}`;
    missing.push(message);
    issues.set(scenario, [...(issues.get(scenario) ?? []), message]);
    if (observedFailure) failed.add(scenario);
    return false;
  };
  const receipt = (
    scenario: Scenario,
    id: string | null,
    source: AutonomousObservation["source"],
    detail: string,
    occurredAt?: string | null,
  ) => {
    const observation = id === null ? undefined : observations.get(id);
    const valid = check(scenario, observation?.source === source, detail);
    if (observation && occurredAt)
      check(
        scenario,
        milliseconds(observation.capturedAt) >= milliseconds(occurredAt),
        "receipt capture does not predate its observed fact",
        true,
      );
    return valid;
  };
  const finish = (scenario: Scenario, ran: boolean) => {
    scenarios[scenario] = !ran
      ? "not-run"
      : failed.has(scenario)
        ? "failed"
        : issues.has(scenario)
          ? "blocked"
          : "passed";
  };

  check(
    "setup",
    unique(record.observations.map((item) => item.id)),
    "unique receipt identifiers",
  );
  check(
    "setup",
    unique(record.turns.map((item) => item.id)),
    "unique turn identifiers",
  );
  check("setup", record.observedAt !== null, "dated pilot observation");
  // Schema validation already restricted timestamp fields and unknown keys.
  const observedTimes: number[] = [];
  const collectTimes = (value: unknown, key = "") => {
    if (
      typeof value === "string" &&
      /(?:At|From|Through|^through)$/.test(key)
    ) {
      observedTimes.push(milliseconds(value));
    } else if (Array.isArray(value)) {
      for (const entry of value) collectTimes(entry);
    } else if (value !== null && typeof value === "object") {
      for (const [name, entry] of Object.entries(value))
        collectTimes(entry, name);
    }
  };
  collectTimes(record);
  check(
    "setup",
    record.observedAt &&
      observedTimes.every((value) => value <= milliseconds(record.observedAt)),
    "report date covers all fact and receipt capture timestamps",
    record.observedAt !== null,
  );
  check("setup", record.tableId !== null, "one primary private table");
  const deployment = record.deployment;
  check(
    "setup",
    deployment.buildSha && deployment.configSha256 && deployment.endpointRef,
    "pinned deployment build, configuration and endpoint reference",
  );
  check(
    "setup",
    deployment.isolated === true && deployment.publicAdvertisement === false,
    "approved isolated deployment without public support advertisement",
  );
  check(
    "setup",
    deployment.protocol &&
      deployment.profile &&
      isKnown(deployment.protocol) &&
      isKnown(deployment.profile),
    "exact tested protocol and notification profile",
  );
  receipt(
    "setup",
    deployment.approvalRef,
    "operator",
    "isolated deployment approval receipt",
  );
  receipt(
    "setup",
    deployment.configurationRef,
    "operator",
    "deployed build/configuration receipt",
  );
  const [a, b] = record.participants;
  const requiredReceivers = record.acceptanceMode === "a-only" ? [a] : [a, b];
  const expectedResponseTurns = record.acceptanceMode === "a-only" ? 1 : 2;
  check(
    "setup",
    a.role === "A" && b.role === "B",
    "ordered A and B participant records",
  );
  for (const key of [
    "ownerRef",
    "accountRef",
    "guestId",
    "connectionId",
    "membershipId",
  ] as const) {
    check(
      "setup",
      a[key] && b[key] && a[key] !== b[key],
      `two independent participant ${key} values`,
    );
  }
  check(
    "setup",
    a.consent.observationRef !== b.consent.observationRef,
    "separate owner consent receipts",
  );
  check(
    "setup",
    requiredReceivers.every((person) => person.subscriptionId !== null) &&
      unique(requiredReceivers.map((person) => person.subscriptionId)),
    "distinct active subscriptions for the mode's required receivers",
  );
  for (const person of record.participants) {
    check(
      "setup",
      person.workspaceRef &&
        person.host.eligibility === "eligible" &&
        person.host.origin === "actual-host",
      "eligible actual-host account/workspace for each owner",
    );
    check(
      "setup",
      isKnown(person.host.product) &&
        isKnown(person.host.surface) &&
        knownBuild(person.host.exposedBuild),
      "exact host identity or explicit not-exposed-in-tested-host build marker",
    );
    if (requiredReceivers.includes(person))
      check(
        "setup",
        person.host.runObservation !== "unsupported",
        "supported independent idle/run observation surface for each required receiver",
      );
    receipt(
      "setup",
      person.oauthEvidenceRef,
      "host-tool",
      "actual-host guest OAuth/tool receipt for each participant",
    );
    const subscription = person.subscription;
    if (requiredReceivers.includes(person)) {
      check(
        "setup",
        subscription.tableId === record.tableId && subscription.activeAt,
        "active subscriptions on the same primary table",
      );
      receipt(
        "setup",
        subscription.observationRef,
        "server",
        "active subscription authority receipt for each participant",
        subscription.activeAt,
      );
    }
    const consent = person.consent;
    check(
      "setup",
      consent.approvedAt && consent.instructionsSha256 && consent.maxReplies,
      "separate dated bounded standing instructions",
    );
    receipt(
      "setup",
      consent.observationRef,
      "owner-consent",
      "independent owner approval of standing instructions",
      consent.approvedAt,
    );
    check(
      "setup",
      consent.syntheticOnly &&
        consent.readBeforeReply &&
        consent.reuseMutationKey &&
        consent.stopOnTerminal &&
        consent.suppressAcknowledgmentLoops &&
        consent.askBeforeOutOfScope,
      "synthetic disclosure, read/retry/stop/authority and acknowledgment bounds",
    );
    if (requiredReceivers.includes(person))
      check(
        "setup",
        milliseconds(consent.approvedAt) <= milliseconds(subscription.activeAt),
        "owner consent precedes active subscription",
      );
    const participantMessages = record.turns
      .flatMap((item) => [item.post, ...(item.reply ? [item.reply] : [])])
      .filter((message) => message.senderMembershipId === person.membershipId);
    check(
      "setup",
      consent.approvedAt !== null &&
        participantMessages.every(
          (message) =>
            milliseconds(consent.approvedAt) <=
            milliseconds(message.committedAt),
        ),
      "each owner's approval precedes their recorded posts and replies",
    );
  }
  check(
    "setup",
    unique(record.turns.map((item) => item.event.eventId)),
    "distinct committed event identifiers across all turns",
    true,
  );
  check(
    "setup",
    unique(record.turns.flatMap((item) => (item.run ? [item.run.runId] : []))),
    "distinct new host run identifiers across all turns",
    true,
  );
  check(
    "setup",
    unique(
      record.turns.flatMap((item) =>
        item.deliveries.map((entry) => entry.attemptId),
      ),
    ),
    "distinct dispatch attempt identifiers across all turns",
    true,
  );
  const messages = new Map<string, string>();
  const sequences = new Map<string, string>();
  const mutationKeys = new Map<string, string>();
  let immutableMessagesValid = true;
  for (const item of record.turns) {
    const scenario = item.scenario === "restart" ? "restart" : "eventResponse";
    for (const message of [item.post, ...(item.reply ? [item.reply] : [])]) {
      const immutable = JSON.stringify([
        message.tableId,
        message.seq,
        message.senderMembershipId,
        message.mutationKeySha256,
        message.committedAt,
      ]);
      if (
        messages.has(message.messageId) &&
        messages.get(message.messageId) !== immutable
      )
        immutableMessagesValid = false;
      check(
        scenario,
        !messages.has(message.messageId) ||
          messages.get(message.messageId) === immutable,
        "one immutable table/sequence/sender/key/time for each accepted message",
        true,
      );
      messages.set(message.messageId, immutable);
      const seqKey = `${message.tableId}:${message.seq}`;
      if (sequences.has(seqKey) && sequences.get(seqKey) !== message.messageId)
        immutableMessagesValid = false;
      check(
        scenario,
        !sequences.has(seqKey) || sequences.get(seqKey) === message.messageId,
        "one accepted message identity for each table sequence",
        true,
      );
      sequences.set(seqKey, message.messageId);
      const mutationKey = `${message.tableId}:${message.senderMembershipId}:${message.mutationKeySha256}`;
      if (
        mutationKeys.has(mutationKey) &&
        mutationKeys.get(mutationKey) !== message.messageId
      )
        immutableMessagesValid = false;
      check(
        scenario,
        !mutationKeys.has(mutationKey) ||
          mutationKeys.get(mutationKey) === message.messageId,
        "one accepted message per sender mutation key",
        true,
      );
      mutationKeys.set(mutationKey, message.messageId);
    }
  }
  for (const person of record.participants) {
    const replies = new Set(
      record.turns
        .filter((item) => item.recipient === person.role)
        .flatMap((item) => (item.reply ? [item.reply.messageId] : [])),
    );
    const duplicatedTurn = record.turns.find(
      (item) => item.id === record.duplicateDelivery?.turnId,
    );
    if (duplicatedTurn?.recipient === person.role) {
      for (const id of record.duplicateDelivery?.acceptedReplyMessageIds ?? [])
        replies.add(id);
    }
    check(
      "setup",
      person.consent.maxReplies !== null &&
        replies.size <= person.consent.maxReplies,
      "all observed replies including duplicates stay within each owner's approved bound",
      person.consent.maxReplies !== null,
    );
  }
  finish("setup", record.evidenceKind !== "not-run");

  const validateTurn = (
    item: AutonomousEvidence["turns"][number],
    scenario: Scenario,
  ) => {
    const start = missing.length;
    const sender = item.sender === "A" ? a : b;
    const recipient = item.recipient === "A" ? a : b;
    const { post, event } = item;
    check(
      scenario,
      requiredReceivers.includes(recipient),
      "event targets a receiver required by the explicit acceptance mode",
      true,
    );
    check(
      scenario,
      item.sender !== item.recipient,
      "peer membership rather than self-wakeup",
    );
    check(
      scenario,
      post.tableId === record.tableId && event.tableId === post.tableId,
      "committed post/event on the primary table",
    );
    check(
      scenario,
      post.senderMembershipId === sender.membershipId &&
        event.senderMembershipId === sender.membershipId &&
        event.recipientMembershipId === recipient.membershipId &&
        event.subscriptionId === recipient.subscriptionId,
      "event sender, recipient and active subscription association",
    );
    check(
      scenario,
      event.messageId === post.messageId &&
        event.messageSeq === post.seq &&
        milliseconds(event.committedAt) >= milliseconds(post.committedAt),
      "same committed event/message and ordered sequence",
    );
    check(
      scenario,
      requiredReceivers.every(
        (person) =>
          milliseconds(person.subscription.activeAt) <=
          milliseconds(post.committedAt),
      ),
      "required receiver subscriptions active before peer post",
    );
    receipt(
      scenario,
      post.observationRef,
      "server",
      "committed post receipt",
      post.committedAt,
    );
    receipt(
      scenario,
      post.hostObservationRef,
      "host-tool",
      "actual initiating agent post tool receipt with committed message result",
      post.committedAt,
    );
    receipt(
      scenario,
      event.observationRef,
      "server",
      "committed peer event receipt",
      event.committedAt,
    );
    check(
      scenario,
      unique(item.deliveries.map((entry) => entry.attemptId)),
      "unique delivery attempt identifiers",
    );
    const accepted = item.deliveries.filter(
      (entry) =>
        entry.statusCode !== null &&
        entry.statusCode >= 200 &&
        entry.statusCode < 300 &&
        entry.acceptedAt !== null,
    );
    check(
      scenario,
      accepted.length > 0,
      "observed successful receiver acceptance",
    );
    for (const attempt of item.deliveries) {
      check(
        scenario,
        attempt.eventId === event.eventId &&
          attempt.subscriptionId === event.subscriptionId,
        "delivery/event/subscription association",
      );
      check(
        scenario,
        milliseconds(attempt.authorizedAt) >= milliseconds(event.committedAt) &&
          milliseconds(attempt.dispatchedAt) >=
            milliseconds(attempt.authorizedAt) &&
          (attempt.acceptedAt === null ||
            milliseconds(attempt.acceptedAt) >=
              milliseconds(attempt.dispatchedAt)),
        "ordered delivery authorization, dispatch and response",
      );
      receipt(
        scenario,
        attempt.observationRef,
        "server",
        "safe server delivery observation",
        attempt.acceptedAt ?? attempt.dispatchedAt,
      );
    }
    const notificationValid = missing.length === start;
    const { idle, run, read, reply } = item;
    check(
      scenario,
      idle !== null && run !== null && read !== null && reply !== null,
      "independent idle, new run, authenticated read and committed reply observations",
    );
    if (!idle || !run || !read || !reply)
      return { notificationValid, autonomousValid: false };
    const initiatingAttempt = accepted.find(
      (entry) => entry.attemptId === run.deliveryAttemptId,
    );
    check(
      scenario,
      idle.activeRuns === 0 &&
        milliseconds(idle.observedAt) >=
          milliseconds(recipient.subscription.activeAt) &&
        initiatingAttempt &&
        milliseconds(idle.observedAt) <= milliseconds(post.committedAt),
      "recipient idle before the initiating post",
      true,
    );
    check(
      scenario,
      run.trigger === "peer-event" &&
        run.triggeringEventId === event.eventId &&
        initiatingAttempt &&
        milliseconds(run.startedAt) >=
          milliseconds(initiatingAttempt.dispatchedAt),
      "new host run caused by this peer event without human or polling substitute",
      true,
    );
    receipt(
      scenario,
      idle.observationRef,
      "host-audit",
      "supported host idle-state receipt",
      idle.observedAt,
    );
    receipt(
      scenario,
      run.observationRef,
      "host-audit",
      "independent host event-to-new-run receipt",
      run.startedAt,
    );
    check(
      scenario,
      read.runId === run.runId &&
        read.eventId === event.eventId &&
        read.tableId === post.tableId &&
        read.membershipId === recipient.membershipId &&
        read.connectionId === recipient.connectionId &&
        read.afterSeq < post.seq &&
        read.throughSeq >= post.seq &&
        read.observedMessageIds.includes(post.messageId) &&
        milliseconds(read.readAt) >= milliseconds(run.startedAt),
      "same-run authenticated read of the triggering committed message",
    );
    receipt(
      scenario,
      read.hostObservationRef,
      "host-tool",
      "host authenticated-read tool receipt",
      read.readAt,
    );
    receipt(
      scenario,
      read.serverObservationRef,
      "server",
      "server authenticated-read receipt",
      read.readAt,
    );
    check(
      scenario,
      reply.runId === run.runId &&
        reply.tableId === post.tableId &&
        reply.senderMembershipId === recipient.membershipId &&
        reply.replyToMessageId === post.messageId &&
        reply.messageId !== post.messageId &&
        reply.seq > post.seq &&
        milliseconds(reply.committedAt) >= milliseconds(read.readAt),
      "same-run committed peer reply after authenticated read",
    );
    receipt(
      scenario,
      reply.observationRef,
      "server",
      "committed reply receipt",
      reply.committedAt,
    );
    receipt(
      scenario,
      reply.hostObservationRef,
      "host-tool",
      "same-run host reply tool receipt with committed message result",
      reply.committedAt,
    );
    return { notificationValid, autonomousValid: missing.length === start };
  };

  const responses = record.turns.filter(
    (item) => item.scenario === "event-response",
  );
  check(
    "eventResponse",
    responses.length === expectedResponseTurns,
    "exact event-response turn count for the explicit acceptance mode",
  );
  const responseResults = responses.map((item) =>
    validateTurn(item, "eventResponse"),
  );
  if (record.acceptanceMode === "bidirectional") {
    const first = responses.find(
      (item) => item.sender === "A" && item.recipient === "B",
    );
    const back = responses.find(
      (item) => item.sender === "B" && item.recipient === "A",
    );
    const firstReply = first?.reply;
    check(
      "eventResponse",
      first &&
        back &&
        firstReply &&
        back.post.messageId === firstReply.messageId &&
        back.post.seq === firstReply.seq &&
        back.post.senderMembershipId === firstReply.senderMembershipId &&
        back.post.mutationKeySha256 === firstReply.mutationKeySha256 &&
        back.post.committedAt === firstReply.committedAt,
      "B reply is the exact committed post causing the return A turn",
    );
    check(
      "eventResponse",
      first?.run &&
        back?.run &&
        first.run.runId !== back.run.runId &&
        first.event.eventId !== back.event.eventId,
      "distinct event-driven host runs in both directions",
    );
  } else {
    check(
      "eventResponse",
      responses.length === 1 &&
        responses[0].sender === "B" &&
        responses[0].recipient === "A",
      "A-only acceptance requires an actual B post followed by an event-driven A reply",
      responses.length > 0,
    );
  }
  finish("eventResponse", responses.length > 0);

  const retry = record.retry;
  check("exactRetry", retry !== null, "observed exact mutation-key retry");
  if (retry) {
    const original = record.turns.find(
      (item) => item.id === retry.turnId,
    )?.post;
    check(
      "exactRetry",
      original &&
        retry.originalMutationKeySha256 === original.mutationKeySha256 &&
        retry.retryMutationKeySha256 === retry.originalMutationKeySha256 &&
        retry.originalPayloadSha256 === retry.retryPayloadSha256,
      "unchanged original mutation key and payload",
    );
    check(
      "exactRetry",
      original &&
        retry.originalMessageId === original.messageId &&
        retry.retryMessageId === original.messageId &&
        retry.originalSeq === original.seq &&
        retry.retrySeq === original.seq,
      "the original accepted message/sequence receipt on retry",
    );
    check(
      "exactRetry",
      original &&
        retry.beforeCount >= original.seq &&
        retry.beforeCount === retry.afterCount &&
        milliseconds(retry.retriedAt) >= milliseconds(original.committedAt),
      "no additional accepted transcript message on exact retry",
    );
    receipt(
      "exactRetry",
      retry.observationRef,
      "server",
      "retry and unchanged transcript receipt",
      retry.retriedAt,
    );
  }
  finish("exactRetry", retry !== null);

  const duplicates = record.duplicateDelivery;
  check(
    "duplicateDelivery",
    duplicates !== null,
    "actual duplicate-delivery behavior or explicit not-observed record",
  );
  if (duplicates) {
    const observedTurn = record.turns.find(
      (item) => item.id === duplicates.turnId,
    );
    const accepted =
      observedTurn?.deliveries.filter(
        (entry) =>
          entry.acceptedAt &&
          entry.statusCode !== null &&
          entry.statusCode >= 200 &&
          entry.statusCode < 300,
      ) ?? [];
    check(
      "duplicateDelivery",
      observedTurn &&
        duplicates.eventId === observedTurn.event.eventId &&
        accepted.length === duplicates.acceptedAttemptIds.length &&
        accepted.every((item) =>
          duplicates.acceptedAttemptIds.includes(item.attemptId),
        ),
      "duplicate observations joined to accepted attempts for the same event",
    );
    check(
      "duplicateDelivery",
      accepted.every(
        (item) =>
          milliseconds(item.acceptedAt) <= milliseconds(duplicates.through),
      ),
      "duplicate observation window covers every included receiver acceptance",
      true,
    );
    check(
      "duplicateDelivery",
      unique(duplicates.acceptedAttemptIds) &&
        unique(duplicates.observedRunIds) &&
        unique(duplicates.acceptedReplyMessageIds),
      "unique observed duplicate attempt/run/reply identifiers",
    );
    check(
      "duplicateDelivery",
      observedTurn?.run &&
        observedTurn.reply &&
        duplicates.observedRunIds.includes(observedTurn.run.runId) &&
        duplicates.acceptedReplyMessageIds.includes(
          observedTurn.reply.messageId,
        ) &&
        milliseconds(duplicates.through) >=
          milliseconds(observedTurn.reply.committedAt),
      "host run/reply observation window for the same event",
    );
    check(
      "duplicateDelivery",
      duplicates.behavior === "not-observed"
        ? accepted.length === 1
        : accepted.length > 1 &&
            (duplicates.behavior === "additional-run"
              ? duplicates.observedRunIds.length > 1
              : duplicates.observedRunIds.length === 1),
      "reported duplicate behavior matches observed attempts and runs",
    );
    receipt(
      "duplicateDelivery",
      duplicates.hostObservationRef,
      "host-audit",
      "host duplicate-delivery behavior receipt",
      duplicates.through,
    );
    receipt(
      "duplicateDelivery",
      duplicates.serverObservationRef,
      "server",
      "server duplicate delivery and accepted reply receipt",
      duplicates.through,
    );
  }
  finish("duplicateDelivery", duplicates !== null);

  const cancellation = record.cancellation;
  check(
    "cancellation",
    cancellation !== null,
    "pending-work closure or unsubscribe exercise",
  );
  if (cancellation) {
    const cancellationRecipient = cancellation.recipient === "A" ? a : b;
    check(
      "cancellation",
      requiredReceivers.includes(cancellationRecipient) &&
        cancellation.recipientGuestId === cancellationRecipient.guestId,
      "cancellation targets the independently authorized guest of a required receiver",
      true,
    );
    const decision = milliseconds(cancellation.decisionAt);
    check(
      "cancellation",
      cancellation.tableId !== record.tableId &&
        milliseconds(cancellation.pendingAt) < decision,
      "separate cancellation table with work pending before the decision",
    );
    check(
      "cancellation",
      milliseconds(cancellation.coverageFrom) <=
        milliseconds(cancellation.pendingAt) &&
        milliseconds(cancellation.coverageThrough) >=
          milliseconds(cancellation.postDecisionProbeAt) &&
        milliseconds(cancellation.postDecisionProbeAt) > decision,
      "attempt-ledger coverage spanning pending work and post-decision refusal",
    );
    check(
      "cancellation",
      unique(cancellation.attempts.map((item) => item.attemptId)),
      "unique cancellation attempt identifiers",
    );
    for (const attempt of cancellation.attempts) {
      check(
        "cancellation",
        milliseconds(attempt.authorizedAt) < decision,
        "no newly authorized delivery after the terminal decision",
        true,
      );
      check(
        "cancellation",
        attempt.eventId === cancellation.pendingEventId,
        "attempt ledger is scoped to the same pending event",
        true,
      );
      check(
        "cancellation",
        milliseconds(attempt.authorizedAt) >=
          milliseconds(cancellation.coverageFrom) &&
          (attempt.dispatchedAt === null ||
            milliseconds(attempt.dispatchedAt) >=
              milliseconds(attempt.authorizedAt)) &&
          (attempt.completedAt === null ||
            (attempt.dispatchedAt !== null &&
              milliseconds(attempt.completedAt) >=
                milliseconds(attempt.dispatchedAt) &&
              milliseconds(attempt.completedAt) <=
                milliseconds(cancellation.coverageThrough))),
        "authorization, dispatch and completion remain distinct in observed ledger window",
      );
    }
    receipt(
      "cancellation",
      cancellation.observationRef,
      "server",
      "authoritative terminal decision receipt",
      cancellation.decisionAt,
    );
    receipt(
      "cancellation",
      cancellation.coverageObservationRef,
      "server",
      "complete scoped attempt-ledger observation",
      cancellation.coverageThrough,
    );
    receipt(
      "cancellation",
      cancellation.refusalObservationRef,
      "server",
      "post-decision delivery refusal receipt",
      cancellation.postDecisionProbeAt,
    );
  }
  finish("cancellation", cancellation !== null);

  const restart = record.restart;
  check(
    "restart",
    restart !== null,
    "retained-state restart and fresh real-host progress",
  );
  if (restart) {
    const { before, after } = restart;
    check(
      "restart",
      restart.mode === "retained-storage" &&
        restart.tableId === record.tableId &&
        before.storageIdentity === after.storageIdentity &&
        before.retryStateSha256 === after.retryStateSha256,
      "same retained storage and unchanged server retry state",
      true,
    );
    check(
      "restart",
      before.buildSha === deployment.buildSha &&
        after.buildSha === deployment.buildSha &&
        before.configSha256 === deployment.configSha256 &&
        after.configSha256 === deployment.configSha256,
      "same pinned build/configuration across service restart",
    );
    const originalSubscriptions = requiredReceivers.map(
      (person) => person.subscriptionId,
    );
    check(
      "restart",
      before.subscriptionIds.length === originalSubscriptions.length &&
        after.subscriptionIds.length === originalSubscriptions.length &&
        before.subscriptionIds.every(
          (id, i) => id === originalSubscriptions[i],
        ) &&
        after.subscriptionIds.every((id, i) => id === originalSubscriptions[i]),
      "original active subscriptions survive without replacement",
    );
    check(
      "restart",
      milliseconds(before.observedAt) <= milliseconds(restart.startedAt) &&
        milliseconds(restart.readyAt) >= milliseconds(restart.startedAt) &&
        milliseconds(after.observedAt) >= milliseconds(restart.readyAt),
      "ordered before/restart/ready/after observations",
    );
    receipt(
      "restart",
      restart.operationRef,
      "operator",
      "storage-preserving restart operation receipt",
      restart.readyAt,
    );
    receipt(
      "restart",
      before.observationRef,
      "server",
      "pre-restart durable-state receipt",
      before.observedAt,
    );
    receipt(
      "restart",
      after.observationRef,
      "server",
      "post-restart durable-state receipt",
      after.observedAt,
    );
    const resumed = record.turns.find(
      (item) => item.id === restart.newTurnId && item.scenario === "restart",
    );
    const previousMessages = responses.flatMap((item) => [
      item.post,
      ...(item.reply ? [item.reply] : []),
    ]);
    check(
      "restart",
      record.turns.filter((item) => item.scenario === "restart").length === 1 &&
        resumed &&
        previousMessages.every(
          (message) =>
            message.messageId !== resumed.post.messageId &&
            message.seq < resumed.post.seq &&
            milliseconds(message.committedAt) <=
              milliseconds(resumed.post.committedAt),
        ),
      "one genuinely new post and ordered sequence after the event-response phase",
      resumed !== undefined,
    );
    check(
      "restart",
      resumed &&
        milliseconds(resumed.post.committedAt) > milliseconds(after.observedAt),
      "fresh eligible peer post after retained-state restart",
    );
    if (resumed) validateTurn(resumed, "restart");
    check(
      "restart",
      cancellation &&
        restart.terminalTableId === cancellation.tableId &&
        restart.terminalSubscriptionId === cancellation.subscriptionId &&
        milliseconds(cancellation.decisionAt) <
          milliseconds(restart.startedAt) &&
        restart.terminalStateBefore === restart.terminalStateAfter &&
        restart.terminalStateBefore ===
          (cancellation.action === "close" ? "closed" : "unsubscribed"),
      "the original terminal scope remains terminal after restart",
    );
    check(
      "restart",
      milliseconds(restart.terminalCheckAt) >= milliseconds(restart.readyAt) &&
        restart.terminalDispatchCount === 0,
      "no terminal-scope dispatch resurrection after restart",
    );
    receipt(
      "restart",
      restart.terminalObservationRef,
      "server",
      "retained terminal-state and denied-dispatch receipt",
      restart.terminalCheckAt,
    );
  }
  finish("restart", restart !== null);

  const isolationActions = [
    "metadata",
    "transcript",
    "inbox",
    "renew-subscription",
    "unsubscribe",
  ] as const;
  for (const person of record.participants) {
    for (const action of isolationActions) {
      if (
        (action === "renew-subscription" || action === "unsubscribe") &&
        !requiredReceivers.includes(person)
      )
        continue;
      check(
        "isolation",
        record.isolation.some(
          (item) =>
            item.action === action &&
            item.targetMembershipId === person.membershipId &&
            item.targetSubscriptionId === person.subscriptionId,
        ),
        "third-guest private-read coverage for both memberships and subscription maintenance for required receivers",
      );
    }
  }
  const outsider = record.isolation[0];
  for (const item of record.isolation) {
    check(
      "isolation",
      item.outsiderGuestId === outsider?.outsiderGuestId &&
        item.outsiderConnectionId === outsider.outsiderConnectionId &&
        record.participants.every(
          (person) =>
            item.outsiderGuestId !== person.guestId &&
            item.outsiderConnectionId !== person.connectionId,
        ),
      "one independently authenticated unaffiliated third guest",
    );
    check(
      "isolation",
      item.tableId === record.tableId &&
        item.outcome === "denied" &&
        !item.privateDataReturned &&
        !item.subscriptionChanged,
      "denied access without private content or subscription mutation",
      true,
    );
    receipt(
      "isolation",
      item.clientObservationRef,
      "host-tool",
      "third-guest authenticated client refusal receipt",
      item.observedAt,
    );
    receipt(
      "isolation",
      item.serverObservationRef,
      "server",
      "server denial and unchanged subscription receipt",
      item.observedAt,
    );
  }
  finish("isolation", record.isolation.length > 0);

  const disclosure = record.disclosure;
  check(
    "disclosure",
    disclosure !== null,
    "synthetic-only shared transcript review",
  );
  if (disclosure) {
    check(
      "disclosure",
      disclosure.scope === "synthetic-only" &&
        disclosure.syntheticPayloadsSha256 === disclosure.postedPayloadsSha256,
      "only deliberately supplied synthetic payloads crossed the relay",
    );
    check(
      "disclosure",
      disclosure.ownerReviewRefs[0] !== disclosure.ownerReviewRefs[1],
      "separate owner disclosure reviews",
    );
    for (const id of disclosure.ownerReviewRefs)
      receipt(
        "disclosure",
        id,
        "owner-consent",
        "independent owner synthetic disclosure review",
      );
    receipt(
      "disclosure",
      disclosure.transcriptObservationRef,
      "server",
      "committed synthetic transcript receipt",
    );
  }
  finish("disclosure", disclosure !== null);

  const actual = record.evidenceKind === "real-host";
  if (!actual)
    missing.push(
      "Actual independently observed real-host pilot evidence is required; fixtures are not compatibility results.",
    );
  const hasReceipt = (
    id: string | null,
    source: AutonomousObservation["source"],
  ) => id !== null && observations.get(id)?.source === source;
  // Tools and receipt compatibility do not depend on host run observability.
  const toolsVerified =
    actual &&
    unique(record.observations.map((item) => item.id)) &&
    record.observedAt &&
    observedTimes.every((value) => value <= milliseconds(record.observedAt)) &&
    deployment.isolated === true &&
    deployment.buildSha &&
    deployment.configSha256 &&
    deployment.endpointRef &&
    deployment.protocol &&
    deployment.profile &&
    hasReceipt(deployment.approvalRef, "operator") &&
    hasReceipt(deployment.configurationRef, "operator") &&
    a.role === "A" &&
    b.role === "B" &&
    (["ownerRef", "accountRef", "guestId", "connectionId"] as const).every(
      (key) => a[key] && b[key] && a[key] !== b[key],
    ) &&
    record.participants.every(
      (person) =>
        person.workspaceRef &&
        person.host.eligibility === "eligible" &&
        person.host.origin === "actual-host" &&
        isKnown(person.host.product) &&
        isKnown(person.host.surface) &&
        knownBuild(person.host.exposedBuild) &&
        hasReceipt(person.oauthEvidenceRef, "host-tool"),
    );
  const notificationPrerequisite =
    toolsVerified &&
    immutableMessagesValid &&
    unique(record.turns.map((item) => item.event.eventId)) &&
    unique(
      record.turns.flatMap((item) =>
        item.deliveries.map((entry) => entry.attemptId),
      ),
    ) &&
    record.tableId &&
    requiredReceivers.every(
      (person) =>
        person.subscription.tableId === record.tableId &&
        person.subscription.activeAt &&
        hasReceipt(person.subscription.observationRef, "server"),
    );
  const prerequisite = scenarios.setup === "passed" && actual;
  layers.tools = toolsVerified
    ? "passed"
    : record.evidenceKind === "not-run"
      ? "not-run"
      : "blocked";
  layers.notificationReceipt =
    notificationPrerequisite &&
    responseResults.length === expectedResponseTurns &&
    responseResults.every((item) => item.notificationValid)
      ? "passed"
      : responses.length
        ? "blocked"
        : "not-run";
  layers.autonomousReply =
    prerequisite && scenarios.eventResponse === "passed"
      ? "passed"
      : scenarios.eventResponse === "failed"
        ? "failed"
        : responses.length
          ? "blocked"
          : "not-run";
  return {
    acceptanceMode: record.acceptanceMode,
    structurallyValid: true,
    completeRecord: actual && missing.length === 0,
    missing: [...new Set(missing)],
    layers,
    scenarios,
  };
}
