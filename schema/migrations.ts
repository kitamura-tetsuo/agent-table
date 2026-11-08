import { initialSchema } from "./001_initial";
import { guestSessionsSchema } from "./002_guest_sessions";
import { connectionGrantsSchema } from "./003_connection_grants";
import { creationReservationsSchema } from "./004_creation_reservations";

export const migrations = [
  initialSchema,
  guestSessionsSchema,
  connectionGrantsSchema,
  creationReservationsSchema,
] as const;

export const APPLICATION_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
