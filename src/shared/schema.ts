import {
  APPLICATION_SCHEMA_VERSION,
  migrations,
} from "../../schema/migrations";

export type ApplicationComponent = "table" | "guest";

type SchemaRow = { component: string; version: number };

export class UnsupportedApplicationSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedApplicationSchemaError";
  }
}

// Cloudflare class migrations select the SQLite backend; these migrations
// version each object's application schema and never reset newer storage.
export function initializeApplicationSchema(
  storage: DurableObjectStorage,
  component: ApplicationComponent,
): void {
  storage.transactionSync(() => {
    const hasVersionTable =
      storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__agent_table_schema'",
        )
        .toArray().length !== 0;

    const row = hasVersionTable
      ? storage.sql
          .exec<SchemaRow>(
            "SELECT component, version FROM __agent_table_schema WHERE singleton = 1",
          )
          .toArray()[0]
      : undefined;

    if (hasVersionTable && !row) {
      throw new UnsupportedApplicationSchemaError(
        "Application schema metadata is missing; refusing to recreate it",
      );
    }
    if (row && row.component !== component) {
      throw new UnsupportedApplicationSchemaError(
        "Durable Object application schema belongs to another component",
      );
    }
    if (row && row.version > APPLICATION_SCHEMA_VERSION) {
      throw new UnsupportedApplicationSchemaError(
        `Application schema version ${row.version} is newer than supported ${APPLICATION_SCHEMA_VERSION}`,
      );
    }

    let version = row?.version ?? 0;
    for (const migration of migrations) {
      if (migration.version <= version) continue;

      for (const statement of migration.statements) {
        storage.sql.exec(statement);
      }
      if ("componentStatements" in migration) {
        const statements =
          component === "guest"
            ? "guest" in migration.componentStatements
              ? migration.componentStatements.guest
              : []
            : "table" in migration.componentStatements
              ? migration.componentStatements.table
              : [];
        for (const statement of statements) {
          storage.sql.exec(statement);
        }
      }
      if (version === 0) {
        storage.sql.exec(
          "INSERT INTO __agent_table_schema (singleton, component, version) VALUES (1, ?, ?)",
          component,
          migration.version,
        );
      } else {
        storage.sql.exec(
          "UPDATE __agent_table_schema SET version = ? WHERE singleton = 1",
          migration.version,
        );
      }
      version = migration.version;
    }
  });
}

export function readApplicationSchemaVersion(
  storage: DurableObjectStorage,
): number {
  return storage.sql
    .exec<{ version: number }>(
      "SELECT version FROM __agent_table_schema WHERE singleton = 1",
    )
    .one().version;
}
