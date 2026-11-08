// Each Durable Object owns its application schema independently.
export const initialSchema = {
  version: 1,
  statements: [
    `CREATE TABLE __agent_table_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      component TEXT NOT NULL CHECK (component IN ('table', 'guest')),
      version INTEGER NOT NULL CHECK (version > 0)
    )`,
  ],
} as const;
