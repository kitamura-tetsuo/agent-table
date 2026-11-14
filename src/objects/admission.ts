import { DurableObject } from "cloudflare:workers";
import {
  ADMISSION_RECOVERY_STORAGE,
  initializeRecoveryFence,
  inspectRecoveryObject,
  RECOVERY_MARKER_SQL,
  type RecoveryObjectRequest,
  recoveryObjectDenied,
  recoveryStorageWasVirgin,
  resetRecoveryObject,
} from "../shared/recovery-storage";
import {
  deferQuarantinedAlarm,
  isRestoreQuarantined,
  RESTORE_QUARANTINE_RECHECK_MS,
} from "../shared/release-quarantine";

export { ADMISSION_RECOVERY_STORAGE } from "../shared/recovery-manifests";

export type AdmissionBucket =
  | "guest"
  | "dcr"
  | "protocol"
  | "application"
  | "invitation";

export type AdmissionDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

const WINDOW_MS = 60_000;
const CATEGORIES: ReadonlySet<string> = new Set([
  "guest",
  "dcr",
  "protocol",
  "application",
  "invitation",
]);

/**
 * One object is assigned to each trusted edge source or authenticated guest.
 * SQLite transactions serialize competing Worker isolates and connections.
 * Stored rows contain only timestamps and categories, never credentials,
 * source IPs, table IDs or request payloads.
 */
export class AdmissionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const virgin = recoveryStorageWasVirgin(ctx.storage);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS admission_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS admission_hits_by_window ON admission_hits(category, created_at)",
    );
    ctx.storage.sql.exec(RECOVERY_MARKER_SQL);
    ctx.blockConcurrencyWhile(() =>
      initializeRecoveryFence(ctx, env, ADMISSION_RECOVERY_STORAGE, virgin),
    );
  }

  private denied(): boolean {
    return (
      isRestoreQuarantined(this.env) ||
      recoveryObjectDenied(
        this.ctx.storage,
        this.env,
        ADMISSION_RECOVERY_STORAGE,
      )
    );
  }

  inspectRecovery(input: RecoveryObjectRequest) {
    return inspectRecoveryObject(
      this.ctx,
      this.env,
      ADMISSION_RECOVERY_STORAGE,
      input,
    );
  }

  resetRecovery(input: RecoveryObjectRequest) {
    return resetRecoveryObject(
      this.ctx,
      this.env,
      ADMISSION_RECOVERY_STORAGE,
      input,
    );
  }

  async alarm(): Promise<void> {
    if (await deferQuarantinedAlarm(this.env, this.ctx.storage)) return;
    if (this.denied()) {
      await this.ctx.storage.setAlarm(
        Date.now() + RESTORE_QUARANTINE_RECHECK_MS,
      );
      return;
    }
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Charge even failed application requests before invoking a handler.
   * Use a rolling 60-second window; reject without creating another row.
   * There is no per-isolate cache or eventual-consistency escape path.
   */
  consume(category: AdmissionBucket, maximum: number): AdmissionDecision {
    if (this.denied()) return { allowed: false, retryAfterMs: WINDOW_MS };
    if (
      !CATEGORIES.has(category) ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 10_000
    ) {
      throw new Error("Invalid admission policy");
    }
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      if (this.denied()) return { allowed: false, retryAfterMs: WINDOW_MS };
      this.ctx.storage.sql.exec(
        "DELETE FROM admission_hits WHERE created_at <= ?",
        now - WINDOW_MS,
      );
      const window = this.ctx.storage.sql
        .exec<{ count: number; oldest: number | null }>(
          "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM admission_hits WHERE category = ?",
          category,
        )
        .one();
      if (window.count >= maximum) {
        return {
          allowed: false,
          retryAfterMs: Math.max(
            1_000,
            (window.oldest ?? now) + WINDOW_MS - now,
          ),
        };
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO admission_hits (category, created_at) VALUES (?, ?)",
        category,
        now,
      );
      return { allowed: true };
    });
  }
}
