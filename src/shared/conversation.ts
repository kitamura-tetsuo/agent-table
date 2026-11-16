import { validCreationRequestId } from "./creation";
import { validTableId } from "./invitations";

export const SESSION_MAX_MS = 3_600_000;
export const RESUME_REQUEST_MS = 300_000;
export const SESSION_MARKER_RETENTION_MS = 24 * 3_600_000;
export type ChannelRow = {
  singleton: number;
  generation: number;
  session_id: string | null;
  started_at: number | null;
  deadline: number | null;
};
export type ResumeInput = {
  request_id: string;
  generation: number;
  requested_at: number;
};
export type ResumeDecision = {
  request_id: string;
  generation: number;
  decision: "accept" | "reject";
};
export type EndConversationInput = {
  request_id: string;
  session_id: string;
  generation: number;
};
export type ResumeRow = {
  request_id: string;
  requester: string;
  recipient: string;
  generation: number;
  requested_at: number;
  expires_at: number;
  status: "pending" | "accepted" | "rejected" | "expired";
  session_id: string | null;
  session_generation: number | null;
  retain_until: number;
};
export type ResumeReceipt = {
  requestId: string;
  state: ResumeRow["status"];
  generation: number;
  expiresAt: string;
  sessionId?: string;
  sessionGeneration?: number;
};
function record(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function generation(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < Number.MAX_SAFE_INTEGER
  );
}
export function validResumeInput(value: unknown): value is ResumeInput {
  return (
    record(value, ["request_id", "generation", "requested_at"]) &&
    validTableId(value.request_id) &&
    generation(value.generation) &&
    typeof value.requested_at === "number" &&
    Number.isSafeInteger(value.requested_at) &&
    value.requested_at > 0
  );
}
export function validResumeDecision(value: unknown): value is ResumeDecision {
  return (
    record(value, ["request_id", "generation", "decision"]) &&
    validTableId(value.request_id) &&
    generation(value.generation) &&
    (value.decision === "accept" || value.decision === "reject")
  );
}
export function validEndInput(value: unknown): value is EndConversationInput {
  return (
    record(value, ["request_id", "session_id", "generation"]) &&
    validCreationRequestId(value.request_id) &&
    validTableId(value.session_id) &&
    generation(value.generation) &&
    (value.generation as number) > 0
  );
}
