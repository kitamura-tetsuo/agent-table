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
  validInvitationOperationId,
  validTableId,
} from "../shared/invitations";

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function page(content: string, cookie?: string | null, status = 200): Response {
  const responseHeaders = new Headers({
    ...headers,
    "Content-Type": "text/html; charset=utf-8",
  });
  if (cookie) responseHeaders.append("Set-Cookie", cookie);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Table — Manage private table</title>
<main><h1>Manage private table</h1>
<p>Only an independently verified browser guest session can manage this table.
Invitations grant access to the entire prior transcript. Closing ends new posts and invitations for both guests.
Previously delivered text cannot be recalled; no action implies either guest's consent to any message.</p>
${content}
<p><a href="/guest">Guest identity</a></p>
</main></html>`,
    { status, headers: responseHeaders },
  );
}

function actionForm(
  tableId: string,
  csrf: string,
  action: "invite" | "close",
  requestId: string,
): string {
  const label =
    action === "invite"
      ? "Issue single-use invitation"
      : "Close table for both participants";
  return `<form method="post" action="/guest/manage">
<input type="hidden" name="table_id" value="${escapeHtml(tableId)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<button type="submit" name="action" value="${action}">${label}</button>
</form>`;
}

/** Browser management is a separate, session-authorized route; never forge an OAuth actor. */
export async function handleBrowserTableManage(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== canonicalOAuthOrigin(env))
    return plain("Invalid origin", 400);
  if (request.method !== "GET" && request.method !== "POST") {
    return plain("Method Not Allowed", 405);
  }
  const credential = browserCredential(request);
  const guest = await resolveBrowserGuest(request, env);
  if (!credential || !guest || guest.guestId !== credential.guestId) {
    return plain("Valid guest browser session required", 401);
  }

  let action: "invite" | "close" | null = null;
  let originalKey: string | null = null;
  let tableId: string;
  if (request.method === "GET") {
    if (
      url.searchParams.size !== 1 ||
      url.searchParams.getAll("table_id").length !== 1
    )
      return plain("Invalid request", 400);
    tableId = url.searchParams.get("table_id") ?? "";
  } else {
    if (url.search !== "" || !sameOriginPost(request))
      return plain("CSRF validation failed", 403);
    const form = await readBoundedForm(request);
    if (
      !form ||
      [...form.keys()].sort().join(",") !== "action,csrf,request_id,table_id" ||
      !validDeletionCsrf(request, form.get("csrf") ?? "")
    ) {
      return plain("CSRF validation failed or invalid request", 403);
    }
    const chosen = form.get("action");
    if (chosen !== "invite" && chosen !== "close")
      return plain("Invalid request", 400);
    action = chosen;
    originalKey = form.get("request_id");
    if (!validInvitationOperationId(originalKey))
      return plain("Invalid request", 400);
    tableId = form.get("table_id") ?? "";
  }
  if (!validTableId(tableId)) return plain("Invalid table ID", 400);
  const table = env.TABLES.get(env.TABLES.idFromName(tableId));
  let metadata: Awaited<ReturnType<typeof table.getBrowserMetadata>>;
  try {
    metadata = await table.getBrowserMetadata(credential);
  } catch {
    return plain("Table authority unavailable", 503);
  }
  if (!metadata.ok)
    return plain(
      "Table unavailable",
      metadata.code === "TABLE_EXPIRED" ? 410 : 404,
    );
  const info = metadata.value;
  const member = info.memberships.find(
    (entry) => entry.membershipId === info.ownMembershipId,
  );
  const isCreator = member?.role === "creator";
  const csrf = deletionCsrf(request);
  const heading = `<p><strong>${escapeHtml(info.title)}</strong> · ${escapeHtml(info.state)}</p>
<p><a href="/guest/table?table_id=${tableId}">View private transcript</a></p>`;

  if (action) {
    if (action === "invite" && !isCreator) return plain("Not authorized", 404);
    let result:
      | Awaited<ReturnType<typeof table.issueBrowserInvite>>
      | Awaited<ReturnType<typeof table.closeBrowserTable>>;
    try {
      result =
        action === "invite"
          ? await table.issueBrowserInvite(credential, originalKey as string)
          : await table.closeBrowserTable(credential, originalKey as string);
    } catch {
      return page(
        `${heading}<p>Outcome unknown. Retry ONLY with the original request key.</p>${actionForm(tableId, csrf.token, action, originalKey as string)}`,
        csrf.setCookie,
        503,
      );
    }
    if (!result.ok) {
      const unavailable = result.code === "TEMPORARILY_UNAVAILABLE";
      return page(
        `${heading}<p>${unavailable ? "Outcome unknown. Retry ONLY with the original request key." : "Action denied; no new request key was generated."}</p>${actionForm(tableId, csrf.token, action, originalKey as string)}`,
        csrf.setCookie,
        unavailable ? 503 : 409,
      );
    }
    if (action === "close") {
      return page(
        `${heading}<p>Table closure committed. New messages and invitations are disabled for both participants.</p>`,
        csrf.setCookie,
      );
    }
    if (!("landingUrl" in result.value)) return plain("Unexpected result", 503);
    return page(
      `${heading}<p>Invitation issued. Share this one-hour, single-use link only with the intended guest. Anyone possessing it can try to claim the second seat.</p>
<textarea readonly rows="4" cols="72" aria-label="Invitation sharing link">${escapeHtml(result.value.landingUrl)}</textarea>
<p>Do not put the link in logs or analytics. A retry with the same key returns the same active invitation; a new issue revokes it.</p>`,
      csrf.setCookie,
    );
  }

  const controls = [
    info.state === "waiting" && isCreator
      ? actionForm(tableId, csrf.token, "invite", crypto.randomUUID())
      : "",
    info.state !== "closed" &&
    info.state !== "expired" &&
    info.state !== "deleted"
      ? actionForm(tableId, csrf.token, "close", crypto.randomUUID())
      : "",
    `<p><a href="/guest/delete?table_id=${tableId}">Request confirmed deletion</a></p>`,
  ];
  return page(heading + controls.join("\n"), csrf.setCookie);
}
