import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/auth/guest";
import worker from "../../src/index";
import {
  closeTable,
  createTable,
  requestTableDeletion,
} from "../../src/services/tables";
import {
  allowNewTables,
  allowOutboundNotifications,
} from "../../src/shared/admission";
import {
  authorizeGuestConnection,
  type ConnectionScope,
} from "../../src/shared/auth";

const ORIGIN = "http://localhost:8787";

function dispatch(
  envForRequest: Env,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, options) as Parameters<
      typeof worker.fetch
    >[0],
    envForRequest,
    createExecutionContext(),
  );
}

describe("public ingress limits and independent emergency controls", () => {
  it("rejects oversized raw HTTP requests before OAuth, DCR, or tool decoding", async () => {
    const application = await dispatch(env, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(32 * 1_024 + 1),
    });
    expect(application.status).toBe(413);
    expect(await application.text()).toBe("Request too large");

    const registration = await dispatch(env, "/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(8 * 1_024 + 1),
    });
    expect(registration.status).toBe(413);

    const authorization = await dispatch(env, "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "x".repeat(8 * 1_024 + 1),
    });
    expect(authorization.status).toBe(413);

    const csrf = await dispatch(env, "/guest/session", {
      method: "POST",
      body: "x".repeat(4 * 1_024 + 1),
    });
    expect(csrf.status).toBe(413);
    const longQuery = await dispatch(env, `/guest?query=${"x".repeat(2_050)}`);
    expect(longQuery.status).toBe(414);
    const cookies = await dispatch(env, "/guest/me", {
      headers: { Cookie: `session=${"x".repeat(8_300)}` },
    });
    expect(cookies.status).toBe(413);
  });

  it("keeps durable close and browser-approved purge available during a new-table pause", async () => {
    expect(allowNewTables(env)).toBe(true);
    expect(allowOutboundNotifications(env)).toBe(false);
    const guestId = crypto.randomUUID();
    const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    const session = await guest.createSession(guestId);
    const grant = await guest.createConnection(
      session.sessionId,
      session.secret,
      ["tables:write", "tables:delete", "tables:read"],
      Date.now() + 24 * 60 * 60_000,
    );
    if (!grant) throw new Error("Test connection grant unavailable");
    const actor = async (scope: ConnectionScope) => {
      const verified = await authorizeGuestConnection(
        env,
        guestId,
        grant.connectionId,
        scope,
      );
      if (!verified.allowed) throw new Error("Test actor unavailable");
      return verified.actor;
    };
    const created = await createTable(env, await actor("tables:write"), {
      request_id: "admission_before_pause_0001",
      title: "Retained during new admission pause",
    });
    if (!created.ok) throw new Error(`Test creation failed: ${created.code}`);
    const tableId = created.value.tableId;
    const paused: Env = {
      ...env,
      ALLOW_NEW_GUESTS: "false",
      ALLOW_NEW_TABLES: "false",
      ALLOW_OUTBOUND_NOTIFICATIONS: "false",
    };
    expect(allowNewTables(paused)).toBe(false);
    const blocked = await createTable(paused, await actor("tables:write"), {
      request_id: "admission_after_pause_0001",
      title: "Never created",
    });
    expect(blocked).toEqual({ ok: false, code: "ADMISSION_DISABLED" });
    await runInDurableObject(guest, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM guest_creation_reservations")
          .one(),
      ).toEqual({ n: 1 });
    });

    const closed = await closeTable(
      paused,
      await actor("tables:write"),
      tableId,
      "admission_close_during_pause_0001",
    );
    expect(closed.ok).toBe(true);
    const requestId = "admission_delete_during_pause_0001";
    const pending = await requestTableDeletion(
      paused,
      await actor("tables:delete"),
      tableId,
      requestId,
    );
    expect(pending).toMatchObject({
      ok: true,
      value: { confirmation_required: true },
    });
    const cookie = `${SESSION_COOKIE_NAME}=v1.${guestId}.${session.sessionId}.${session.secret}`;
    const confirmationPage = await dispatch(
      paused,
      `/guest/delete?table_id=${tableId}&request_id=${requestId}`,
      { headers: { Cookie: cookie } },
    );
    expect(confirmationPage.status).toBe(200);
    const body = await confirmationPage.text();
    const token = body.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
    const csrfCookie = confirmationPage.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-agent_table_csrf="))
      ?.split(";")[0];
    if (!token || !csrfCookie) throw new Error("CSRF challenge missing");
    const approval = await dispatch(paused, "/guest/delete", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Cookie: `${cookie}; ${csrfCookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        table_id: tableId,
        request_id: requestId,
        csrf: token,
        decision: "approve",
      }),
    });
    expect(approval.status).toBe(200);
    expect(await approval.text()).toContain("Deletion committed");
    const table = env.TABLES.get(env.TABLES.idFromName(tableId));
    await runInDurableObject(table, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_metadata")
          .one(),
      ).toEqual({ n: 0 });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM table_tombstone_delete_receipts")
          .one(),
      ).toEqual({ n: 1 });
    });
  });
});
