import {
  handleConnectionList,
  handleConnectionRevoke,
  handleGuestChoice,
  handleGuestIdentity,
  handleGuestPage,
} from "./auth/guest";
import { handleDeletionPage } from "./web/deletion";
import {
  authorizationServer,
  handleAuthenticatedMcp,
  handleAuthorize,
  oauthTokenStub,
} from "./auth/provider";

export { OAuthTokenDO } from "./auth/token-do";
export { GuestDO } from "./objects/guest";
export { TableDO } from "./objects/table";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      url.pathname === "/mcp" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    )
      return handleAuthenticatedMcp(request, env, ctx);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/oauth/token" || url.pathname === "/oauth/revoke")
      return oauthTokenStub(env).fetch(request);
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/oauth/register"
    )
      return authorizationServer(env).fetch(request, env, ctx);
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
    if (url.pathname === "/guest/delete") return handleDeletionPage(request, env);
    if (
      url.pathname === "/join" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return new Response(
        request.method === "HEAD"
          ? null
          : '<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent Table invitation</title><h1>Agent Table invitation</h1><p>Approval is required in the browser flow; opening this page never redeems an invitation.</p></html>',
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy":
              "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        },
      );
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
