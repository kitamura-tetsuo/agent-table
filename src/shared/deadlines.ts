/**
 * Local Durable Object scheduling. A promise queue coordinates only the short
 * per-instance decision; the alarm and SQL storage remain durable authorities.
 */
export const DEADLINE_POLICY = {
  recoveryWakeupMs: 60_000,
  backlogWakeupMs: 1_000,
  maxDrainBatch: 100,
} as const;

export type DeadlineObservation<T> = {
  value: T;
  alarmAt: number;
};

export type DrainObservation = {
  processed: number;
  nextDeadline: number | null;
  alarmAt: number | null;
};

type SchedulerCheckpoint =
  | "before-arm"
  | "after-arm"
  | "after-mutation"
  | "before-safety-arm"
  | "after-safety-arm"
  | "before-rearm"
  | "after-durable-commit";

function validDeadline(deadline: number): boolean {
  return Number.isSafeInteger(deadline) && deadline > 0;
}

export class DurableDeadlineScheduler {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: DurableObjectStorage) {}

  /** A deterministic fault/barrier seam, accessible only inside DO test code. */
  private async checkpoint(_phase: SchedulerCheckpoint): Promise<void> {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Alarm and synchronous SQL mutation commit atomically in the pinned SQLite
   * runtime's async storage transaction; a failed arm cannot commit the work.
   */
  commitWithWakeup<T>(
    deadline: number,
    mutation: () => T,
  ): Promise<DeadlineObservation<T>> {
    if (!validDeadline(deadline)) {
      return Promise.reject(new Error("Invalid durable deadline"));
    }
    return this.serialize(async () => {
      await this.checkpoint("before-arm");
      const result = await this.storage.transaction(async (txn) => {
        const current = await txn.getAlarm();
        const next = current === null ? deadline : Math.min(current, deadline);
        if (current === null || next < current) {
          await txn.setAlarm(next);
        }
        await this.checkpoint("after-arm");
        const value = this.storage.transactionSync(mutation);
        await this.checkpoint("after-mutation");
        return { value, alarmAt: next };
      });
      await this.checkpoint("after-durable-commit");
      return result;
    });
  }

  /**
   * On reconstruction, restore a missing alarm without disturbing an earlier
   * one. Existing data is examined in its own durable storage transaction.
   */
  ensureExistingWakeup(
    findEarliest: () => number | null,
  ): Promise<number | null> {
    return this.serialize(() =>
      this.storage.transaction(async (txn) => {
        const current = await txn.getAlarm();
        const earliest = this.storage.transactionSync(findEarliest);
        if (earliest !== null && !validDeadline(earliest)) {
          throw new Error("Invalid persisted deadline");
        }
        if (earliest !== null && (current === null || earliest < current)) {
          await txn.setAlarm(earliest);
          return earliest;
        }
        return current;
      }),
    );
  }

  /**
   * Rearm recovery separately before processing an alarm: a crash or repeated
   * storage failure cannot exhaust the platform's bounded automatic retries.
   */
  drainDueWork(
    findEarliest: () => number | null,
    processDue: (now: number, budget: number) => number,
  ): Promise<DrainObservation> {
    return this.serialize(async () => {
      const safety = Date.now() + DEADLINE_POLICY.recoveryWakeupMs;
      await this.checkpoint("before-safety-arm");
      await this.storage.transaction(async (txn) => {
        const current = await txn.getAlarm();
        if (current === null || current <= Date.now() || safety < current) {
          await txn.setAlarm(safety);
        }
      });
      await this.checkpoint("after-safety-arm");

      const result = await this.storage.transaction(async (txn) => {
        const now = Date.now();
        const processed = this.storage.transactionSync(() =>
          processDue(now, DEADLINE_POLICY.maxDrainBatch),
        );
        if (
          !Number.isInteger(processed) ||
          processed < 0 ||
          processed > DEADLINE_POLICY.maxDrainBatch
        ) {
          throw new Error("Invalid deadline drain count");
        }
        await this.checkpoint("after-mutation");
        const nextDeadline = this.storage.transactionSync(findEarliest);
        if (nextDeadline !== null && !validDeadline(nextDeadline)) {
          throw new Error("Invalid persisted deadline");
        }
        await this.checkpoint("before-rearm");
        if (nextDeadline === null) {
          await txn.deleteAlarm();
          return { processed, nextDeadline, alarmAt: null };
        }
        const alarmAt = Math.max(
          nextDeadline,
          Date.now() + DEADLINE_POLICY.backlogWakeupMs,
        );
        await txn.setAlarm(alarmAt);
        return { processed, nextDeadline, alarmAt };
      });
      await this.checkpoint("after-durable-commit");
      return result;
    });
  }
}
