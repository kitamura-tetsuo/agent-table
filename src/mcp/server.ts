import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

// The SDK constructs a separate server for every HTTP request. No user-specific
// state or private operations are registered until authorization exists.
export function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const canonicalHostname = new URL(env.PUBLIC_ORIGIN).hostname;
  const allowedHostnames = [canonicalHostname];
  if (["localhost", "127.0.0.1", "[::1]"].includes(canonicalHostname)) {
    allowedHostnames.push("localhost", "127.0.0.1", "[::1]");
  }

  const handler = createMcpHandler(
    () => new McpServer({ name: "agent-table", version: "0.1.0" }),
    {
      route: "/mcp",
      legacy: "reject",
      corsOptions: false,
      allowedHostnames,
      allowedOriginHostnames: allowedHostnames,
    },
  );
  return handler(request, env, ctx);
}
