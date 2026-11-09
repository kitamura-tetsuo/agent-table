import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { checkPrincipalAdmission } from "../../src/shared/admission";

const ORIGIN = "http://localhost:8787";

function dispatch(
  environment: Env,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, options) as Parameters<
      typeof worker.fetch
    >[0],
    environment,
    createExecutionContext(),
  );
}

async function createGuest(
  environment: Env,
  csrf: string,
  csrfCookie: string,
  source: string,
  forwardedFor: string,
): Promise<Response> {
  return dispatch(environment, "/guest/session", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Cookie: csrfCookie,
      "CF-Connecting-IP": source,
      "X-Forwarded-For": forwardedFor,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ choice: "new", csrf }),
  });
}

async function admissionStub(environment: Env, identity: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return environment.ADMISSION.get(environment.ADMISSION.idFromName(hash));
}

describe("cross-isolate admission policy", () => {
  it("limits fresh guest HTTP sessions by one edge identity despite guest and forwarding churn", async () => {
    const limited: Env = {
      ...env,
      ALLOW_NEW_GUESTS: "true",
      GUEST_CHALLENGE_MODE: "off",
      EDGE_GUEST_RATE_PER_MINUTE: "2",
    };
    const page = await dispatch(limited, "/guest");
    expect(page.status).toBe(200);
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
    const csrfCookie = page.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-agent_table_csrf="))
      ?.split(";")[0];
    if (!csrf || !csrfCookie) throw new Error("Expected browser CSRF state");

    const ip = "192.0.2.31";
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createGuest(limited, csrf, csrfCookie, ip, `198.51.100.${index + 10}`),
      ),
    );
    expect(results.filter((result) => result.status === 303)).toHaveLength(2);
    expect(results.filter((result) => result.status === 429)).toHaveLength(4);
    const denied = results.find((result) => result.status === 429);
    expect(denied?.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
    expect(await denied?.text()).toBe("RATE_LIMITED");
    expect(denied?.headers.has("Set-Cookie")).toBe(false);

    const stub = await admissionStub(limited, `edge-v1:${ip}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const count = state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM admission_hits WHERE category = 'guest'",
        )
        .one().count;
      expect(count).toBe(2);
    });

    const unrelated = await createGuest(
      limited,
      csrf,
      csrfCookie,
      "192.0.2.32",
      "198.51.100.99",
    );
    expect(unrelated.status).toBe(303);
  });

  it("charges a verified principal across connections and refuses invalid quota config", async () => {
    const principal = crypto.randomUUID();
    const limited: Env = { ...env, PRINCIPAL_RATE_PER_MINUTE: "2" };
    expect(await checkPrincipalAdmission(limited, principal)).toBeNull();
    expect(await checkPrincipalAdmission(limited, principal)).toBeNull();
    const denied = await checkPrincipalAdmission(limited, principal);
    expect(denied?.status).toBe(429);
    expect(denied?.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
    expect(
      await checkPrincipalAdmission(limited, crypto.randomUUID()),
    ).toBeNull();

    const stub = await admissionStub(limited, `principal-v1:${principal}`);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_hits WHERE category = 'application'",
          )
          .one().count,
      ).toBe(2);
    });
    const invalid: Env = { ...env, PRINCIPAL_RATE_PER_MINUTE: "0" };
    expect((await checkPrincipalAdmission(invalid, principal))?.status).toBe(
      503,
    );
  });

  it("charges real DCR, OAuth handshake and invite routes independently after size refusal", async () => {
    const source = "192.0.2.49";
    const limited: Env = {
      ...env,
      EDGE_DCR_RATE_PER_MINUTE: "1",
      EDGE_PROTOCOL_RATE_PER_MINUTE: "1",
      EDGE_INVITATION_RATE_PER_MINUTE: "1",
    };
    const headers = {
      "CF-Connecting-IP": source,
      "X-Forwarded-For": "203.0.113.2",
    };
    const oversized = await dispatch(limited, "/oauth/register", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "x".repeat(8 * 1_024 + 1),
    });
    expect(oversized.status).toBe(413);

    const register = () =>
      dispatch(limited, "/oauth/register", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      });
    const firstDcr = await register();
    expect(firstDcr.status).not.toBe(429);
    const secondDcr = await register();
    expect(secondDcr.status).toBe(429);
    expect(secondDcr.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);

    const token = () =>
      dispatch(limited, "/oauth/token", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=unsupported",
      });
    expect((await token()).status).not.toBe(429);
    expect((await token()).status).toBe(429);

    const join = () => dispatch(limited, "/join", { headers });
    expect((await join()).status).toBe(200);
    expect((await join()).status).toBe(429);

    const stub = await admissionStub(limited, `edge-v1:${source}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ category: string; count: number }>(
          "SELECT category, COUNT(*) AS count FROM admission_hits GROUP BY category ORDER BY category",
        )
        .toArray();
      expect(rows).toEqual([
        { category: "dcr", count: 1 },
        { category: "invitation", count: 1 },
        { category: "protocol", count: 1 },
      ]);
    });
  });

  it("charges protected-resource discovery to the protocol budget", async () => {
    const source = "192.0.2.83";
    const limited: Env = {
      ...env,
      EDGE_PROTOCOL_RATE_PER_MINUTE: "1",
      EDGE_APPLICATION_RATE_PER_MINUTE: "1",
    };
    const headers = { "CF-Connecting-IP": source };
    const discovery = () =>
      dispatch(limited, "/.well-known/oauth-protected-resource/mcp", {
        headers,
      });
    const first = await discovery();
    expect(first.status).not.toBe(429);
    const denied = await discovery();
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
    expect(await denied.text()).toBe("RATE_LIMITED");

    // Discovery and application requests must consume separate quotas.
    const application = () => dispatch(limited, "/mcp", { headers });
    expect((await application()).status).not.toBe(429);
    expect((await application()).status).toBe(429);

    const stub = await admissionStub(limited, `edge-v1:${source}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ category: string; count: number }>(
          "SELECT category, COUNT(*) AS count FROM admission_hits GROUP BY category ORDER BY category",
        )
        .toArray();
      expect(rows).toEqual([
        { category: "application", count: 1 },
        { category: "protocol", count: 1 },
      ]);
    });
  });

  it("meters guest and connection browser reads using a shared edge budget", async () => {
    const source = "192.0.2.84";
    const limited: Env = {
      ...env,
      EDGE_APPLICATION_RATE_PER_MINUTE: "3",
      EDGE_GUEST_RATE_PER_MINUTE: "1",
    };
    const cookie = `__Host-agent_table_session=v1.${crypto.randomUUID()}.${crypto.randomUUID()}.${"A".repeat(43)}`;
    const headers = {
      "CF-Connecting-IP": source,
      "X-Forwarded-For": "198.51.100.40",
      Cookie: cookie,
    };

    expect((await dispatch(limited, "/guest", { headers })).status).toBe(200);
    expect((await dispatch(limited, "/guest/me", { headers })).status).toBe(
      401,
    );
    expect(
      (await dispatch(limited, "/guest/connections", { headers })).status,
    ).toBe(401);

    // A fourth browser read must be refused before more guest-state work.
    const denied = await dispatch(limited, "/", { headers });
    expect(denied.status).toBe(429);
    expect(await denied.text()).toBe("RATE_LIMITED");
    expect(denied.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");

    // Guest creation still has its separate admission category.
    const firstGuest = await dispatch(limited, "/guest/session", {
      method: "POST",
      headers,
    });
    expect(firstGuest.status).toBe(403);
    const secondGuest = await dispatch(limited, "/guest/session", {
      method: "POST",
      headers,
    });
    expect(secondGuest.status).toBe(429);

    const stub = await admissionStub(limited, `edge-v1:${source}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ category: string; count: number }>(
          "SELECT category, COUNT(*) AS count FROM admission_hits GROUP BY category ORDER BY category",
        )
        .toArray();
      expect(rows).toEqual([
        { category: "application", count: 3 },
        { category: "guest", count: 1 },
      ]);
    });
  });

  it("shares an edge budget across equivalent IPv6 source spellings", async () => {
    const limited: Env = { ...env, EDGE_DCR_RATE_PER_MINUTE: "1" };
    const register = (source: string, forwardedFor: string) =>
      dispatch(limited, "/oauth/register", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": source,
          "X-Forwarded-For": forwardedFor,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    const first = await register("2001:0db8:0:0:0:0:0:beef", "198.51.100.10");
    expect(first.status).not.toBe(429);
    const second = await register("2001:db8::beef", "198.51.100.11");
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);

    const stub = await admissionStub(limited, "edge-v1:[2001:db8::beef]");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_hits WHERE category = 'dcr'",
          )
          .one().count,
      ).toBe(1);
    });
  });

  it("buckets malformed edge identities together despite forwarded headers", async () => {
    const limited: Env = { ...env, EDGE_DCR_RATE_PER_MINUTE: "1" };
    const register = (source: string, forwardedFor: string) =>
      dispatch(limited, "/oauth/register", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": source,
          "X-Forwarded-For": forwardedFor,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    const first = await register("deadcafe", "198.51.100.12");
    expect(first.status).not.toBe(429);
    const second = await register("999.999.999.999", "198.51.100.13");
    expect(second.status).toBe(429);

    const stub = await admissionStub(limited, "edge-v1:unknown-source");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_hits WHERE category = 'dcr'",
          )
          .one().count,
      ).toBe(1);
    });
  });

  it("shares a durable Worker-subrequest limit despite x-real-ip and CF-Worker churn", async () => {
    const limited: Env = { ...env, EDGE_DCR_RATE_PER_MINUTE: "2" };
    const register = (source: string, worker: string) =>
      dispatch(limited, "/oauth/register", {
        method: "POST",
        headers: {
          "CF-Worker": worker,
          "CF-Connecting-IP": source,
          "X-Real-IP": source,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    const sourceA = "192.0.2.90";
    const sourceB = "192.0.2.91";
    const sourceC = "192.0.2.92";
    expect((await register(sourceA, "outliner-online.com")).status).not.toBe(
      429,
    );
    expect((await register(sourceB, "other-zone.example")).status).not.toBe(
      429,
    );
    const denied = await register(sourceC, "outliner-online.com");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);

    const workerStub = await admissionStub(
      limited,
      "edge-v1:worker-subrequest",
    );
    await runInDurableObject(workerStub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_hits WHERE category = 'dcr'",
          )
          .one().count,
      ).toBe(2);
    });
    for (const source of [sourceA, sourceB]) {
      const stub = await admissionStub(limited, `edge-v1:${source}`);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM admission_hits WHERE category = 'dcr'",
            )
            .one().count,
        ).toBe(1);
      });
    }
    // Direct traffic from another source has its own budget.
    expect(
      (
        await dispatch(limited, "/oauth/register", {
          method: "POST",
          headers: {
            "CF-Connecting-IP": sourceC,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).not.toBe(429);
  });

  it("does not consume the shared Worker budget when source admission already refused", async () => {
    const limited: Env = { ...env, EDGE_APPLICATION_RATE_PER_MINUTE: "2" };
    // This category is independent of the DCR Worker-budget regression above.
    const attempt = (source: string, workerHeader: boolean) =>
      dispatch(limited, "/mcp", {
        headers: {
          "CF-Connecting-IP": source,
          ...(workerHeader ? { "CF-Worker": "spoofed.example" } : {}),
        },
      });
    const sourceA = "192.0.2.94";
    const sourceB = "192.0.2.95";
    const sourceC = "192.0.2.96";
    expect((await attempt(sourceA, true)).status).not.toBe(429);
    expect((await attempt(sourceA, false)).status).not.toBe(429);
    const sourceDenied = await attempt(sourceA, true);
    expect(sourceDenied.status).toBe(429);
    expect((await attempt(sourceB, true)).status).not.toBe(429);
    const workerDenied = await attempt(sourceC, true);
    expect(workerDenied.status).toBe(429);
    expect(workerDenied.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);

    const workerStub = await admissionStub(
      limited,
      "edge-v1:worker-subrequest",
    );
    await runInDurableObject(workerStub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_hits WHERE category = 'application'",
          )
          .one().count,
      ).toBe(2);
    });
  });

  it("does not let a forged CF-Worker header bypass the direct source budget", async () => {
    const limited: Env = { ...env, EDGE_DCR_RATE_PER_MINUTE: "1" };
    const source = "192.0.2.93";
    const register = (forwardedWorker?: string) =>
      dispatch(limited, "/oauth/register", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": source,
          ...(forwardedWorker ? { "CF-Worker": forwardedWorker } : {}),
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    expect((await register()).status).not.toBe(429);
    const denied = await register("attacker-controlled.example");
    expect(denied.status).toBe(429);
    expect(await denied.text()).toBe("RATE_LIMITED");
  });
  it("rejects oversized DELETE payloads before edge accounting and without reflecting input", async () => {
    const source = "192.0.2.76";
    const limited: Env = { ...env, EDGE_APPLICATION_RATE_PER_MINUTE: "1" };
    const headers = {
      "CF-Connecting-IP": source,
      "Content-Type": "application/json",
    };
    const secretMarker = "synthetic-private-payload-do-not-reflect";
    const oversized = await dispatch(limited, "/mcp", {
      method: "DELETE",
      headers,
      body: secretMarker + "x".repeat(32 * 1_024),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("Cache-Control")).toBe("no-store");
    expect(await oversized.text()).toBe("Request too large");
    expect(oversized.headers.has("Retry-After")).toBe(false);

    const allowed = await dispatch(limited, "/mcp", {
      method: "DELETE",
      headers,
    });
    expect(allowed.status).not.toBe(429);
    const denied = await dispatch(limited, "/mcp", {
      method: "DELETE",
      headers,
    });
    expect(denied.status).toBe(429);
    expect(await denied.text()).toBe("RATE_LIMITED");
    expect(denied.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
    const stub = await admissionStub(limited, `edge-v1:${source}`);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_hits WHERE category = 'application'",
          )
          .one().count,
      ).toBe(1);
    });
  });
});
