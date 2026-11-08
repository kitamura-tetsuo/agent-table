/** TableDO-local immutable messages, deduplication and usage accounting. */
export const transcriptSchema = {
  version: 7,
  statements: [],
  componentStatements: {
    table: [
      `CREATE TABLE table_messages (
        seq INTEGER PRIMARY KEY CHECK (seq > 0),
        message_id TEXT NOT NULL UNIQUE,
        sender_membership_id TEXT NOT NULL,
        body TEXT NOT NULL,
        body_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        reply_to_message_id TEXT
      )`,
      "CREATE INDEX table_messages_by_time ON table_messages(created_at)",
      `CREATE TABLE table_post_receipts (
        guest_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        message_seq INTEGER NOT NULL,
        PRIMARY KEY(guest_id, request_id)
      )`,
      "CREATE TABLE table_transcript_usage (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), body_bytes INTEGER NOT NULL DEFAULT 0)",
      "INSERT INTO table_transcript_usage(singleton,body_bytes) VALUES (1,0)",
    ],
  },
} as const;
