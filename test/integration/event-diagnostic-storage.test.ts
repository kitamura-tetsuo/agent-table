import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_DIAGNOSTIC_RETENTION_MS,
  type EventDiagnosticRecord,
  type EventDiagnosticScope,
  eventDiagnosticContext,
  eventDiagnosticPolicyDigest,
  validEventDiagnosticRecord,
} from "../../src/evidence/event-diagnostics";
import type { ConnectionScope } from "../../src/shared/auth";
import type { PrivatePilotPolicy } from "../../src/shared/private-pilot";

const STORAGE_KEY = "event-diagnostics:v1";
const SENTINEL = "CALLBACK_SECRET_HEADER_CONTENT_SENTINEL";
const PILOT_MODES = ["a-only-discovery", "a-only"] as const;

async function guest() {
  const guestId = crypto.randomUUID();
  const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await stub.createSession(guestId);
  const connect = async (scopes: ConnectionScope[] = ["events:subscribe"]) => {
    const grant = await stub.createConnection(
      session.sessionId,
      session.secret,
      scopes,
      Date.now() + 4 * 60 * 60_000,
    );
    if (!grant) throw new Error("Missing synthetic diagnostic grant");
    return grant;
  };
  const grant = await connect();
  return { guestId, stub, grant, connect };
}

async function fixture(mode: PrivatePilotPolicy["mode"]) {
  const owner = await guest();
  const now = Date.now();
  const policy: PrivatePilotPolicy = {
    schemaVersion: 1,
    mode,
    observationMode: "private-redacted",
    buildSha: "a".repeat(40),
    approvedAt: new Date(now - 2_000).toISOString(),
    notBefore: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    approvalRef: "synthetic-diagnostic-storage-review",
    recipientGuestId: owner.guestId,
    recipientConnectionId: owner.grant.connectionId,
    tableIds: [crypto.randomUUID()],
    callbackTargets:
      mode === "a-only"
        ? [{ origin: "https://events.example.org", pathPrefix: "/" }]
        : [],
  };
  const overlay: Env = {
    ...env,
    RELEASE_ENVIRONMENT: "staging",
    RELEASE_PROFILE: "private-pilot-a-only",
    RELEASE_BUILD_SHA: policy.buildSha,
    RESTORE_QUARANTINE: "false",
    ENABLE_MCP_SUBSCRIPTIONS: "false",
    ENABLE_OPENAI_EVENTS: "false",
    ALLOW_OUTBOUND_NOTIFICATIONS: mode === "a-only" ? "true" : "false",
    PRIVATE_PILOT_POLICY: JSON.stringify(policy),
  };
  const configure = (patch: Partial<Env> = {}) =>
    runInDurableObject(owner.stub, (instance) => {
      const harness = instance as unknown as { env: Env };
      harness.env = { ...harness.env, ...overlay, ...patch };
    });
  await configure();
  const record = (index = 0): EventDiagnosticRecord => ({
    diagnosticId: index.toString(16).padStart(12, "0"),
    observedAt: now - 500 + index,
    method: "events/subscribe",
    stage: "parameters",
    outcome: "invalid",
    detail: "delivery",
  });
  const scope: EventDiagnosticScope = {
    buildSha: policy.buildSha,
    approvalRef: policy.approvalRef,
    policyDigest: await eventDiagnosticPolicyDigest(policy),
  };
  const read = (connectionId = owner.grant.connectionId) =>
    owner.stub.readEventDiagnostics(owner.guestId, connectionId);
  const stored = () =>
    runInDurableObject(owner.stub, (_instance, state) =>
      state.storage.get(STORAGE_KEY),
    );
  return {
    ...owner,
    now,
    policy,
    overlay,
    configure,
    record,
    scope,
    read,
    stored,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(PILOT_MODES)("private GuestDO diagnostics (%s)", (mode) => {
  it("reads only the exact recipient and checks fresh Events grants", async () => {
    const f = await fixture(mode);
    const other = await guest();
    const alternate = await f.connect();
    const noEvents = await f.connect(["tables:read"]);
    const record = f.record();
    expect(await f.stub.recordEventDiagnostics([record], f.scope)).toBe(true);
    expect(await f.read()).toMatchObject({
      records: [record],
      droppedCount: 0,
      scopeMatches: true,
      context: { recipientMatched: true, tableAllowed: null },
    });
    expect(await f.read(alternate.connectionId)).toMatchObject({
      records: [],
      scopeMatches: false,
      retentionUntil: null,
      context: { recipientMatched: false },
    });
    expect(await f.read(noEvents.connectionId)).toBeNull();
    expect(await f.read(crypto.randomUUID())).toBeNull();
    expect(
      await f.stub.readEventDiagnostics(
        other.guestId,
        other.grant.connectionId,
      ),
    ).toBeNull();
    await runInDurableObject(other.stub, (instance) => {
      const harness = instance as unknown as { env: Env };
      harness.env = { ...harness.env, ...f.overlay };
    });
    expect(await other.stub.recordEventDiagnostics([record], f.scope)).toBe(
      false,
    );
    expect(
      await other.stub.readEventDiagnostics(
        other.guestId,
        other.grant.connectionId,
      ),
    ).toMatchObject({ records: [], scopeMatches: false });
    await runInDurableObject(f.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_connections SET revoked_at = ? WHERE connection_id = ?",
        Date.now(),
        f.grant.connectionId,
      );
    });
    expect(await f.read()).toBeNull();
  });

  it("rejects unknown fields, malformed values and out-of-window batches atomically", async () => {
    const f = await fixture(mode);
    const valid = f.record();
    const malformed: unknown[] = [
      null,
      [],
      { ...valid, callbackUrl: `https://example.org/${SENTINEL}` },
      { ...valid, body: SENTINEL },
      { ...valid, diagnosticId: "ABCDEF012345" },
      { ...valid, observedAt: Number.NaN },
      { ...valid, observedAt: 1.5 },
      { ...valid, method: SENTINEL },
      { ...valid, stage: SENTINEL },
      { ...valid, outcome: SENTINEL },
      { ...valid, detail: SENTINEL },
      { ...valid, detail: undefined },
    ];
    expect(validEventDiagnosticRecord(valid)).toBe(true);
    for (const value of malformed) {
      expect(validEventDiagnosticRecord(value)).toBe(false);
      expect(
        await f.stub.recordEventDiagnostics(
          [valid, value] as EventDiagnosticRecord[],
          f.scope,
        ),
      ).toBe(false);
    }
    for (const observedAt of [
      Date.parse(f.policy.notBefore) - 1,
      Date.parse(f.policy.expiresAt),
    ]) {
      expect(
        await f.stub.recordEventDiagnostics(
          [{ ...valid, observedAt }],
          f.scope,
        ),
      ).toBe(false);
    }
    expect(await f.stub.recordEventDiagnostics([], f.scope)).toBe(false);
    expect(
      await f.stub.recordEventDiagnostics(
        Array.from({ length: 17 }, (_, index) => f.record(index)),
        f.scope,
      ),
    ).toBe(false);
    expect(await f.stored()).toBeUndefined();
    expect(JSON.stringify(await f.read())).not.toContain(SENTINEL);
  });

  it("rejects stale provenance even when the previous approval window overlaps", async () => {
    const f = await fixture(mode);
    const record = f.record();
    for (const scope of [
      { ...f.scope, buildSha: "b".repeat(40) },
      { ...f.scope, approvalRef: "previous-synthetic-review" },
      { ...f.scope, policyDigest: "b".repeat(64) },
      { ...f.scope, policyDigest: "A".repeat(64) },
      { ...f.scope, policyDigest: SENTINEL },
      { ...f.scope, extra: SENTINEL },
    ]) {
      expect(await f.stub.recordEventDiagnostics([record], scope)).toBe(false);
    }
    const nextPolicy = { ...f.policy, approvalRef: "next-synthetic-review" };
    await f.configure({ PRIVATE_PILOT_POLICY: JSON.stringify(nextPolicy) });
    expect(await f.stub.recordEventDiagnostics([record], f.scope)).toBe(false);
    expect(
      await f.stub.recordEventDiagnostics([record], {
        buildSha: nextPolicy.buildSha,
        approvalRef: nextPolicy.approvalRef,
        policyDigest: await eventDiagnosticPolicyDigest(nextPolicy),
      }),
    ).toBe(true);
    expect(await f.read()).toMatchObject({
      records: [record],
      scopeMatches: true,
    });
  });

  it("requires a valid staging policy and returns safe context on configuration mismatch", async () => {
    const f = await fixture(mode);
    expect(await f.stub.recordEventDiagnostics([f.record()], f.scope)).toBe(
      true,
    );
    const patches: Partial<Env>[] = [
      { RELEASE_ENVIRONMENT: "production" },
      { RELEASE_PROFILE: "manual" },
      { RELEASE_BUILD_SHA: "b".repeat(40) },
      { RESTORE_QUARANTINE: "true" },
      { ENABLE_OPENAI_EVENTS: "true" },
      ...(mode === "a-only-discovery"
        ? [{ ALLOW_OUTBOUND_NOTIFICATIONS: "true" }]
        : []),
      { PRIVATE_PILOT_POLICY: "" },
    ];
    for (const patch of patches) {
      await f.configure(patch);
      expect(await f.stub.recordEventDiagnostics([f.record(1)], f.scope)).toBe(
        false,
      );
      expect(await f.read()).toMatchObject({
        records: [],
        scopeMatches: false,
        context: { policyConfigured: false, policyActive: false },
      });
    }
    await f.configure();
    expect(await f.read()).toMatchObject({
      records: [f.record()],
      scopeMatches: true,
    });
  });

  it("rejects a delayed batch after policy scope changes with the same build and approval", async () => {
    const f = await fixture(mode);
    const alternate = await f.connect();
    const scopes: PrivatePilotPolicy[] = [
      { ...f.policy, tableIds: [crypto.randomUUID()] },
      { ...f.policy, recipientConnectionId: alternate.connectionId },
      {
        ...f.policy,
        expiresAt: new Date(
          Date.parse(f.policy.expiresAt) + 60_000,
        ).toISOString(),
      },
      ...(mode === "a-only"
        ? [
            {
              ...f.policy,
              callbackTargets: [
                { origin: "https://other.example.org", pathPrefix: "/" },
              ],
            },
          ]
        : []),
    ];
    for (const policy of scopes) {
      await f.configure({ PRIVATE_PILOT_POLICY: JSON.stringify(policy) });
      expect(await f.stub.recordEventDiagnostics([f.record()], f.scope)).toBe(
        false,
      );
    }
    expect(await f.stored()).toBeUndefined();
  });

  it("requires observation opt-in even with the exact newly configured policy digest", async () => {
    const f = await fixture(mode);
    expect(await f.stub.recordEventDiagnostics([f.record()], f.scope)).toBe(
      true,
    );
    const stored = await f.stored();
    const withoutOptIn = { ...f.policy };
    delete withoutOptIn.observationMode;
    await f.configure({ PRIVATE_PILOT_POLICY: JSON.stringify(withoutOptIn) });
    expect(
      await f.stub.recordEventDiagnostics([f.record(1)], {
        ...f.scope,
        policyDigest: await eventDiagnosticPolicyDigest(withoutOptIn),
      }),
    ).toBe(false);
    expect(await f.read()).toMatchObject({
      records: [],
      scopeMatches: false,
    });
    expect(await f.stored()).toEqual(stored);
  });

  it("does not carry a captured batch or retained records across a mode transition", async () => {
    const f = await fixture(mode);
    expect(await f.stub.recordEventDiagnostics([f.record()], f.scope)).toBe(
      true,
    );
    const stored = await f.stored();
    const nextMode = mode === "a-only" ? "a-only-discovery" : "a-only";
    const nextPolicy: PrivatePilotPolicy = {
      ...f.policy,
      mode: nextMode,
      callbackTargets:
        nextMode === "a-only"
          ? [{ origin: "https://events.example.org", pathPrefix: "/" }]
          : [],
    };
    await f.configure({
      ALLOW_OUTBOUND_NOTIFICATIONS: nextMode === "a-only" ? "true" : "false",
      PRIVATE_PILOT_POLICY: JSON.stringify(nextPolicy),
    });
    expect(await f.stub.recordEventDiagnostics([f.record(1)], f.scope)).toBe(
      false,
    );
    expect(await f.stored()).toEqual(stored);
    expect(await f.read()).toMatchObject({
      records: [],
      scopeMatches: false,
    });
    expect(
      await f.stub.recordEventDiagnostics([f.record(2)], {
        ...f.scope,
        policyDigest: await eventDiagnosticPolicyDigest(nextPolicy),
      }),
    ).toBe(true);
    expect(await f.read()).toMatchObject({
      records: [f.record(2)],
      scopeMatches: true,
      context: { mode: nextMode },
    });
  });

  it("does not relabel an in-flight write under a newly configured approval", async () => {
    const f = await fixture(mode);
    await runInDurableObject(f.stub, async (instance) => {
      const harness = instance as unknown as { env: Env };
      const original = crypto.subtle.digest.bind(crypto.subtle);
      const hashing = vi
        .spyOn(crypto.subtle, "digest")
        .mockImplementation(async (algorithm, data) => {
          const digest = await original(algorithm, data);
          harness.env = {
            ...harness.env,
            PRIVATE_PILOT_POLICY: JSON.stringify({
              ...f.policy,
              approvalRef: "replacement-synthetic-approval",
            }),
          };
          return digest;
        });
      try {
        expect(
          await instance.recordEventDiagnostics([f.record()], f.scope),
        ).toBe(false);
      } finally {
        hashing.mockRestore();
      }
    });
    expect(await f.stored()).toBeUndefined();
  });

  it("retains the latest 64 records without losing concurrent request batches", async () => {
    const f = await fixture(mode);
    const records = Array.from({ length: 80 }, (_, index) => f.record(index));
    const batches = Array.from({ length: 5 }, (_, index) =>
      records.slice(index * 16, index * 16 + 16),
    );
    expect(
      await Promise.all(
        batches
          .reverse()
          .map((batch) => f.stub.recordEventDiagnostics(batch, f.scope)),
      ),
    ).toEqual([true, true, true, true, true]);
    expect(await f.read()).toMatchObject({
      records: records.slice(16),
      droppedCount: 16,
      scopeMatches: true,
    });
  });

  it("hides previous policy records and replaces the ring on scope changes", async () => {
    const f = await fixture(mode);
    expect(await f.stub.recordEventDiagnostics([f.record()], f.scope)).toBe(
      true,
    );
    const nextPolicy = { ...f.policy, tableIds: [crypto.randomUUID()] };
    await f.configure({ PRIVATE_PILOT_POLICY: JSON.stringify(nextPolicy) });
    expect(await f.read()).toMatchObject({
      records: [],
      scopeMatches: false,
    });
    expect(
      await f.stub.recordEventDiagnostics([f.record(1)], {
        ...f.scope,
        policyDigest: await eventDiagnosticPolicyDigest(nextPolicy),
      }),
    ).toBe(true);
    expect(await f.read()).toMatchObject({
      records: [f.record(1)],
      droppedCount: 0,
      scopeMatches: true,
    });
    const alternate = await f.connect();
    const alternatePolicy = {
      ...nextPolicy,
      recipientConnectionId: alternate.connectionId,
    };
    await f.configure({
      PRIVATE_PILOT_POLICY: JSON.stringify(alternatePolicy),
    });
    expect(await f.read()).toMatchObject({
      records: [],
      scopeMatches: false,
    });
    expect(
      await f.stub.recordEventDiagnostics([f.record(2)], {
        ...f.scope,
        policyDigest: await eventDiagnosticPolicyDigest(alternatePolicy),
      }),
    ).toBe(true);
    expect(await f.read(alternate.connectionId)).toMatchObject({
      records: [f.record(2)],
      scopeMatches: true,
    });
  });

  it("allows bounded post-expiry reads and replaces expired data on a later approved window", async () => {
    const f = await fixture(mode);
    const record = f.record();
    const expiry = Date.parse(f.policy.expiresAt);
    const retention = expiry + EVENT_DIAGNOSTIC_RETENTION_MS;
    expect(await f.stub.recordEventDiagnostics([record], f.scope)).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expiry);
    expect(await f.stub.recordEventDiagnostics([record], f.scope)).toBe(false);
    expect(await f.read()).toMatchObject({
      records: [record],
      retentionUntil: retention,
      context: { policyActive: false },
    });
    vi.setSystemTime(retention - 1);
    expect(await f.read()).toMatchObject({ records: [record] });
    vi.setSystemTime(retention);
    expect(await f.read()).toMatchObject({
      records: [],
      droppedCount: 0,
      retentionUntil: retention,
      scopeMatches: true,
    });
    const nextPolicy: PrivatePilotPolicy = {
      ...f.policy,
      approvalRef: "later-synthetic-window",
      approvedAt: new Date(retention).toISOString(),
      notBefore: new Date(retention).toISOString(),
      expiresAt: new Date(retention + 60_000).toISOString(),
    };
    await f.configure({ PRIVATE_PILOT_POLICY: JSON.stringify(nextPolicy) });
    const laterRecord = { ...f.record(1), observedAt: retention };
    expect(
      await f.stub.recordEventDiagnostics([laterRecord], {
        ...f.scope,
        approvalRef: nextPolicy.approvalRef,
        policyDigest: await eventDiagnosticPolicyDigest(nextPolicy),
      }),
    ).toBe(true);
    expect(await f.read()).toMatchObject({
      records: [laterRecord],
      droppedCount: 0,
    });
    expect(JSON.stringify(await f.stored())).not.toContain(record.diagnosticId);
  });

  it("persists across eviction without changing SQL schema or existing deadlines", async () => {
    const f = await fixture(mode);
    const record = f.record();
    const schemaBefore = await f.stub.schemaVersion();
    const alarmBefore = await runInDurableObject(f.stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(await f.stub.recordEventDiagnostics([record], f.scope)).toBe(true);
    await evictDurableObject(f.stub);
    await f.configure();
    expect(await f.read()).toMatchObject({
      records: [record],
      scopeMatches: true,
    });
    expect(await f.stub.schemaVersion()).toBe(schemaBefore);
    expect(
      await runInDurableObject(f.stub, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(alarmBefore);
  });

  it("rechecks revocation after the asynchronous storage read", async () => {
    const f = await fixture(mode);
    expect(await f.stub.recordEventDiagnostics([f.record()], f.scope)).toBe(
      true,
    );
    await runInDurableObject(f.stub, async (instance, state) => {
      const original = state.storage.get.bind(state.storage);
      const read = vi
        .spyOn(state.storage, "get")
        .mockImplementation(async (key) => {
          state.storage.sql.exec(
            "UPDATE guest_connections SET revoked_at = ? WHERE connection_id = ?",
            Date.now(),
            f.grant.connectionId,
          );
          return original(key);
        });
      try {
        expect(
          await instance.readEventDiagnostics(f.guestId, f.grant.connectionId),
        ).toBeNull();
      } finally {
        read.mockRestore();
      }
    });
  });

  it("contains storage failures without changing connection behavior or exposing messages", async () => {
    const f = await fixture(mode);
    await runInDurableObject(f.stub, async (instance, state) => {
      const write = vi
        .spyOn(state.storage, "transaction")
        .mockRejectedValue(new Error(SENTINEL));
      try {
        expect(
          await instance.recordEventDiagnostics([f.record()], f.scope),
        ).toBe(false);
        expect(
          instance.authorizeConnection(
            f.guestId,
            f.grant.connectionId,
            "events:subscribe",
          ),
        ).toMatchObject({ allowed: true });
      } finally {
        write.mockRestore();
      }
      const read = vi
        .spyOn(state.storage, "get")
        .mockRejectedValue(new Error(SENTINEL));
      try {
        expect(
          await instance.readEventDiagnostics(f.guestId, f.grant.connectionId),
        ).toBeNull();
      } finally {
        read.mockRestore();
      }
    });
    expect(await f.stub.recordEventDiagnostics([f.record(1)], f.scope)).toBe(
      true,
    );
    expect(await f.read()).toMatchObject({
      records: [f.record(1)],
      scopeMatches: true,
    });
    expect(JSON.stringify(await f.read())).not.toContain(SENTINEL);
  });

  it("projects runtime classifications without raw identifiers or malformed environment values", async () => {
    const f = await fixture(mode);
    const actor = { guestId: f.guestId, connectionId: f.grant.connectionId };
    expect(
      eventDiagnosticContext(f.overlay, actor, f.policy.tableIds[0]),
    ).toMatchObject({
      policyConfigured: true,
      policyActive: true,
      recipientMatched: true,
      tableAllowed: true,
    });
    expect(eventDiagnosticContext(f.overlay, actor).tableAllowed).toBeNull();
    expect(
      eventDiagnosticContext(f.overlay, actor, crypto.randomUUID())
        .tableAllowed,
    ).toBe(false);
    const safe = eventDiagnosticContext(
      {
        ...f.overlay,
        RELEASE_ENVIRONMENT: SENTINEL,
        RELEASE_PROFILE: SENTINEL,
        RELEASE_BUILD_SHA: SENTINEL,
      },
      actor,
    );
    expect(safe).toMatchObject({
      environment: "unknown",
      profile: "unknown",
      buildSha: null,
      policyConfigured: false,
      policyActive: false,
    });
    const encoded = JSON.stringify(safe);
    for (const secret of [
      SENTINEL,
      f.guestId,
      f.grant.connectionId,
      f.policy.tableIds[0],
      f.policy.approvalRef,
    ]) {
      expect(encoded).not.toContain(secret);
    }
  });
});

describe("private delivery diagnostic stop boundaries", () => {
  it("rejects new batches while paused but retains exact-policy records for fresh reads", async () => {
    const f = await fixture("a-only");
    const record = f.record();
    expect(await f.stub.recordEventDiagnostics([record], f.scope)).toBe(true);
    const stored = await f.stored();
    await f.configure({ ALLOW_OUTBOUND_NOTIFICATIONS: "false" });
    expect(await f.stub.recordEventDiagnostics([f.record(1)], f.scope)).toBe(
      false,
    );
    expect(await f.stored()).toEqual(stored);
    expect(await f.read()).toMatchObject({
      records: [record],
      scopeMatches: true,
      context: { policyConfigured: true, policyActive: false },
    });
  });

  it.each(["pause", "expiry"] as const)(
    "rejects a write when %s occurs during policy hashing",
    async (stop) => {
      const f = await fixture("a-only");
      expect(await f.stub.recordEventDiagnostics([f.record()], f.scope)).toBe(
        true,
      );
      const stored = await f.stored();
      await runInDurableObject(f.stub, async (instance) => {
        const harness = instance as unknown as { env: Env };
        const original = crypto.subtle.digest.bind(crypto.subtle);
        const clock = vi.spyOn(Date, "now");
        const hashing = vi
          .spyOn(crypto.subtle, "digest")
          .mockImplementation(async (algorithm, data) => {
            const digest = await original(algorithm, data);
            if (stop === "pause") {
              harness.env = {
                ...harness.env,
                ALLOW_OUTBOUND_NOTIFICATIONS: "false",
              };
            } else {
              clock.mockReturnValue(Date.parse(f.policy.expiresAt));
            }
            return digest;
          });
        try {
          expect(
            await instance.recordEventDiagnostics([f.record(1)], f.scope),
          ).toBe(false);
        } finally {
          hashing.mockRestore();
          clock.mockRestore();
        }
      });
      expect(await f.stored()).toEqual(stored);
      expect(await f.read()).toMatchObject({
        records: [f.record()],
        scopeMatches: true,
      });
    },
  );
});
