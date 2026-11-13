import {
  McpServer,
  ProtocolError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import * as z from "zod/v4";
import { eventDiagnosticContext } from "../evidence/event-diagnostics";
import {
  MESSAGE_EVENT_DEFINITION,
  validEventListParams,
} from "../notifications/openai-events";
import { getEventDiagnostics } from "../services/event-diagnostics";
import {
  type EventServiceFailure,
  subscribeEvent,
  unsubscribeEvent,
} from "../services/events";
import {
  closeTable,
  createInvite,
  createTable,
  getTable,
  joinTable,
  type PublicTableResult,
  postMessage,
  readMessages,
  requestTableDeletion,
} from "../services/tables";
import { authorizeGuestConnection, type ConnectionScope } from "../shared/auth";
import { validTableId } from "../shared/invitations";
import { CREATION_LIMITS, TABLE_LIMITS } from "../shared/limits";
import {
  PRIVATE_PILOT_PROFILE,
  privatePilotDiscoveryAllowed,
} from "../shared/private-pilot";
import { getOwnConnectionIdentity } from "./connection-identity";
import type { EventDiagnosticTrace } from "./event-diagnostic-trace";
import {
  handleOwnedInboxListen,
  isListenRequest,
  MAX_MCP_HINTS_PER_STREAM,
} from "./live-listen";

export type AuthenticatedMcpIdentity = {
  readonly guestId: string;
  readonly connectionId: string;
  readonly scopes: readonly ConnectionScope[];
  // Null must fail closed at any future listen boundary. Populated exclusively
  // from the OAuth host context, not token claims decoded by this application.
  readonly tokenExpiresAtMs: number | null;
};

const TABLE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createInput = z.strictObject({
  request_id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  title: z.string().min(1),
  purpose: z.string().optional(),
  ttl_seconds: z
    .number()
    .int()
    .min(CREATION_LIMITS.minTtlSeconds)
    .max(CREATION_LIMITS.maxTtlSeconds)
    .optional(),
});
const getInput = z.strictObject({ table_id: z.string().regex(TABLE_ID) });
const inviteInput = z.strictObject({
  table_id: z.string().regex(TABLE_ID),
  request_id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});
const joinInput = z.strictObject({
  invitation: z.string().min(1).max(160),
  request_id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

const closeInput = z.strictObject({
  table_id: z.string().regex(TABLE_ID),
  request_id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

const deleteInput = z.strictObject({
  table_id: z.string().regex(TABLE_ID),
  request_id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

const postInput = z.strictObject({
  table_id: z.string().regex(TABLE_ID),
  body: z.string(),
  reply_to_message_id: z.string().regex(TABLE_ID).optional(),
  request_id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});
const readInput = z.strictObject({
  table_id: z.string().regex(TABLE_ID),
  after_seq: z.number().int().nonnegative().optional(),
  through_seq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(TABLE_LIMITS.readPageMaximum).optional(),
});

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function appResult(result: PublicTableResult, liveSubscriptions = false) {
  if (!result.ok) {
    return toolResult(
      {
        error: {
          code: result.code,
          ...(result.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: result.retryAfterMs }),
          retry:
            result.code === "TEMPORARILY_UNAVAILABLE"
              ? "Retry with the same request_id and unchanged arguments."
              : undefined,
        },
      },
      true,
    );
  }
  return toolResult({
    ...result.value,
    notifications: liveSubscriptions
      ? {
          available: true,
          transport: "mcp_subscriptions_listen",
          maxHintsPerStream: MAX_MCP_HINTS_PER_STREAM,
          reconnect: "listen_again_then_read_after_last_seq",
          ...(result.value.notifications
            ? { events: result.value.notifications }
            : {}),
        }
      : (result.value.notifications ?? {
          available: false,
          reason: "not_implemented",
        }),
  });
}

function eventError(reason: EventServiceFailure): ProtocolError {
  if (reason === "invalid")
    return new ProtocolError(-32602, "Invalid Events parameters");
  if (reason.startsWith("callback_")) {
    return new ProtocolError(-32015, "CallbackEndpointError", {
      reason: reason.slice("callback_".length),
    });
  }
  if (reason === "conflict")
    return new ProtocolError(-32009, "Subscription destination conflict");
  if (reason === "unavailable")
    return new ProtocolError(-32603, "Subscription service unavailable");
  // Do not reveal whether a private table, membership, or grant exists.
  return new ProtocolError(-32001, "Subscription unavailable");
}

/**
 * A server is built for each authenticated request. This identity came from
 * validated OAuth properties, never from tool arguments or request headers.
 */
function newServer(
  env: Env,
  identity: AuthenticatedMcpIdentity,
  liveSubscriptions: boolean,
  privateEvents = false,
  diagnostics?: EventDiagnosticTrace,
) {
  const advertiseEvents =
    privateEvents && privatePilotDiscoveryAllowed(env, identity);
  diagnostics?.record(
    diagnostics.methodHint,
    "capabilities",
    advertiseEvents ? "enabled" : "disabled",
  );
  const server = new McpServer(
    { name: "agent-table", version: "0.1.0" },
    {
      maxToolInputElements: 32,
      // SDK defaults enable list-change streams when tools/resources register.
      // Advertise only the guarded, authenticated listen profile.
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: liveSubscriptions },
        ...(advertiseEvents ? { events: {} } : {}),
      },
    },
  );
  server.server.onerror = () => {
    // SDK error text can contain input; retain only its occurrence.
    diagnostics?.record(diagnostics.methodHint, "response", "exception");
  };
  const scopedActor = async (scope: ConnectionScope) => {
    if (!identity.scopes.includes(scope)) return null;
    const checked = await authorizeGuestConnection(
      env,
      identity.guestId,
      identity.connectionId,
      scope,
    );
    return checked.allowed ? checked.actor : null;
  };

  // Public Events stay unadvertised. A separately approved staging pilot
  // exposes the provider profile only to its freshly authorized recipient.
  server.server.setRequestHandler(
    "events/list",
    { params: z.unknown() },
    async (params) => {
      diagnostics?.record("events/list", "handler", "received");
      if (!validEventListParams(params)) {
        diagnostics?.record("events/list", "parameters", "invalid");
        throw new ProtocolError(-32602, "Invalid Events cursor");
      }
      const actor = await scopedActor("events:subscribe");
      if (
        !actor ||
        (env.RELEASE_PROFILE === PRIVATE_PILOT_PROFILE &&
          !privatePilotDiscoveryAllowed(env, actor))
      ) {
        diagnostics?.record("events/list", "handler", "denied");
        throw eventError("denied");
      }
      diagnostics?.record("events/list", "handler", "success");
      return { events: [MESSAGE_EVENT_DEFINITION] };
    },
  );
  server.server.setRequestHandler(
    "events/subscribe",
    { params: z.unknown() },
    async (params) => {
      diagnostics?.record("events/subscribe", "handler", "received");
      const actor = await scopedActor("events:subscribe");
      if (!actor) {
        diagnostics?.record("events/subscribe", "authentication", "denied");
        throw eventError("denied");
      }
      const result = await subscribeEvent(env, actor, params, diagnostics);
      if (!result.ok) {
        diagnostics?.record(
          "events/subscribe",
          "handler",
          result.reason === "callback_operator_review_required"
            ? "operator_review_required"
            : result.reason,
        );
        throw eventError(result.reason);
      }
      diagnostics?.record("events/subscribe", "handler", "success");
      return result.value;
    },
  );
  server.server.setRequestHandler(
    "events/unsubscribe",
    { params: z.unknown() },
    async (params) => {
      diagnostics?.record("events/unsubscribe", "handler", "received");
      const actor = await scopedActor("events:subscribe");
      if (!actor) {
        diagnostics?.record("events/unsubscribe", "authentication", "denied");
        throw eventError("denied");
      }
      const result = await unsubscribeEvent(env, actor, params);
      if (!result.ok) {
        diagnostics?.record(
          "events/unsubscribe",
          "handler",
          result.reason === "callback_operator_review_required"
            ? "operator_review_required"
            : result.reason,
        );
        throw eventError(result.reason);
      }
      diagnostics?.record("events/unsubscribe", "handler", "success");
      return {};
    },
  );

  server.registerTool(
    "get_connection",
    {
      description:
        "Inspect only your authenticated guest and connection IDs, currently authorized scopes, and token/grant expiry. This grants no table membership or future authority.",
      inputSchema: z.strictObject({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const connection = await getOwnConnectionIdentity(env, identity);
      return connection
        ? toolResult(connection)
        : toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
    },
  );

  server.registerTool(
    "get_event_diagnostics",
    {
      description:
        "Inspect your authorized table's Events configuration and bounded recent protocol diagnostics. Shows where discovery or subscription stopped, without callback URLs, credentials or message content. Diagnostic records do not prove delivery or an autonomous host run.",
      inputSchema: getInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const reader = await scopedActor("tables:read");
      const actor = await scopedActor("events:subscribe");
      if (!reader || !actor)
        return toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
      const result = await getEventDiagnostics(env, actor, input.table_id);
      return result.ok
        ? toolResult(result.value)
        : toolResult({ error: { code: result.code } }, true);
    },
  );

  server.registerTool(
    "create_table",
    {
      description:
        "Create a private two-seat table. Reuse request_id on uncertain retries; no invitation is issued.",
      inputSchema: createInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const actor = await scopedActor("tables:write");
      if (!actor)
        return toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
      return appResult(await createTable(env, actor, input), liveSubscriptions);
    },
  );
  server.registerTool(
    "get_table",
    {
      description:
        "Read only your membership-authorized table metadata and notification availability.",
      inputSchema: getInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ table_id }) => {
      const actor = await scopedActor("tables:read");
      if (!actor)
        return toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
      return appResult(await getTable(env, actor, table_id), liveSubscriptions);
    },
  );
  server.registerTool(
    "create_invite",
    {
      description:
        "Creator-only one-hour single-use invitation. A different key revokes the former unused invitation; retries never reveal terminal secrets.",
      inputSchema: inviteInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ table_id, request_id }) => {
      const actor = await scopedActor("tables:write");
      if (!actor)
        return toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
      if (!validTableId(table_id))
        return toolResult({ error: { code: "INVALID_REQUEST" } }, true);
      const result = await createInvite(env, actor, table_id, request_id);
      return result.ok
        ? toolResult(result.value)
        : toolResult(
            {
              error: {
                code: result.code,
                retry:
                  result.code === "TEMPORARILY_UNAVAILABLE"
                    ? "Retry with the same request_id and unchanged arguments."
                    : undefined,
              },
            },
            true,
          );
    },
  );
  server.registerTool(
    "join_table",
    {
      description:
        "Consume an opaque invitation to atomically claim the single available second seat.",
      inputSchema: joinInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ invitation, request_id }) => {
      const actor = await scopedActor("tables:write");
      if (!actor)
        return toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
      return appResult(
        await joinTable(env, actor, invitation, request_id),
        liveSubscriptions,
      );
    },
  );

  server.registerTool(
    "close_table",
    {
      description:
        "Close a shared table permanently to new posts and invites. Retained reads remain available only until its original expiry.",
      inputSchema: closeInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ table_id, request_id }) => {
      const actor = await scopedActor("tables:write");
      if (!actor)
        return toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
      const result = await closeTable(env, actor, table_id, request_id);
      return result.ok
        ? toolResult(result.value)
        : toolResult({ error: { code: result.code } }, true);
    },
  );

  server.registerTool(
    "delete_table",
    {
      description:
        "Request a five-minute, same-guest browser approval for shared-table deletion. This tool never deletes content. The URL alone is not authorization.",
      inputSchema: deleteInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ table_id, request_id }) => {
      const actor = await scopedActor("tables:delete");
      if (!actor)
        return toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
      if (!validTableId(table_id)) {
        return toolResult({ error: { code: "INVALID_REQUEST" } }, true);
      }
      const result = await requestTableDeletion(
        env,
        actor,
        table_id,
        request_id,
      );
      return result.ok
        ? toolResult(result.value)
        : toolResult({ error: { code: result.code } }, true);
    },
  );

  server.registerTool(
    "post_message",
    {
      description: "Commit an immutable message with a durable retry receipt.",
      inputSchema: postInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ table_id, body, reply_to_message_id, request_id }) => {
      const actor = await scopedActor("tables:write");
      if (!actor)
        return toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
      const value = await postMessage(env, actor, table_id, {
        request_id,
        body,
        ...(reply_to_message_id === undefined ? {} : { reply_to_message_id }),
      });
      return value.ok
        ? toolResult(value.value)
        : toolResult({ error: { code: value.code } }, true);
    },
  );
  server.registerTool(
    "read_messages",
    {
      description: "Read a bounded snapshot without consuming unread events.",
      inputSchema: readInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ table_id, after_seq, limit, through_seq }) => {
      const actor = await scopedActor("tables:read");
      if (!actor)
        return toolResult({ error: { code: "NOT_AUTHORIZED" } }, true);
      const value = await readMessages(env, actor, table_id, {
        ...(after_seq === undefined ? {} : { after_seq }),
        ...(limit === undefined ? {} : { limit }),
        ...(through_seq === undefined ? {} : { through_seq }),
      });
      return value.ok
        ? toolResult(value.value)
        : toolResult({ error: { code: value.code } }, true);
    },
  );
  server.registerResource(
    "own-inbox",
    new ResourceTemplate(
      "agent-table://tables/{tableId}/inbox/{membershipId}",
      { list: undefined },
    ),
    { title: "Own inbox status", mimeType: "application/json" },
    async (uri) => {
      const actor = await scopedActor("tables:read");
      if (!actor) throw new Error("Resource not found");
      const { parseOwnInboxUri } = await import("../shared/resources");
      const identity = parseOwnInboxUri(uri.href);
      if (!identity) throw new Error("Resource not found");
      const value = await env.TABLES.get(
        env.TABLES.idFromName(identity.tableId),
      ).readOwnInbox(actor, uri.href);
      if (!value.ok) throw new Error("Resource not found");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(value.value),
          },
        ],
      };
    },
  );
  return server;
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  identity: AuthenticatedMcpIdentity,
  diagnostics?: EventDiagnosticTrace,
): Promise<Response> {
  // This function accepts only identity established by the OAuth middleware.
  diagnostics?.record(diagnostics.methodHint, "authentication", "allowed");
  const canonicalHostname = new URL(env.PUBLIC_ORIGIN).hostname;
  const allowedHostnames = [canonicalHostname];
  if (["localhost", "127.0.0.1", "[::1]"].includes(canonicalHostname)) {
    allowedHostnames.push("localhost", "127.0.0.1", "[::1]");
  }

  const configuredSubscriptions =
    env.ENABLE_MCP_SUBSCRIPTIONS === "true" &&
    identity.scopes.includes("events:subscribe") &&
    identity.tokenExpiresAtMs !== null &&
    identity.tokenExpiresAtMs > Date.now();
  const liveSubscriptions =
    configuredSubscriptions &&
    (
      await authorizeGuestConnection(
        env,
        identity.guestId,
        identity.connectionId,
        "events:subscribe",
      )
    ).allowed;
  const privateEvents =
    privatePilotDiscoveryAllowed(env, identity) &&
    identity.scopes.includes("events:subscribe") &&
    identity.tokenExpiresAtMs !== null &&
    identity.tokenExpiresAtMs > Date.now() &&
    (
      await authorizeGuestConnection(
        env,
        identity.guestId,
        identity.connectionId,
        "events:subscribe",
      )
    ).allowed;
  diagnostics?.record(
    diagnostics.methodHint,
    "recipient",
    eventDiagnosticContext(env, identity).recipientMatched
      ? "allowed"
      : "denied",
  );
  if (liveSubscriptions && (await isListenRequest(request))) {
    return handleOwnedInboxListen(
      request,
      env,
      ctx,
      identity,
      allowedHostnames,
      () => newServer(env, identity, true, false, diagnostics),
    );
  }

  const handler = createMcpHandler(
    () =>
      newServer(env, identity, liveSubscriptions, privateEvents, diagnostics),
    {
      route: "/mcp",
      legacy: "reject",
      // The guarded listen route is handled above. Other requests, including
      // unauthorized listens, must not open a generic SDK in-memory bus.
      maxSubscriptions: 0,
      corsOptions: false,
      allowedHostnames,
      allowedOriginHostnames: allowedHostnames,
    },
  );
  return handler(request, env, ctx);
}
