import { describe, expect, it, vi } from "vitest";
import { sendRelayMessage } from "../../src/notifications/relay-message-client";
import { relayOperationDigest } from "../../src/notifications/relay-operation";
import { parseRelayHttpOutcome } from "../../src/notifications/relay-outcome";

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
const config = {
  origin: "https://relay.example.org",
  callerId: "synthetic-worker-1",
  audience: "test:synthetic-relay",
  signingKeyPkcs8: btoa(
    String.fromCharCode(
      ...bytes(
        "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      ),
    ),
  ),
  callbackTargets: [
    { origin: "https://callback.example.org", pathPrefix: "/events" },
  ],
};
const request = () => ({
  body: new Uint8Array([1, 2]),
  method: "POST" as const,
  headers: { "content-type": "application/json" },
});
const operation = () => ({
  requestId: "synthetic-request-1",
  timestamp: Date.now(),
});
describe("unwired message-only relay adapter", () => {
  it("authenticates separate path/kind and preserves observed retry delay", async () => {
    const outcome = {
      kind: "http",
      status: 429,
      retryAfterState: "known",
      retryAfterSeconds: 120,
      retryAfterObservedAt: Date.now(),
    };
    let digest = "";
    const transport = vi.fn(async (url, init) => {
      expect(url).toBe("https://relay.example.org/relay/v1/message");
      const raw = init?.body as Uint8Array;
      const envelope = JSON.parse(new TextDecoder().decode(raw));
      expect(envelope.kind).toBe("message");
      const key = await crypto.subtle.importKey(
        "spki",
        bytes(
          "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        ),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const prefix = new TextEncoder().encode(
        "POST\n/relay/v1/message\nsynthetic-worker-1\n",
      );
      const signed = new Uint8Array(prefix.length + raw.length);
      signed.set(prefix);
      signed.set(raw, prefix.length);
      const signature = Uint8Array.from(
        atob(new Headers(init?.headers).get("x-agent-table-signature") ?? ""),
        (c) => c.charCodeAt(0),
      );
      expect(
        await crypto.subtle.verify("Ed25519", key, signature, signed),
      ).toBe(true);
      digest = await relayOperationDigest({
        ...envelope,
        callerId: config.callerId,
      });
      expect(digest).not.toBe(
        await relayOperationDigest({
          ...envelope,
          kind: "forward",
          callerId: config.callerId,
        }),
      );
      return Response.json({ state: "completed", outcome });
    });
    expect(
      await sendRelayMessage(
        config,
        operation(),
        "https://callback.example.org/events",
        request(),
        async () => true,
        transport,
      ),
    ).toEqual({ ok: true, outcome });
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("never treats legacy unknown delay or challenge body as message completion", async () => {
    for (const response of [
      { status: 204, payload: "e30=" },
      { state: "completed", outcome: { kind: "http", status: 503 } },
      {
        state: "completed",
        outcome: { kind: "http", status: 503, retryAfterState: "unknown" },
      },
      {
        state: "completed",
        outcome: {
          kind: "http",
          status: 429,
          retryAfterState: "known",
          retryAfterSeconds: 901,
          retryAfterObservedAt: Date.now(),
        },
      },
    ])
      expect(
        (
          await sendRelayMessage(
            config,
            operation(),
            "https://callback.example.org/events",
            request(),
            async () => true,
            async () => Response.json(response),
          )
        ).ok,
      ).toBe(false);
    expect(parseRelayHttpOutcome({ kind: "http", status: 503 }, true)).toEqual({
      kind: "http",
      status: 503,
      retryAfterState: "unknown",
    });
    expect(
      parseRelayHttpOutcome({
        kind: "http",
        status: 503,
        retryAfterState: "absent",
      }),
    ).toEqual({ kind: "http", status: 503, retryAfterState: "absent" });
  });
  it("requires final authority and snapshots config before async mutation", async () => {
    const transport = vi.fn(async (url) => {
      expect(url).toBe("https://relay.example.org/relay/v1/message");
      return Response.json({
        state: "completed",
        outcome: { kind: "http", status: 204, retryAfterState: "absent" },
      });
    });
    const mutable = structuredClone(config);
    const op = operation();
    expect(
      (
        await sendRelayMessage(
          mutable,
          op,
          "https://callback.example.org/events",
          request(),
          async () => {
            mutable.origin = "http://127.0.0.1";
            op.timestamp = 0;
            return true;
          },
          transport,
        )
      ).ok,
    ).toBe(true);
    const denied = vi.fn();
    expect(
      (
        await sendRelayMessage(
          config,
          operation(),
          "https://callback.example.org/events",
          request(),
          async () => false,
          denied,
        )
      ).ok,
    ).toBe(false);
    expect(denied).not.toHaveBeenCalled();
  });
});
