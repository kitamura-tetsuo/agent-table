import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/auth/guest";
import worker from "../../src/index";
import { authorizeGuestConnection, type ConnectionScope } from "../../src/shared/auth";

const ORIGIN = "http://localhost:8787";
const context = {} as ExecutionContext;
const CSRF_NAME = "__Host-agent_table_csrf";

function dispatch(path: string, options?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, options) as Parameters<typeof worker.fetch>[0],
    env,
    context,
  );
}

async function guest() {
  const id = crypto.randomUUID();
  const stub = env.GUESTS.get(env.GUESTS.idFromName(id));
  const session = await stub.createSession(id);
  const grant = await stub.createConnection(
    session.sessionId,
    session.secret,
    ["tables:read", "tables:write", "tables:delete"],
    Date.now() + 10 * 24 * 60 * 60_000,
  );
  if (!grant) throw new Error("Missing test guest grant");
  async function actor(scope: ConnectionScope) {
    const result = await authorizeGuestConnection(env, id, grant.connectionId, scope);
    if (!result.allowed) throw new Error("Missing test actor");
    return result.actor;
  }
  return {
    id,
    stub,
    session,
    actor,
    credential: { guestId: id, sessionId: session.sessionId, secret: session.secret },
    cookie: `${SESSION_COOKIE_NAME}=v1.${id}.${session.sessionId}.${session.secret}`,
  };
}

async function fixture() {
  const owner = await guest();
  const input = {
    request_id: "delete_created_request_0001",
    title: "Synthetic shared content",
  };
  const writer = await owner.actor("tables:write");
  const reserved = await owner.stub.reserveCreation(writer, input);
  if (!reserved.ok) throw new Error("Unable to reserve test table");
  const id = reserved.reservation.tableId;
  const table = env.TABLES.get(env.TABLES.idFromName(id));
  const created = await table.initializeTable(writer, input, reserved.reservation);
  if (!created.ok) throw new Error("Unable to initialize test table");
  const posted = await table.postMessage(writer, {
    request_id: "delete_original_message_0001",
    body: "Only the real shared table holds this",
  });
  if (!posted.ok) throw new Error("Unable to post test message");
  return { owner, writer, id, table, created };
}

async function csrfPage(tableId: string, requestId: string, cookie: string) {
  const path = `/guest/delete?table_id=${tableId}&request_id=${requestId}`;
  const response = await dispatch(path, { headers: { Cookie: cookie } });
  const body = await response.text();
  const token = body.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
  const csrfCookie = response.headers.getSetCookie()
    .find((value) => value.startsWith(`${CSRF_NAME}=`))?.split(";")[0];
  if (!token || !csrfCookie) throw new Error("Missing deletion CSRF challenge");
  return { response, body, token, csrfCookie, path };
}

function confirm(
  tableId: string,
  requestId: string,
  decision: "approve" | "deny",
  ownerCookie: string,
  csrf: Awaited<ReturnType<typeof csrfPage>>,
  overrides?: { origin?: string; csrf?: string; additional?: Record<string, string> },
) {
  const form = new URLSearchParams({
    table_id: tableId,
    request_id: requestId,
    csrf: overrides?.csrf ?? csrf.token,
    decision,
    ...overrides?.additional,
  });
  return dispatch("/guest/delete", {
    method: "POST",
    headers: {
      Cookie: `${ownerCookie}; ${csrf.csrfCookie}`,
      Origin: overrides?.origin ?? ORIGIN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
}

describe("browser-confirmed deletion through real TableDO and GuestDO", () => {
  it("keeps GET and agent initiation read-only, then atomically purges only after a same-guest CSRF POST", async () => {
    const f = await fixture();
    const foreign = await guest();
    const requestId = "browser_shared_delete_0001";
    const deleteActor = await f.owner.actor("tables:delete");
    const pending = await f.table.requestDeletion(deleteActor, requestId);
    expect(pending).toMatchObject({
      ok: true,
      value: { confirmation_required: true },
    });
    expect(await f.table.requestDeletion(deleteActor, requestId)).toEqual(pending);
    const page = await csrfPage(f.id, requestId, f.owner.cookie);
    expect(page.response.status).toBe(200);
    expect(page.body).toContain("both");
    expect(page.body).toContain("Permanently delete");
    expect((await dispatch(page.path, { headers: { Cookie: foreign.cookie } })).status).toBe(404);
    expect((await dispatch(page.path)).status).toBe(401);
    expect((await confirm(f.id, requestId, "approve", f.owner.cookie, page, { origin: "https://evil.example" })).status).toBe(403);
    expect((await confirm(f.id, requestId, "approve", f.owner.cookie, page, { csrf: "invalid" })).status).toBe(403);
    expect((await confirm(f.id, requestId, "approve", foreign.cookie, page)).status).toBe(409);
    expect((await confirm(f.id, requestId, "approve", f.owner.cookie, page, { additional: { confirmed: "true" } })).status).toBe(400);
    expect(
      await f.table.readMessages(await f.owner.actor("tables:read"), {}),
    ).toMatchObject({ ok: true, value: { messages: [{ seq: 1 }] } });
    const approved = await confirm(f.id, requestId, "approve", f.owner.cookie, page);
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("Deletion committed");

    await runInDurableObject(f.table, async (_instance, state) => {
      for (const name of [
        "table_metadata", "table_memberships", "table_invitations",
        "table_messages", "table_post_receipts", "table_delete_confirmations",
      ]) {
        expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${name}`).one()).toEqual({ n: 0 });
      }
      expect(state.storage.sql.exec(
        "SELECT terminal_state FROM table_tombstones",
      ).one()).toEqual({ terminal_state: "deleted" });
      expect(state.storage.sql.exec(
        "SELECT guest_id, request_id FROM table_tombstone_delete_receipts",
      ).one()).toEqual({ guest_id: f.owner.id, request_id: requestId });
    });
    await evictDurableObject(f.table);
    const retry = await confirm(f.id, requestId, "approve", f.owner.cookie, page);
    expect(retry.status).toBe(200);
    expect(await f.table.requestDeletion(deleteActor, requestId)).toEqual({
      ok: true,
      value: { confirmation_required: false, state: "deleted" },
    });
    expect(
      await f.table.readMessages(await f.owner.actor("tables:read"), {}),
    ).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });
  });

  it("a denied or expired five-minute key cannot be extended and direct browser initiation uses the same ledger", async () => {
    const f = await fixture();
    const requestId = "browser_denied_delete_0001";
    const pending = await f.table.requestDeletion(
      await f.owner.actor("tables:delete"), requestId,
    );
    expect(pending.ok).toBe(true);
    const page = await csrfPage(f.id, requestId, f.owner.cookie);
    const denied = await confirm(f.id, requestId, "deny", f.owner.cookie, page);
    expect(denied.status).toBe(200);
    expect((await confirm(f.id, requestId, "approve", f.owner.cookie, page)).status).toBe(200);
    expect(await f.table.requestDeletion(await f.owner.actor("tables:delete"), requestId)).toEqual({
      ok: false, code: "CONFIRMATION_DENIED",
    });
    expect((await f.table.readMessages(await f.owner.actor("tables:read"), {})).ok).toBe(true);

    const direct = await dispatch(`/guest/delete?table_id=${f.id}`, {
      headers: { Cookie: f.owner.cookie },
    });
    expect(direct.status).toBe(200);
    const html = await direct.text();
    const token = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
    const csrfCookie = direct.headers.getSetCookie().find((x) => x.startsWith(`${CSRF_NAME}=`))?.split(";")[0];
    if (!token || !csrfCookie) throw new Error("Missing request CSRF");
    const directRequest = await dispatch("/guest/delete", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Cookie: `${f.owner.cookie}; ${csrfCookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ decision: "request", csrf: token, table_id: f.id }),
    });
    expect(directRequest.status).toBe(303);
    const destination = new URL(directRequest.headers.get("Location") ?? "");
    const directKey = destination.searchParams.get("request_id");
    if (!directKey) throw new Error("Missing issued key");
    expect((await f.table.deletionView(f.owner.id, directKey)).ok).toBe(true);

    const expiredKey = "browser_expiring_delete_0001";
    const expiring = await f.table.requestDeletion(await f.owner.actor("tables:delete"), expiredKey);
    if (!expiring.ok || !expiring.value.confirmation_required) throw new Error("Missing pending key");
    const expiry = Date.parse(expiring.value.expires_at);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(expiry);
      expect(await f.table.requestDeletion(await f.owner.actor("tables:delete"), expiredKey)).toEqual({
        ok: false, code: "CONFIRMATION_EXPIRED",
      });
      expect(await f.table.resolveDeletion(f.owner.credential, expiredKey, "approve")).toEqual({
        ok: false, code: "CONFIRMATION_EXPIRED",
      });
      expect((await f.table.requestDeletion(
        await f.owner.actor("tables:delete"), "browser_fresh_delete_0001",
      )).ok).toBe(true);
      expect((await f.table.readMessages(await f.owner.actor("tables:read"), {})).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a purge failure rolls back content and receipt, and a same-key approval retry can finish", async () => {
    const f = await fixture();
    const key = "browser_failure_retry_0001";
    expect((await f.table.requestDeletion(await f.owner.actor("tables:delete"), key)).ok).toBe(true);
    await runInDurableObject(f.table, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER reject_delete BEFORE DELETE ON table_messages
         BEGIN SELECT RAISE(ABORT, 'injected-delete-failure'); END`,
      );
    });
    await expect(f.table.resolveDeletion(f.owner.credential, key, "approve")).rejects.toThrow();
    await runInDurableObject(f.table, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM table_messages").one()).toEqual({ n: 1 });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM table_tombstones").one()).toEqual({ n: 0 });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM table_delete_confirmations").one()).toEqual({ n: 1 });
      state.storage.sql.exec("DROP TRIGGER reject_delete");
    });
    await evictDurableObject(f.table);
    const [a, b] = await Promise.all([
      f.table.resolveDeletion(f.owner.credential, key, "approve"),
      f.table.resolveDeletion(f.owner.credential, key, "approve"),
    ]);
    expect(a).toEqual({ ok: true, value: { state: "deleted" } });
    expect(b).toEqual({ ok: true, value: { state: "deleted" } });
    await runInDurableObject(f.table, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM table_messages").one()).toEqual({ n: 0 });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM table_tombstone_delete_receipts").one()).toEqual({ n: 1 });
    });
  });
});
