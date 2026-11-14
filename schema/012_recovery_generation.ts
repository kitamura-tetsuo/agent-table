/** A restored marker is usable only with matching independent recovery authority. */
export const recoveryGenerationSchema = {
  version: 12,
  statements: [
    `CREATE TABLE __agent_table_recovery (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      component TEXT NOT NULL,
      generation TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL
    )`,
  ],
} as const;
