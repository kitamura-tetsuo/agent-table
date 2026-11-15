import type { sendRelayChallenge } from "./relay-challenge-client";
import type { RelayClientConfiguration } from "./relay-client";
import type { readRelayStatus } from "./relay-status-client";
export interface RelayVerificationOperation {
  requestId: string;
  issuedAt: number;
  acceptanceExpiresAt: number;
  audience: string;
  callerId: string;
  operationDigest: string;
}
export interface RelayVerificationAdapter {
  configuration: RelayClientConfiguration;
  send: typeof sendRelayChallenge;
  read: typeof readRelayStatus;
}
export function validRelayVerificationOperation(
  i: RelayVerificationOperation,
): boolean {
  return (
    !!i &&
    [i.requestId, i.callerId, i.audience, i.operationDigest].every(
      (v) => typeof v === "string",
    ) &&
    Object.keys(i).sort().join(",") ===
      "acceptanceExpiresAt,audience,callerId,issuedAt,operationDigest,requestId" &&
    /^[A-Za-z0-9_-]{16,128}$/.test(i.requestId) &&
    /^[A-Za-z0-9_-]{16,128}$/.test(i.callerId) &&
    /^(production|test):[a-z][a-z0-9-]{2,63}$/.test(i.audience) &&
    /^[a-f0-9]{64}$/.test(i.operationDigest) &&
    Number.isSafeInteger(i.issuedAt) &&
    i.issuedAt > 0 &&
    i.acceptanceExpiresAt === i.issuedAt + 60000
  );
}
