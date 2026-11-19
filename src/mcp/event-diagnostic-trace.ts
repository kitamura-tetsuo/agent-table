import {
  activeEventDiagnosticPolicy,
  type EventDiagnosticRecord,
  eventDiagnosticPolicyDigest,
} from "../evidence/event-diagnostics";
import {
  activeNativeDiagnosticPolicy,
  nativeDiagnosticBindingKey,
  nativeDiagnosticDigest,
} from "../shared/native-event-diagnostics";

export interface EventDiagnosticTrace {
  authenticate?(actor: { guestId: string; connectionId: string }): void;
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
  const native = activeNativeDiagnosticPolicy(env);
  if (native) return beginNativeTrace(request, env, native);
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

/** Native diagnostics bind identity only after OAuth authentication. Header hints
 * never select a recipient or count as an actual handler observation. */
function beginNativeTrace(
  request: Request,
  env: Env,
  policy: NonNullable<ReturnType<typeof activeNativeDiagnosticPolicy>>,
): EventDiagnosticTrace | undefined {
  if (new URL(request.url).pathname !== "/mcp") return undefined;
  const bindingKey = nativeDiagnosticBindingKey(env, policy);
  const digest = nativeDiagnosticDigest(env, policy).catch(() => null);
  const records: EventDiagnosticRecord[] = [];
  const diagnosticId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  let actor: { guestId: string; connectionId: string } | undefined;
  let finished = false;
  return {
    methodHint: eventMethodHint(request.headers.get("Mcp-Method")),
    authenticate(value) {
      if (!finished && value.connectionId === policy.connectionId)
        actor = { ...value };
    },
    record(method, stage, outcome, detail = "none") {
      if (
        finished ||
        !actor ||
        records.length >= 16 ||
        (method !== "events/list" && method !== "events/subscribe")
      )
        return;
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
      if (!actor || !records.length) return;
      const owner = actor;
      const persist = async () => {
        try {
          const policyDigest = await digest;
          if (
            !policyDigest ||
            nativeDiagnosticBindingKey(env, policy) !== bindingKey
          )
            return;
          await env.GUESTS.get(
            env.GUESTS.idFromName(owner.guestId),
          ).recordEventDiagnostics(
            records,
            {
              buildSha: policy.buildSha,
              approvalRef: policy.approvalRef,
              policyDigest,
            },
            owner,
          );
        } catch {
          /* Best effort; absence is unknown. */
        }
      };
      try {
        ctx.waitUntil(persist());
      } catch {
        /* No protocol side effects. */
      }
    },
  };
}
