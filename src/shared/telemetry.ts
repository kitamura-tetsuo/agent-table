/**
 * Operational telemetry is an allowlisted record of observations, not a
 * transcript, trace of a private identity, or evidence of a later host action.
 */
export type SafeRoute =
  | "guest"
  | "dcr"
  | "protocol"
  | "application"
  | "invitation"
  | "other";

export type OperationalEvent =
  | {
      kind: "stream";
      reason:
        | "cancelled"
        | "replaced"
        | "deadline"
        | "authorization"
        | "slow_consumer"
        | "concurrency"
        | "terminal"
        | "output_cap"
        | "transport";
      durationMs: number;
    }
  | {
      kind: "http";
      route: SafeRoute;
      outcome: "response" | "exception";
      status: number;
      durationMs: number;
      correlationId: string;
    }
  | {
      kind: "alarm";
      component: "guest" | "table";
      outcome: "committed" | "unknown";
      processed: number | null;
      backlogLagMs: number | null;
      durationMs: number;
    }
  | {
      kind: "commit";
      operation: "post_message" | "create_table" | "close_table";
      outcome: "committed" | "unknown";
      durationMs: number;
    }
  | {
      kind: "invitation";
      operation: "create_invite" | "join_table";
      outcome: "accepted" | "rejected" | "unknown";
      failureCategory:
        | "none"
        | "invalid"
        | "expired"
        | "denied"
        | "unavailable"
        | "other";
      durationMs: number;
    };

export type FutureMetric =
  | { name: "stream.active"; value: number }
  | { name: "stream.duration_ms"; value: number }
  | { name: "outbox.pending"; value: number }
  | { name: "outbox.oldest_age_ms"; value: number }
  | { name: "outbox.retry"; value: number }
  | { name: "outbox.delivery_failure"; value: number };

// These are independent causal observations. Neither HTTP 2xx nor a storage
// commit implies receiver acceptance, a host run, or a committed peer reply.
export type ProgressEvidence = {
  storage: "committed" | "not_committed" | "unknown";
  transport: "observed" | "failed" | "unknown";
  receiver: "accepted" | "rejected" | "unknown";
  hostRun: "observed" | "unknown";
  reply: "committed" | "unknown";
};

export const unobservedProgress: ProgressEvidence = {
  storage: "unknown",
  transport: "unknown",
  receiver: "unknown",
  hostRun: "unknown",
  reply: "unknown",
};

const ROUTES: ReadonlySet<string> = new Set([
  "guest",
  "dcr",
  "protocol",
  "application",
  "invitation",
  "other",
]);
const METRICS: ReadonlySet<string> = new Set([
  "stream.active",
  "stream.duration_ms",
  "outbox.pending",
  "outbox.oldest_age_ms",
  "outbox.retry",
  "outbox.delivery_failure",
]);
const MAX_MEASUREMENT = 1_000_000_000;
const CORRELATION = /^[a-f0-9]{12}$/;

function measurement(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_MEASUREMENT, Math.floor(value));
}

function publish(record: Record<string, string | number | null>): void {
  try {
    // Explicit scalar fields only: never serialize a request, error, body,
    // URL, guest/table identifier, or arbitrary user-controlled object.
    console.log({ schema: "agent-table.telemetry.v1", ...record });
  } catch {
    // Observability must not change the operation's authoritative outcome.
  }
}

/** A fresh, nonpersistent request correlation token, never a user identity. */
export function correlationId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

export function emitOperationalEvent(event: OperationalEvent): void {
  const duration = measurement(event.durationMs);
  if (duration === null) return;
  if (event.kind === "http") {
    if (
      !ROUTES.has(event.route) ||
      (event.outcome !== "response" && event.outcome !== "exception") ||
      !Number.isInteger(event.status) ||
      event.status < 100 ||
      event.status > 599 ||
      !CORRELATION.test(event.correlationId)
    )
      return;
    publish({
      kind: "http",
      route: event.route,
      outcome: event.outcome,
      status: event.status,
      durationMs: duration,
      correlationId: event.correlationId,
    });
    return;
  }
  if (event.kind === "alarm") {
    if (
      (event.component !== "guest" && event.component !== "table") ||
      (event.outcome !== "committed" && event.outcome !== "unknown")
    )
      return;
    const processed = measurement(event.processed);
    const lag = measurement(event.backlogLagMs);
    if (
      (event.processed !== null && processed === null) ||
      (event.backlogLagMs !== null && lag === null)
    )
      return;
    publish({
      kind: "alarm",
      component: event.component,
      outcome: event.outcome,
      processed,
      backlogLagMs: lag,
      durationMs: duration,
    });
    return;
  }
  if (event.kind === "stream") {
    if (
      ![
        "cancelled",
        "replaced",
        "deadline",
        "authorization",
        "slow_consumer",
        "concurrency",
        "terminal",
        "output_cap",
        "transport",
      ].includes(event.reason)
    )
      return;
    publish({ kind: "stream", reason: event.reason, durationMs: duration });
    return;
  }
  if (event.kind === "invitation") {
    if (
      (event.operation !== "create_invite" &&
        event.operation !== "join_table") ||
      !["accepted", "rejected", "unknown"].includes(event.outcome) ||
      ![
        "none",
        "invalid",
        "expired",
        "denied",
        "unavailable",
        "other",
      ].includes(event.failureCategory) ||
      (event.outcome === "accepted") !== (event.failureCategory === "none")
    )
      return;
    publish({
      kind: "invitation",
      operation: event.operation,
      outcome: event.outcome,
      failureCategory: event.failureCategory,
      durationMs: duration,
    });
    return;
  }
  if (
    event.kind === "commit" &&
    (event.operation === "post_message" ||
      event.operation === "create_table" ||
      event.operation === "close_table") &&
    (event.outcome === "committed" || event.outcome === "unknown")
  ) {
    publish({
      kind: "commit",
      operation: event.operation,
      outcome: event.outcome,
      durationMs: duration,
    });
  }
}

/** Extension seam: unused notification metrics are never emitted as zeroes. */
export function recordFutureMetric(metric: FutureMetric): void {
  const value = measurement(metric.value);
  if (!METRICS.has(metric.name) || value === null) return;
  publish({ kind: "metric", name: metric.name, value });
}
