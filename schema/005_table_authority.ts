// Only a TableDO may persist table identity and local membership authority.
export const tableAuthoritySchema = {
  version: 5,
  statements: [],
  componentStatements: {
    table: [
      `CREATE TABLE table_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        table_id TEXT NOT NULL UNIQUE,
        creation_request_id TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
        creator_guest_id TEXT NOT NULL,
        title TEXT NOT NULL,
        purpose TEXT,
        state TEXT NOT NULL DEFAULT 'waiting'
          CHECK (state IN ('waiting', 'open', 'closed', 'expired', 'deleted')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
        closed_at INTEGER,
        deleted_at INTEGER,
        last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
      )`,
      `CREATE TABLE table_memberships (
        membership_id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL,
        guest_id TEXT NOT NULL UNIQUE,
        seat INTEGER NOT NULL UNIQUE CHECK (seat IN (1, 2)),
        role TEXT NOT NULL CHECK (role IN ('creator', 'invitee')),
        joined_at INTEGER NOT NULL,
        latest_peer_seq INTEGER NOT NULL DEFAULT 0 CHECK (latest_peer_seq >= 0),
        FOREIGN KEY (table_id) REFERENCES table_metadata(table_id)
      )`,
      "CREATE INDEX table_memberships_table ON table_memberships (table_id, seat)",
    ],
  },
} as const;
