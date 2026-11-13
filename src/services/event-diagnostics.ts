import {
  type EventDiagnosticSnapshot,
  eventDiagnosticContext,
  type SafeEventRuntimeContext,
} from "../evidence/event-diagnostics";
import type { VerifiedConnectionActor } from "../shared/auth";
import { validTableId } from "../shared/invitations";
import { isRestoreQuarantined } from "../shared/release-quarantine";
import type {
  SafeTableMetadata,
  TableResult,
  TableState,
} from "../shared/table";

export type TableEventDiagnostics = {
  observedAt: string;
  context: SafeEventRuntimeContext;
  /** Null means unknown, including an unavailable, stale or mismatched record. */
  callbackOrigin: string | null;
  lifecycle: {
    state: TableState;
    expiresAt: string;
    expired: boolean;
  };
  notifications: NonNullable<SafeTableMetadata["notifications"]>;
};

export type EventDiagnostics = {
  schemaVersion: 1;
  observedAt: string;
  worker: SafeEventRuntimeContext;
  table: TableEventDiagnostics;
  recent:
    | ({ status: "available" } & EventDiagnosticSnapshot)
    | { status: "unknown" };
  limitations: {
    recordingIsBestEffort: true;
    emptyRecordsDoNotProveNoRequest: true;
    missingCallbackOriginIsUnknown: true;
    arrivalDoesNotProveHostAcceptance: true;
    componentReadsAreAtomic: false;
    pendingCountCoversOwnActiveSubscriptionOnly: true;
  };
};

/** Read actual membership authority before exposing any component diagnostics. */
export async function getEventDiagnostics(
  env: Env,
  actor: VerifiedConnectionActor,
  tableId: string,
): Promise<TableResult<EventDiagnostics>> {
  if (!validTableId(tableId)) return { ok: false, code: "INVALID_REQUEST" };
  if (isRestoreQuarantined(env)) return { ok: false, code: "TABLE_NOT_FOUND" };

  try {
    const table = await env.TABLES.get(
      env.TABLES.idFromName(tableId),
    ).readEventDiagnostics(actor);
    if (!table.ok) return table;

    // The diagnostic store may be unavailable or lose a race with revocation.
    // Neither condition establishes an empty history or a missing host call.
    let recent: EventDiagnostics["recent"] = { status: "unknown" };
    try {
      const snapshot = await env.GUESTS.get(
        env.GUESTS.idFromName(actor.guestId),
      ).readEventDiagnostics(actor.guestId, actor.connectionId);
      if (snapshot) {
        recent = {
          status: "available",
          context: snapshot.context,
          records: snapshot.records,
          droppedCount: snapshot.droppedCount,
          retentionUntil: snapshot.retentionUntil,
          scopeMatches: snapshot.scopeMatches,
        };
      }
    } catch {
      // Never include an RPC exception, request body, callback or credential.
    }

    return {
      ok: true,
      value: {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        worker: eventDiagnosticContext(env, actor, tableId),
        table: table.value,
        recent,
        limitations: {
          recordingIsBestEffort: true,
          emptyRecordsDoNotProveNoRequest: true,
          missingCallbackOriginIsUnknown: true,
          arrivalDoesNotProveHostAcceptance: true,
          componentReadsAreAtomic: false,
          pendingCountCoversOwnActiveSubscriptionOnly: true,
        },
      },
    };
  } catch {
    return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
  }
}
