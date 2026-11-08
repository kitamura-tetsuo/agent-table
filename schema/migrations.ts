import { initialSchema } from "./001_initial";

export const migrations = [initialSchema] as const;

export const APPLICATION_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
