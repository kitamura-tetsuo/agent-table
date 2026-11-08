import { initialSchema } from "./001_initial";
import { guestSessionsSchema } from "./002_guest_sessions";

export const migrations = [initialSchema, guestSessionsSchema] as const;

export const APPLICATION_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
