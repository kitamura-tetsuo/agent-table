/** Candidate-bound verification metadata only; never stores challenge or payload. */
export const relayVerificationSchema = {
  version: 14,
  statements: [],
  componentStatements: {
    table: [
      "ALTER TABLE table_event_candidates ADD COLUMN verification_mode TEXT NOT NULL DEFAULT 'native' CHECK(verification_mode IN ('native','relay'))",
      `CREATE TABLE table_event_relay_verifications (
 candidate_id TEXT PRIMARY KEY, membership_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
 guest_id TEXT NOT NULL, connection_id TEXT NOT NULL, fence INTEGER NOT NULL,
 candidate_expires_at INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE,
 issued_at INTEGER NOT NULL, acceptance_expires_at INTEGER NOT NULL,
 audience TEXT NOT NULL, caller_id TEXT NOT NULL, operation_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','unknown','verified','failed')),
 CHECK(acceptance_expires_at=issued_at+60000)
 ) STRICT`,
      `CREATE TRIGGER table_event_relay_verification_identity_immutable BEFORE UPDATE OF
 candidate_id,membership_id,subscription_id,guest_id,connection_id,fence,candidate_expires_at,
 request_id,issued_at,acceptance_expires_at,audience,caller_id,operation_digest ON table_event_relay_verifications
 BEGIN SELECT RAISE(ABORT,'immutable-relay-verification'); END`,
      `CREATE TRIGGER table_event_relay_verification_result_immutable BEFORE UPDATE ON table_event_relay_verifications
 WHEN OLD.state IN ('verified','failed') BEGIN SELECT RAISE(ABORT,'immutable-relay-verification-result'); END`,
    ],
  },
} as const;
