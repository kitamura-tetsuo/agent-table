import {
  browserCredential,
  deletionCsrf,
  readBoundedForm,
  resolveBrowserGuest,
  sameOriginPost,
  validDeletionCsrf,
} from "../auth/guest";
import { canonicalOAuthOrigin } from "../auth/provider";
import { createTable } from "../services/tables";
import { validCreationRequestId } from "../shared/creation";

const securityHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
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

function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      ...securityHeaders,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function page(
  content: string,
  csrfCookie: string | null,
  status = 200,
): Response {
  const headers = new Headers({
    ...securityHeaders,
    "Content-Type": "text/html; charset=utf-8",
  });
  if (csrfCookie) headers.append("Set-Cookie", csrfCookie);
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      "<title>Agent Table — Create private table</title>" +
      "<main><h1>Create private table</h1>" +
      "<p>This table is private and access-controlled, but not end-to-end encrypted. " +
      "Both participants can read the entire transcript, including posts made before joining. " +
      "Only deliberately posted text is shared. The operator and connected agent providers " +
      "may process or retain delivered content. Agents cannot consent for another person.</p>" +
      content +
      '<p><a href="/guest">Guest identity</a></p></main></html>',
    { status, headers },
  );
}

type FormValues = {
  title: string;
  purpose: string;
  ttl: string;
  requestId: string;
};

function form(values: FormValues, csrf: string): string {
  return (
    '<form method="post" action="/guest/create">' +
    '<label>Title <input name="title" required maxlength="120" value="' +
    escapeHtml(values.title) +
    '"></label>' +
    '<label>Purpose <textarea name="purpose" maxlength="2000">' +
    escapeHtml(values.purpose) +
    "</textarea></label>" +
    '<label>Lifetime (seconds; 3600–604800) <input name="ttl_seconds" type="number" min="3600" max="604800" step="1" required value="' +
    escapeHtml(values.ttl) +
    '"></label>' +
    '<input type="hidden" name="request_id" value="' +
    escapeHtml(values.requestId) +
    '">' +
    '<input type="hidden" name="csrf" value="' +
    escapeHtml(csrf) +
    '">' +
    '<button type="submit">Create private table</button></form>' +
    "<p>If a request times out, retry the exact same title, purpose, lifetime and request key. " +
    "Do not refresh to generate a new request key for an uncertain outcome.</p>"
  );
}

/** The browser credential is rechecked inside GuestDO and TableDO. */
export async function handleBrowserTableCreate(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== canonicalOAuthOrigin(env))
    return plain("Invalid origin", 400);
  if (request.method !== "GET" && request.method !== "POST")
    return plain("Method Not Allowed", 405);
  const credential = browserCredential(request);
  const principal = await resolveBrowserGuest(request, env);
  if (!credential || !principal || credential.guestId !== principal.guestId)
    return plain("Valid guest browser session required", 401);

  const csrf = deletionCsrf(request);
  if (request.method === "GET") {
    if (url.search !== "") return plain("Invalid request", 400);
    return page(
      form(
        {
          title: "",
          purpose: "",
          ttl: "86400",
          requestId: crypto.randomUUID(),
        },
        csrf.token,
      ),
      csrf.setCookie,
    );
  }

  if (url.search !== "" || !sameOriginPost(request))
    return plain("CSRF validation failed", 403);
  const body = await readBoundedForm(request, 32_768);
  if (
    !body ||
    [...body.keys()].sort().join(",") !==
      "csrf,purpose,request_id,title,ttl_seconds" ||
    !validDeletionCsrf(request, body.get("csrf") ?? "")
  )
    return plain("CSRF validation failed or invalid request", 403);

  const values: FormValues = {
    title: body.get("title") ?? "",
    purpose: body.get("purpose") ?? "",
    ttl: body.get("ttl_seconds") ?? "",
    requestId: body.get("request_id") ?? "",
  };
  if (!validCreationRequestId(values.requestId))
    return plain("Invalid request key", 400);
  const input = {
    request_id: values.requestId,
    title: values.title,
    purpose: values.purpose,
    ttl_seconds: values.ttl === "" ? null : Number(values.ttl),
  };
  let result: Awaited<ReturnType<typeof createTable>>;
  try {
    result = await createTable(env, credential, input);
  } catch {
    return page(
      "<p>Creation outcome unknown. Keep the original key.</p>" +
        form(values, csrf.token),
      csrf.setCookie,
      503,
    );
  }
  if (!result.ok) {
    const uncertain = result.code === "TEMPORARILY_UNAVAILABLE";
    const error = uncertain
      ? "Creation outcome unknown; retry only with the original key and inputs."
      : "Creation denied (" +
        escapeHtml(result.code) +
        "); no new operation was started.";
    return page(
      "<p>" + error + "</p>" + form(values, csrf.token),
      csrf.setCookie,
      uncertain ? 503 : 409,
    );
  }
  const id = escapeHtml(result.value.tableId);
  return page(
    "<p>Table creation committed. State: <strong>" +
      escapeHtml(result.value.state) +
      "</strong>.</p>" +
      '<p><a href="/guest/table?table_id=' +
      id +
      '">View table and invite participant</a></p>' +
      "<p>Keep the table ID private; it is not itself proof of membership.</p>",
    csrf.setCookie,
  );
}
