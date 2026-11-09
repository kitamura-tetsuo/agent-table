import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { VerifiedConnectionActor } from "../../src/shared/auth";
import { authorizeGuestConnection } from "../../src/shared/auth";

const ORIGIN = "http://localhost:8787";
const context = {} as ExecutionContext;
const CSRF_NAME = "__Host-agent_table_csrf";

function dispatch(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(ORIGIN + path, init) as Parameters<typeof worker.fetch>[0],
    env,
    context,
  );
}

async function guest() {
  const id = crypto.randomUUID();
  const stub = env.GUESTS.get(env.GUESTS.idFromName(id));
  const session = await stub.createSession(id);
  const cookie =
    "__Host-agent_table_session=v1." +
    id +
    "." +
    session.sessionId +
    "." +
    session.secret;
  const grant = await stub.createConnection(
    session.sessionId,
    session.secret,
    ["tables:read", "tables:write"],
    Date.now() + 30 * 60_000,
  );
  if (!grant) throw new Error("Missing synthetic grant");
  const connectionId = grant.connectionId;
  async function actor(
    scope: "tables:write" | "tables:read",
  ): Promise<VerifiedConnectionActor> {
    const result = await authorizeGuestConnection(env, id, connectionId, scope);
    if (!result.allowed) throw new Error("Missing synthetic actor");
    return result.actor;
  }
  return { id, stub, session, cookie, actor };
}

async function fixture() {
  const owner = await guest();
  const joined = await guest();
  const stranger = await guest();
  const writer = await owner.actor("tables:write");
  const input = {
    request_id: "manual_join_creation_0001",
    title: "Private <script>title</script>",
  };
  const reservation = await owner.stub.reserveCreation(writer, input);
  if (!reservation.ok) throw new Error("Failed to reserve synthetic table");
  const id = reservation.reservation.tableId;
  const table = env.TABLES.get(env.TABLES.idFromName(id));
  const created = await table.initializeTable(
    writer,
    input,
    reservation.reservation,
  );
  if (!created.ok) throw new Error("Failed to initialize synthetic table");
  const posted = await table.postMessage(writer, {
    request_id: "manual_join_before_join_0001",
    body: "History before the second person joins",
  });
  if (!posted.ok) throw new Error("Failed to post pre-join history");
  const issued = await table.issueInvite(writer, "manual_join_issue_0001");
  if (!issued.ok) throw new Error("Failed to issue synthetic invitation");
  return { owner, joined, stranger, id, table, issued: issued.value };
}

function formPost(
  cookie: string,
  csrf: string,
  invitation: string,
  requestId = "manual_join_request_0001",
  origin = ORIGIN,
) {
  return dispatch("/join", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf, invitation, request_id: requestId }),
  });
}

describe("fragment-only browser invitation join against real GuestDO and TableDO", () => {
  it("keeps preview safe and joins only after an authenticated same-origin CSRF decision", async () => {
    const f = await fixture();
    const { invitation, landingUrl } = f.issued;
    expect(landingUrl).toBe(`${ORIGIN}/join#${invitation}`);
    const preview = await dispatch("/join", { method: "GET" });
    expect(preview.status).toBe(200);
    expect(await preview.text()).not.toContain(invitation);
    expect(preview.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(preview.headers.get("Cache-Control")).toBe("no-store");
    expect(preview.headers.get("Content-Security-Policy")).toContain(
      "connect-src 'none'",
    );
    const head = await dispatch("/join", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const query = await dispatch(
      `/join?invitation=${encodeURIComponent(invitation)}`,
    );
    expect(query.status).toBe(400);
    expect(await query.text()).not.toContain(invitation);
    expect(
      await f.table.getMetadata(await f.owner.actor("tables:read")),
    ).toMatchObject({ ok: true, value: { state: "waiting" } });
    const strangerRead = await f.table.getMetadata(
      await f.stranger.actor("tables:read"),
    );
    expect(strangerRead).toEqual({ ok: false, code: "TABLE_NOT_FOUND" });

    const page = await dispatch("/join", {
      headers: { Cookie: f.joined.cookie },
    });
    const body = await page.text();
    expect(page.status).toBe(200);
    expect(body).toContain("including messages posted before you join");
    expect(body).toContain("not end-to-end encrypted");
    expect(body).not.toContain(invitation);
    expect(body).toContain('src="/join.js"');
    const csrf = body.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
    const csrfCookie = page.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${CSRF_NAME}=`))
      ?.split(";")[0];
    if (!csrf || !csrfCookie) throw new Error("Missing join CSRF cookie");
    const bothCookies = `${f.joined.cookie}; ${csrfCookie}`;

    const denied = await formPost(
      bothCookies,
      csrf,
      invitation,
      "manual_join_request_0001",
      "https://attacker.invalid",
    );
    expect(denied.status).toBe(403);
    const deniedCsrf = await formPost(bothCookies, "x".repeat(43), invitation);
    expect(deniedCsrf.status).toBe(403);
    const anon = await formPost(csrfCookie, csrf, invitation);
    expect(anon.status).toBe(401);
    const forged = await f.table.redeemBrowserInvite(
      {
        guestId: f.joined.id,
        sessionId: f.joined.session.sessionId,
        secret: "bad-secret",
      },
      invitation,
      "manual_join_request_0001",
    );
    expect(forged).toEqual({ ok: false, code: "INVITATION_INVALID" });
    expect(
      await f.table.getMetadata(await f.owner.actor("tables:read")),
    ).toMatchObject({ ok: true, value: { state: "waiting" } });

    const accepted = await formPost(bothCookies, csrf, invitation);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain("Joining committed");
    const retried = await formPost(bothCookies, csrf, invitation);
    expect(retried.status).toBe(200);
    expect(
      await f.table.getMetadata(await f.owner.actor("tables:read")),
    ).toMatchObject({
      ok: true,
      value: { state: "open", memberships: [{ seat: 1 }, { seat: 2 }] },
    });
    const previousHistory = await f.table.readMessages(
      await f.joined.actor("tables:read"),
      {},
    );
    expect(previousHistory).toMatchObject({
      ok: true,
      value: { messages: [{ body: "History before the second person joins" }] },
    });
    const tooLate = await f.table.redeemBrowserInvite(
      {
        guestId: f.stranger.id,
        sessionId: f.stranger.session.sessionId,
        secret: f.stranger.session.secret,
      },
      invitation,
      "manual_join_stranger_0001",
    );
    expect(tooLate).toEqual({ ok: false, code: "INVITATION_INVALID" });
    expect(
      (await f.table.getMetadata(await f.stranger.actor("tables:read"))).ok,
    ).toBe(false);
  });
});
