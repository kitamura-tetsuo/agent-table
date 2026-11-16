/**
 * Unconnected result-only verifier candidate. The caller MUST authenticate the
 * exact envelope and reserve its operation before invoking this adapter.
 * No listener, store mutation, payload logging or production wiring.
 */
import { acceptedChallenge } from "../src/notifications/challenge.ts";
import { relayOperationDigest } from "./egress-relay-ingress-prototype.mjs";
import {
  checkedHeaders,
  sendPinnedPrototype,
} from "./egress-relay-prototype.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createResultOnlyChallengeVerifier(send = sendPinnedPrototype) {
  return async (original, callerId, targets) => {
    let digest;
    try {
      const envelope = structuredClone(original);
      if (
        !envelope ||
        envelope.version !== 1 ||
        envelope.kind !== "challenge" ||
        typeof envelope.payload !== "string" ||
        envelope.payload.length > 21848 ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(callerId)
      )
        return { kind: "unknown" };
      const body = Buffer.from(envelope.payload, "base64");
      if (body.toString("base64") !== envelope.payload || body.length > 16384)
        return { kind: "unknown" };
      const request = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      );
      if (
        !request ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !== "challenge,type" ||
        request.type !== "verification" ||
        typeof request.challenge !== "string" ||
        !UUID.test(request.challenge)
      )
        return { kind: "unknown" };
      const headers = checkedHeaders(envelope.headers);
      digest = relayOperationDigest(envelope, callerId, "challenge");
      const result = await send(
        envelope.destination,
        structuredClone(targets),
        body,
        headers,
      );
      if (
        !result ||
        !Number.isInteger(result.status) ||
        result.status < 200 ||
        result.status >= 300 ||
        !(result.body instanceof Uint8Array) ||
        result.body.length > 65536
      )
        return { kind: "unknown", operationDigest: digest };
      return {
        kind: "challenge",
        operationDigest: digest,
        verification: acceptedChallenge(result.body, request.challenge)
          ? "verified"
          : "failed",
      };
    } catch {
      return digest
        ? { kind: "unknown", operationDigest: digest }
        : { kind: "unknown" };
    }
  };
}
