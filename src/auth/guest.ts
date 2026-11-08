import type { GuestSessionPrincipal, NewGuestSession } from "../objects/guest";
import { randomBase64Url } from "../shared/random";
import { connectionsPage } from "../web/connections";
import { guestPage } from "../web/guest";

export const SESSION_COOKIE_NAME = "__Host-agent_table_session";
const CSRF_COOKIE_NAME = "__Host-agent_table_csrf";
const SESSION_COOKIE =
  /^v1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_LIMIT = 8_192;
const BODY_LIMIT = 1_024;

type BrowserCredential = { guestId: string; sessionId: string; secret: string };

const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  // Keep same-origin POST Origin headers while suppressing cross-site referrers.
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header || header.length > COOKIE_LIMIT) return null;
  let value: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (value !== null) return null;
    value = part.slice(separator + 1).trim();
  }
  return value;
}

function browserCredential(request: Request): BrowserCredential | null {
  const encoded = getCookie(request, SESSION_COOKIE_NAME);
  const match = encoded?.match(SESSION_COOKIE);
  if (!match) return null;
  const [, guestId, sessionId, secret] = match;
  return { guestId, sessionId, secret };
}

function guestStub(env: Env, guestId: string) {
  return env.GUESTS.get(env.GUESTS.idFromName(guestId));
}

export async function resolveBrowserGuest(
  request: Request,
  env: Env,
): Promise<GuestSessionPrincipal | null> {
  const credential = browserCredential(request);
  if (!credential) return null;
  const guest = await guestStub(env, credential.guestId).validateSession(
    credential.sessionId,
    credential.secret,
  );
  return guest?.guestId === credential.guestId ? guest : null;
}

function allowedScheme(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}

function sameOriginPost(request: Request): boolean {
  return (
    allowedScheme(request) &&
    request.headers.get("Origin") === new URL(request.url).origin &&
    request.headers.get("Sec-Fetch-Site") !== "cross-site"
  );
}

function sameToken(left: string, right: string): boolean {
  if (!CSRF_TOKEN.test(left) || !CSRF_TOKEN.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < 43; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function sessionCookie(session: NewGuestSession): string {
  const seconds = Math.max(
    0,
    Math.min(
      30 * 24 * 60 * 60,
      Math.floor((session.expiresAt - Date.now()) / 1_000),
    ),
  );
  return `${SESSION_COOKIE_NAME}=v1.${session.guestId}.${session.sessionId}.${session.secret}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
}

function csrfCookie(token: string): string {
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`;
}

function response(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      ...securityHeaders,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export async function handleGuestPage(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!allowedScheme(request)) return response("HTTPS required", 403);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return response("Method Not Allowed", 405);
  }
  if (request.method === "HEAD") {
    return new Response(null, { headers: securityHeaders });
  }
  const guest = await resolveBrowserGuest(request, env);
  const csrfFromCookie = getCookie(request, CSRF_COOKIE_NAME);
  const csrf =
    csrfFromCookie && CSRF_TOKEN.test(csrfFromCookie)
      ? csrfFromCookie
      : randomBase64Url(32);
  const headers = new Headers({
    ...securityHeaders,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  if (csrf !== csrfFromCookie) headers.append("Set-Cookie", csrfCookie(csrf));
  return new Response(guestPage(guest, csrf, env.ALLOW_NEW_GUESTS === "true"), {
    headers,
  });
}

export async function handleGuestIdentity(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!allowedScheme(request)) return response("HTTPS required", 403);
  const guest = await resolveBrowserGuest(request, env);
  return new Response(
    JSON.stringify(
      guest
        ? { guestId: guest.guestId, expiresAt: guest.expiresAt }
        : { error: "no-valid-guest-session" },
    ),
    {
      status: guest ? 200 : 401,
      headers: {
        ...securityHeaders,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

async function readBoundedForm(
  request: Request,
): Promise<URLSearchParams | null> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
    "application/x-www-form-urlencoded"
  ) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return null;
  }
}

export async function handleGuestChoice(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return response("Method Not Allowed", 405);
  if (!sameOriginPost(request)) return response("CSRF validation failed", 403);
  const form = await readBoundedForm(request);
  if (!form || [...form.keys()].sort().join(",") !== "choice,csrf") {
    return response("Invalid guest choice", 400);
  }
  const csrf = form.get("csrf") ?? "";
  if (!sameToken(csrf, getCookie(request, CSRF_COOKIE_NAME) ?? "")) {
    return response("CSRF validation failed", 403);
  }

  const choice = form.get("choice");
  let newSession: NewGuestSession | null;
  if (choice === "new") {
    if (env.ALLOW_NEW_GUESTS !== "true") {
      return response("New guest admission is disabled", 503);
    }
    const guestId = crypto.randomUUID();
    newSession = await guestStub(env, guestId).createSession(guestId);
  } else if (choice === "reuse") {
    const credential = browserCredential(request);
    if (!credential) return response("No valid guest session", 401);
    // Rotation rechecks validity in the DO transaction and invalidates the old secret.
    newSession = await guestStub(env, credential.guestId).rotateSession(
      credential.sessionId,
      credential.secret,
    );
    if (!newSession || newSession.guestId !== credential.guestId) {
      return response("No valid guest session", 401);
    }
  } else {
    return response("Invalid guest choice", 400);
  }

  const headers = new Headers({ ...securityHeaders, Location: "/guest" });
  headers.append("Set-Cookie", sessionCookie(newSession));
  headers.append(
    "Set-Cookie",
    `${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  );
  return new Response(null, { status: 303, headers });
}

/** Connection management is browser-only; no OAuth token or public grant API. */
export async function handleConnectionList(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") return response("Method Not Allowed", 405);
  if (!allowedScheme(request)) return response("HTTPS required", 403);
  const credential = browserCredential(request);
  if (!credential) return response("No valid guest session", 401);
  let guest: GuestSessionPrincipal | null;
  let connections;
  try {
    const stub = guestStub(env, credential.guestId);
    guest = await stub.validateSession(credential.sessionId, credential.secret);
    if (!guest || guest.guestId !== credential.guestId) {
      return response("No valid guest session", 401);
    }
    connections = await stub.listConnections(credential.sessionId, credential.secret);
  } catch {
    return response("Connection authority unavailable", 503);
  }
  if (!connections) return response("No valid guest session", 401);
  const existingCsrf = getCookie(request, CSRF_COOKIE_NAME);
  const csrf =
    existingCsrf && CSRF_TOKEN.test(existingCsrf)
      ? existingCsrf
      : randomBase64Url(32);
  const headers = new Headers({
    ...securityHeaders,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  if (csrf !== existingCsrf) headers.append("Set-Cookie", csrfCookie(csrf));
  return new Response(connectionsPage(guest.guestId, connections, csrf), {
    headers,
  });
}

export async function handleConnectionRevoke(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return response("Method Not Allowed", 405);
  if (!sameOriginPost(request)) return response("CSRF validation failed", 403);
  const form = await readBoundedForm(request);
  if (!form || [...form.keys()].sort().join(",") !== "connection_id,csrf") {
    return response("Invalid revocation request", 400);
  }
  if (
    !sameToken(
      form.get("csrf") ?? "",
      getCookie(request, CSRF_COOKIE_NAME) ?? "",
    )
  ) {
    return response("CSRF validation failed", 403);
  }
  const credential = browserCredential(request);
  if (!credential) return response("No valid guest session", 401);
  let result;
  try {
    result = await guestStub(env, credential.guestId).revokeConnection(
      credential.sessionId,
      credential.secret,
      form.get("connection_id") ?? "",
    );
  } catch {
    return response("Connection authority unavailable", 503);
  }
  if (result.status === "unauthorized") {
    return response("No valid guest session", 401);
  }
  if (result.status === "not-found") {
    return response("Connection not found", 404);
  }
  const headers = new Headers({
    ...securityHeaders,
    Location: "/guest/connections",
  });
  headers.append("Set-Cookie", sessionCookie(result.session));
  headers.append(
    "Set-Cookie",
    CSRF_COOKIE_NAME + "=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
  );
  return new Response(null, { status: 303, headers });
}
