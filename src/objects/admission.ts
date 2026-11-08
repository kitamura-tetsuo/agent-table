import { DurableObject } from "cloudflare:workers";

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
  }

  /**
   * Charge even failed application requests before invoking a handler.
   * Use a rolling 60-second window; reject without creating another row.
   * There is no per-isolate cache or eventual-consistency escape path.
   */
  consume(category: AdmissionBucket, maximum: number): AdmissionDecision {
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
          retryAfterMs: Math.max(1_000, (window.oldest ?? now) + WINDOW_MS - now),
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
