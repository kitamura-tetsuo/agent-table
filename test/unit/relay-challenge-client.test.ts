import { describe, expect, it, vi } from "vitest";
import { sendRelayChallenge } from "../../src/notifications/relay-challenge-client";

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
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(
    JSON.stringify({
      type: "verification",
      challenge: "123e4567-e89b-42d3-a456-426614174000",
    }),
  ),
});
const operation = () => ({
  requestId: "synthetic-request-1",
  timestamp: Date.now(),
});
describe("challenge-only Worker result adapter", () => {
  it("signs distinct challenge route and never mistakes HTTP success for proof", async () => {
    let fresh = false;
    const transport = vi.fn(async (url, init) => {
      expect(fresh).toBe(true);
      expect(url).toBe("https://relay.example.org/relay/v1/challenge");
      const raw = init?.body as Uint8Array;
      const envelope = JSON.parse(new TextDecoder().decode(raw));
      expect(envelope.kind).toBe("challenge");
      const prefix = new TextEncoder().encode(
        "POST\n/relay/v1/challenge\n" + config.callerId + "\n",
      );
      const signed = new Uint8Array(prefix.length + raw.length);
      signed.set(prefix);
      signed.set(raw, prefix.length);
      const publicKey = await crypto.subtle.importKey(
        "spki",
        bytes(
          "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        ),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const sig = Uint8Array.from(
        atob(new Headers(init?.headers).get("x-agent-table-signature")!),
        (c) => c.charCodeAt(0),
      );
      expect(
        await crypto.subtle.verify("Ed25519", publicKey, sig, signed),
      ).toBe(true);
      return Response.json({
        state: "completed",
        outcome: { kind: "challenge", verification: "verified" },
      });
    });
    expect(
      await sendRelayChallenge(
        config,
        operation(),
        "https://callback.example.org/events",
        request(),
        async () => {
          fresh = true;
          return true;
        },
        transport,
      ),
    ).toEqual({
      ok: true,
      outcome: { kind: "challenge", verification: "verified" },
    });
    for (const outcome of [
      { kind: "http", status: 204, retryAfterState: "absent" },
      { kind: "challenge", verification: "verified", body: "secret" },
      { kind: "not-sent" },
    ]) {
      expect(
        (
          await sendRelayChallenge(
            config,
            operation(),
            "https://callback.example.org/events",
            request(),
            async () => true,
            async () => Response.json({ state: "completed", outcome }),
          )
        ).ok,
      ).toBe(false);
    }
  });
  it("preserves failed verification and refuses revoked authority or altered origin", async () => {
    const mutable = structuredClone(config);
    const transport = vi.fn(async (url) => {
      expect(url).toBe("https://relay.example.org/relay/v1/challenge");
      return Response.json({
        state: "completed",
        outcome: { kind: "challenge", verification: "failed" },
      });
    });
    expect(
      await sendRelayChallenge(
        mutable,
        operation(),
        "https://callback.example.org/events",
        request(),
        async () => {
          mutable.origin = "https://evil.example.org";
          return true;
        },
        transport,
      ),
    ).toEqual({
      ok: true,
      outcome: { kind: "challenge", verification: "failed" },
    });
    const denied = vi.fn();
    expect(
      (
        await sendRelayChallenge(
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
  it("bounds missing result without retrying a verification", async () => {
    vi.useFakeTimers();
    const transport = vi.fn(
      async () => new Response(new ReadableStream({ start() {} })),
    );
    try {
      const work = sendRelayChallenge(
        config,
        operation(),
        "https://callback.example.org/events",
        request(),
        async () => true,
        transport,
      );
      await vi.advanceTimersByTimeAsync(15001);
      expect((await work).ok).toBe(false);
      expect(transport.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
