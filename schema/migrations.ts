import { initialSchema } from "./001_initial";
import { guestSessionsSchema } from "./002_guest_sessions";
import { connectionGrantsSchema } from "./003_connection_grants";

export const migrations = [
  initialSchema,
  guestSessionsSchema,
  connectionGrantsSchema,
] as const;

export const APPLICATION_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
