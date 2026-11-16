import { describe, expect, it, vi } from "vitest";
import type { RelayClientConfiguration } from "../../src/notifications/relay-client";

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

import { readRelayStatus } from "../../src/notifications/relay-status-client";

const request = () => ({
  requestId: "synthetic-request-1",
  operationDigest: "a".repeat(64),
  timestamp: Date.now(),
});
describe("status-only Worker relay readback", () => {
  it("uses distinct authenticated path and preserves unknown without sending", async () => {
    let authority = false;
    const transport = vi.fn(async (url, init) => {
      expect(authority).toBe(true);
      expect(url).toBe("https://relay.example.org/relay/v1/status");
      expect(init?.redirect).toBe("manual");
      const raw = init?.body as Uint8Array;
      const envelope = JSON.parse(new TextDecoder().decode(raw));
      expect(Object.keys(envelope).sort()).toEqual([
        "audience",
        "operationDigest",
        "requestId",
        "timestamp",
        "version",
      ]);
      const prefix = new TextEncoder().encode(
        `POST\n/relay/v1/status\n${config.callerId}\n`,
      );
      const signed = new Uint8Array(prefix.length + raw.length);
      signed.set(prefix);
      signed.set(raw, prefix.length);
      const key = await crypto.subtle.importKey(
        "spki",
        bytes(
          "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        ),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      expect(
        await crypto.subtle.verify(
          "Ed25519",
          key,
          from64(
            new Headers(init?.headers).get("x-agent-table-signature") ?? "",
          ),
          signed,
        ),
      ).toBe(true);
      return Response.json({ state: "unknown" });
    });
    expect(
      await readRelayStatus(
        config,
        request(),
        async () => {
          authority = true;
          return true;
        },
        transport,
      ),
    ).toEqual({ ok: true, state: "unknown" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("requires fresh authority and refuses malformed metadata without a retry", async () => {
    const denied = vi.fn();
    expect(
      (await readRelayStatus(config, request(), async () => false, denied)).ok,
    ).toBe(false);
    expect(denied).not.toHaveBeenCalled();
    for (const value of [
      {
        state: "completed",
        outcome: { kind: "http", status: 204, retryAfterState: "unknown" },
      },
      { state: "completed", outcome: { kind: "not-sent" } },
      { state: "pending" },
    ]) {
      expect(
        await readRelayStatus(
          config,
          request(),
          async () => true,
          async () => Response.json(value),
        ),
      ).toEqual({ ok: true, ...value });
    }
    for (const value of [
      { state: "completed", outcome: { kind: "http", status: 700 } },
      { state: "unknown", payload: "secret" },
      { state: "completed", outcome: { kind: "not-sent", status: 200 } },
    ]) {
      const send = vi.fn(async () => Response.json(value));
      expect(
        (await readRelayStatus(config, request(), async () => true, send)).ok,
      ).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it("bounds streams that ignore abort and never treats timeout as no-send", async () => {
    vi.useFakeTimers();
    try {
      const work = readRelayStatus(
        config,
        request(),
        async () => true,
        async () => new Response(new ReadableStream({ start() {} })),
      );
      await vi.advanceTimersByTimeAsync(5001);
      expect(await work).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });
});

it("freezes validated origin and identity before async authority callback", async () => {
  const mutable = structuredClone(config);
  const operation = request();
  const transport = vi.fn(async (url) => {
    expect(url).toBe("https://relay.example.org/relay/v1/status");
    return Response.json({ state: "unknown" });
  });
  expect(
    await readRelayStatus(
      mutable,
      operation,
      async () => {
        mutable.origin = "https://evil.example.org";
        operation.timestamp = 0;
        return true;
      },
      transport,
    ),
  ).toEqual({ ok: true, state: "unknown" });
});
