import { describe, expect, it } from "vitest";
import {
  messageCreatedEvent,
  parseEventSubscriptionParams,
  signWebhook,
  subscriptionIdentity,
} from "../../src/notifications/openai-events";
import fixture from "../fixtures/events/openai-profile-2026-11-10.json";

describe("pinned synthetic OpenAI Events provider wire fixture", () => {
  it("keeps the canonical subscribe/refresh/unsubscribe identity", async () => {
    const subscribed = parseEventSubscriptionParams(
      fixture.subscribe,
      "subscribe",
    );
    const stopped = parseEventSubscriptionParams(
      fixture.unsubscribe,
      "unsubscribe",
    );
    expect(subscribed).not.toBeNull();
    expect(stopped).not.toBeNull();
    if (!subscribed || !stopped) return;
    const first = await subscriptionIdentity(fixture.principal, subscribed);
    const second = await subscriptionIdentity(fixture.principal, stopped);
    expect(first).toBe(fixture.expectedSubscriptionId);
    expect(second).toBe(first);
    expect(subscribed.ttlMs).toBe(60_000);
    expect(subscribed.cursor).toBeNull();
  });

  it("signs the independent fixed challenge bytes and minimal event payload", () => {
    const verification = fixture.verification;
    const signed = signWebhook(
      verification.body,
      verification.webhookId,
      fixture.expectedSubscriptionId,
      [fixture.subscribe.delivery.secret],
      new Date(verification.timestamp),
    );
    expect(new TextDecoder().decode(signed.body)).toBe(
      JSON.stringify(verification.body),
    );
    expect(signed.headers["webhook-signature"]).toBe(
      verification.expectedSignature,
    );
    expect(signed.headers["X-MCP-Subscription-Id"]).toBe(
      fixture.expectedSubscriptionId,
    );
    const event = messageCreatedEvent({
      eventId: fixture.event.eventId,
      tableId: fixture.event.tableId,
      messageId: fixture.event.messageId,
      seq: fixture.event.seq,
      inboxUri: fixture.event.inboxUri,
      occurredAt: new Date(fixture.event.occurredAt),
    });
    expect(Object.keys(event.data)).toEqual([
      "table_id",
      "message_id",
      "seq",
      "inbox_uri",
    ]);
    expect(event.cursor).toBeNull();
    expect(JSON.stringify(event)).not.toContain("body");
    expect(JSON.stringify(event)).not.toContain("purpose");
  });
});
