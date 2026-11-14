import { createHash } from "node:crypto";
import { recoveryGenerationSchema } from "../../schema/012_recovery_generation.ts";
import type { RecoveryDoBinding } from "./recovery.ts";

const APPLICATION_SCHEMA_VERSION = 12;

export const RECOVERY_MARKER_SQL =
  recoveryGenerationSchema.statements[0].replace(
    "CREATE TABLE ",
    "CREATE TABLE IF NOT EXISTS ",
  );
export const MARKER = "__agent_table_recovery";
export const SCHEMA = "__agent_table_schema";
const MARKER_COLUMNS = [
  "singleton",
  "component",
  "generation",
  "operation_id",
  "plan_sha256",
] as const;
const SCHEMA_COLUMNS = ["singleton", "component", "version"] as const;
export interface RecoveryStorageDescriptor {
  component: string;
  binding: RecoveryDoBinding;
  schemaVersion: number;
  tables: readonly { name: string; columns: readonly string[] }[];
  applicationSchema: boolean;
  schemaSha256: string;
}

/** Exact reviewed SQLite DDL, including constraints and explicit indexes. */
export function recoverySchemaCatalogSha256(
  catalog: readonly {
    name: string;
    type: string;
    tbl_name: string;
    sql: string | null;
  }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...catalog]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((row) => ({
            name: row.name,
            type: row.type,
            table: row.tbl_name,
            sql: row.sql?.trim() ?? null,
          })),
      ),
    )
    .digest("hex");
}

const table = (
  name: string,
  columns: string,
): { name: string; columns: readonly string[] } => ({
  name,
  columns: columns.split(","),
});

export const GUEST_RECOVERY_STORAGE: RecoveryStorageDescriptor = {
  component: "guest",
  binding: "GUESTS",
  schemaVersion: APPLICATION_SCHEMA_VERSION,
  applicationSchema: true,
  // Applying migrations 1..12 to a virgin guest SQLite database produces this
  // catalog. Recovery tests verify the same catalog in the pinned Workerd.
  schemaSha256:
    "9586006bff9ab0daee6130c49eeede14bb4a78d88804717ff6aec4ee1975539a",
  // Child rows precede their referenced identity during an approved reset.
  tables: [
    table(
      "guest_creation_reservations",
      "request_id,guest_id,request_digest,table_id,created_at,expires_at,retention_until,charged_at,outcome",
    ),
    table(
      "guest_connections",
      "connection_id,guest_id,scopes_json,created_at,expires_at,revoked_at",
    ),
    table(
      "guest_sessions",
      "session_id,secret_digest,created_at,expires_at,invalidated_at",
    ),
    table("guest_identity", "singleton,guest_id,created_at"),
  ],
};

export const TABLE_RECOVERY_STORAGE: RecoveryStorageDescriptor = {
  component: "table",
  binding: "TABLES",
  schemaVersion: APPLICATION_SCHEMA_VERSION,
  applicationSchema: true,
  schemaSha256:
    "b32cb9770b0184126645b4f692053ea54c522ecd5592e190a781ebf786adb55f",
  tables: [
    table(
      "table_event_outbox",
      "event_id,message_id,message_seq,recipient_membership_id,subscription_id,subscription_generation,status,attempt_count,first_attempt_at,next_attempt_at,lease_token,lease_deadline,created_at,expires_at,last_error_category",
    ),
    table(
      "table_event_candidates",
      "membership_id,candidate_id,subscription_id,guest_id,connection_id,callback_url,secret_envelope,requested_ttl_ms,fence,expires_at",
    ),
    table(
      "table_event_subscriptions",
      "membership_id,generation,fence,status,guest_id,connection_id,subscription_id,callback_url,secret_envelope,previous_secret_envelope,rotation_until,expires_at",
    ),
    table("table_delete_confirmations", "guest_id,request_id,expires_at,state"),
    table("table_tombstone_delete_receipts", "guest_id,request_id"),
    table(
      "table_post_receipts",
      "guest_id,request_id,request_digest,message_seq",
    ),
    table(
      "table_messages",
      "seq,message_id,sender_membership_id,body,body_bytes,created_at,reply_to_message_id",
    ),
    table("table_transcript_usage", "singleton,body_bytes"),
    table(
      "table_join_receipts",
      "guest_id,request_id,invite_id,secret_digest,membership_id",
    ),
    table(
      "table_invitations",
      "invite_id,request_id,issuer_guest_id,secret_digest,response_envelope,issued_at,expires_at,state,consumed_by,consumed_at",
    ),
    table(
      "table_memberships",
      "membership_id,table_id,guest_id,seat,role,joined_at,latest_peer_seq",
    ),
    table(
      "table_metadata",
      "singleton,table_id,creation_request_id,request_digest,creator_guest_id,title,purpose,state,created_at,expires_at,closed_at,deleted_at,last_seq",
    ),
    table("table_tombstone_guests", "guest_id"),
    table(
      "table_tombstones",
      "table_id,terminal_state,expires_at,terminal_at,retain_until",
    ),
  ],
};

export function recoveryStorageManifest(descriptor: RecoveryStorageDescriptor) {
  return [
    ...(descriptor.applicationSchema
      ? [{ name: SCHEMA, columns: SCHEMA_COLUMNS }]
      : []),
    { name: MARKER, columns: MARKER_COLUMNS },
    ...descriptor.tables,
  ];
}

export const ADMISSION_RECOVERY_STORAGE: RecoveryStorageDescriptor = {
  component: "admission",
  binding: "ADMISSION",
  schemaVersion: 1,
  applicationSchema: false,
  schemaSha256:
    "92bbc5007efab3e4707f89c11e76d3a0f72bf50082222e7113ec8e907467761f",
  tables: [table("admission_hits", "id,category,created_at")],
};
export const OAUTH_RECOVERY_STORAGE: RecoveryStorageDescriptor = {
  component: "oauth-token",
  binding: "OAUTH_SERIALIZER",
  schemaVersion: 1,
  applicationSchema: false,
  schemaSha256:
    "56f153f1d95e4e22d1c6a013b2f7ee21084c4bc4ba13b6adb201b03cc2ca11cc",
  tables: [],
};
