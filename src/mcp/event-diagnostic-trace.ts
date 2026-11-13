import {
  activeEventDiagnosticPolicy,
  type EventDiagnosticRecord,
  eventDiagnosticPolicyDigest,
} from "../evidence/event-diagnostics";

export interface EventDiagnosticTrace {
  readonly methodHint: EventDiagnosticRecord["method"];
  record(
    method: EventDiagnosticRecord["method"],
    stage: EventDiagnosticRecord["stage"],
    outcome: EventDiagnosticRecord["outcome"],
    detail?: EventDiagnosticRecord["detail"],
  ): void;
  finish(ctx: ExecutionContext): void;
}

/** A header is only a routing hint; actual handler entries are recorded separately. */
export function eventMethodHint(
  value: string | null,
): EventDiagnosticRecord["method"] {
  switch (value) {
    case "initialize":
    case "server/discover":
    case "events/list":
    case "events/subscribe":
    case "events/unsubscribe":
      return value;
    default:
      return "other";
  }
}

/** Keep diagnostics out of the protocol response and never retain request fields. */
export function beginEventDiagnosticTrace(
  request: Request,
  env: Env,
): EventDiagnosticTrace | undefined {
  const policy = activeEventDiagnosticPolicy(env);
  if (!policy || new URL(request.url).pathname !== "/mcp") return undefined;
  // Routine tool calls, including this diagnostic read, must not evict traces.
  const declaredMethod = request.headers.get("Mcp-Method");
  if (declaredMethod === "tools/call" || declaredMethod === "tools/list")
    return undefined;
  const diagnosticId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const methodHint = eventMethodHint(declaredMethod);
  const records: EventDiagnosticRecord[] = [];
  let finished = false;
  return {
    methodHint,
    record(method, stage, outcome, detail = "none") {
      if (finished || records.length >= 16) return;
      records.push({
        diagnosticId,
        observedAt: Date.now(),
        method,
        stage,
        outcome,
        detail,
      });
    },
    finish(ctx) {
      if (finished) return;
      finished = true;
      // Rejections before edge admission must not create a new DO write path.
      if (!records.some((record) => record.stage === "authentication")) return;
      // One bounded asynchronous write must not change an application's result.
      const persist = async () => {
        try {
          const policyDigest = await eventDiagnosticPolicyDigest(policy);
          await env.GUESTS.get(
            env.GUESTS.idFromName(policy.recipientGuestId),
          ).recordEventDiagnostics(records, {
            buildSha: policy.buildSha,
            approvalRef: policy.approvalRef,
            policyDigest,
          });
        } catch {
          // Missing diagnostics remain unknown, never evidence of no request.
        }
      };
      try {
        ctx.waitUntil(persist());
      } catch {
        // An unavailable execution context must not break the public operation.
      }
    },
  };
}
