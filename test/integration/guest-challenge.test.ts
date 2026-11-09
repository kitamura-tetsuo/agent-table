import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  guestChallengeConfiguration,
  verifyGuestChallenge,
} from "../../src/shared/admission";

const ORIGIN = "http://localhost:8787";
const SITE_KEY = "0x4AAAAAAAsyntheticSite";
const TOKEN = "synthetic_token_for_verifier_only";
const required: Env = {
  ...env,
  ALLOW_NEW_GUESTS: "true",
  GUEST_CHALLENGE_MODE: "required",
  TURNSTILE_SITE_KEY: SITE_KEY,
  TURNSTILE_SECRET: "synthetic-secret-not-a-real-credential",
};

describe("server-verified guest admission challenge", () => {
  it("fails closed for missing verifier configuration or unknown mode", () => {
    expect(
      guestChallengeConfiguration({
        ...required,
        TURNSTILE_SECRET: undefined,
      }),
    ).toEqual({ mode: "unavailable" });
    expect(
      guestChallengeConfiguration({
        ...required,
        GUEST_CHALLENGE_MODE: "unexpected",
      }),
    ).toEqual({ mode: "unavailable" });
  });

  it("verifies official Siteverify response fields, rejecting mismatches and outages", async () => {
    const payload = {
      success: true,
      hostname: "localhost",
      action: "create_guest",
      challenge_ts: new Date().toISOString(),
    };
    const verifier = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      // Construct the real Workerd Request: unsupported redirect modes throw.
      expect(
        new Request(
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
          init,
        ).redirect,
      ).toBe("manual");
      const body = init?.body as URLSearchParams;
      expect(body.get("secret")).toBe(required.TURNSTILE_SECRET);
      expect(body.get("response")).toBe(TOKEN);
      return Response.json(payload);
    });
    expect(await verifyGuestChallenge(required, TOKEN, verifier)).toBe(true);
    const redirected = await verifyGuestChallenge(
      required,
      TOKEN,
      async (_url, init) => {
        expect(new Request(_url, init).redirect).toBe("manual");
        return Response.redirect("https://redirect.example.test/verifier", 302);
      },
    );
    expect(redirected).toBe(false);
    for (const change of [
      { hostname: "evil.example" },
      { action: "another_action" },
      { success: false },
      { challenge_ts: new Date(Date.now() - 360_000).toISOString() },
    ]) {
      const responseFetch: typeof fetch = async () =>
        Response.json({
          ...payload,
          ...change,
        });
      expect(await verifyGuestChallenge(required, TOKEN, responseFetch)).toBe(
        false,
      );
    }
    expect(await verifyGuestChallenge(required, "", verifier)).toBe(false);
    expect(
      await verifyGuestChallenge(required, TOKEN, async () => {
        throw new Error("synthetic service outage");
      }),
    ).toBe(false);
  });

  it("bounds Siteverify body bytes and rejects forged lengths", async () => {
    const valid = {
      success: true,
      hostname: "localhost",
      action: "create_guest",
      challenge_ts: new Date().toISOString(),
    };
    const oversized = JSON.stringify({ ...valid, padding: "x".repeat(4_096) });
    const verifier = async () =>
      new Response(oversized, {
        headers: { "Content-Type": "application/json" },
      });
    // The verifier's response would otherwise be accepted despite the padding.
    expect(await verifyGuestChallenge(required, TOKEN, verifier)).toBe(false);

    const shortBody = JSON.stringify(valid);
    const forgedLength = async () =>
      new Response(shortBody, {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "5000",
        },
      });
    expect(
      await verifyGuestChallenge(required, TOKEN, forgedLength),
    ).toBe(false);

    const streamed = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(oversized.slice(0, 100)));
            controller.enqueue(encoder.encode(oversized.slice(100)));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    expect(await verifyGuestChallenge(required, TOKEN, streamed)).toBe(false);
    expect(
      await verifyGuestChallenge(required, TOKEN, async () =>
        Response.json(valid),
      ),
    ).toBe(true);
  });

  it("renders a challenge and refuses missing proof on real guest routes", async () => {
    const page = await worker.fetch(
      new Request(`${ORIGIN}/guest`) as Parameters<typeof worker.fetch>[0],
      required,
      createExecutionContext(),
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-action="create_guest"');
    expect(html).toContain(SITE_KEY);
    expect(page.headers.get("Content-Security-Policy")).toContain(
      "challenges.cloudflare.com",
    );
    const token = html.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
    const cookie = page.headers
      .getSetCookie()
      .find((item) => item.startsWith("__Host-agent_table_csrf="))
      ?.split(";")[0];
    if (!token || !cookie) throw new Error("Expected CSRF not issued");
    const missing = await worker.fetch(
      new Request(`${ORIGIN}/guest/session`, {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          choice: "new",
          csrf: token,
          "cf-turnstile-response": "",
        }),
      }) as Parameters<typeof worker.fetch>[0],
      required,
      createExecutionContext(),
    );
    expect(missing.status).toBe(403);
    expect(missing.headers.has("Set-Cookie")).toBe(false);
    const unknown = await worker.fetch(
      new Request(`${ORIGIN}/guest/session`, {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          choice: "new",
          csrf: token,
          "cf-turnstile-response": TOKEN,
          human: "true",
        }),
      }) as Parameters<typeof worker.fetch>[0],
      required,
      createExecutionContext(),
    );
    expect(unknown.status).toBe(400);
  });
});
