import { describe, expect, it } from "vitest";
import {
  type EventParameterFailure,
  inspectEventSubscriptionParams,
  parseEventSubscriptionParams,
} from "../../src/notifications/openai-events";

const TABLE_ID = "01234567-89ab-4cde-8123-0123456789ab";
const PRIVATE_VALUE = "REJECTED_PRIVATE_PARAMETER_SENTINEL";
const SECRET = `whsec_${btoa("S".repeat(32))}`;

function parameters() {
  return {
    name: "table.message.created",
    arguments: { table_id: TABLE_ID },
    delivery: {
      mode: "webhook",
      url: `https://events.example.org/${PRIVATE_VALUE}?private=${PRIVATE_VALUE}`,
      secret: SECRET,
    },
    cursor: null,
    ttlMs: 60_000,
    _meta: { private: PRIVATE_VALUE },
  };
}

describe("Events parameter diagnostic categories", () => {
  const invalid: Array<{
    detail: EventParameterFailure;
    change: (value: ReturnType<typeof parameters>) => unknown;
  }> = [
    {
      detail: "shape",
      change: (value) => ({ ...value, private: PRIVATE_VALUE }),
    },
    {
      detail: "metadata",
      change: (value) => ({ ...value, _meta: PRIVATE_VALUE }),
    },
    { detail: "event", change: (value) => ({ ...value, name: PRIVATE_VALUE }) },
    {
      detail: "arguments",
      change: (value) => ({ ...value, arguments: { table_id: PRIVATE_VALUE } }),
    },
    {
      detail: "delivery",
      change: (value) => ({
        ...value,
        delivery: { ...value.delivery, mode: PRIVATE_VALUE },
      }),
    },
    {
      detail: "secret",
      change: (value) => ({
        ...value,
        delivery: { ...value.delivery, secret: PRIVATE_VALUE },
      }),
    },
    {
      detail: "cursor",
      change: (value) => ({ ...value, cursor: PRIVATE_VALUE }),
    },
    { detail: "ttl", change: (value) => ({ ...value, ttlMs: PRIVATE_VALUE }) },
  ];

  it.each(invalid)(
    "returns only the $detail category for rejected input",
    ({ detail, change }) => {
      const input = change(parameters());
      const inspected = inspectEventSubscriptionParams(input, "subscribe");
      expect(inspected).toEqual({ ok: false, detail });
      expect(JSON.stringify(inspected)).not.toContain(PRIVATE_VALUE);
      expect(JSON.stringify(inspected)).not.toContain(SECRET);
      expect(parseEventSubscriptionParams(input, "subscribe")).toBeNull();
    },
  );

  it("preserves accepted subscription values and removes protocol metadata", () => {
    const input = parameters();
    const expected = {
      name: input.name,
      arguments: input.arguments,
      delivery: input.delivery,
      cursor: null,
      ttlMs: 60_000,
    };
    const inspected = inspectEventSubscriptionParams(input, "subscribe");
    expect(inspected).toEqual({
      ok: true,
      value: expected,
    });
    expect(parseEventSubscriptionParams(input, "subscribe")).toEqual(expected);
    expect(inspected.ok && Object.hasOwn(inspected.value, "_meta")).toBe(false);
  });

  it("keeps unsubscribe's narrower contract and never echoes a forbidden credential", () => {
    const input = parameters();
    const unsubscribe = {
      name: input.name,
      arguments: input.arguments,
      delivery: { mode: input.delivery.mode, url: input.delivery.url },
      _meta: input._meta,
    };
    expect(inspectEventSubscriptionParams(unsubscribe, "unsubscribe")).toEqual({
      ok: true,
      value: {
        name: unsubscribe.name,
        arguments: unsubscribe.arguments,
        delivery: unsubscribe.delivery,
        cursor: null,
        ttlMs: null,
      },
    });
    const rejected = inspectEventSubscriptionParams(
      {
        ...unsubscribe,
        delivery: { ...unsubscribe.delivery, secret: PRIVATE_VALUE },
      },
      "unsubscribe",
    );
    expect(rejected).toEqual({ ok: false, detail: "delivery" });
    expect(JSON.stringify(rejected)).not.toContain(PRIVATE_VALUE);
    expect(
      parseEventSubscriptionParams(
        { ...unsubscribe, cursor: null },
        "unsubscribe",
      ),
    ).toBeNull();
  });
});
