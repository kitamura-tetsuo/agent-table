import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createTable, getTable, postMessage } from "../../src/services/tables";
import { authorizeGuestConnection } from "../../src/shared/auth";

async function syntheticTable() {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const grant = await guest.createConnection(
    session.sessionId,
    session.secret,
    ["tables:read", "tables:write"],
    Date.now() + 60_000,
  );
  if (!grant) throw new Error("Synthetic grant unavailable");
  const decision = await authorizeGuestConnection(
    env,
    guestId,
    grant.connectionId,
    "tables:write",
  );
  if (!decision.allowed) throw new Error("Synthetic actor unavailable");
  const actor = decision.actor;
  const readDecision = await authorizeGuestConnection(
    env,
    guestId,
    grant.connectionId,
    "tables:read",
  );
  if (!readDecision.allowed) throw new Error("Synthetic reader unavailable");
  const created = await createTable(env, actor, {
    request_id: "telemetry_synthetic_creation_0001",
    title: "Synthetic private title - never log",
  });
  if (!created.ok) throw new Error("Synthetic table unavailable");
  const table = env.TABLES.get(env.TABLES.idFromName(created.value.tableId));
  return {
    actor,
    readActor: readDecision.actor,
    table,
    tableId: created.value.tableId,
  };
}

async function storedCounts(
  table: Awaited<ReturnType<typeof syntheticTable>>["table"],
) {
  return runInDurableObject(table, async (_instance, state) => ({
    messages: state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM table_messages")
      .one().count,
    receipts: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM table_post_receipts",
      )
      .one().count,
    databaseBytes: state.storage.sql.databaseSize,
  }));
}

describe("synthetic local telemetry workloads", () => {
  it("measures a quiet table without claiming absent host/stream observations", async () => {
    const fixture = await syntheticTable();
    const metadata = await getTable(env, fixture.readActor, fixture.tableId);
    expect(metadata.ok).toBe(true);
    const counts = await storedCounts(fixture.table);
    expect(counts.messages).toBe(0);
    expect(counts.receipts).toBe(0);
    expect(counts.databaseBytes).toBeGreaterThan(0);
    console.log(
      JSON.stringify({
        profile: "quiet",
        runtime: "local-workerd",
        observedTableReads: 1,
        observedMessages: counts.messages,
        observedReceipts: counts.receipts,
        observedDatabaseBytes: counts.databaseBytes,
        unavailable: ["billed-cpu", "stream", "outbox", "host-run"],
      }),
    );
  });

  it("matches active-post observations to authoritative SQLite rows", async () => {
    const fixture = await syntheticTable();
    const first = {
      request_id: "telemetry_synthetic_post_00001",
      body: "synthetic-only-private-body-one",
    };
    const second = {
      request_id: "telemetry_synthetic_post_00002",
      body: "synthetic-only-private-body-two",
    };
    const firstResult = await postMessage(
      env,
      fixture.actor,
      fixture.tableId,
      first,
    );
    const secondResult = await postMessage(
      env,
      fixture.actor,
      fixture.tableId,
      second,
    );
    const repeated = await postMessage(
      env,
      fixture.actor,
      fixture.tableId,
      first,
    );
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(repeated).toEqual(firstResult);
    const counts = await storedCounts(fixture.table);
    expect(counts.messages).toBe(2);
    expect(counts.receipts).toBe(2);
    console.log(
      JSON.stringify({
        profile: "active",
        runtime: "local-workerd",
        observedPostAttempts: 3,
        observedCommittedMessages: counts.messages,
        observedReceipts: counts.receipts,
        observedDatabaseBytes: counts.databaseBytes,
        unavailable: ["billed-cpu", "stream", "outbox", "host-run"],
      }),
    );
  });
});
