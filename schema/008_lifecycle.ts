/** Minimal table tombstone authority, never a replacement for erased content. */
export const lifecycleSchema = {
  version: 8,
  statements: [],
  componentStatements: {
    table: [
      `CREATE TABLE table_tombstones (
        table_id TEXT PRIMARY KEY,
        terminal_state TEXT NOT NULL CHECK (terminal_state IN ('deleted', 'expired')),
        expires_at INTEGER NOT NULL,
        terminal_at INTEGER NOT NULL,
        retain_until INTEGER NOT NULL
      )`,
      "CREATE TABLE table_tombstone_guests (guest_id TEXT PRIMARY KEY)",
    ],
  },
} as const;
