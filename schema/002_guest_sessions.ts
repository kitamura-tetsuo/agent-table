// Guest sessions belong to GuestDO, never to a table namespace.
export const guestSessionsSchema = {
  version: 2,
  statements: [],
  componentStatements: {
    guest: [
      `CREATE TABLE guest_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        guest_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE guest_sessions (
        session_id TEXT PRIMARY KEY,
        secret_digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        invalidated_at INTEGER,
        CHECK (expires_at > created_at),
        CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
      )`,
      `CREATE INDEX guest_sessions_expiry ON guest_sessions (expires_at)`,
    ],
  },
} as const;
