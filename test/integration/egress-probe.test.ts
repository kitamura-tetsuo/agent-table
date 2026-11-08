import { describe, expect, it, vi } from "vitest";
import probe from "../egress/probe-worker";

const config = {
  PROBE_AUTH_TOKEN: "test-only-token",
  PROBE_CALLBACK_URL:
    "https://events.provider.example.org/callback/synthetic-id",
  PROBE_REVIEWED_ORIGIN: "https://events.provider.example.org",
  PROBE_REVIEWED_PATH_PREFIX: "/callback",
};

function request(token = "test-only-token"): Request {
  return new Request("http://localhost/__egress_probe", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("isolated diagnostic fetch probe (not connection-boundary proof)", () => {
  it("does not expose an unconfigured or unauthenticated fetch endpoint", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      expect((await probe.fetch(request(), {})).status).toBe(503);
      expect((await probe.fetch(request("wrong"), config)).status).toBe(404);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses an unreviewed host before making a fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const response = await probe.fetch(request(), {
        ...config,
        PROBE_CALLBACK_URL: "https://localhost/synthetic",
      });
      expect(await response.json()).toEqual({ result: "destination-rejected" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("uses manual redirects and a signal for a reviewed opaque callback", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    try {
      const response = await probe.fetch(request(), config);
      expect(await response.json()).toEqual({ result: "reachable" });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toBe(config.PROBE_CALLBACK_URL);
      const init = spy.mock.calls[0][1];
      expect(init?.redirect).toBe("manual");
      expect(init?.method).toBe("POST");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a redirect without fetching its target", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1" },
      }),
    );
    try {
      const response = await probe.fetch(request(), config);
      expect(await response.json()).toEqual({ result: "redirect-refused" });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses invalid response statuses without exposing bodies", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("secret body", { status: 401 }));
    try {
      const response = await probe.fetch(request(), config);
      expect(await response.json()).toEqual({
        result: "upstream-non-2xx",
        upstreamStatus: 401,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses both declared and streamed oversized responses", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      spy.mockResolvedValueOnce(
        new Response("x", { headers: { "Content-Length": "65537" } }),
      );
      expect(await (await probe.fetch(request(), config)).json()).toEqual({
        result: "response-too-large",
      });
      spy.mockResolvedValueOnce(new Response(new Uint8Array(65_537)));
      expect(await (await probe.fetch(request(), config)).json()).toEqual({
        result: "response-too-large",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("echoes only sanitized test ID and safe category without leaking headers or bodies", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ secret: "upstream-leak" }), {
        status: 200,
        headers: {
          "Set-Cookie": "session=secret",
          Location: "https://evil.example.com",
        },
      }),
    );
    try {
      const req = new Request("http://localhost/__egress_probe", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.PROBE_AUTH_TOKEN}`,
          "X-Probe-Test-Id": "test-run-001",
        },
      });
      const response = await probe.fetch(req, config);
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({
        result: "reachable",
        testId: "test-run-001",
      });
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(response.headers.get("Location")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
