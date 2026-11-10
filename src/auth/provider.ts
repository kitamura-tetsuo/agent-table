import {
  AuthorizationError,
  insufficientScope,
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
} from "@cloudflare/workers-oauth-provider";
import { handleMcp } from "../mcp/server";
import { validatedTokenDeadline } from "../mcp/subscriptions";
import { checkPrincipalAdmission } from "../shared/admission";
import {
  authorizeGuestConnection,
  CONNECTION_SCOPES,
  isConnectionScope,
} from "../shared/auth";
import { randomBase64Url } from "../shared/random";
import {
  browserCredential,
  readBoundedForm,
  resolveBrowserGuest,
  sameOriginPost,
  sessionCookie,
} from "./guest";

const ACCESS_SECONDS = 15 * 60;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const CSRF_COOKIE = "__Host-agent_table_oauth_csrf";
const CSRF = /^[A-Za-z0-9_-]{43}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OAuthActorProps = {
  guestId: string;
  connectionId: string;
};

export function canonicalOAuthOrigin(env: Env): string {
  const url = new URL(env.PUBLIC_ORIGIN);
  const isLocal =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !isLocal) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.origin !== env.PUBLIC_ORIGIN.replace(/\/$/, "")
  ) {
    throw new Error("Invalid canonical OAuth origin");
  }
  return url.origin;
}

export function canonicalMcpResource(env: Env): string {
  return `${canonicalOAuthOrigin(env)}/mcp`;
}

function oauthProps(value: unknown): OAuthActorProps | null {
  if (!value || typeof value !== "object") return null;
  const props = value as Record<string, unknown>;
  if (
    typeof props.guestId !== "string" ||
    typeof props.connectionId !== "string" ||
    !UUID.test(props.guestId) ||
    !UUID.test(props.connectionId)
  )
    return null;
  return { guestId: props.guestId, connectionId: props.connectionId };
}

export function authorizationServer(env: Env) {
  const issuer = canonicalOAuthOrigin(env);
  const resource = canonicalMcpResource(env);
  return new OAuthAuthorizationServer<Env>({
    issuer,
    resources: [resource],
    scopesSupported: [...CONNECTION_SCOPES],
    clientRegistrationEndpoint: "/oauth/register",
    accessTokenTTL: ACCESS_SECONDS,
    refreshTokenTTL: REFRESH_SECONDS,
    // Never turn a refresh into another guest or a larger scope.
    tokenExchangeCallback: async (options) => {
      const props = oauthProps(options.props);
      if (
        !props ||
        props.guestId !== options.userId ||
        options.resource !== resource ||
        options.scope.length === 0 ||
        options.scope.some((scope) => !isConnectionScope(scope))
      ) {
        throw new OAuthError("invalid_grant", {
          description: "Invalid connection",
        });
      }
      const guest = env.GUESTS.get(env.GUESTS.idFromName(props.guestId));
      for (const scope of options.scope) {
        let allowed = false;
        try {
          allowed = (
            await guest.authorizeConnection(
              props.guestId,
              props.connectionId,
              scope as (typeof CONNECTION_SCOPES)[number],
            )
          ).allowed;
        } catch {
          throw new OAuthError("temporarily_unavailable", {
            description: "Authorization service unavailable",
            statusCode: 503,
          });
        }
        if (!allowed) {
          throw new OAuthError("invalid_grant", {
            description: "Connection revoked or expired",
          });
        }
      }
      return {
        accessTokenTTL: ACCESS_SECONDS,
        refreshTokenTTL: REFRESH_SECONDS,
        accessTokenScope: options.requestedScope,
      };
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  if (header.length > 8192) return null;
  const entries = header.split(";").map((piece) => piece.trim());
  const matches = entries.filter((piece) => piece.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

function equalCsrf(a: string, b: string): boolean {
  if (!CSRF.test(a) || !CSRF.test(b)) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function consentBinding(
  credential: NonNullable<ReturnType<typeof browserCredential>>,
  handle: string,
): Promise<string> {
  // A form signed with guest A's HttpOnly session cannot be retargeted to B.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(credential.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(
    `oauth-consent-v1:${credential.guestId}:${credential.sessionId}:${handle}`,
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function consentPage(
  info: {
    clientName: string;
    clientDomain?: string;
    redirectHost: string;
    redirectIsLoopback: boolean;
    scope: string[];
  },
  guestId: string,
  handle: string,
  csrf: string,
  binding: string,
): string {
  const requested = info.scope
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Authorize Agent Table</title>
<h1>Connect ${escapeHtml(info.clientName)}</h1>
<p>Client: ${info.clientDomain ? escapeHtml(info.clientDomain) : "Self-registered, not verified"}</p>
<p>Token recipient: ${escapeHtml(info.redirectHost)}</p>
${info.redirectIsLoopback ? "<p>The client runs on your computer. Verify you started it.</p>" : ""}
<p>Selected pseudonymous guest: <code>${escapeHtml(guestId)}</code></p>
<p>Choose this browser guest deliberately. To create another guest,
open <a href="/guest" target="_blank" rel="noopener noreferrer">guest management</a>
and start authorization again after selecting it.</p>
<p>Only approved scopes are delegated. This connection can be revoked from
<a href="/guest/connections">browser connection management</a>.
If you lose your browser session, you cannot recover or revoke it through a table ID.
Agents may retain information already read, and approval does not grant table membership.</p>
<form method="post" action="/authorize">
<input name="handle" type="hidden" value="${escapeHtml(handle)}">
<input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
<input name="guest_id" type="hidden" value="${escapeHtml(guestId)}">
<input name="binding" type="hidden" value="${escapeHtml(binding)}">
${requested}<p><button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></p></form></html>`;
}

function safeError(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * The library owns client validation and browser-bound one-use consent handles.
 * GuestDO owns identity and grant creation; neither client metadata nor form
 * fields can choose the guest/connection bound into a token.
 */
export async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!["GET", "POST"].includes(request.method))
    return safeError("Method Not Allowed", 405);
  if (new URL(request.url).origin !== canonicalOAuthOrigin(env))
    return safeError("Invalid authorization origin", 400);

  const principal = await resolveBrowserGuest(request, env);
  if (!principal) {
    return safeError(
      "Choose or reuse a browser guest at /guest, then return to authorization. No grant was issued.",
      401,
    );
  }
  const oauth = authorizationServer(env).getOAuthApi(env);
  try {
    if (request.method === "GET") {
      const parsed = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(parsed);
      const consent = await oauth.beginConsent(parsed);
      const csrf = randomBase64Url(32);
      const headers = new Headers(consent.headers);
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      headers.append(
        "Set-Cookie",
        `${CSRF_COOKIE}=${csrf}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
      );
      const credential = browserCredential(request);
      if (!credential || credential.guestId !== principal.guestId)
        return safeError("Invalid guest", 401);
      const binding = await consentBinding(credential, consent.handle);
      return new Response(
        consentPage(details, principal.guestId, consent.handle, csrf, binding),
        { headers },
      );
    }

    if (!sameOriginPost(request))
      return safeError("CSRF validation failed", 403);
    const form = await readBoundedForm(request);
    if (!form || request.headers.get("Content-Length") === "0") {
      return safeError("Invalid consent", 400);
    }
    const allowedKeys = new Set([
      "handle",
      "csrf",
      "decision",
      "scope",
      "guest_id",
      "binding",
    ]);
    if ([...form.keys()].some((key) => !allowedKeys.has(key)))
      return safeError("Invalid consent", 400);
    if (
      !equalCsrf(
        form.get("csrf") ?? "",
        cookieValue(request, CSRF_COOKIE) ?? "",
      )
    ) {
      return safeError("CSRF validation failed", 403);
    }
    const handle = form.get("handle") ?? "";
    const decision = form.get("decision");
    if (decision === "deny") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (decision !== "approve")
      return safeError("Invalid consent decision", 400);
    // Guest identity is bound to the displayed, session-keyed form, not
    // trusted from the hidden guest_id field or current cookie alone.
    const credential = browserCredential(request);
    if (!credential || credential.guestId !== principal.guestId)
      return safeError("Invalid guest", 401);
    if (
      form.getAll("guest_id").length !== 1 ||
      form.getAll("binding").length !== 1 ||
      form.get("guest_id") !== principal.guestId ||
      !equalCsrf(
        form.get("binding") ?? "",
        await consentBinding(credential, handle),
      )
    )
      return safeError("Guest changed; restart authorization", 409);
    const requested = form.getAll("scope");
    if (
      requested.length < 1 ||
      requested.length > CONNECTION_SCOPES.length ||
      requested.some((value) => !isConnectionScope(value)) ||
      new Set(requested).size !== requested.length
    )
      return safeError("Invalid requested scopes", 400);

    const approved = await oauth.approveConsent(request, handle, {
      scope: requested,
    });
    const guest = env.GUESTS.get(env.GUESTS.idFromName(principal.guestId));
    const grant = await guest.createConnection(
      credential.sessionId,
      credential.secret,
      requested as (typeof CONNECTION_SCOPES)[number][],
      Date.now() + REFRESH_SECONDS * 1000,
    );
    if (!grant) return safeError("Guest session expired", 401);
    const rotated = await guest.rotateSession(
      credential.sessionId,
      credential.secret,
    );
    if (!rotated) {
      // A grant may exist but no authorization code has been issued. Fail closed.
      return safeError("Unable to rotate guest session", 503);
    }
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: principal.guestId,
      metadata: {},
      scope: requested,
      props: { guestId: principal.guestId, connectionId: grant.connectionId },
    });
    const headers = new Headers(approved.headers);
    headers.set("Location", redirectTo);
    headers.set("Cache-Control", "no-store");
    headers.append("Set-Cookie", sessionCookie(rotated));
    headers.append(
      "Set-Cookie",
      `${CSRF_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    );
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError)
      return safeError("Invalid authorization request", 400);
    throw error;
  }
}

/** Token exchange is serialized in the single token Durable Object. */
export function oauthTokenStub(env: Env) {
  return env.OAUTH_SERIALIZER.get(
    env.OAUTH_SERIALIZER.idFromName("token-exchange-v1"),
  );
}

export async function handleAuthenticatedMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const origin = canonicalOAuthOrigin(env);
  const resource = canonicalMcpResource(env);
  const host = new OAuthResourceServer<Env, OAuthActorProps>({
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      resource_name: "Agent Table",
    },
    // The individual tools enforce their own read/write grants.
    requiredScopes: [],
    validateToken: (environment) => (audience, token) =>
      authorizationServer(environment).validateToken<OAuthActorProps>(
        audience,
        token,
        environment,
      ),
    handler: {
      async fetch(authRequest, environment, authCtx) {
        const props = oauthProps(authCtx.props);
        if (!props || authCtx.auth.userId !== props.guestId)
          return safeError("Invalid authenticated context", 401);
        const scopes = authCtx.auth.scope.filter(isConnectionScope);
        const scope = scopes[0];
        if (!scope) return insufficientScope(authCtx.auth, ["tables:read"]);
        const checked = await authorizeGuestConnection(
          environment,
          props.guestId,
          props.connectionId,
          scope,
        );
        if (!checked.allowed) {
          return safeError("Connection not authorized", 401);
        }
        const rateRejected = await checkPrincipalAdmission(
          environment,
          props.guestId,
        );
        if (rateRejected) return rateRejected;
        // The actor is request-local. Private tools must independently enforce
        // the scope of each operation and check TableDO membership.
        return handleMcp(authRequest, environment, authCtx, {
          guestId: props.guestId,
          connectionId: props.connectionId,
          scopes,
          tokenExpiresAtMs: validatedTokenDeadline(authCtx.auth.expiresAt),
        });
      },
    },
  });
  return host.fetch(request, env, ctx);
}
