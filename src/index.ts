import {
  handleConnectionList,
  handleConnectionRevoke,
  handleGuestChoice,
  handleGuestIdentity,
  handleGuestPage,
} from "./auth/guest";
import {
  authorizationServer,
  classifyOAuthGrant,
  handleAuthenticatedMcp,
  handleAuthorize,
  oauthTokenStub,
} from "./auth/provider";
import { handleStagingEvidence } from "./evidence/staging";
import {
  checkEdgeAdmission,
  type EdgeAdmissionCategory,
  rejectOversizedIngress,
} from "./shared/admission";
import { correlationId, emitOperationalEvent } from "./shared/telemetry";
import { handleBrowserTableCreate } from "./web/create";
import { handleDeletionPage } from "./web/deletion";
import { handleJoinPage, handleJoinScript } from "./web/join";
import { handleBrowserTableManage } from "./web/manage";
import { handleBrowserTableView } from "./web/table";

export { OAuthTokenDO } from "./auth/token-do";
export { AdmissionDO } from "./objects/admission";
export { GuestDO } from "./objects/guest";
export { TableDO } from "./objects/table";

/** Bound admission separately from authenticated ownership and table quotas. */
function edgeCategory(request: Request): EdgeAdmissionCategory | null {
  const path = new URL(request.url).pathname;
  if (path === "/guest/session" && request.method === "POST") return "guest";
  if (path === "/oauth/register" && request.method === "POST") return "dcr";
  if (path === "/mcp") return "application";
  if (path === "/join") return "invitation";
  if (
    path === "/authorize" ||
    path === "/oauth/token" ||
    path === "/oauth/revoke" ||
    path.startsWith("/.well-known/oauth-") ||
    path === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return "protocol";
  }
  if (
    path === "/" ||
    path === "/guest" ||
    path === "/guest/me" ||
    path === "/guest/connections" ||
    path === "/guest/delete" ||
    path === "/guest/table" ||
    path === "/guest/manage" ||
    path === "/guest/create" ||
    path === "/guest/connections/revoke" ||
    path === "/join.js"
  ) {
    return "application";
  }
  return null;
}

const handleRequest: ExportedHandler<Env>["fetch"] = async (
  request,
  env,
  ctx,
) => {
  const ingressRejected = await rejectOversizedIngress(request);
  if (ingressRejected) return ingressRejected;
  const url = new URL(request.url);
  // Disabled diagnostics must not consume the OAuth protocol rate-limit budget.
  if (url.pathname === "/__staging/evidence")
    return handleStagingEvidence(request, env);
  const category = edgeCategory(request);
  if (category) {
    const rateRejected = await checkEdgeAdmission(request, env, category);
    if (rateRejected) return rateRejected;
  }
  if (
    url.pathname === "/mcp" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  )
    return handleAuthenticatedMcp(request, env, ctx);
  if (url.pathname === "/authorize") return handleAuthorize(request, env);
  if (url.pathname === "/oauth/token") {
    if (env.OAUTH_AUDIT_MODE !== "metadata")
      return oauthTokenStub(env).fetch(request);
    const grantType = await classifyOAuthGrant(request);
    const response = await oauthTokenStub(env).fetch(request);
    // Staging-only and allowlisted: never log request bodies or credentials.
    console.info(
      JSON.stringify({
        event: "agent_table.oauth_token_exchange",
        grant_type: grantType,
        http_status: response.status,
      }),
    );
    return response;
  }
  if (url.pathname === "/oauth/revoke")
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
  if (url.pathname === "/guest/table")
    return handleBrowserTableView(request, env);
  if (url.pathname === "/guest/manage")
    return handleBrowserTableManage(request, env);
  if (url.pathname === "/guest/create")
    return handleBrowserTableCreate(request, env);
  if (url.pathname === "/join") return handleJoinPage(request, env);
  if (url.pathname === "/join.js") return handleJoinScript(request);
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
};

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const requestCorrelation = correlationId();
    let outcome: "response" | "exception" = "exception";
    let status = 500;
    try {
      const response = await handleRequest(request, env, ctx);
      outcome = "response";
      status = response.status;
      return response;
    } catch {
      // Never serialize an exception that may contain user input or credentials.
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      });
    } finally {
      emitOperationalEvent({
        kind: "http",
        route: edgeCategory(request) ?? "other",
        outcome,
        status,
        durationMs: Date.now() - started,
        correlationId: requestCorrelation,
      });
    }
  },
} satisfies ExportedHandler<Env>;
