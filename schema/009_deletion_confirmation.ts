/** Browser deletion ledger stays local to the authoritative table. */
export const deletionConfirmationSchema = {
  version: 9,
  statements: [],
  componentStatements: {
    table: [
      `CREATE TABLE table_delete_confirmations (
        guest_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'denied', 'expired')),
        PRIMARY KEY (guest_id, request_id)
      )`,
      `CREATE TABLE table_tombstone_delete_receipts (
        guest_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        PRIMARY KEY (guest_id, request_id)
      )`,
    ],
  },
} as const;
