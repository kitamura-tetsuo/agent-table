import { createHmac } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";
import {
  grantedSubscriptionTtlMs,
  MESSAGE_EVENT_DEFINITION,
  messageCreatedEvent,
  parseEventSubscriptionParams,
  signWebhook,
  subscriptionIdentity,
  validSigningSecret,
  verifyCallbackControl,
} from "../../src/notifications/openai-events";

const TABLE = "a4567890-1234-4567-89ab-cdef01234567";
const MSG = "b4567890-1234-4567-89ab-cdef01234567";
const MEMBER = "c4567890-1234-4567-89ab-cdef01234567";
const URL =
  "https://events.provider.example.org/callback/opaque?ticket=synthetic";
const SECRET = `whsec_${Buffer.alloc(32, 23).toString("base64")}`;
const ROTATED = `whsec_${Buffer.alloc(32, 42).toString("base64")}`;
const TS = new Date();
const SUB = "sub_abcdef0123456789abcdef01";
function subscribed() {
  return {
    name: "table.message.created",
    arguments: { table_id: TABLE },
    delivery: { mode: "webhook", url: URL, secret: SECRET },
    cursor: null,
  };
}

describe("OpenAI Events wire (public registration remains disabled)", () => {
  it("defines only the webhook peer-message event with no replay", () => {
    expect(MESSAGE_EVENT_DEFINITION.delivery).toEqual(["webhook"]);
    expect(MESSAGE_EVENT_DEFINITION.inputSchema.additionalProperties).toBe(
      false,
    );
    expect(MESSAGE_EVENT_DEFINITION.payloadSchema.required).toEqual([
      "table_id",
      "message_id",
      "seq",
      "inbox_uri",
    ]);
  });
  it("accepts strict compound subscriptions and unsubscribes, never an ID-only shortcut", () => {
    expect(
      parseEventSubscriptionParams(subscribed(), "subscribe")?.cursor,
    ).toBeNull();
    const unsubscribe = {
      name: subscribed().name,
      arguments: subscribed().arguments,
      delivery: { mode: "webhook", url: URL },
    };
    expect(
      parseEventSubscriptionParams(unsubscribe, "unsubscribe"),
    ).not.toBeNull();
    expect(parseEventSubscriptionParams({ id: SUB }, "unsubscribe")).toBeNull();
    for (const bad of [
      { ...subscribed(), arguments: { table_id: TABLE, other: "foreign" } },
      { ...subscribed(), name: "table.deleted" },
      { ...subscribed(), arguments: { table_id: "invalid" } },
      { ...subscribed(), cursor: "history1" },
      { ...subscribed(), delivery: { ...subscribed().delivery, mode: "poll" } },
      {
        ...subscribed(),
        delivery: { ...subscribed().delivery, secret: "not-secret" },
      },
      { ...subscribed(), ttlMs: -1 },
      { ...subscribed(), ttlMs: "3600000" },
      { ...subscribed(), owner: "untrusted" },
    ])
      expect(parseEventSubscriptionParams(bad, "subscribe")).toBeNull();
    expect(
      parseEventSubscriptionParams(
        {
          ...unsubscribe,
          delivery: { ...unsubscribe.delivery, secret: SECRET },
        },
        "unsubscribe",
      ),
    ).toBeNull();
  });
  it("rejects malformed, non-canonical and out-of-range signing secrets", () => {
    expect(validSigningSecret(SECRET)).toBe(true);
    for (const bad of [
      `whsec_${Buffer.alloc(16, 1).toString("base64")}`,
      `whsec_${Buffer.alloc(65, 1).toString("base64")}`,
      "whsec_invalid?",
      "whsec_",
      `${SECRET}extra`,
    ])
      expect(validSigningSecret(bad)).toBe(false);
  });
  it("derives a secret-independent identity scoped to guest and application connection", async () => {
    const input = parseEventSubscriptionParams(subscribed(), "subscribe");
    if (!input) throw new Error("Invalid fixture");
    const principal = { guestId: "guest-1", connectionId: "connection-1" };
    const id = await subscriptionIdentity(principal, input);
    expect(id).toMatch(/^sub_[A-Za-z0-9_-]{24}$/);
    expect(
      await subscriptionIdentity(principal, {
        ...input,
        delivery: { ...input.delivery, secret: ROTATED },
      }),
    ).toBe(id);
    expect(
      await subscriptionIdentity({ ...principal, guestId: "guest-2" }, input),
    ).not.toBe(id);
    expect(
      await subscriptionIdentity(
        { ...principal, connectionId: "connection-2" },
        input,
      ),
    ).not.toBe(id);
    expect(
      await subscriptionIdentity(principal, {
        ...input,
        delivery: { ...input.delivery, url: `${URL}-changed` },
      }),
    ).not.toBe(id);
  });
  it("caps TTL by hour, table expiry and connection lifetime", () => {
    expect(grantedSubscriptionTtlMs(null, 5e6, 5e6)).toBe(3_600_000);
    expect(grantedSubscriptionTtlMs(8e6, 5e6, 5e6)).toBe(3_600_000);
    expect(grantedSubscriptionTtlMs(120_000, 90_000, 100_000)).toBe(90_000);
    expect(grantedSubscriptionTtlMs(null, 0, 100_000)).toBe(0);
    expect(grantedSubscriptionTtlMs(null, Number.NaN, 100_000)).toBe(0);
  });
  it("serializes only committed fields and a canonical own-inbox URI", () => {
    const event = messageCreatedEvent({
      eventId: "evt_message0001",
      tableId: TABLE,
      messageId: MSG,
      seq: 4,
      inboxUri: `agent-table://tables/${TABLE}/inbox/${MEMBER}`,
      occurredAt: TS,
    });
    expect(event.name).toBe("table.message.created");
    expect(Object.keys(event.data)).toEqual([
      "table_id",
      "message_id",
      "seq",
      "inbox_uri",
    ]);
    expect(event.cursor).toBeNull();
    expect(JSON.stringify(event)).not.toMatch(
      /body|purpose|secret|instruction/,
    );
    expect(() =>
      messageCreatedEvent({
        eventId: "evt_message0001",
        tableId: TABLE,
        messageId: MSG,
        seq: 4,
        inboxUri: `agent-table://tables/${MSG}/inbox/${MEMBER}`,
        occurredAt: TS,
      }),
    ).toThrow();
  });
  it("signs the exact bytes using Standard Webhooks and independent HMAC", () => {
    const payload = {
      type: "verification",
      challenge: "12345678-1234-4567-89ab-cdef01234567",
    };
    const signed = signWebhook(
      payload,
      "msg_verification0001",
      SUB,
      [SECRET],
      TS,
    );
    const body = new TextDecoder().decode(signed.body);
    const expected = createHmac(
      "sha256",
      Buffer.from(SECRET.slice(6), "base64"),
    )
      .update(`msg_verification0001.${Math.floor(TS.getTime() / 1000)}.${body}`)
      .digest("base64");
    expect(signed.headers["webhook-signature"]).toBe(`v1,${expected}`);
    expect(signed.headers["X-MCP-Subscription-Id"]).toBe(SUB);
    expect(new Webhook(SECRET).verify(body, signed.headers)).toEqual(payload);
  });
  it("refuses signing unexpected private content or mismatched envelope identity", () => {
    expect(() =>
      signWebhook(
        {
          type: "verification",
          challenge: "12345678-1234-4567-89ab-cdef01234567",
          body: "private-message",
        },
        "msg_verification0001",
        SUB,
        [SECRET],
        TS,
      ),
    ).toThrow();
    expect(() =>
      signWebhook(
        {
          eventId: "evt_message0001",
          name: "table.message.created",
          timestamp: TS.toISOString(),
          data: {
            table_id: TABLE,
            message_id: MSG,
            seq: 1,
            inbox_uri: `agent-table://tables/${TABLE}/inbox/${MEMBER}`,
          },
          cursor: null,
        },
        "evt_different0001",
        SUB,
        [SECRET],
        TS,
      ),
    ).toThrow();
  });

  it("supports bounded dual signing during credential rotation", () => {
    const signed = signWebhook(
      {
        type: "verification",
        challenge: "12345678-1234-4567-89ab-cdef01234568",
      },
      "msg_verification0002",
      SUB,
      [SECRET, ROTATED],
      TS,
    );
    const body = new TextDecoder().decode(signed.body);
    expect(signed.headers["webhook-signature"].split(" ")).toHaveLength(2);
    expect(new Webhook(SECRET).verify(body, signed.headers)).toBeTruthy();
    expect(new Webhook(ROTATED).verify(body, signed.headers)).toBeTruthy();
    expect(JSON.stringify(signed)).not.toContain(SECRET);
    expect(JSON.stringify(signed)).not.toContain(ROTATED);
    expect(() =>
      signWebhook(
        {},
        "msg_verification0002",
        SUB,
        [SECRET, ROTATED, SECRET],
        TS,
      ),
    ).toThrow();
  });
  it("performs reviewed HTTPS challenge verification without advertising Events", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(
          new TextDecoder().decode(init?.body as ArrayBuffer),
        );
        expect(body.type).toBe("verification");
        expect(JSON.stringify(body)).not.toContain(TABLE);
        expect(init?.redirect).toBe("manual");
        const h = new Headers(init?.headers);
        expect(
          new Webhook(SECRET).verify(JSON.stringify(body), {
            "webhook-id": h.get("webhook-id") ?? "",
            "webhook-timestamp": h.get("webhook-timestamp") ?? "",
            "webhook-signature": h.get("webhook-signature") ?? "",
          }),
        ).toEqual(body);
        return new Response(JSON.stringify({ challenge: body.challenge }));
      });
    const reviewed = [
      {
        origin: "https://events.provider.example.org",
        pathPrefix: "/callback",
      },
    ];
    try {
      expect(await verifyCallbackControl(URL, reviewed, SECRET, SUB)).toBe(
        "verified",
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        await verifyCallbackControl(
          "https://internal.invalid/private",
          reviewed,
          SECRET,
          SUB,
        ),
      ).toBe("transport-failed");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("refuses an invalid challenge echo", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ challenge: "different" })),
      );
    try {
      expect(
        await verifyCallbackControl(
          URL,
          [
            {
              origin: "https://events.provider.example.org",
              pathPrefix: "/callback",
            },
          ],
          SECRET,
          SUB,
        ),
      ).toBe("challenge-failed");
    } finally {
      spy.mockRestore();
    }
  });
});
