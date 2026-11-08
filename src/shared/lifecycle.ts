/** Idempotent, minimal shared close receipt. */
export interface CloseTableReceipt {
  table_id: string;
  state: "closed";
  closed_at: string;
  expires_at: string;
}

/** Internal-only deletion response; never discloses retained content. */
export interface PurgeTableReceipt {
  table_id: string;
  state: "deleted";
}

/**
 * Best-effort invalidation hint, not an authorization or delivery record.
 * Consumers must recheck TableDO before each new outbound side effect.
 */
export interface LifecycleInvalidation {
  tableId: string;
  state: "closed" | "expired" | "deleted";
}
