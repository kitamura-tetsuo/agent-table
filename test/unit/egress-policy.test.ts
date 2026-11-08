import { describe, expect, it, vi } from "vitest";
import {
  callbackTransportReadiness,
  MAX_CALLBACK_REQUEST_BYTES,
  sendVerifiedHttps,
  validateReviewedCallbackDestination,
} from "../../src/notifications/egress";

const reviewed = [
  {
    origin: "https://events.provider.example.org",
    pathPrefix: "/callback",
  },
] as const;

describe("callback egress preflight", () => {
  it("recognizes an exact reviewed origin with an opaque callback path", () => {
    const decision = validateReviewedCallbackDestination(
      "https://events.provider.example.org/callback/sub-opaque-123?challenge=synthetic",
      reviewed,
    );
    expect(decision.ok).toBe(true);
  });

  it("requires explicit root policy for unrelated provider-generated paths", () => {
    const callback =
      "https://events.provider.example.org/opaque/sub-123?key=synthetic";
    expect(validateReviewedCallbackDestination(callback, reviewed).ok).toBe(
      false,
    );
    expect(
      validateReviewedCallbackDestination(callback, [
        { origin: "https://events.provider.example.org", pathPrefix: "/" },
      ]).ok,
    ).toBe(true);
  });

  it("rejects non-canonical review policy rather than broadening it", () => {
    const callback = "https://events.provider.example.org/admin";
    for (const pathPrefix of [
      "/callback/../admin",
      "//admin",
      "/admin?x=1",
      "",
    ]) {
      expect(
        validateReviewedCallbackDestination(callback, [
          { origin: "https://events.provider.example.org", pathPrefix },
        ]).ok,
      ).toBe(false);
    }
  });

  it.each([
    "http://events.provider.example.org/callback",
    "https://events.provider.example.org:444/callback",
    "https://user:pass@events.provider.example.org/callback",
    "https://events.provider.example.org/other",
    "https://events.provider.example.org/callback-impersonator",
    "https://events.provider.example.org.evil.org/callback",
    "https://127.0.0.1/callback",
    "https://[::1]/callback",
    "https://localhost/callback",
    "https://events.provider.example.org./callback",
    "https://events.provider.example.org/callback#fragment",
    "https://events.provider.example.org\\@evil.org/callback",
    " https://events.provider.example.org/callback",
    "https://events.provider.example.org/callback\n",
  ])("rejects an unreviewed or unsupported URL: %s", (url) => {
    expect(validateReviewedCallbackDestination(url, reviewed)).toEqual({
      ok: false,
      reason: "destination-rejected",
    });
  });

  it("exercises the bounded production sender without enabling public Events", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    try {
      expect(
        await sendVerifiedHttps(
          "https://events.provider.example.org/callback/opaque",
          reviewed,
          { method: "POST", body: new Uint8Array([1]) },
        ),
      ).toEqual({
        ok: true,
        status: 200,
        body: new TextEncoder().encode("ok"),
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][1]?.redirect).toBe("manual");
      expect(spy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
      expect(callbackTransportReadiness()).toEqual({
        enabled: false,
        reason: "connection-boundary-unverified",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses redirects and oversized responses without a second fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      spy.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: "http://127.0.0.1" } }),
      );
      const args = [
        "https://events.provider.example.org/callback",
        reviewed,
        { method: "POST" as const, body: new Uint8Array([1]) },
      ] as const;
      expect(await sendVerifiedHttps(...args)).toEqual({
        ok: false,
        reason: "redirect-refused",
      });
      spy.mockResolvedValueOnce(new Response(new Uint8Array(65_537)));
      expect(await sendVerifiedHttps(...args)).toEqual({
        ok: false,
        reason: "response-too-large",
      });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects caller-controlled routing headers before I/O", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      expect(await sendVerifiedHttps(
        "https://events.provider.example.org/callback",
        reviewed,
        {
          method: "POST",
          body: new Uint8Array(),
          headers: { Host: "127.0.0.1" },
        },
      )).toEqual({ ok: false, reason: "invalid-headers" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects oversized request buffers before transport selection", async () => {
    expect(
      await sendVerifiedHttps(
        "https://events.provider.example.org/callback",
        reviewed,
        {
          method: "POST",
          body: new Uint8Array(MAX_CALLBACK_REQUEST_BYTES + 1),
        },
      ),
    ).toEqual({ ok: false, reason: "request-too-large" });
  });

  it("never allows an unreviewed destination, including when disabled", async () => {
    expect(
      await sendVerifiedHttps("https://127.0.0.1/callback", reviewed, {
        method: "POST",
        body: new Uint8Array(),
      }),
    ).toEqual({ ok: false, reason: "destination-rejected" });
  });
});
