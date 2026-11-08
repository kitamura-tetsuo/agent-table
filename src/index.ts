import {
  handleConnectionList,
  handleConnectionRevoke,
  handleGuestChoice,
  handleGuestIdentity,
  handleGuestPage,
} from "./auth/guest";
import { handleMcp } from "./mcp/server";

export { GuestDO } from "./objects/guest";
export { TableDO } from "./objects/table";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return handleMcp(request, env, ctx);
    }
    if (url.pathname === "/" || url.pathname === "/guest") {
      return handleGuestPage(request, env);
    }
    if (url.pathname === "/guest/session") {
      return handleGuestChoice(request, env);
    }
    if (url.pathname === "/guest/connections") {
      return handleConnectionList(request, env);
    }
    if (url.pathname === "/guest/connections/revoke") {
      return handleConnectionRevoke(request, env);
    }
    if (url.pathname === "/guest/me") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET", "Cache-Control": "no-store" },
        });
      }
      return handleGuestIdentity(request, env);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }
    if (url.pathname === "/health") {
      return new Response(
        request.method === "HEAD" ? null : JSON.stringify({ status: "ok" }),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      );
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
