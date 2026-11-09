import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { authorizeGuestConnection } from "../../src/shared/auth";

const ORIGIN = "http://localhost:8787";
const CSRF_NAME = "__Host-agent_table_csrf";
const context = {} as ExecutionContext;

function dispatch(path: string, init?: RequestInit, bindings = env) {
  return worker.fetch(
    new Request(ORIGIN + path, init) as Parameters<typeof worker.fetch>[0],
    bindings,
    context,
  );
}

async function browserGuest() {
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
  return { id, stub, session, cookie };
}

async function createForm(cookie: string) {
  const response = await dispatch("/guest/create", {
    headers: { Cookie: cookie },
  });
  const html = await response.text();
  const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
  const key = html.match(/name="request_id" value="([0-9a-f-]{36})"/)?.[1];
  const csrfCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(CSRF_NAME + "="))
    ?.split(";")[0];
  if (!csrf || !key || !csrfCookie)
    throw new Error("Missing browser creation form security fields");
  return { response, html, csrf, key, cookies: cookie + "; " + csrfCookie };
}

function createPost(
  cookies: string,
  csrf: string,
  key: string,
  title = "Private <script>alert(1)</script>",
  purpose = "Deliberate disclosure only",
  origin = ORIGIN,
  extra?: Record<string, string>,
) {
  return dispatch("/guest/create", {
    method: "POST",
    headers: {
      Cookie: cookies,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      csrf,
      request_id: key,
      title,
      purpose,
      ttl_seconds: "86400",
      ...extra,
    }),
  });
}

describe("browser table creation via shared GuestDO/TableDO authority", () => {
  it("creates from a session without a preexisting OAuth grant and replays the original key", async () => {
    const owner = await browserGuest();
    const stranger = await browserGuest();
    expect((await dispatch("/guest/create")).status).toBe(401);
    const form = await createForm(owner.cookie);
    expect(form.response.status).toBe(200);
    expect(form.html).toContain("not end-to-end encrypted");
    expect(form.html).toContain("entire transcript");
    expect(form.response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(
      (
        await createPost(
          form.cookies,
          form.csrf,
          form.key,
          "Private",
          "Purpose",
          "https://attacker.invalid",
        )
      ).status,
    ).toBe(403);
    expect((await createPost(owner.cookie, form.csrf, form.key)).status).toBe(
      403,
    );
    expect(
      (
        await createPost(
          form.cookies,
          form.csrf,
          form.key,
          "Private",
          "Purpose",
          ORIGIN,
          { forged: "yes" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await createPost(form.cookies, form.csrf, form.key, "   ")).status,
    ).toBe(409);

    const created = await createPost(form.cookies, form.csrf, form.key);
    expect(created.status).toBe(200);
    const html = await created.text();
    const id = html.match(/\/guest\/table\?table_id=([0-9a-f-]{36})/)?.[1];
    if (!id) throw new Error("Browser creation did not commit a table");
    expect(html).toContain("Table creation committed");
    expect(html).not.toContain("<script");
    const table = env.TABLES.get(env.TABLES.idFromName(id));
    const view = await table.getBrowserMetadata({
      guestId: owner.id,
      sessionId: owner.session.sessionId,
      secret: owner.session.secret,
    });
    expect(view).toMatchObject({
      ok: true,
      value: {
        tableId: id,
        title: "Private <script>alert(1)</script>",
        state: "waiting",
      },
    });
    expect(
      (
        await table.getBrowserMetadata({
          guestId: stranger.id,
          sessionId: stranger.session.sessionId,
          secret: stranger.session.secret,
        })
      ).ok,
    ).toBe(false);

    const same = await createPost(form.cookies, form.csrf, form.key);
    expect(same.status).toBe(200);
    expect(await same.text()).toContain("table_id=" + id);
    const mismatch = await createPost(
      form.cookies,
      form.csrf,
      form.key,
      "A different title",
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.text()).toContain("IDEMPOTENCY_CONFLICT");

    // An independently authorized connection observes the same committed table.
    const grant = await owner.stub.createConnection(
      owner.session.sessionId,
      owner.session.secret,
      ["tables:read"],
      Date.now() + 60_000,
    );
    if (!grant) throw new Error("Failed to issue independent read grant");
    const decision = await authorizeGuestConnection(
      env,
      owner.id,
      grant.connectionId,
      "tables:read",
    );
    if (!decision.allowed) throw new Error("Grant was not verified");
    expect(await table.getMetadata(decision.actor)).toMatchObject({
      ok: true,
      value: { tableId: id, state: "waiting" },
    });

    expect(
      await owner.stub.invalidateSession(
        owner.session.sessionId,
        owner.session.secret,
      ),
    ).toBe(true);
    expect((await createPost(form.cookies, form.csrf, form.key)).status).toBe(
      401,
    );
  });

  it("accepts the full Unicode code-point limits through a bounded form", async () => {
    const owner = await browserGuest();
    const form = await createForm(owner.cookie);
    const title = "😀".repeat(120);
    const purpose = "🌿".repeat(2000);
    const result = await createPost(
      form.cookies,
      form.csrf,
      form.key,
      title,
      purpose,
    );
    expect(result.status).toBe(200);
    expect(await result.text()).toContain("Table creation committed");
    const reservation = await owner.stub.getCreationReservation(
      {
        guestId: owner.id,
        sessionId: owner.session.sessionId,
        secret: owner.session.secret,
      },
      form.key,
    );
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;
    const table = env.TABLES.get(
      env.TABLES.idFromName(reservation.reservation.tableId),
    );
    const metadata = await table.getBrowserMetadata({
      guestId: owner.id,
      sessionId: owner.session.sessionId,
      secret: owner.session.secret,
    });
    expect(metadata).toMatchObject({
      ok: true,
      value: { title, purpose },
    });
  });

  it("does not spend a creation reservation for a forged browser credential", async () => {
    const owner = await browserGuest();
    const forged = {
      guestId: owner.id,
      sessionId: owner.session.sessionId,
      secret: "X".repeat(43),
    };
    const input = { request_id: crypto.randomUUID(), title: "Forbidden" };
    const denied = await owner.stub.reserveCreation(forged, input);
    expect(denied).toEqual({ ok: false, code: "UNAUTHORIZED" });
    const authorized = await owner.stub.reserveCreation(
      {
        guestId: owner.id,
        sessionId: owner.session.sessionId,
        secret: owner.session.secret,
      },
      input,
    );
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    const table = env.TABLES.get(
      env.TABLES.idFromName(authorized.reservation.tableId),
    );
    expect(
      await table.initializeTable(forged, input, authorized.reservation),
    ).toEqual({ ok: false, code: "INVALID_RESERVATION" });
    expect(
      (
        await table.initializeTable(
          {
            guestId: owner.id,
            sessionId: owner.session.sessionId,
            secret: owner.session.secret,
          },
          input,
          authorized.reservation,
        )
      ).ok,
    ).toBe(true);
  });
});
