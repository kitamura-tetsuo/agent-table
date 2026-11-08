// Invitation issuance, one active secret, and second-seat consumption are TableDO-local.
export const invitationsSchema = {
  version: 6,
  statements: [],
  componentStatements: {
    table: [
      "CREATE TABLE table_invitations (invite_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, issuer_guest_id TEXT NOT NULL, secret_digest TEXT NOT NULL CHECK (length(secret_digest) = 64), response_envelope TEXT, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'consumed')), consumed_by TEXT, consumed_at INTEGER, CHECK ((state = 'active' AND response_envelope IS NOT NULL AND consumed_by IS NULL) OR (state != 'active' AND response_envelope IS NULL)))",
      "CREATE UNIQUE INDEX table_one_active_invitation ON table_invitations (state) WHERE state = 'active'",
      "CREATE TABLE table_join_receipts (guest_id TEXT NOT NULL, request_id TEXT NOT NULL, invite_id TEXT NOT NULL, secret_digest TEXT NOT NULL, membership_id TEXT NOT NULL, PRIMARY KEY (guest_id, request_id))",
    ],
  },
} as const;
