import { describe, expect, it, vi } from "vitest";
import {
  handleStagingEvidence,
  requestFingerprint,
} from "../../src/evidence/staging";
import worker from "../../src/index";

const GUEST = "9fff5657-a730-4571-84a8-1d0c752b8cfb";
const TABLE = "36c4b87f-28a7-43bc-aeb2-a263c276cbd1";
const CONNECTION = "6d4027a2-ce03-41e3-9d7c-893c53b3b108";
const SECRET = "a".repeat(64);
const STAGING = "https://agent-table-test.outliner-online.com";
const guestRead = vi.fn(async () => ({
  identityMatches: true,
  recentConnections: [
    {
      connectionFingerprint: "f".repeat(24),
      state: "active",
      scopes: ["tables:read"],
    },
  ],
  connection: { exists: true, state: "revoked" },
  creationReservation: { exists: true, outcome: "initialized" },
}));
const tableRead = vi.fn(async () => ({
  metadataExists: true,
  creatorMatchesGuest: true,
  seatOneCreatorMatchesGuest: true,
}));
const bindings = {
  PUBLIC_ORIGIN: STAGING,
  RELEASE_ENVIRONMENT: "staging",
  RESTORE_QUARANTINE: "false",
  RELEASE_PROFILE: "manual",
  RELEASE_BUILD_SHA: "a".repeat(40),
  ENABLE_MCP_SUBSCRIPTIONS: "false",
  ENABLE_OPENAI_EVENTS: "false",
  ALLOW_OUTBOUND_NOTIFICATIONS: "false",
  STAGING_EVIDENCE_MODE: "read-only",
  STAGING_EVIDENCE_KEY: SECRET,
  GUESTS: {
    idFromName: (id: string) => id,
    get: () => ({ readStagingEvidence: guestRead }),
  },
  TABLES: {
    idFromName: (id: string) => id,
    get: () => ({ readStagingEvidence: tableRead }),
  },
} as unknown as Env;

function probe(
  env: Env = bindings,
  data: unknown = { guestId: GUEST, tableId: TABLE, connectionId: CONNECTION },
  secret: string | null = SECRET,
  method = "POST",
) {
  return handleStagingEvidence(
    new Request(`${STAGING}/__staging/evidence`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Agent-Table-Staging-Evidence": secret } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(data) } : {}),
    }),
    env,
  );
}

describe("staging-only SQLite evidence inspection", () => {
  it("is unreachable on production/local or when disabled, even with the secret", async () => {
    for (const env of [
      { ...bindings, PUBLIC_ORIGIN: "https://agent-table.outliner-online.com" },
      { ...bindings, STAGING_EVIDENCE_MODE: "off" },
      { ...bindings, STAGING_EVIDENCE_KEY: undefined },
    ] as Env[]) {
      const response = await probe(env);
      expect(response.status).toBe(env.STAGING_EVIDENCE_KEY ? 404 : 401);
    }
  });

  it("rejects alternate hostnames and bypasses protocol admission when off", async () => {
    const alienHost = new Request(
      "https://agent-table-staging.kitamura-tetsuo.workers.dev/__staging/evidence",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-Table-Staging-Evidence": SECRET,
        },
        body: JSON.stringify({ guestId: GUEST }),
      },
    );
    expect((await handleStagingEvidence(alienHost, bindings)).status).toBe(404);
    const disabled = { ...bindings, STAGING_EVIDENCE_MODE: "off" } as Env;
    const response = await worker.fetch(
      new Request(`${STAGING}/__staging/evidence`, {
        method: "POST",
      }) as Parameters<typeof worker.fetch>[0],
      disabled,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);

    // Recovery isolation takes precedence even over a disabled diagnostic route.
    const quarantined = {
      ...bindings,
      STAGING_EVIDENCE_MODE: "off",
      RESTORE_QUARANTINE: "true",
    } as Env;
    const recoveryResponse = await worker.fetch(
      new Request(`${STAGING}/__staging/evidence`, {
        method: "POST",
      }) as Parameters<typeof worker.fetch>[0],
      quarantined,
      {} as ExecutionContext,
    );
    expect(recoveryResponse.status).toBe(503);
  });

  it("requires a full constant-time fixed-size secret and POST", async () => {
    expect((await probe(bindings, {}, null)).status).toBe(401);
    expect((await probe(bindings, {}, "b".repeat(64))).status).toBe(401);
    expect((await probe(bindings, {}, "a".repeat(63))).status).toBe(401);
    expect((await probe(bindings, {}, SECRET, "GET")).status).toBe(405);
  });

  it("rejects arbitrary SQL, extra fields and invalid identifiers", async () => {
    for (const data of [
      { guestId: GUEST, query: "SELECT * FROM guest_sessions" },
      { guestId: GUEST, tableId: "not-a-uuid" },
      { guestId: "not-a-uuid" },
      { guestId: GUEST, connectionId: "0".repeat(1000) },
    ]) {
      expect((await probe(bindings, data)).status).toBe(
        JSON.stringify(data).length > 512 ? 413 : 400,
      );
    }
  });

  it("joins only sanitized results and prevents cache/log-sensitive response values", async () => {
    guestRead.mockClear();
    tableRead.mockClear();
    const response = await probe();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(guestRead).toHaveBeenCalledWith(GUEST, TABLE, CONNECTION);
    expect(tableRead).toHaveBeenCalledWith(TABLE, GUEST);
    const raw = await response.text();
    for (const sensitive of [
      GUEST,
      TABLE,
      CONNECTION,
      SECRET,
      "SELECT",
      "messages",
    ]) {
      expect(raw).not.toContain(sensitive);
    }
    expect(JSON.parse(raw)).toMatchObject({
      evidence: "staging-durable-object-sqlite",
      guestSqlite: {
        identityMatches: true,
        recentConnections: [{ state: "active", scopes: ["tables:read"] }],
        connection: { state: "revoked" },
      },
      tableSqlite: { metadataExists: true, creatorMatchesGuest: true },
    });
  });

  it("fingerprints creation operation IDs without exposing them", async () => {
    const fingerprint = await requestFingerprint(
      "e8beff31-e480-4a44-83cb-a339f9c23f08",
    );
    expect(fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(fingerprint).toBe(
      await requestFingerprint("e8beff31-e480-4a44-83cb-a339f9c23f08"),
    );
    expect(fingerprint).not.toBe(
      await requestFingerprint("39e91398-e0a7-4dfa-a5b1-604bb753176a"),
    );
  });
});

describe("explicit private pilot evidence view", () => {
  function pilot() {
    const now = Date.now();
    const policy = {
      schemaVersion: 1,
      mode: "a-only",
      observationMode: "private-redacted",
      buildSha: "a".repeat(40),
      approvedAt: new Date(now - 3000).toISOString(),
      notBefore: new Date(now - 2000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      approvalRef: "synthetic-observation-review",
      recipientGuestId: GUEST,
      recipientConnectionId: CONNECTION,
      tableIds: [TABLE],
      callbackTargets: [
        { origin: "https://receiver.example.org", pathPrefix: "/" },
      ],
    };
    const read = vi.fn(async () => ({
      schema: "agent-table.private-pilot-snapshot.v1",
      table: { tableId: TABLE },
    }));
    return {
      read,
      policy,
      env: {
        ...bindings,
        RELEASE_PROFILE: "private-pilot-a-only",
        PRIVATE_PILOT_POLICY: JSON.stringify(policy),
        TABLES: {
          idFromName: (id: string) => id,
          get: () => ({ readPrivatePilotEvidence: read }),
        },
      } as unknown as Env,
    };
  }
  const input = {
    guestId: GUEST,
    tableId: TABLE,
    connectionId: CONNECTION,
    view: "private-pilot",
  };

  it("requires the existing secret plus the exact observation policy and explicit view", async () => {
    const f = pilot();
    expect((await probe(f.env, input, null)).status).toBe(401);
    expect((await probe(bindings, input)).status).toBe(404);
    expect(
      (await probe(f.env, { ...input, connectionId: crypto.randomUUID() }))
        .status,
    ).toBe(404);
    expect(
      (await probe(f.env, { ...input, tableId: crypto.randomUUID() })).status,
    ).toBe(404);
    expect(
      (
        await probe(
          {
            ...f.env,
            PRIVATE_PILOT_POLICY: JSON.stringify({
              ...f.policy,
              observationMode: undefined,
            }),
          },
          input,
        )
      ).status,
    ).toBe(404);
    expect(f.read).not.toHaveBeenCalled();
    const response = await probe(f.env, input);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(f.read).toHaveBeenCalledExactlyOnceWith(TABLE, GUEST, CONNECTION);
  });

  it("fails closed on incomplete selectors or diagnostic failures without echoing errors", async () => {
    const f = pilot();
    expect(
      (await probe(f.env, { guestId: GUEST, view: "private-pilot" })).status,
    ).toBe(400);
    f.read.mockRejectedValueOnce(new Error("SENSITIVE CALLBACK/SECRET"));
    const response = await probe(f.env, input);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"unavailable"}');
  });
});
