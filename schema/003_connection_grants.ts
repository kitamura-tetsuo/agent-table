// Grants live only in the guest's SQLite Durable Object, not in OAuth KV.
export const connectionGrantsSchema = {
  version: 3,
  statements: [],
  componentStatements: {
    guest: [
      `CREATE TABLE guest_connections (
        connection_id TEXT PRIMARY KEY,
        guest_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        CHECK (expires_at > created_at),
        CHECK (revoked_at IS NULL OR revoked_at >= created_at),
        FOREIGN KEY (guest_id) REFERENCES guest_identity(guest_id)
      )`,
      "CREATE INDEX guest_connections_owner ON guest_connections (guest_id, created_at)",
      "CREATE INDEX guest_connections_expiry ON guest_connections (expires_at)",
    ],
  },
} as const;
