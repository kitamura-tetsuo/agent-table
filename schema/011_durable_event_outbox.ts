/**
 * Durable, message-bound event work. Dispatch stays disabled until the
 * authenticated lease/retry/terminal state machine is implemented and tested.
 */
export const durableEventOutboxSchema = {
  version: 11,
  statements: [],
  componentStatements: {
    table: [
      `CREATE TABLE table_event_outbox (
        event_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        message_seq INTEGER NOT NULL,
        recipient_membership_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        subscription_generation INTEGER NOT NULL CHECK (subscription_generation >= 1),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'in_flight', 'accepted', 'failed', 'cancelled')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
        first_attempt_at INTEGER,
        next_attempt_at INTEGER,
        lease_token TEXT,
        lease_deadline INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_error_category TEXT,
        UNIQUE (recipient_membership_id, message_seq),
        FOREIGN KEY (recipient_membership_id) REFERENCES table_memberships(membership_id),
        FOREIGN KEY (message_seq) REFERENCES table_messages(seq)
      )`,
      "CREATE INDEX table_event_outbox_due ON table_event_outbox(status, next_attempt_at)",
      "CREATE INDEX table_event_outbox_owner ON table_event_outbox(recipient_membership_id, status)",
    ],
  },
} as const;
