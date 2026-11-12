import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLANNED_MAX_CALLBACK_RESPONSE_BYTES } from "../../src/notifications/egress";
import { authorizeGuestConnection } from "../../src/shared/auth";
import { sealSecret } from "../../src/shared/secret-envelope";

const SECRET = `whsec_${btoa("P".repeat(32))}`;
const SUBSCRIPTION = "sub_syntheticObservedAttempt1234";
const CALLBACK =
  "https://events.provider.example.org/callback/PRIVATE_CALLBACK_PATH?token=PRIVATE_CALLBACK_QUERY";
const BODY = "PRIVATE_TRANSCRIPT_SENTINEL";
const RESPONSE_HEADER = "PRIVATE_RESPONSE_HEADER";
const SCHEMA = "agent-table.private-pilot.v1";
const cleanups: Array<() => Promise<void>> = [];

type Observation = {
  schema: string;
  kind: string;
  tableId: string;
  eventId: string;
  messageId: string;
  membershipId: string;
  subscriptionId: string;
  generation: number;
  attempt: number;
  seq: number;
  observedAt: number;
  status?: number;
  outcome?: string;
  errorCategory?: string;
  settled?: string | null;
  transportInvoked?: boolean;
  responseObserved?: boolean;
};

function observations(calls: readonly (readonly unknown[])[]): Observation[] {
  return calls.flatMap(([text]) => {
    if (typeof text !== "string") return [];
    try {
      const value = JSON.parse(text);
      return value?.schema === SCHEMA ? [value as Observation] : [];
    } catch {
      return [];
    }
  });
}

/** Real grant, encrypted credentials and retained SQLite; only HTTP is synthetic. */
async function fixture() {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const grant = await guest.createConnection(
    session.sessionId,
    session.secret,
    ["events:subscribe", "tables:write", "tables:read"],
    Date.now() + 3_600_000,
  );
  if (!grant) throw new Error("Missing synthetic connection");
  const authorized = await authorizeGuestConnection(
    env,
    guestId,
    grant.connectionId,
    "tables:write",
  );
  if (!authorized.allowed) throw new Error("Missing synthetic authority");
  const tableId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const senderMembershipId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const stub = env.TABLES.get(env.TABLES.idFromName(tableId));
  const started = Date.now();
  const policy = {
    schemaVersion: 1,
    mode: "a-only",
    observationMode: "private-redacted",
    buildSha: "a".repeat(40),
    approvedAt: new Date(started - 20_000).toISOString(),
    notBefore: new Date(started - 10_000).toISOString(),
    expiresAt: new Date(started + 600_000).toISOString(),
    approvalRef: "synthetic-observed-delivery",
    recipientGuestId: guestId,
    recipientConnectionId: grant.connectionId,
    tableIds: [tableId],
    callbackTargets: [
      {
        origin: "https://events.provider.example.org",
        pathPrefix: "/callback",
      },
    ],
  };
  const overlay: Env = {
    ...env,
    PUBLIC_ORIGIN: "https://agent-table-test.outliner-online.com",
    RELEASE_ENVIRONMENT: "staging",
    RELEASE_PROFILE: "private-pilot-a-only",
    RELEASE_BUILD_SHA: policy.buildSha,
    RESTORE_QUARANTINE: "false",
    ENABLE_MCP_SUBSCRIPTIONS: "false",
    ENABLE_OPENAI_EVENTS: "false",
    ALLOW_OUTBOUND_NOTIFICATIONS: "true",
    STAGING_EVIDENCE_MODE: "read-only",
    PRIVATE_PILOT_POLICY: JSON.stringify(policy),
  };
  const envelope = await sealSecret(
    "callback-credential",
    SECRET,
    { recordId: `event:${SUBSCRIPTION}` },
    env,
  );
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      "INSERT INTO table_metadata (singleton, table_id, creation_request_id, request_digest, creator_guest_id, title, state, created_at, expires_at, last_seq) VALUES (1, ?, ?, ?, ?, 'PRIVATE_TABLE_TITLE', 'open', ?, ?, 1)",
      tableId,
      crypto.randomUUID(),
      "a".repeat(64),
      guestId,
      started - 2000,
      started + 3_600_000,
    );
    sql.exec(
      "INSERT INTO table_memberships (membership_id, table_id, guest_id, seat, role, joined_at) VALUES (?, ?, ?, 1, 'creator', ?)",
      membershipId,
      tableId,
      guestId,
      started - 2000,
    );
    sql.exec(
      "INSERT INTO table_memberships (membership_id, table_id, guest_id, seat, role, joined_at) VALUES (?, ?, ?, 2, 'invitee', ?)",
      senderMembershipId,
      tableId,
      crypto.randomUUID(),
      started - 1500,
    );
    sql.exec(
      "INSERT INTO table_event_subscriptions (membership_id, generation, fence, status, guest_id, connection_id, subscription_id, callback_url, secret_envelope, expires_at) VALUES (?, 1, 1, 'active', ?, ?, ?, ?, ?, ?)",
      membershipId,
      guestId,
      grant.connectionId,
      SUBSCRIPTION,
      CALLBACK,
      envelope,
      started + 600_000,
    );
    sql.exec(
      "INSERT INTO table_messages (seq, message_id, sender_membership_id, body, body_bytes, created_at) VALUES (1, ?, ?, ?, ?, ?)",
      messageId,
      senderMembershipId,
      BODY,
      BODY.length,
      started - 1000,
    );
    sql.exec(
      "INSERT INTO table_event_outbox (event_id, message_id, message_seq, recipient_membership_id, subscription_id, subscription_generation, created_at, expires_at, next_attempt_at) VALUES (?, ?, 1, ?, ?, 1, ?, ?, ?)",
      eventId,
      messageId,
      membershipId,
      SUBSCRIPTION,
      started - 1000,
      started + 600_000,
      started - 1,
    );
  });
  const configure = (patch: Partial<Env> = {}) =>
    runInDurableObject(stub, (instance) => {
      const harness = instance as unknown as { env: Env };
      harness.env = { ...overlay, ...patch };
    });
  await configure();
  cleanups.push(async () => {
    await configure({ ALLOW_OUTBOUND_NOTIFICATIONS: "false" });
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.deleteAlarm(),
    );
  });
  const snapshot = (
    requestedTable = tableId,
    requestedGuest = guestId,
    requestedConnection = grant.connectionId,
  ) =>
    stub.readPrivatePilotEvidence(
      requestedTable,
      requestedGuest,
      requestedConnection,
    );
  const alarm = () => runInDurableObject(stub, (instance) => instance.alarm());
  const refusesSnapshot = (
    requestedTable = tableId,
    requestedGuest = guestId,
    requestedConnection = grant.connectionId,
  ) =>
    runInDurableObject(stub, (instance) => {
      // Catch inside the DO to avoid the Vitest bridge's duplicate RPC rejection.
      expect(() =>
        instance.readPrivatePilotEvidence(
          requestedTable,
          requestedGuest,
          requestedConnection,
        ),
      ).toThrow("Private pilot evidence is disabled");
    });
  return {
    stub,
    guest,
    session,
    grant,
    actor: authorized.actor,
    tableId,
    guestId,
    membershipId,
    senderMembershipId,
    messageId,
    eventId,
    policy,
    envelope,
    configure,
    snapshot,
    alarm,
    refusesSnapshot,
  };
}

function assertRedacted(
  serialized: string,
  f: Awaited<ReturnType<typeof fixture>>,
  lease?: string,
) {
  for (const value of [
    SECRET,
    CALLBACK,
    "PRIVATE_CALLBACK_PATH",
    "PRIVATE_CALLBACK_QUERY",
    BODY,
    RESPONSE_HEADER,
    "PRIVATE_TABLE_TITLE",
    f.envelope,
    f.guestId,
    f.grant.connectionId,
    ...(lease ? [lease] : []),
  ])
    expect(serialized).not.toContain(value);
  expect(serialized).not.toMatch(
    /secret_envelope|callback_url|lease_token|webhook-signature|x-mcp-signature/,
  );
}

beforeEach(() => {
  // No fixture or recovery alarm may contact the network outside its mock.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Synthetic HTTP not configured"),
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe("private pilot observation projection (synthetic HTTP, not host acceptance)", () => {
  it("keeps observations disabled for a valid delivery policy without the explicit opt-in", async () => {
    const f = await fixture();
    await f.configure({
      PRIVATE_PILOT_POLICY: JSON.stringify({
        ...f.policy,
        observationMode: undefined,
      }),
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    await f.alarm();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(observations(info.mock.calls)).toEqual([]);
    await runInDurableObject(f.stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ status: string; attempt_count: number }>(
            "SELECT status, attempt_count FROM table_event_outbox",
          )
          .one(),
      ).toEqual({ status: "accepted", attempt_count: 1 });
    });
    await f.refusesSnapshot();
  });

  it("joins four actual dispatch observations to the persisted attempt without leaking payload or credentials", async () => {
    const f = await fixture();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let lease = "";
    const fetch = vi.spyOn(globalThis, "fetch");
    await runInDurableObject(f.stub, async (instance, state) => {
      fetch.mockImplementation(async (url, init) => {
        expect(String(url)).toBe(CALLBACK);
        const verified = new Webhook(SECRET).verify(
          new TextDecoder().decode(init?.body as ArrayBuffer),
          Object.fromEntries(new Headers(init?.headers)),
        );
        expect(verified).toMatchObject({
          eventId: f.eventId,
          data: { message_id: f.messageId, seq: 1 },
        });
        const rows = state.storage.sql
          .exec<{ lease_token: string; attempt_count: number }>(
            "SELECT lease_token, attempt_count FROM table_event_outbox",
          )
          .one();
        lease = rows.lease_token;
        expect(rows.attempt_count).toBe(1);
        expect(lease).toBeTruthy();
        return new Response(null, {
          status: 204,
          headers: { "X-Private-Sentinel": RESPONSE_HEADER },
        });
      });
      await instance.alarm();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const records = observations(info.mock.calls);
    expect(records.map((record) => record.kind)).toEqual([
      "attempt-authorized",
      "transport-invoked",
      "response-headers",
      "attempt-completed",
    ]);
    const snapshot = await f.snapshot();
    expect(snapshot.outbox).toHaveLength(1);
    expect(snapshot.outbox[0]).toMatchObject({
      eventId: f.eventId,
      messageId: f.messageId,
      membershipId: f.membershipId,
      subscriptionId: SUBSCRIPTION,
      generation: 1,
      attemptCount: 1,
      seq: 1,
      status: "accepted",
      nextAttemptAt: null,
      leaseDeadline: null,
    });
    expect(snapshot.messages).toEqual([
      {
        messageId: f.messageId,
        seq: 1,
        senderMembershipId: f.senderMembershipId,
        createdAt: snapshot.outbox[0].createdAt,
        replyToMessageId: null,
      },
    ]);
    const commonKeys = [
      "schema",
      "buildSha",
      "approvalRef",
      "tableId",
      "eventId",
      "messageId",
      "seq",
      "membershipId",
      "subscriptionId",
      "generation",
      "attempt",
      "kind",
      "observedAt",
    ];
    const extraKeys = [
      [],
      [],
      ["status"],
      ["outcome", "settled", "transportInvoked", "responseObserved"],
    ];
    for (const [index, record] of records.entries()) {
      expect(Object.keys(record).sort()).toEqual(
        [...commonKeys, ...extraKeys[index]].sort(),
      );
      expect(record).toMatchObject({
        tableId: f.tableId,
        eventId: f.eventId,
        messageId: f.messageId,
        membershipId: f.membershipId,
        subscriptionId: SUBSCRIPTION,
        generation: 1,
        attempt: snapshot.outbox[0].attemptCount,
        seq: 1,
      });
      expect(record.observedAt).toBeGreaterThanOrEqual(
        index === 0
          ? (snapshot.outbox[0].firstAttemptAt ?? 0)
          : records[index - 1].observedAt,
      );
    }
    expect(records[2].status).toBe(204);
    expect(records[3]).toMatchObject({
      outcome: "accepted",
      settled: "accepted",
      transportInvoked: true,
      responseObserved: true,
    });
    assertRedacted(JSON.stringify({ records, snapshot }), f, lease);
  });

  it("retains the retry identity and charged attempt count across reconstruction", async () => {
    const f = await fixture();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { "Retry-After": "1" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await f.alarm();
    const before = await f.snapshot();
    expect(before.outbox[0]).toMatchObject({
      eventId: f.eventId,
      status: "pending",
      attemptCount: 1,
      lastErrorCategory: "server-error",
    });
    expect(before.outbox[0].nextAttemptAt).toBeGreaterThan(
      before.outbox[0].firstAttemptAt ?? 0,
    );
    await evictDurableObject(f.stub);
    await f.configure();
    expect((await f.snapshot()).outbox).toEqual(before.outbox);
    await runInDurableObject(f.stub, (_instance, state) => {
      // Advance only the synthetic due time; retain identity, budget and horizon.
      state.storage.sql.exec(
        "UPDATE table_event_outbox SET next_attempt_at = ? WHERE status = 'pending'",
        Date.now() - 1,
      );
    });
    await f.alarm();
    expect(fetch).toHaveBeenCalledTimes(2);
    const snapshot = await f.snapshot();
    expect(snapshot.outbox[0]).toMatchObject({
      eventId: f.eventId,
      status: "accepted",
      attemptCount: 2,
      firstAttemptAt: before.outbox[0].firstAttemptAt,
    });
    const records = observations(info.mock.calls);
    expect(records).toHaveLength(8);
    expect(records.every((record) => record.eventId === f.eventId)).toBe(true);
    expect(records.map((record) => record.attempt)).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2,
    ]);
    expect(records[3]).toMatchObject({
      outcome: "transient",
      errorCategory: "server-error",
      settled: "pending",
    });
    expect(records[7]).toMatchObject({
      outcome: "accepted",
      settled: "accepted",
    });
    assertRedacted(JSON.stringify({ records, snapshot }), f);
  });

  it("keeps completion after closure cancels an already invoked attempt", async () => {
    const f = await fixture();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetch = vi.spyOn(globalThis, "fetch");
    await runInDurableObject(f.stub, async (instance) => {
      fetch.mockImplementation(async () => {
        const closed = await instance.closeTable(f.actor, crypto.randomUUID());
        expect(closed.ok).toBe(true);
        expect(
          instance.readPrivatePilotEvidence(
            f.tableId,
            f.guestId,
            f.grant.connectionId,
          ).outbox[0].status,
        ).toBe("cancelled");
        return new Response(null, { status: 204 });
      });
      await instance.alarm();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const records = observations(info.mock.calls);
    expect(records).toHaveLength(4);
    expect(records[3]).toMatchObject({
      kind: "attempt-completed",
      outcome: "accepted",
      settled: null,
      transportInvoked: true,
      responseObserved: true,
    });
    const snapshot = await f.snapshot();
    expect(snapshot.table).toMatchObject({
      tableId: f.tableId,
      state: "closed",
    });
    expect(snapshot.table?.closedAt).not.toBeNull();
    expect(snapshot.subscription).toMatchObject({ status: "inactive" });
    expect(snapshot.outbox[0]).toMatchObject({
      status: "cancelled",
      attemptCount: 1,
      nextAttemptAt: null,
      leaseDeadline: null,
    });
    expect(records[1].observedAt).toBeLessThanOrEqual(
      snapshot.table?.closedAt ?? 0,
    );
    expect(records[3].observedAt).toBeGreaterThanOrEqual(
      snapshot.table?.closedAt ?? 0,
    );
    await f.alarm();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(observations(info.mock.calls)).toHaveLength(4);
    assertRedacted(JSON.stringify({ records, snapshot }), f);
  });

  it("records accepted response headers separately from a later oversized-body failure", async () => {
    const f = await fixture();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array(PLANNED_MAX_CALLBACK_RESPONSE_BYTES + 1), {
          status: 200,
          headers: { "X-Private-Sentinel": RESPONSE_HEADER },
        }),
    );
    await f.alarm();
    const records = observations(info.mock.calls);
    expect(records).toHaveLength(4);
    expect(records[2]).toMatchObject({ kind: "response-headers", status: 200 });
    expect(records[3]).toMatchObject({
      kind: "attempt-completed",
      outcome: "permanent",
      errorCategory: "payload-rejected",
      settled: "failed",
      responseObserved: true,
    });
    const snapshot = await f.snapshot();
    expect(snapshot.outbox[0]).toMatchObject({
      status: "failed",
      attemptCount: 1,
      lastErrorCategory: "payload-rejected",
    });
    assertRedacted(JSON.stringify({ records, snapshot }), f);
  });

  it("reads retained state when delivery is paused or policy expired but refuses unapproved scope", async () => {
    const f = await fixture();
    const original = await f.snapshot();
    await f.configure({ ALLOW_OUTBOUND_NOTIFICATIONS: "false" });
    expect((await f.snapshot()).outbox).toEqual(original.outbox);
    const now = Date.now();
    await f.configure({
      PRIVATE_PILOT_POLICY: JSON.stringify({
        ...f.policy,
        approvedAt: new Date(now - 90_000).toISOString(),
        notBefore: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now - 30_000).toISOString(),
      }),
    });
    expect((await f.snapshot()).outbox).toEqual(original.outbox);
    for (const patch of [
      {
        PRIVATE_PILOT_POLICY: JSON.stringify({
          ...f.policy,
          observationMode: undefined,
        }),
      },
      { RESTORE_QUARANTINE: "true" },
      { RELEASE_ENVIRONMENT: "production" },
      { STAGING_EVIDENCE_MODE: "off" },
      { PUBLIC_ORIGIN: "https://unrelated.example.org" },
    ]) {
      await f.configure(patch);
      await f.refusesSnapshot();
    }
    await f.configure();
    await f.refusesSnapshot(f.tableId, crypto.randomUUID());
    await f.refusesSnapshot(f.tableId, f.guestId, crypto.randomUUID());
    const otherTable = crypto.randomUUID();
    await f.configure({
      PRIVATE_PILOT_POLICY: JSON.stringify({
        ...f.policy,
        tableIds: [f.tableId, otherTable],
      }),
    });
    await f.refusesSnapshot(otherTable);
    assertRedacted(JSON.stringify(original), f);
  });
});
