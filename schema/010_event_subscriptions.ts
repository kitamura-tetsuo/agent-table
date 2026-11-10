/** Table-local ownership and fencing for the optional MCP Events adapter. */
export const eventSubscriptionsSchema = {
  version: 10,
  statements: [],
  componentStatements: {
    table: [
      `CREATE TABLE table_event_subscriptions (
        membership_id TEXT PRIMARY KEY,
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
        FOREIGN KEY (membership_id) REFERENCES table_memberships(membership_id)
      )`,
      `CREATE TABLE table_event_candidates (
        membership_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL UNIQUE,
        subscription_id TEXT NOT NULL,
        guest_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        secret_envelope TEXT NOT NULL,
        requested_ttl_ms INTEGER,
        fence INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (membership_id) REFERENCES table_memberships(membership_id)
      )`,
      "CREATE INDEX table_event_candidates_expiry ON table_event_candidates (expires_at)",
      "CREATE INDEX table_event_subscriptions_expiry ON table_event_subscriptions (status, expires_at)",
    ],
  },
} as const;
