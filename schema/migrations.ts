import { initialSchema } from "./001_initial";
import { guestSessionsSchema } from "./002_guest_sessions";
import { connectionGrantsSchema } from "./003_connection_grants";
import { creationReservationsSchema } from "./004_creation_reservations";
import { tableAuthoritySchema } from "./005_table_authority";
import { invitationsSchema } from "./006_invitations";
import { transcriptSchema } from "./007_transcript";
import { lifecycleSchema } from "./008_lifecycle";
import { deletionConfirmationSchema } from "./009_deletion_confirmation";
import { eventSubscriptionsSchema } from "./010_event_subscriptions";
import { durableEventOutboxSchema } from "./011_durable_event_outbox";
import { recoveryGenerationSchema } from "./012_recovery_generation";

export const migrations = [
  initialSchema,
  guestSessionsSchema,
  connectionGrantsSchema,
  creationReservationsSchema,
  tableAuthoritySchema,
  invitationsSchema,
  transcriptSchema,
  lifecycleSchema,
  deletionConfirmationSchema,
  eventSubscriptionsSchema,
  durableEventOutboxSchema,
  recoveryGenerationSchema,
] as const;

export const APPLICATION_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
