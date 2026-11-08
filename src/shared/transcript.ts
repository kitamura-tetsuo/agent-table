import { validTableId } from "./invitations";
import { TABLE_LIMITS } from "./limits";

export const MAX_POSTS_PER_MINUTE = 10;
export const POST_WINDOW_MS = 60_000;

export interface PostMessageInput {
  request_id: string;
  body: string;
  reply_to_message_id?: string;
}
export interface ReadMessagesInput {
  after_seq?: number;
  limit?: number;
  through_seq?: number;
}
export interface PostReceipt {
  table_id: string;
  message_id: string;
  seq: number;
  sender_membership_id: string;
  created_at: string;
  persisted: true;
}
export interface TranscriptMessage {
  seq: number;
  message_id: string;
  sender_membership_id: string;
  body: string;
  created_at: string;
  reply_to_message_id?: string;
}
export interface TranscriptPage {
  messages: TranscriptMessage[];
  next_after_seq: number;
  through_seq: number;
  has_more: boolean;
  own_inbox_uri: string;
  latest_peer_seq: number;
}
const KEY = /^[A-Za-z0-9_-]{16,128}$/;

export function validPostInput(value: unknown): value is PostMessageInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) => !["request_id", "body", "reply_to_message_id"].includes(key),
    ) ||
    typeof item.request_id !== "string" ||
    !KEY.test(item.request_id) ||
    typeof item.body !== "string" ||
    item.body.trim().length === 0 ||
    (item.reply_to_message_id !== undefined &&
      !validTableId(item.reply_to_message_id))
  ) return false;
  for (const symbol of item.body) {
    const point = symbol.codePointAt(0);
    if (point !== undefined && point >= 0xd800 && point <= 0xdfff) return false;
  }
  return new TextEncoder().encode(item.body).byteLength <= TABLE_LIMITS.messageBodyBytes;
}

export function validReadInput(value: unknown): value is ReadMessagesInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(
    (key) => !["after_seq", "through_seq", "limit"].includes(key),
  )) return false;
  const after = item.after_seq ?? 0;
  const limit = item.limit ?? TABLE_LIMITS.readPageDefault;
  return (
    typeof after === "number" && Number.isSafeInteger(after) && after >= 0 &&
    typeof limit === "number" && Number.isSafeInteger(limit) &&
    limit >= 1 && limit <= TABLE_LIMITS.readPageMaximum &&
    (item.through_seq === undefined ||
      (typeof item.through_seq === "number" &&
        Number.isSafeInteger(item.through_seq) &&
        item.through_seq >= after))
  );
}

/** Hash sorted keys, retaining original message text byte-for-byte. */
export async function postDigest(value: PostMessageInput): Promise<string> {
  const data = {
    body: value.body,
    ...(value.reply_to_message_id === undefined
      ? {}
      : { reply_to_message_id: value.reply_to_message_id }),
  };
  const canonical: Record<string, string> = {};
  for (const key of Object.keys(data).sort()) {
    const value = data[key as keyof typeof data];
    if (value !== undefined) canonical[key] = value;
  }
  const hash = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  ));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
