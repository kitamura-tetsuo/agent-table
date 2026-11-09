import { Webhook } from "standardwebhooks";
import { parseOwnInboxUri } from "../shared/resources";
import { type ReviewedCallbackTarget, sendVerifiedHttps } from "./egress";

export const MESSAGE_EVENT_NAME = "table.message.created";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_WEBHOOK_BODY_BYTES = 16 * 1024;
const MAX_SUBSCRIPTION_TTL_MS = 3_600_000;

export const MESSAGE_EVENT_DEFINITION = {
  name: MESSAGE_EVENT_NAME,
  description: "A peer posted a committed message in a private table.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: { table_id: { type: "string", format: "uuid" } },
    required: ["table_id"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      table_id: { type: "string", format: "uuid" },
      message_id: { type: "string", format: "uuid" },
      seq: { type: "integer", minimum: 1 },
      inbox_uri: { type: "string" },
    },
    required: ["table_id", "message_id", "seq", "inbox_uri"],
    additionalProperties: false,
  },
} as const;

type RecordValue = Record<string, unknown>;
type Delivery = { mode: "webhook"; url: string };
export type EventSubscriptionParams = {
  name: typeof MESSAGE_EVENT_NAME;
  arguments: { table_id: string };
  delivery: Delivery & { secret?: string };
  cursor: null;
  ttlMs: number | null;
};

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is RecordValue {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

/**
 * Only parse the pinned webhook profile. Authorization and reviewed callback
 * destination enforcement are separate mandatory boundaries.
 */
export function parseEventSubscriptionParams(
  value: unknown,
  operation: "subscribe" | "unsubscribe",
): EventSubscriptionParams | null {
  const keys =
    operation === "subscribe"
      ? ["name", "arguments", "delivery", "cursor", "ttlMs"]
      : ["name", "arguments", "delivery"];
  if (!exactRecord(value, keys)) return null;
  if (value.name !== MESSAGE_EVENT_NAME) return null;
  if (
    !exactRecord(value.arguments, ["table_id"]) ||
    typeof value.arguments.table_id !== "string" ||
    !UUID_V4.test(value.arguments.table_id)
  )
    return null;
  const deliveryKeys =
    operation === "subscribe" ? ["mode", "url", "secret"] : ["mode", "url"];
  if (
    !exactRecord(value.delivery, deliveryKeys) ||
    value.delivery.mode !== "webhook" ||
    typeof value.delivery.url !== "string" ||
    value.delivery.url.length > 2048 ||
    !value.delivery.url.startsWith("https://")
  )
    return null;
  if (
    operation === "subscribe" &&
    (typeof value.delivery.secret !== "string" ||
      !validSigningSecret(value.delivery.secret))
  )
    return null;
  if (operation === "unsubscribe" && "secret" in value.delivery) return null;
  if (operation === "subscribe" && "cursor" in value && value.cursor !== null)
    return null;
  const ttl =
    operation === "subscribe" && "ttlMs" in value ? value.ttlMs : null;
  if (
    ttl !== null &&
    (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 1000)
  )
    return null;
  return {
    name: MESSAGE_EVENT_NAME,
    arguments: { table_id: value.arguments.table_id },
    delivery: {
      mode: "webhook",
      url: value.delivery.url,
      ...(operation === "subscribe"
        ? { secret: value.delivery.secret as string }
        : {}),
    },
    cursor: null,
    ttlMs: ttl,
  };
}

export function grantedSubscriptionTtlMs(
  requested: number | null,
  remainingTableMs: number,
  remainingConnectionMs: number,
): number {
  if (
    !Number.isFinite(remainingTableMs) ||
    !Number.isFinite(remainingConnectionMs) ||
    remainingTableMs <= 0 ||
    remainingConnectionMs <= 0
  )
    return 0;
  return Math.max(
    0,
    Math.floor(
      Math.min(
        requested ?? MAX_SUBSCRIPTION_TTL_MS,
        MAX_SUBSCRIPTION_TTL_MS,
        remainingTableMs,
        remainingConnectionMs,
      ),
    ),
  );
}

/**
 * The canonical identity contains the actual server-authenticated guest and
 * connection, never caller-supplied ownership fields or the signing secret.
 */
export async function subscriptionIdentity(
  principal: { guestId: string; connectionId: string },
  input: Pick<EventSubscriptionParams, "name" | "arguments" | "delivery">,
): Promise<string> {
  if (!principal.guestId || !principal.connectionId)
    throw new Error("Invalid principal");
  const canonical = JSON.stringify([
    principal.guestId,
    principal.connectionId,
    input.delivery.url,
    input.name,
    { table_id: input.arguments.table_id },
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  return `sub_${btoa(String.fromCharCode(...digest.slice(0, 18)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

export function validSigningSecret(secret: string): boolean {
  if (!secret.startsWith("whsec_")) return false;
  const encoded = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    return false;
  try {
    const decoded = atob(encoded);
    return (
      decoded.length >= 24 && decoded.length <= 64 && btoa(decoded) === encoded
    );
  } catch {
    return false;
  }
}

/**
 * Protect the metadata-only event contract even if a future internal caller
 * mistakenly passes a transcript object to the signing helper.
 */
function safeOutboundBody(body: unknown, webhookId: string): boolean {
  if (exactRecord(body, ["type", "challenge"])) {
    return (
      body.type === "verification" &&
      typeof body.challenge === "string" &&
      UUID_V4.test(body.challenge)
    );
  }
  if (!exactRecord(body, ["eventId", "name", "timestamp", "data", "cursor"]))
    return false;
  if (
    body.eventId !== webhookId ||
    body.name !== MESSAGE_EVENT_NAME ||
    body.cursor !== null ||
    typeof body.timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(body.timestamp) ||
    Number.isNaN(Date.parse(body.timestamp)) ||
    !exactRecord(body.data, ["table_id", "message_id", "seq", "inbox_uri"])
  )
    return false;
  const data = body.data;
  return (
    typeof data.table_id === "string" &&
    typeof data.message_id === "string" &&
    typeof data.seq === "number" &&
    typeof data.inbox_uri === "string" &&
    UUID_V4.test(data.table_id) &&
    UUID_V4.test(data.message_id) &&
    Number.isSafeInteger(data.seq) &&
    data.seq > 0 &&
    parseOwnInboxUri(data.inbox_uri)?.tableId === data.table_id
  );
}

export type SignedWebhook = {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
};

/**
 * Standard Webhooks signs exactly the bytes later handed to the HTTPS sender.
 * Optional second key supports bounded rotation; the caller enforces its expiry.
 */
export function signWebhook(
  body: unknown,
  webhookId: string,
  subscriptionId: string,
  secrets: readonly string[],
  timestamp: Date,
): SignedWebhook {
  if (
    !/^[A-Za-z0-9_-]{8,128}$/.test(webhookId) ||
    !/^sub_[A-Za-z0-9_-]{16,64}$/.test(subscriptionId) ||
    secrets.length < 1 ||
    secrets.length > 2 ||
    secrets.some((secret) => !validSigningSecret(secret)) ||
    !Number.isFinite(timestamp.getTime())
  )
    throw new Error("Invalid webhook envelope");
  if (!safeOutboundBody(body, webhookId))
    throw new Error("Invalid or non-minimal webhook payload");
  const serialized = JSON.stringify(body);
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength > MAX_WEBHOOK_BODY_BYTES)
    throw new Error("Webhook body exceeds bounded transport");
  return {
    body: bytes,
    headers: {
      "Content-Type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": secrets
        .map((secret) =>
          new Webhook(secret).sign(webhookId, timestamp, serialized),
        )
        .join(" "),
      "X-MCP-Subscription-Id": subscriptionId,
    },
  };
}

export function messageCreatedEvent(input: {
  eventId: string;
  tableId: string;
  messageId: string;
  seq: number;
  inboxUri: string;
  occurredAt: Date;
}) {
  if (
    !/^[A-Za-z0-9_-]{8,128}$/.test(input.eventId) ||
    !UUID_V4.test(input.tableId) ||
    !UUID_V4.test(input.messageId) ||
    !Number.isSafeInteger(input.seq) ||
    input.seq < 1 ||
    !Number.isFinite(input.occurredAt.getTime()) ||
    parseOwnInboxUri(input.inboxUri)?.tableId !== input.tableId
  )
    throw new Error("Invalid committed event");
  return {
    eventId: input.eventId,
    name: MESSAGE_EVENT_NAME,
    timestamp: input.occurredAt.toISOString(),
    data: {
      table_id: input.tableId,
      message_id: input.messageId,
      seq: input.seq,
      inbox_uri: input.inboxUri,
    },
    cursor: null,
  } as const;
}

function acceptedChallenge(body: Uint8Array, expected: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return false;
  }
  if (
    !exactRecord(parsed, ["challenge"]) ||
    typeof parsed.challenge !== "string"
  )
    return false;
  const actual = new TextEncoder().encode(parsed.challenge);
  const wanted = new TextEncoder().encode(expected);
  let difference = actual.length ^ wanted.length;
  for (let i = 0; i < Math.max(actual.length, wanted.length); i++) {
    difference |= (actual[i] ?? 0) ^ (wanted[i] ?? 0);
  }
  return difference === 0;
}

/**
 * Not exposed by MCP registration yet. A verified response is only an external
 * observation; a subsequent TableDO transaction must recheck candidate state,
 * membership, connection grant and expiry before activation.
 */
export async function verifyCallbackControl(
  destination: string,
  reviewed: readonly ReviewedCallbackTarget[],
  secret: string,
  subscriptionId: string,
): Promise<"verified" | "challenge-failed" | "transport-failed"> {
  const challenge = crypto.randomUUID();
  const request = signWebhook(
    { type: "verification", challenge },
    `msg_verification_${crypto.randomUUID().replace(/-/g, "")}`,
    subscriptionId,
    [secret],
    new Date(),
  );
  const result = await sendVerifiedHttps(destination, reviewed, {
    method: "POST",
    ...request,
  });
  if (!result.ok) return "transport-failed";
  return acceptedChallenge(result.body, challenge)
    ? "verified"
    : "challenge-failed";
}
