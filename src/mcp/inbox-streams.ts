import type { InboxSubscriptionCheck } from "./subscriptions";

export const INBOX_AUTH_POLL_MS = 1_000;

export type InboxStreamStopReason =
  | "cancelled"
  | "replaced"
  | "deadline"
  | "authorization"
  | "slow_consumer"
  | "concurrency"
  | "terminal";

type Entry = {
  cancellationId: string;
  snapshot: InboxSubscriptionCheck;
  controller: ReadableStreamDefaultController<Uint8Array>;
  check: () => Promise<InboxSubscriptionCheck | null>;
  deadline: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setTimeout>;
  checking: boolean;
  started: number;
};

/** Internal byte-stream plumbing, NOT an MCP transport or subscription ack. */
export class InboxHintStreams {
  private readonly entries = new Map<string, Entry>();
  private pendingChecks = 0;

  constructor(
    private readonly observe: (active: number, durationMs?: number) => void,
    private readonly onStop?: (
      reason: InboxStreamStopReason,
      durationMs: number,
    ) => void,
    private readonly canEmit: () => boolean = () => true,
  ) {}

  attach(
    snapshot: InboxSubscriptionCheck,
    check: Entry["check"],
    cancellationId: string = crypto.randomUUID(),
  ): ReadableStream<Uint8Array> {
    const old = this.entries.get(snapshot.membershipId);
    if (old) this.stop(old, "replaced");
    // A private table has exactly two seats. Do not silently expand that bound.
    if (
      !this.canEmit() ||
      this.entries.size >= 2 ||
      snapshot.expiresAt <= Date.now()
    ) {
      throw new Error("Inbox stream unavailable");
    }
    let entry: Entry;
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          entry = {
            cancellationId,
            snapshot: { ...snapshot },
            controller,
            check,
            checking: false,
            started: Date.now(),
            deadline: setTimeout(
              () => this.stop(entry, "deadline"),
              snapshot.expiresAt - Date.now(),
            ),
          };
          this.entries.set(snapshot.membershipId, entry);
          this.observe(this.entries.size);
          this.poll(entry);
        },
        cancel: () => this.stop(entry, "cancelled", true),
      },
      // At most one small URI hint is queued here. RPC/network buffering is a
      // separate boundary; this does not bound a future SDK router's SSE queue.
      { highWaterMark: 1 },
    );
  }

  closeAll(): void {
    for (const entry of this.entries.values()) this.stop(entry, "terminal");
  }

  cancel(membershipId: string, cancellationId: string): void {
    const entry = this.entries.get(membershipId);
    if (entry && entry.cancellationId === cancellationId)
      this.stop(entry, "cancelled");
  }

  async notify(membershipId: string): Promise<void> {
    const entry = this.entries.get(membershipId);
    if (!entry) return;
    if (!(await this.revalidate(entry)) || !this.current(entry)) return;
    if (!this.canEmit()) {
      this.stop(entry, "authorization");
      return;
    }
    if ((entry.controller.desiredSize ?? 0) <= 0) {
      this.stop(entry, "slow_consumer");
      return;
    }
    // Only the canonical URI crosses this boundary: no text, actor, or cursor.
    entry.controller.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({ kind: "resource_updated", uri: entry.snapshot.uri })}\n`,
      ),
    );
  }

  private current(entry: Entry): boolean {
    return this.entries.get(entry.snapshot.membershipId) === entry;
  }

  private stop(
    entry: Entry,
    reason: InboxStreamStopReason,
    sourceAlreadyCancelled = false,
  ): void {
    if (!this.current(entry)) return;
    this.entries.delete(entry.snapshot.membershipId);
    clearTimeout(entry.deadline);
    clearTimeout(entry.poll);
    // Error discards queued hints on replacement, expiry and invalidation.
    // Bytes already read by a downstream consumer cannot be recalled.
    if (!sourceAlreadyCancelled)
      entry.controller.error(new Error("Inbox stream ended"));
    const duration = Date.now() - entry.started;
    this.observe(this.entries.size, duration);
    this.onStop?.(reason, duration);
  }

  private poll(entry: Entry): void {
    entry.poll = setTimeout(async () => {
      if (!this.current(entry)) return;
      if (!entry.checking) await this.revalidate(entry);
      if (this.current(entry)) this.poll(entry);
    }, INBOX_AUTH_POLL_MS);
  }

  private async revalidate(entry: Entry): Promise<boolean> {
    if (!this.current(entry)) return false;
    // No per-post promise queue, including when GuestDO is slow. Conservative
    // termination on overlap lets a client reconnect and recover by cursor.
    if (entry.checking || this.pendingChecks >= 2) {
      this.stop(entry, "concurrency");
      return false;
    }
    entry.checking = true;
    this.pendingChecks++;
    try {
      const checked = await entry.check();
      if (!this.current(entry)) return false;
      if (
        !this.canEmit() ||
        !checked ||
        checked.uri !== entry.snapshot.uri ||
        checked.membershipId !== entry.snapshot.membershipId ||
        checked.tableId !== entry.snapshot.tableId ||
        Math.min(checked.expiresAt, entry.snapshot.expiresAt) <= Date.now()
      ) {
        this.stop(entry, "authorization");
        return false;
      }
      // Revalidation can shorten a lifetime, never renew it.
      if (checked.expiresAt < entry.snapshot.expiresAt) {
        entry.snapshot = { ...entry.snapshot, expiresAt: checked.expiresAt };
        clearTimeout(entry.deadline);
        entry.deadline = setTimeout(
          () => this.stop(entry, "deadline"),
          checked.expiresAt - Date.now(),
        );
      }
      return true;
    } catch {
      this.stop(entry, "authorization");
      return false;
    } finally {
      entry.checking = false;
      this.pendingChecks--;
    }
  }
}
