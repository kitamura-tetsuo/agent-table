/** Opt-in channels only; no historical table is reopened by this migration. */
export const conversationSessionsSchema = {
  version: 15,
  statements: [],
  componentStatements: {
    table: [
      `CREATE TABLE table_channel (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  session_id TEXT, started_at INTEGER, deadline INTEGER,
  CHECK((session_id IS NULL AND started_at IS NULL AND deadline IS NULL) OR
    (session_id IS NOT NULL AND deadline=started_at+3600000))
)`,
      `CREATE TABLE table_resume_requests (
  request_id TEXT PRIMARY KEY, requester TEXT NOT NULL, recipient TEXT NOT NULL,
  generation INTEGER NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','expired')),
  session_id TEXT, session_generation INTEGER, retain_until INTEGER NOT NULL,
  CHECK(expires_at<=requested_at+300000)
)`,
      `CREATE INDEX table_resume_expiry ON table_resume_requests(status,expires_at)`,
      `CREATE TABLE table_session_terminals (
  session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL UNIQUE,
  ended_at INTEGER NOT NULL, retain_until INTEGER NOT NULL
)`,
      `CREATE TABLE table_event_subscriptions_new (
        membership_id TEXT NOT NULL, event_name TEXT NOT NULL DEFAULT 'table.message.created', session_id TEXT, session_generation INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
        fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= generation),
        status TEXT NOT NULL CHECK (status IN ('inactive', 'active', 'expired')),
        guest_id TEXT,
        connection_id TEXT,
        subscription_id TEXT,
        callback_url TEXT,
        secret_envelope TEXT,
        previous_secret_envelope TEXT,
        rotation_until INTEGER,
        expires_at INTEGER,
        PRIMARY KEY(membership_id,event_name), FOREIGN KEY (membership_id) REFERENCES table_memberships(membership_id)
      )`,
      `INSERT INTO table_event_subscriptions_new (membership_id,generation,fence,status,guest_id,connection_id,subscription_id,callback_url,secret_envelope,previous_secret_envelope,rotation_until,expires_at) SELECT membership_id,generation,fence,status,guest_id,connection_id,subscription_id,callback_url,secret_envelope,previous_secret_envelope,rotation_until,expires_at FROM table_event_subscriptions`,
      `DROP TABLE table_event_subscriptions`,
      `ALTER TABLE table_event_subscriptions_new RENAME TO table_event_subscriptions`,
      `CREATE INDEX table_event_subscriptions_expiry ON table_event_subscriptions (status, expires_at)`,
      `CREATE TABLE table_event_candidates_new (
        membership_id TEXT NOT NULL, event_name TEXT NOT NULL DEFAULT 'table.message.created', session_id TEXT, session_generation INTEGER NOT NULL DEFAULT 0,
        candidate_id TEXT NOT NULL UNIQUE,
        subscription_id TEXT NOT NULL,
        guest_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        secret_envelope TEXT NOT NULL,
        requested_ttl_ms INTEGER,
        fence INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        verification_mode TEXT NOT NULL DEFAULT 'native' CHECK(verification_mode IN ('native','relay')), PRIMARY KEY(membership_id,event_name), FOREIGN KEY (membership_id) REFERENCES table_memberships(membership_id)
      )`,
      `INSERT INTO table_event_candidates_new (membership_id,candidate_id,subscription_id,guest_id,connection_id,callback_url,secret_envelope,requested_ttl_ms,fence,expires_at,verification_mode) SELECT membership_id,candidate_id,subscription_id,guest_id,connection_id,callback_url,secret_envelope,requested_ttl_ms,fence,expires_at,verification_mode FROM table_event_candidates`,
      `DROP TABLE table_event_candidates`,
      `ALTER TABLE table_event_candidates_new RENAME TO table_event_candidates`,
      `CREATE INDEX table_event_candidates_expiry ON table_event_candidates (expires_at)`,
      `CREATE TABLE table_event_outbox_new (
        event_id TEXT PRIMARY KEY, relay_reconcile_after INTEGER, event_name TEXT NOT NULL DEFAULT 'table.message.created', session_id TEXT, session_generation INTEGER NOT NULL DEFAULT 0,
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
        UNIQUE (recipient_membership_id, event_name, message_seq),
        FOREIGN KEY (recipient_membership_id) REFERENCES table_memberships(membership_id),
        CHECK(session_generation>=0)
      )`,
      `INSERT INTO table_event_outbox_new (event_id,message_id,message_seq,recipient_membership_id,subscription_id,subscription_generation,status,attempt_count,first_attempt_at,next_attempt_at,lease_token,lease_deadline,created_at,expires_at,last_error_category,relay_reconcile_after) SELECT event_id,message_id,message_seq,recipient_membership_id,subscription_id,subscription_generation,status,attempt_count,first_attempt_at,next_attempt_at,lease_token,lease_deadline,created_at,expires_at,last_error_category,relay_reconcile_after FROM table_event_outbox`,
      `DROP TABLE table_event_outbox`,
      `ALTER TABLE table_event_outbox_new RENAME TO table_event_outbox`,
      `CREATE INDEX table_event_outbox_due ON table_event_outbox(status, next_attempt_at)`,
      `CREATE INDEX table_event_outbox_owner ON table_event_outbox(recipient_membership_id, status)`,
    ],
  },
} as const;
