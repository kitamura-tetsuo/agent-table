import {
  browserCredential,
  deletionCsrf,
  readBoundedForm,
  resolveBrowserGuest,
  sameOriginPost,
  validDeletionCsrf,
} from "../auth/guest";
import { canonicalOAuthOrigin } from "../auth/provider";
import type { DeletionReceipt, DeletionView } from "../shared/deletion";
import {
  validInvitationOperationId,
  validTableId,
} from "../shared/invitations";
import type { TableResult } from "../shared/table";

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
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

function page(body: string, cookie?: string | null): Response {
  const responseHeaders = new Headers({
    ...headers,
    "Content-Type": "text/html; charset=utf-8",
  });
  if (cookie) responseHeaders.append("Set-Cookie", cookie);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Table — Delete shared table</title>
<main><h1>Delete shared table</h1>
<p>Deleting removes the shared content for <strong>both</strong> participants.
Copies already delivered to agents or retained in platform backups cannot be recalled.
No agent connection or URL can replace this browser's guest session.</p>
${body}</main></html>`,
    { headers: responseHeaders },
  );
}

function hidden(name: string, value: string): string {
  // Identifiers and tokens are strictly validated ASCII; escape as defense in depth.
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  return `<input type="hidden" name="${name}" value="${escaped}">`;
}

/** GET/preview is read-only; POST requires a real guest, Origin and CSRF. */
export async function handleDeletionPage(
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
    return plain(
      "A valid guest browser session is required. It cannot be recovered from an agent token or a table link.",
      401,
    );
  }

  if (request.method === "GET") {
    if (
      url.searchParams.getAll("table_id").length !== 1 ||
      url.searchParams.size > 2 ||
      (url.searchParams.has("request_id") &&
        url.searchParams.getAll("request_id").length !== 1)
    )
      return plain("Invalid request", 400);
    const tableId = url.searchParams.get("table_id") ?? "";
    if (!validTableId(tableId)) return plain("Invalid table ID", 400);
    const requestId = url.searchParams.get("request_id");
    const csrf = deletionCsrf(request);
    if (!requestId) {
      return page(
        `<p>Requesting deletion is not approval. A second explicit action will be required.</p>
<form method="post" action="/guest/delete">
${hidden("table_id", tableId)}${hidden("csrf", csrf.token)}
<button type="submit" name="decision" value="request">Start five-minute confirmation</button>
</form>`,
        csrf.setCookie,
      );
    }
    if (!validInvitationOperationId(requestId))
      return plain("Invalid request", 400);
    let result: TableResult<DeletionView>;
    try {
      result = await env.TABLES.get(
        env.TABLES.idFromName(tableId),
      ).deletionView(guest.guestId, requestId);
    } catch {
      return plain("Deletion authority unavailable", 503);
    }
    if (!result.ok) return plain("Confirmation unavailable", 404);
    if (result.value.state !== "pending") {
      return page(
        `<p>Confirmation state: ${result.value.state}. No deletion action is available.</p>`,
        csrf.setCookie,
      );
    }
    return page(
      `<p>Confirmation expires at ${result.value.expires_at ?? "unknown"} UTC.
Only the signed-in table member can approve.</p>
<form method="post" action="/guest/delete">
${hidden("table_id", tableId)}${hidden("request_id", requestId)}${hidden("csrf", csrf.token)}
<button type="submit" name="decision" value="approve">Permanently delete shared content</button>
<button type="submit" name="decision" value="deny">Keep table / deny deletion</button>
</form>`,
      csrf.setCookie,
    );
  }

  if (!sameOriginPost(request)) return plain("CSRF validation failed", 403);
  const form = await readBoundedForm(request);
  if (!form || !validDeletionCsrf(request, form.get("csrf") ?? "")) {
    return plain("CSRF validation failed", 403);
  }
  const decision = form.get("decision");
  const keys = [...form.keys()].sort().join(",");
  const tableId = form.get("table_id") ?? "";
  if (!validTableId(tableId)) return plain("Invalid request", 400);
  if (decision === "request") {
    if (keys !== "csrf,decision,table_id") return plain("Invalid request", 400);
    let result: TableResult<DeletionReceipt>;
    try {
      result = await env.TABLES.get(
        env.TABLES.idFromName(tableId),
      ).requestBrowserDeletion(credential, crypto.randomUUID());
    } catch {
      return plain("Deletion authority unavailable", 503);
    }
    if (!result.ok || result.value.confirmation_required !== true) {
      return plain("Unable to start confirmation", result.ok ? 409 : 404);
    }
    return new Response(null, {
      status: 303,
      headers: { ...headers, Location: result.value.confirmation_url },
    });
  }
  if (
    (decision !== "approve" && decision !== "deny") ||
    keys !== "csrf,decision,request_id,table_id"
  )
    return plain("Invalid request", 400);
  const requestId = form.get("request_id") ?? "";
  if (!validInvitationOperationId(requestId))
    return plain("Invalid request", 400);
  let result: TableResult<{ state: "deleted" | "denied" }>;
  try {
    result = await env.TABLES.get(
      env.TABLES.idFromName(tableId),
    ).resolveDeletion(credential, requestId, decision);
  } catch {
    return plain("Deletion authority unavailable", 503);
  }
  if (!result.ok) {
    return plain(
      result.code === "CONFIRMATION_EXPIRED"
        ? "Confirmation expired. Start a new request."
        : "Confirmation denied or unavailable",
      result.code === "CONFIRMATION_EXPIRED" ? 410 : 409,
    );
  }
  return page(
    result.value.state === "deleted"
      ? "<p>Deletion committed. Shared table content is no longer available.</p>"
      : "<p>Deletion was denied. Shared content was not deleted.</p>",
  );
}
