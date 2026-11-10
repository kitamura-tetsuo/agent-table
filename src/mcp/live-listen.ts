import {
  createMcpHandler,
  hostHeaderValidationResponse,
  InMemoryServerEventBus,
  isJsonContentType,
  type McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { INGRESS_LIMITS } from "../shared/admission";
import { authorizeGuestConnection } from "../shared/auth";
import { emitOperationalEvent } from "../shared/telemetry";
import type { AuthenticatedMcpIdentity } from "./server";
import { parseCanonicalInboxFilter } from "./subscriptions";

const decoder = new TextDecoder("utf-8", { fatal: true });
// A hard cap on all update frames, even when Workerd's outgoing RPC/network
// transport eagerly consumes the response stream. Clients resubscribe and
// catch up through durable reads; there is no server-side event replay.
export const MAX_MCP_HINTS_PER_STREAM = 4;

type ListenEnvelope = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { notifications?: unknown };
};

/** Inspect a copy; all real protocol/header validation remains with the SDK. */
async function envelope(request: Request): Promise<ListenEnvelope | null> {
  if (request.method !== "POST") return null;
  try {
    const value: unknown = await request.clone().json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as ListenEnvelope)
      : null;
  } catch {
    return null;
  }
}

export async function isListenRequest(request: Request): Promise<boolean> {
  return (await envelope(request))?.method === "subscriptions/listen";
}

function refused(id: unknown, code: number): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: typeof id === "number" || typeof id === "string" ? id : null,
      error: {
        code,
        message:
          code === -32602
            ? "Invalid inbox subscription"
            : "Inbox subscription unavailable",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Demand-driven bridge for the pinned SDK's otherwise unbounded SSE router.
 * Its bus sees at most one publish per downstream pull, after the SDK ack.
 * The SDK keepalive is disabled and its completion is the only control frame.
 * The TableDO may queue at most one hint and independently closes slow readers.
 */
export function boundSdkInboxResponse(
  response: Response,
  table: ReturnType<Env["TABLES"]["get"]>,
  opened: {
    stream: ReadableStream<Uint8Array>;
    snapshot: { uri: string; membershipId: string };
    cancellationId: string;
  },
  handler: ReturnType<typeof createMcpHandler>,
  signal: AbortSignal,
): Response {
  if (!response.body) throw new Error("Missing SDK listen stream");
  const sdkReader = response.body.getReader();
  const hintReader = opened.stream.getReader();
  let acknowledged = false;
  let stopped = false;
  let hintsEmitted = 0;
  let sourceEnded = false;
  const started = Date.now();
  const endSource = async () => {
    if (sourceEnded) return;
    sourceEnded = true;
    await Promise.allSettled([
      table.cancelInboxHintStream(
        opened.snapshot.membershipId,
        opened.cancellationId,
      ),
      hintReader.cancel(),
    ]);
    // The official SDK emits a standard completion result. The caller must
    // use another listen request for additional updates after this cap.
    await handler.close();
  };
  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener("abort", onAbort);
    // RPC cancellation alone can leave an unread stream registered. The
    // generation-bound cancellation capability is the authority for cleanup.
    await Promise.allSettled([
      table.cancelInboxHintStream(
        opened.snapshot.membershipId,
        opened.cancellationId,
      ),
      hintReader.cancel(),
      sdkReader.cancel(),
      handler.close(),
    ]);
  };
  const onAbort = () => void cleanup();
  signal.addEventListener("abort", onAbort, { once: true });
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (stopped) return;
        try {
          if (acknowledged && !sourceEnded) {
            // No source read or bus publish happens until the downstream is
            // ready for another frame. This also bounds the SDK's own queue.
            try {
              const hint = await hintReader.read();
              if (hint.done) {
                await endSource();
              } else {
                const parsed: unknown = JSON.parse(decoder.decode(hint.value));
                if (
                  !parsed ||
                  typeof parsed !== "object" ||
                  (parsed as { kind?: string }).kind !== "resource_updated" ||
                  (parsed as { uri?: string }).uri !== opened.snapshot.uri
                ) {
                  throw new Error("Invalid internal hint");
                }
                handler.notify.resourceUpdated(opened.snapshot.uri);
                hintsEmitted++;
              }
            } catch {
              await endSource();
            }
          }
          const frame = await sdkReader.read();
          if (stopped) return;
          if (frame.done) {
            controller.close();
            await cleanup();
          } else {
            acknowledged = true;
            controller.enqueue(frame.value);
            if (hintsEmitted >= MAX_MCP_HINTS_PER_STREAM) {
              emitOperationalEvent({
                kind: "stream",
                reason: "output_cap",
                durationMs: Date.now() - started,
              });
              await endSource();
            }
          }
        } catch {
          if (!stopped) {
            controller.error(new Error("Inbox stream ended"));
            await cleanup();
          }
        }
      },
      async cancel() {
        await cleanup();
      },
    },
    // Zero speculative pulls. A paused network reader cannot cause new
    // notifications to accumulate in the SDK's internal response stream.
    { highWaterMark: 0 },
  );
  if (signal.aborted) void cleanup();
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Authenticated request-local gateway; no actor or event bus is shared. */
export async function handleOwnedInboxListen(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  identity: AuthenticatedMcpIdentity,
  allowedHostnames: string[],
  factory: () => McpServer,
): Promise<Response> {
  const badHost = hostHeaderValidationResponse(request, allowedHostnames);
  if (badHost) return badHost;
  const badOrigin = originValidationResponse(request, allowedHostnames);
  if (badOrigin) return badOrigin;

  const body = await envelope(request);
  // Prevent a malformed/legacy request from replacing an otherwise healthy
  // stream before the official SDK's stricter protocol ladder can reject it.
  if (
    body?.jsonrpc !== "2.0" ||
    (typeof body.id !== "string" &&
      !(typeof body.id === "number" && Number.isSafeInteger(body.id))) ||
    request.headers.get("Mcp-Protocol-Version") !== "2026-07-28" ||
    !isJsonContentType(request.headers.get("Content-Type")) ||
    !request.headers.get("Accept")?.includes("text/event-stream") ||
    !request.headers.get("Accept")?.includes("application/json")
  ) {
    return refused(body?.id, -32602);
  }
  const filter = parseCanonicalInboxFilter(body?.params?.notifications);
  if (!filter) return refused(body?.id, -32602);
  if (identity.tokenExpiresAtMs === null) return refused(body?.id, -32603);

  // This check is independent of the OAuth resource middleware's initial
  // check; TableDO repeats it after the RPC await and before every emission.
  const granted = await authorizeGuestConnection(
    env,
    identity.guestId,
    identity.connectionId,
    "events:subscribe",
  );
  if (!granted.allowed) return refused(body?.id, -32603);
  const table = env.TABLES.get(env.TABLES.idFromName(filter.tableId));
  const opened = await table.openInboxHintStream(
    granted.actor,
    body?.params?.notifications,
    identity.tokenExpiresAtMs,
  );
  if (!opened.ok) return refused(body?.id, -32603);

  const bus = new InMemoryServerEventBus();
  const handler = createMcpHandler(factory, {
    bus,
    legacy: "reject",
    maxSubscriptions: 1,
    keepAliveMs: 0,
    maxRequestBodySize: INGRESS_LIMITS.applicationBodyBytes,
  });
  try {
    const response = await handler.fetch(request);
    if (
      response.status !== 200 ||
      !response.headers.get("Content-Type")?.startsWith("text/event-stream")
    ) {
      await table.cancelInboxHintStream(
        opened.value.snapshot.membershipId,
        opened.value.cancellationId,
      );
      await opened.value.stream.cancel().catch(() => {});
      await handler.close();
      return response;
    }
    return boundSdkInboxResponse(
      response,
      table,
      opened.value,
      handler,
      request.signal,
    );
  } catch {
    await table.cancelInboxHintStream(
      opened.value.snapshot.membershipId,
      opened.value.cancellationId,
    );
    await handler.close();
    return refused(body?.id, -32603);
  }
}
