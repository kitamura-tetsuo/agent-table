import { describe, expect, it, vi } from "vitest";
import {
  callbackTransportReadiness,
  extractSafeCloudflareErrorCode,
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
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
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
        new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1" },
        }),
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
      expect(
        await sendVerifiedHttps(
          "https://events.provider.example.org/callback",
          reviewed,
          {
            method: "POST",
            body: new Uint8Array(),
            headers: { Host: "127.0.0.1" },
          },
        ),
      ).toEqual({ ok: false, reason: "invalid-headers" });
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

  it("maps deadline abort and network failures to typed outcomes without leaking exceptions", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      vi.useFakeTimers();
      spy.mockImplementationOnce(
        () => new Promise(() => {}), // never resolves until timeout
      );
      const promise = sendVerifiedHttps(
        "https://events.provider.example.org/callback",
        reviewed,
        { method: "POST", body: new Uint8Array([1]) },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const deadlineResult = await promise;
      expect(deadlineResult).toEqual({ ok: false, reason: "deadline" });
    } finally {
      vi.useRealTimers();
    }

    try {
      spy.mockRejectedValueOnce(
        new TypeError("fetch failed: connection refused"),
      );
      const transportErrorResult = await sendVerifiedHttps(
        "https://events.provider.example.org/callback",
        reviewed,
        { method: "POST", body: new Uint8Array([1]) },
      );
      expect(transportErrorResult).toEqual({
        ok: false,
        reason: "transport-error",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("safely extracts Cloudflare 1xxx error code on 5xx responses with diagnostics enabled", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      // 1. Error 1000 in HTML body from Cloudflare edge
      spy.mockResolvedValueOnce(
        new Response(
          '<!DOCTYPE html><html><head><title>DNS points to prohibited IP | Error 1000</title></head><body><div class="cf-error-details"><h1>Error 1000</h1><p>DNS points to prohibited IP</p></div></body></html>',
          {
            status: 530,
            headers: {
              server: "cloudflare",
              "cf-ray": "mock-ray-1000",
            },
          },
        ),
      );
      expect(
        await sendVerifiedHttps(
          "https://events.provider.example.org/callback",
          reviewed,
          { method: "POST", body: new Uint8Array([1]) },
          { diagnostics: true },
        ),
      ).toEqual({
        ok: false,
        reason: "upstream-non-2xx",
        status: 530,
        cfErrorCode: 1000,
      });

      // 2. Error 1016 with cf-error-code header
      spy.mockResolvedValueOnce(
        new Response("origin dns error", {
          status: 530,
          headers: {
            server: "cloudflare",
            "cf-ray": "mock-ray-1016",
            "cf-error-code": "1016",
          },
        }),
      );
      expect(
        await sendVerifiedHttps(
          "https://events.provider.example.org/callback",
          reviewed,
          { method: "POST", body: new Uint8Array([1]) },
          { diagnostics: true },
        ),
      ).toEqual({
        ok: false,
        reason: "upstream-non-2xx",
        status: 530,
        cfErrorCode: 1016,
      });

      // 3. Error 1016 with official cf-error-type header
      spy.mockResolvedValueOnce(
        new Response("origin dns error", {
          status: 530,
          headers: {
            server: "cloudflare",
            "cf-ray": "mock-ray-type-1016",
            "cf-error-type": "1016",
          },
        }),
      );
      expect(
        await sendVerifiedHttps(
          "https://events.provider.example.org/callback",
          reviewed,
          { method: "POST", body: new Uint8Array([1]) },
          { diagnostics: true },
        ),
      ).toEqual({
        ok: false,
        reason: "upstream-non-2xx",
        status: 530,
        cfErrorCode: 1016,
      });

      // 4. Production mode: diagnostics disabled by default ignores cf-error-code
      spy.mockResolvedValueOnce(
        new Response("origin dns error", {
          status: 530,
          headers: {
            server: "cloudflare",
            "cf-ray": "mock-ray-prod",
            "cf-error-code": "1016",
          },
        }),
      );
      expect(
        await sendVerifiedHttps(
          "https://events.provider.example.org/callback",
          reviewed,
          { method: "POST", body: new Uint8Array([1]) },
        ),
      ).toEqual({
        ok: false,
        reason: "upstream-non-2xx",
        status: 530,
      });

      // 5. Generic 5xx without 1xxx code
      spy.mockResolvedValueOnce(
        new Response("internal server error", { status: 500 }),
      );
      expect(
        await sendVerifiedHttps(
          "https://events.provider.example.org/callback",
          reviewed,
          { method: "POST", body: new Uint8Array([1]) },
          { diagnostics: true },
        ),
      ).toEqual({
        ok: false,
        reason: "upstream-non-2xx",
        status: 500,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("distinguishes external origin spoofed error pages from authentic Cloudflare edge errors", async () => {
    // External origin server returns status 530 with spoofed Error 1016 HTML but no Cloudflare headers
    const spoofedResponse = new Response(
      '<!DOCTYPE html><html><body><div class="cf-error-code">1016</div></body></html>',
      {
        status: 530,
        headers: {
          server: "Apache/2.4.41 (Ubuntu)",
        },
      },
    );
    expect(
      await extractSafeCloudflareErrorCode(spoofedResponse),
    ).toBeUndefined();

    // Authenticated Cloudflare edge response returns 1016
    const authenticResponse = new Response(
      '<!DOCTYPE html><html><body><div class="cf-error-code">1016</div></body></html>',
      {
        status: 530,
        headers: {
          server: "cloudflare",
          "cf-ray": "authentic-ray-1016",
        },
      },
    );
    expect(await extractSafeCloudflareErrorCode(authenticResponse)).toBe(1016);
  });

  it("bounds 5xx diagnostic reading against huge chunks, infinite streams, and stream aborts", async () => {
    // 1. Huge single chunk (1 MiB): parsed only first 4 KiB, stream cancelled immediately
    let streamCancelled = false;
    const hugeChunk = new Uint8Array(1024 * 1024);
    const prefix = new TextEncoder().encode(
      '<!DOCTYPE html><html><body><div class="cf-error-code">1016</div>',
    );
    hugeChunk.set(prefix, 0);

    const hugeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(hugeChunk);
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const hugeResponse = new Response(hugeStream, {
      status: 530,
      headers: {
        server: "cloudflare",
        "cf-ray": "ray-huge",
      },
    });
    expect(await extractSafeCloudflareErrorCode(hugeResponse)).toBe(1016);
    expect(streamCancelled).toBe(true);

    // 2. Non-ending / slow stream respects shared deadline
    let hangingCancelled = false;
    const hangingStream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {}); // never resolves
      },
      cancel() {
        hangingCancelled = true;
      },
    });
    const hangingResponse = new Response(hangingStream, {
      status: 530,
      headers: {
        server: "cloudflare",
        "cf-ray": "ray-hanging",
      },
    });
    const immediateTimeout = Promise.reject(new Error("deadline"));
    expect(
      await extractSafeCloudflareErrorCode(hangingResponse, immediateTimeout),
    ).toBeUndefined();
    expect(hangingCancelled).toBe(true);

    // 3. Aborted / errored stream handles cleanly without unhandled rejection
    const erroredStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("network stream aborted"));
      },
    });
    const erroredResponse = new Response(erroredStream, {
      status: 530,
      headers: {
        server: "cloudflare",
        "cf-ray": "ray-aborted",
      },
    });
    expect(
      await extractSafeCloudflareErrorCode(erroredResponse),
    ).toBeUndefined();
  });

  it("applies overall 10s deadline when 5xx response body hangs during diagnostic extraction", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      vi.useFakeTimers();
      const hangingStream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {}); // never resolves
        },
      });
      spy.mockResolvedValueOnce(
        new Response(hangingStream, {
          status: 530,
          headers: {
            server: "cloudflare",
            "cf-ray": "ray-timeout",
          },
        }),
      );

      const promise = sendVerifiedHttps(
        "https://events.provider.example.org/callback",
        reviewed,
        { method: "POST", body: new Uint8Array([1]) },
        { diagnostics: true },
      );

      await vi.advanceTimersByTimeAsync(10_000);
      const outcome = await promise;
      expect(outcome).toEqual({ ok: false, reason: "deadline" });
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
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
