/**
 * Relay metadata only. No profile activation or forwarding permission.
 */
export const relayAttemptLedgerSchema = {
  version: 13,
  statements: [],
  componentStatements: {
    table: [
      "ALTER TABLE table_event_outbox ADD COLUMN relay_reconcile_after INTEGER",
      `CREATE TABLE table_event_relay_attempts (
      request_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 1),
      ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 8),
      lease_token TEXT NOT NULL,
      first_attempt_at INTEGER NOT NULL,
      lease_deadline INTEGER NOT NULL,
      audience TEXT NOT NULL,
      caller_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      acceptance_expires_at INTEGER NOT NULL,
      operation_digest TEXT NOT NULL,
      transport_reserved INTEGER NOT NULL DEFAULT 0 CHECK(transport_reserved IN (0,1)),
      state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','unknown','completed')),
      outcome_kind TEXT CHECK(outcome_kind IN ('http','not-sent')),
      http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
      outcome_json TEXT,
      UNIQUE(event_id,ordinal),
      UNIQUE(event_id,lease_token),
      CHECK(issued_at >= first_attempt_at AND acceptance_expires_at > issued_at),
      CHECK((state = 'completed' AND outcome_kind IS NOT NULL) OR
            (state <> 'completed' AND outcome_kind IS NULL AND http_status IS NULL)),
      CHECK((outcome_kind = 'http' AND http_status IS NOT NULL) OR
            ((outcome_kind IS NULL OR outcome_kind = 'not-sent') AND http_status IS NULL))
    ) STRICT`,
      `CREATE INDEX table_event_relay_attempts_event ON table_event_relay_attempts(event_id,ordinal)`,
      `CREATE TRIGGER table_event_relay_attempt_identity_immutable
      BEFORE UPDATE OF request_id,event_id,subscription_id,generation,ordinal,lease_token,
        first_attempt_at,lease_deadline,audience,caller_id,issued_at,acceptance_expires_at,operation_digest
      ON table_event_relay_attempts BEGIN
        SELECT RAISE(ABORT,'immutable-relay-attempt');
      END`,
      `CREATE TRIGGER table_event_relay_attempt_outcome_immutable
      BEFORE UPDATE ON table_event_relay_attempts WHEN OLD.state = 'completed'
      BEGIN SELECT RAISE(ABORT,'immutable-relay-outcome'); END`,
    ],
  },
} as const;
