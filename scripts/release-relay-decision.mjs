/**
 * Operator review metadata, NOT machine attestation of the relay/host.
 * Call only in the existing exact-build/config protected release flow, after
 * verifyOperationalDecision and verifyProtectedEnvironmentApproval. This helper
 * alone cannot authorize deployment or mint runtime authority.
 */
import { createHash } from "node:crypto";
import { productionRelayConfiguration } from "../src/shared/production-relay-events.ts";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 2048 &&
  !/[\r\0]/.test(value);
const refs = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 20 &&
  value.every((ref) => {
    try {
      const u = new URL(ref);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        ref.length <= 2048
      );
    } catch {
      return false;
    }
  });
function requireReview(value) {
  if (!value) throw new Error("production-relay-operator-review-unverified");
}
export function verifyProductionRelayDecision(record, vars) {
  const config = productionRelayConfiguration(vars);
  const review = record?.productionRelay;
  requireReview(
    config &&
      review &&
      Object.keys(review).sort().join(",") ===
        "callbackTargetsSha256,configurationSha256,connectionSecurityEvidence,dataHandling,hostBehaviorEvidence,limitations,reviewKind,signingPublicKeySha256,transportIdentity",
  );
  requireReview(
    review.reviewKind === "operator-reviewed" &&
      review.configurationSha256 === digest(vars.EVENTS_RELAY_CONFIGURATION) &&
      review.callbackTargetsSha256 ===
        digest(vars.EVENTS_REVIEWED_CALLBACK_TARGETS) &&
      /^[a-f0-9]{64}$/.test(config.signingPublicKeySha256 ?? "") &&
      review.signingPublicKeySha256 === config.signingPublicKeySha256,
  );
  requireReview(
    Object.keys(review.transportIdentity ?? {})
      .sort()
      .join(",") === "artifact,host,process" &&
      Object.values(review.transportIdentity).every(text),
  );
  requireReview(
    refs(review.connectionSecurityEvidence) &&
      refs(review.hostBehaviorEvidence) &&
      Array.isArray(review.limitations) &&
      review.limitations.length <= 50 &&
      review.limitations.every(text),
  );
  // These are concrete operator choices/disclosures, not new transport guarantees.
  requireReview(
    Object.keys(review.dataHandling ?? {})
      .sort()
      .join(",") ===
      "keyOwnership,limits,retention,rollback,uncertainRestart" &&
      Object.values(review.dataHandling).every(text),
  );
  return {
    reviewAuthority: "operator-reviewed-under-protected-environment",
    configurationSha256: review.configurationSha256,
    callbackTargetsSha256: review.callbackTargetsSha256,
    signingPublicKeySha256: review.signingPublicKeySha256,
    decisionSha256: digest(JSON.stringify(review)),
    machineVerifiedTransportEvidence: false,
  };
}
