import { env, exports } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

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

/** Obtain a real OAuth consented read token and use the pinned official SDK. */
async function readWithOfficialSdk(cookie: string, tableId: string) {
  const redirect = "https://client.example/callback";
  const resource = ORIGIN + "/mcp";
  const registration = await exports.default.fetch(ORIGIN + "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Browser-created table readback",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registration.status).toBe(201);
  const clientId = String(
    ((await registration.json()) as { client_id: string }).client_id,
  );
  const verifier = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...hash))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const authorization = new URL(ORIGIN + "/authorize");
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope: "tables:read",
    state: "browser_creation_readback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }))
    authorization.searchParams.set(name, value);
  const consent = await exports.default.fetch(authorization.toString(), {
    headers: { Cookie: cookie },
  });
  expect(consent.status).toBe(200);
  const consentHtml = await consent.text();
  const hidden = (name: string) =>
    new RegExp('name="' + name + '" type="hidden" value="([^"]+)"').exec(
      consentHtml,
    )?.[1];
  const handle = hidden("handle");
  const csrf = hidden("csrf");
  const binding = hidden("binding");
  const guestId = hidden("guest_id");
  if (!handle || !csrf || !binding || !guestId)
    throw new Error("OAuth consent fields unavailable");
  const consentCookies = consent.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]);
  const approved = await exports.default.fetch(ORIGIN + "/authorize", {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: [cookie, ...consentCookies].join("; "),
    },
    body: new URLSearchParams([
      ["handle", handle],
      ["csrf", csrf],
      ["guest_id", guestId],
      ["binding", binding],
      ["decision", "approve"],
      ["scope", "tables:read"],
    ]),
  });
  expect(approved.status).toBe(302);
  const code = new URL(
    approved.headers.get("Location") ?? redirect,
  ).searchParams.get("code");
  if (!code) throw new Error("OAuth code missing");
  const exchanged = await exports.default.fetch(ORIGIN + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
      resource,
    }),
  });
  expect(exchanged.status).toBe(200);
  const token = String(
    ((await exchanged.json()) as { access_token: string }).access_token,
  );
  const sdk = new Client(
    { name: "browser-created-table-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await sdk.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      authProvider: { token: async () => token },
      fetch: (url, init) => {
        const request = new Request(url, init);
        request.headers.set("Host", new URL(request.url).host);
        return exports.default.fetch(request);
      },
    }),
  );
  try {
    const read = await sdk.callTool({
      name: "get_table",
      arguments: { table_id: tableId },
    });
    expect(read.isError).not.toBe(true);
    const block = read.content.find((part) => part.type === "text");
    if (block?.type !== "text") throw new Error("SDK readback missing text");
    return JSON.parse(block.text) as Record<string, unknown>;
  } finally {
    await sdk.close();
  }
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

    // The official SDK independently reads durable state after real OAuth consent.
    expect(await readWithOfficialSdk(owner.cookie, id)).toMatchObject({
      tableId: id,
      state: "waiting",
      title: "Private <script>alert(1)</script>",
    });
    // OAuth consent rotates the guest browser session, invalidating its old cookie.
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

  it("preserves admission pause before any browser reservation", async () => {
    const owner = await browserGuest();
    const form = await createForm(owner.cookie);
    const paused = { ...env, ALLOW_NEW_TABLES: "false" } as Env;
    const response = await dispatch(
      "/guest/create",
      {
        method: "POST",
        headers: {
          Cookie: form.cookies,
          Origin: ORIGIN,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          csrf: form.csrf,
          request_id: form.key,
          title: "Not created",
          purpose: "",
          ttl_seconds: "86400",
        }),
      },
      paused,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("ADMISSION_DISABLED");
    expect(
      await owner.stub.getCreationReservation(
        {
          guestId: owner.id,
          sessionId: owner.session.sessionId,
          secret: owner.session.secret,
        },
        form.key,
      ),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
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
