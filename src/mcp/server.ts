import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import * as z from "zod/v4";
import {
  createInvite,
  createTable,
  getTable,
  joinTable,
  type PublicTableResult,
} from "../services/tables";
import { authorizeGuestConnection, type ConnectionScope } from "../shared/auth";
import { validTableId } from "../shared/invitations";
import { CREATION_LIMITS } from "../shared/limits";

export type AuthenticatedMcpIdentity = {
  readonly guestId: string;
  readonly connectionId: string;
  readonly scopes: readonly ConnectionScope[];
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

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function appResult(result: PublicTableResult) {
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
    notifications: { available: false, reason: "not_implemented" },
  });
}

/**
 * A server is built for each authenticated request. This identity came from
 * validated OAuth properties, never from tool arguments or request headers.
 */
function newServer(env: Env, identity: AuthenticatedMcpIdentity) {
  const server = new McpServer(
    { name: "agent-table", version: "0.1.0" },
    { maxToolInputElements: 32 },
  );
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
      return appResult(await createTable(env, actor, input));
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
      return appResult(await getTable(env, actor, table_id));
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
      return appResult(await joinTable(env, actor, invitation, request_id));
    },
  );
  // No concrete private resources are globally listed or registered.
  return server;
}

export function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  identity: AuthenticatedMcpIdentity,
): Promise<Response> {
  const canonicalHostname = new URL(env.PUBLIC_ORIGIN).hostname;
  const allowedHostnames = [canonicalHostname];
  if (["localhost", "127.0.0.1", "[::1]"].includes(canonicalHostname)) {
    allowedHostnames.push("localhost", "127.0.0.1", "[::1]");
  }

  const handler = createMcpHandler(() => newServer(env, identity), {
    route: "/mcp",
    legacy: "reject",
    corsOptions: false,
    allowedHostnames,
    allowedOriginHostnames: allowedHostnames,
  });
  return handler(request, env, ctx);
}
