import { describe, expect, it, vi } from "vitest";
import {
  type RelayClientConfiguration,
  sendRelayHttps,
} from "../../src/notifications/relay-client";

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const to64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const from64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
// Public RFC8032 TEST 1 values; never deployment credentials.
const config: RelayClientConfiguration = {
  origin: "https://relay.example.org",
  callerId: "synthetic-worker-1",
  audience: "test:synthetic-relay",
  signingKeyPkcs8: to64(
    bytes(
      "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    ),
  ),
  callbackTargets: [
    { origin: "https://callback.example.org", pathPrefix: "/events" },
  ],
};
const destination = "https://callback.example.org/events";
const operation = () => ({
  requestId: "synthetic-request-1",
  timestamp: Date.now(),
});
const request = () => ({
  method: "POST" as const,
  body: new Uint8Array([1, 2]),
  headers: { "webhook-id": "synthetic" },
});

describe("unwired Worker relay transport", () => {
  it("signs exact caller/method/path/envelope and uses original persisted operation identity", async () => {
    let checked = false;
    const transport = vi.fn(async (input, init) => {
      expect(checked).toBe(true);
      expect(input).toBe("https://relay.example.org/relay/v1");
      expect(init?.redirect).toBe("manual");
      const body = init?.body as Uint8Array;
      const envelope = JSON.parse(new TextDecoder().decode(body));
      expect(envelope.requestId).toBe("synthetic-request-1");
      expect(envelope.payload).toBe("AQI=");
      const header = new Headers(init?.headers);
      const publicKey = await crypto.subtle.importKey(
        "spki",
        bytes(
          "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        ),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const prefix = new TextEncoder().encode(
        "POST\n/relay/v1\nsynthetic-worker-1\n",
      );
      const signed = new Uint8Array(prefix.length + body.length);
      signed.set(prefix);
      signed.set(body, prefix.length);
      expect(
        await crypto.subtle.verify(
          "Ed25519",
          publicKey,
          from64(header.get("x-agent-table-signature") ?? ""),
          signed,
        ),
      ).toBe(true);
      return new Response(JSON.stringify({ status: 204, payload: "Aw==" }));
    }) as typeof fetch;
    const outcome = await sendRelayHttps(
      config,
      operation(),
      destination,
      request(),
      async () => {
        checked = true;
        return true;
      },
      transport,
    );
    expect(outcome).toEqual({
      ok: true,
      status: 204,
      body: new Uint8Array([3]),
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rechecks authority after signing and refuses unavailable or stale authorization", async () => {
    const transport = vi.fn() as unknown as typeof fetch;
    expect(
      (
        await sendRelayHttps(
          config,
          operation(),
          destination,
          request(),
          async () => false,
          transport,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await sendRelayHttps(
          config,
          { ...operation(), timestamp: Date.now() - 60001 },
          destination,
          request(),
          async () => true,
          transport,
        )
      ).ok,
    ).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects unreviewed callback, credentialed relay URL and unsafe headers before transport", async () => {
    const transport = vi.fn() as unknown as typeof fetch;
    for (const [conf, url, req] of [
      [config, "https://evil.example.org/events", request()],
      [
        { ...config, origin: "https://user@relay.example.org" },
        destination,
        request(),
      ],
      [config, destination, { ...request(), headers: { host: "evil" } }],
    ] as const) {
      expect(
        (
          await sendRelayHttps(
            conf,
            operation(),
            url,
            req,
            async () => true,
            transport,
          )
        ).ok,
      ).toBe(false);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("refuses redirects, duplicate/ambiguous relay results and oversized response without retries", async () => {
    for (const response of [
      new Response("", { status: 302 }),
      new Response("", { status: 409 }),
      new Response(
        JSON.stringify({ status: 204, payload: "AQI", extra: true }),
      ),
      new Response("x".repeat(90001)),
    ]) {
      const transport = vi.fn(async () => response) as typeof fetch;
      expect(
        (
          await sendRelayHttps(
            config,
            operation(),
            destination,
            request(),
            async () => true,
            transport,
          )
        ).ok,
      ).toBe(false);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
});

it("bounds a response stream that ignores abort instead of hanging past the operation deadline", async () => {
  vi.useFakeTimers();
  try {
    let reached!: () => void;
    const called = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const transport = vi.fn(async () => {
      reached();
      return new Response(
        new ReadableStream({
          start() {
            /* never produces or closes */
          },
        }),
      );
    }) as typeof fetch;
    const pending = sendRelayHttps(
      config,
      operation(),
      destination,
      request(),
      async () => true,
      transport,
    );
    await called;
    await vi.advanceTimersByTimeAsync(15001);
    expect(await pending).toEqual({ ok: false, reason: "deadline" });
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("freezes validated relay origin before asynchronous authorization", async () => {
  const mutable = structuredClone(config);
  const op = operation();
  const transport = vi.fn(async (url) => {
    expect(url).toBe("https://relay.example.org/relay/v1");
    return Response.json({ status: 204, payload: "" });
  });
  expect(
    (
      await sendRelayHttps(
        mutable,
        op,
        destination,
        request(),
        async () => {
          mutable.origin = "https://evil.example.org";
          op.timestamp = 0;
          return true;
        },
        transport,
      )
    ).ok,
  ).toBe(true);
});
