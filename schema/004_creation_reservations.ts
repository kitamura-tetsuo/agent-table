// An admission ledger is scoped to one guest's SQLite Durable Object.
export const creationReservationsSchema = {
  version: 4,
  statements: [],
  componentStatements: {
    guest: [
      `CREATE TABLE guest_creation_reservations (
        request_id TEXT PRIMARY KEY,
        guest_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        table_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        retention_until INTEGER NOT NULL,
        charged_at INTEGER NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'reserved'
          CHECK (outcome IN ('reserved', 'initialized', 'failed')),
        CHECK (length(request_digest) = 64),
        CHECK (expires_at > created_at),
        CHECK (retention_until > expires_at),
        CHECK (charged_at = created_at),
        FOREIGN KEY (guest_id) REFERENCES guest_identity(guest_id)
      )`,
      `CREATE INDEX guest_creation_reservations_charges
         ON guest_creation_reservations (guest_id, charged_at)`,
      `CREATE INDEX guest_creation_reservations_retention
         ON guest_creation_reservations (retention_until)`,
    ],
  },
} as const;
