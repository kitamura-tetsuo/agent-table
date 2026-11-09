import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/auth/guest";
import worker from "../../src/index";
import { closeTable, createTable } from "../../src/services/tables";
import { allowOutboundNotifications } from "../../src/shared/admission";
import { authorizeGuestConnection } from "../../src/shared/auth";
import {
  isRestoreQuarantined,
  rejectRestoredAccess,
} from "../../src/shared/release-quarantine";

const origin = "http://localhost:8787";

describe("restore quarantine ingress (actual Worker handler)", () => {
  it("denies all ordinary and protocol access in a quarantined release", async () => {
    for (const [path, method] of [
      ["/health", "GET"],
      ["/guest/me", "GET"],
      ["/mcp", "POST"],
      ["/oauth/token", "POST"],
      ["/guest/connections/revoke", "POST"],
      ["/join", "POST"],
    ] as const) {
      const response = await worker.fetch(
        new Request(`${origin}${path}`, { method }) as unknown as Parameters<
          typeof worker.fetch
        >[0],
        { ...env, RELEASE_ENVIRONMENT: "staging", RESTORE_QUARANTINE: "true" },
        createExecutionContext(),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("Service unavailable during recovery");
    }
  });

  it("denies staging or production access if the independent gate is missing or malformed", () => {
    for (const name of ["staging", "production"] as const) {
      expect(
        rejectRestoredAccess({ RELEASE_ENVIRONMENT: name }),
      ).not.toBeNull();
      expect(
        rejectRestoredAccess({
          RELEASE_ENVIRONMENT: name,
          RESTORE_QUARANTINE: "unknown",
        }),
      ).not.toBeNull();
    }
  });

  it("preserves ordinary local development defaults and explicit authorized release mode", () => {
    expect(rejectRestoredAccess({})).not.toBeNull();
    expect(
      rejectRestoredAccess({
        RELEASE_ENVIRONMENT: "local",
        RESTORE_QUARANTINE: "false",
      }),
    ).toBeNull();
    expect(
      rejectRestoredAccess({
        RELEASE_ENVIRONMENT: "staging",
        RESTORE_QUARANTINE: "false",
      }),
    ).toBeNull();
    expect(
      rejectRestoredAccess({
        RELEASE_ENVIRONMENT: "staging",
        RESTORE_QUARANTINE: "true",
      }),
    ).not.toBeNull();
  });
});

async function storedPrivateTable() {
  const guestId = crypto.randomUUID();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const session = await guest.createSession(guestId);
  const connection = await guest.createConnection(
    session.sessionId,
    session.secret,
    ["tables:read", "tables:write", "tables:delete"],
    Date.now() + 60_000,
  );
  if (!connection) throw new Error("Synthetic connection unavailable");
  const writer = await authorizeGuestConnection(
    env,
    guestId,
    connection.connectionId,
    "tables:write",
  );
  const deleter = await authorizeGuestConnection(
    env,
    guestId,
    connection.connectionId,
    "tables:delete",
  );
  if (!writer.allowed || !deleter.allowed)
    throw new Error("Synthetic membership authority unavailable");
  const created = await createTable(env, writer.actor, {
    request_id: "recovery_fixture_create_request_0001",
    title: "Synthetic retained conversation",
  });
  if (!created.ok) throw new Error("Synthetic table creation unavailable");
  const tableId = created.value.tableId;
  const table = env.TABLES.get(env.TABLES.idFromName(tableId));
  const posted = await table.postMessage(writer.actor, {
    request_id: "recovery_fixture_message_0001",
    body: "Synthetic private recovery fixture",
  });
  if (!posted.ok) throw new Error("Synthetic post unavailable");
  const cookie = `${SESSION_COOKIE_NAME}=v1.${guestId}.${session.sessionId}.${session.secret}`;
  return {
    guest,
    table,
    tableId,
    cookie,
    writer: writer.actor,
    deleter: deleter.actor,
  };
}

function dispatchWithBindings(
  path: string,
  bindings: Env,
  options?: RequestInit,
): Promise<Response> {
  return worker.fetch(
    new Request(`${origin}${path}`, options) as Parameters<
      typeof worker.fetch
    >[0],
    bindings,
    createExecutionContext(),
  );
}

describe("retained private state under recovery and normal admission pause", () => {
  it("keeps restored private SQLite rows unreachable after DO eviction and refuses outbound eligibility", async () => {
    const stored = await storedPrivateTable();
    const quarantined: Env = {
      ...env,
      RELEASE_ENVIRONMENT: "staging",
      RESTORE_QUARANTINE: "true",
      ALLOW_OUTBOUND_NOTIFICATIONS: "true",
    };
    expect(isRestoreQuarantined(quarantined)).toBe(true);
    expect(allowOutboundNotifications(quarantined)).toBe(false);

    for (const path of [
      `/guest/table?table_id=${stored.tableId}`,
      `/guest/delete?table_id=${stored.tableId}`,
      "/guest/connections",
    ]) {
      const response = await dispatchWithBindings(path, quarantined, {
        headers: { Cookie: stored.cookie },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    await evictDurableObject(stored.table);
    await evictDurableObject(stored.guest);
    const afterEviction = await dispatchWithBindings(
      `/guest/table?table_id=${stored.tableId}`,
      quarantined,
      { headers: { Cookie: stored.cookie } },
    );
    expect(afterEviction.status).toBe(503);
    await runInDurableObject(stored.table, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ body: string }>("SELECT body FROM table_messages")
          .one().body,
      ).toBe("Synthetic private recovery fixture");
      expect(
        state.storage.sql
          .exec<{ state: string }>("SELECT state FROM table_metadata")
          .one().state,
      ).toBe("waiting");
    });
    for (const flag of [undefined, "unknown", "true"]) {
      expect(
        allowOutboundNotifications({
          ...quarantined,
          RESTORE_QUARANTINE: flag,
        }),
      ).toBe(false);
    }
  });

  it("keeps normal intake pause separate from an authorized close and browser-confirmed erasure", async () => {
    const stored = await storedPrivateTable();
    const paused: Env = {
      ...env,
      RELEASE_ENVIRONMENT: "staging",
      RESTORE_QUARANTINE: "false",
      ALLOW_NEW_GUESTS: "false",
      ALLOW_NEW_TABLES: "false",
      ALLOW_OUTBOUND_NOTIFICATIONS: "false",
    };
    expect(rejectRestoredAccess(paused)).toBeNull();
    expect(
      await createTable(paused, stored.writer, {
        request_id: "recovery_fixture_forbidden_new_table_0001",
        title: "Not admitted",
      }),
    ).toEqual({ ok: false, code: "ADMISSION_DISABLED" });

    const close = await closeTable(
      paused,
      stored.writer,
      stored.tableId,
      "recovery_fixture_close_0001",
    );
    expect(close.ok).toBe(true);
    const requestId = "recovery_fixture_delete_0001";
    const pending = await stored.table.requestDeletion(
      stored.deleter,
      requestId,
    );
    expect(pending).toMatchObject({
      ok: true,
      value: { confirmation_required: true },
    });
    const response = await dispatchWithBindings(
      `/guest/delete?table_id=${stored.tableId}&request_id=${requestId}`,
      paused,
      { headers: { Cookie: stored.cookie } },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
    const csrfCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-agent_table_csrf="))
      ?.split(";")[0];
    if (!csrf || !csrfCookie) throw new Error("Browser confirmation missing");
    const approved = await dispatchWithBindings("/guest/delete", paused, {
      method: "POST",
      headers: {
        Cookie: `${stored.cookie}; ${csrfCookie}`,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        table_id: stored.tableId,
        request_id: requestId,
        csrf,
        decision: "approve",
      }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("Deletion committed");
    await evictDurableObject(stored.table);
    await runInDurableObject(stored.table, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_messages")
          .one(),
      ).toEqual({ n: 0 });
      expect(
        state.storage.sql
          .exec("SELECT terminal_state FROM table_tombstones")
          .one(),
      ).toEqual({ terminal_state: "deleted" });
    });
  });
});

// Exercise real persisted DO rows without mutating the shared local test
// bindings. The test-only receiver inherits the actual instance's storage and
// deadline scheduler while injecting a quarantined release configuration.
function quarantinedAlarmReceiver<T extends { alarm(): Promise<void> }>(
  instance: T,
): T {
  const receiver = Object.create(instance) as T;
  Object.defineProperty(receiver, "env", {
    value: {
      ...env,
      RELEASE_ENVIRONMENT: "staging",
      RESTORE_QUARANTINE: "true",
    },
  });
  return receiver;
}

describe("restore quarantine isolation of Durable Object alarm paths", () => {
  it("does not purge an expired retained table or its private transcript", async () => {
    const stored = await storedPrivateTable();
    await runInDurableObject(stored.table, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE table_metadata SET created_at = ?, expires_at = ? WHERE singleton = 1",
        Date.now() - 2 * 24 * 60 * 60_000,
        Date.now() - 24 * 60 * 60_000,
      );
      const alarm = await state.storage.getAlarm();
      await quarantinedAlarmReceiver(instance).alarm();
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_messages")
          .one(),
      ).toEqual({ n: 1 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_metadata")
          .one(),
      ).toEqual({ n: 1 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_tombstones")
          .one(),
      ).toEqual({ n: 0 });
      expect(await state.storage.getAlarm()).toBe(alarm);
    });
  });

  it("preserves expired guest sessions through a quarantined alarm", async () => {
    const guestId = crypto.randomUUID();
    const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    const session = await guest.createSession(guestId);
    await runInDurableObject(guest, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE guest_sessions SET created_at = ?, expires_at = ? WHERE session_id = ?",
        Date.now() - 31 * 24 * 60 * 60_000,
        Date.now() - 24 * 60 * 60_000,
        session.sessionId,
      );
      const alarm = await state.storage.getAlarm();
      await quarantinedAlarmReceiver(instance).alarm();
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM guest_sessions")
          .one(),
      ).toEqual({ n: 1 });
      expect(await state.storage.getAlarm()).toBe(alarm);
    });
  });
});
