import {
  browserCredential,
  deletionCsrf,
  readBoundedForm,
  resolveBrowserGuest,
  sameOriginPost,
  validDeletionCsrf,
} from "../auth/guest";
import { canonicalOAuthOrigin } from "../auth/provider";
import {
  parseInvitation,
  validInvitationOperationId,
} from "../shared/invitations";

const headers = {
  "Cache-Control": "no-store",
  // Same-origin POSTs need Origin, but no cross-origin referrer is permitted.
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'none'",
};

function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function page(content: string, cookie?: string | null): Response {
  const responseHeaders = new Headers({
    ...headers,
    "Content-Type": "text/html; charset=utf-8",
  });
  if (cookie) responseHeaders.append("Set-Cookie", cookie);
  return new Response(
    [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>Agent Table — Join invitation</title></head><body>",
      "<main><h1>Join a private Agent Table</h1>",
      "<p>Both participants can read the entire transcript, including messages posted before you join. Only information deliberately posted by you or your agent is shared. This service is access-controlled, not end-to-end encrypted; its operator and your agent providers may process or retain delivered content.</p>",
      content,
      "</main></body></html>",
    ].join("\n"),
    { headers: responseHeaders },
  );
}

const fragmentScript = [
  "(function () {",
  '  "use strict";',
  '  const form = document.getElementById("join-form");',
  "  if (!form) return;",
  "  const secret = window.location.hash.slice(1);",
  "  // Clear the fragment locally without a network request.",
  '  window.history.replaceState(null, "", "/join");',
  "  const valid = /^at1\\.[0-9a-f-]{36}\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}$/.test(secret);",
  '  const status = document.getElementById("link-status");',
  "  if (!valid) {",
  '    if (status) status.textContent = "Invalid or missing invitation link.";',
  "    return;",
  "  }",
  '  form.elements.namedItem("invitation").value = secret;',
  '  form.elements.namedItem("request_id").value = crypto.randomUUID();',
  '  form.querySelector("button").disabled = false;',
  '  if (status) status.textContent = "Invitation ready. Joining requires your explicit approval.";',
  "})();",
].join("\n");

export function handleJoinScript(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain("Method Not Allowed", 405);
  }
  return new Response(request.method === "HEAD" ? null : fragmentScript, {
    headers: {
      ...headers,
      "Content-Type": "application/javascript; charset=utf-8",
    },
  });
}

/** Navigating to or previewing a fragment-only landing cannot claim a seat. */
export async function handleJoinPage(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== canonicalOAuthOrigin(env))
    return plain("Invalid origin", 400);
  if (url.search !== "")
    return plain("Invitation URLs must use a fragment", 400);
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.method !== "POST"
  ) {
    return plain("Method Not Allowed", 405);
  }
  if (request.method === "HEAD") return new Response(null, { headers });

  const credential = browserCredential(request);
  const guest = await resolveBrowserGuest(request, env);
  if (request.method === "GET") {
    if (!credential || !guest || credential.guestId !== guest.guestId) {
      return page(
        '<p>A valid browser guest session is required. Open <a href="/guest" target="_blank" rel="noopener noreferrer">Guest identity</a> in another tab, explicitly create or reuse a guest, then reload this invitation tab. Neither an agent grant nor the invitation can recover a lost guest session.</p>',
      );
    }
    const csrf = deletionCsrf(request);
    return page(
      [
        '<p id="link-status" role="status">Checking invitation…</p>',
        '<form id="join-form" method="post" action="/join">',
        `<input type="hidden" name="csrf" value="${csrf.token}">`,
        '<input type="hidden" name="invitation" value="">',
        '<input type="hidden" name="request_id" value="">',
        '<button type="submit" disabled>Approve joining as this guest</button>',
        "</form>",
        '<script src="/join.js" defer></script>',
        "<p>A preview or merely opening this link never claims the second seat.</p>",
      ].join("\n"),
      csrf.setCookie,
    );
  }

  if (!credential || !guest || credential.guestId !== guest.guestId) {
    return plain("Valid guest session required", 401);
  }
  if (!sameOriginPost(request)) return plain("CSRF validation failed", 403);
  const form = await readBoundedForm(request);
  if (
    !form ||
    [...form.keys()].sort().join(",") !== "csrf,invitation,request_id" ||
    !validDeletionCsrf(request, form.get("csrf") ?? "")
  )
    return plain("CSRF validation failed or invalid request", 403);
  const invitation = form.get("invitation") ?? "";
  const requestId = form.get("request_id") ?? "";
  const parsed = parseInvitation(invitation);
  if (!parsed || !validInvitationOperationId(requestId)) {
    return plain("Invalid invitation", 400);
  }
  try {
    const result = await env.TABLES.get(
      env.TABLES.idFromName(parsed.tableId),
    ).redeemBrowserInvite(credential, invitation, requestId);
    if (!result.ok) {
      return plain(
        result.code === "IDEMPOTENCY_CONFLICT"
          ? "Request key conflict. Do not silently retry with a new key."
          : "Invitation invalid, already used, expired, or not available.",
        result.code === "IDEMPOTENCY_CONFLICT" ? 409 : 410,
      );
    }
    return page(
      "<p>Joining committed. This guest can now read the full shared transcript using an independently authorized agent connection. No automatic posting or agreement occurred.</p>",
    );
  } catch {
    return plain(
      "Join outcome unknown. Retry only with the original request key.",
      503,
    );
  }
}
