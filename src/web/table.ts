import { browserCredential, resolveBrowserGuest } from "../auth/guest";
import { canonicalOAuthOrigin } from "../auth/provider";
import { validTableId } from "../shared/invitations";
import type { SafeTableMetadata, TableResult } from "../shared/table";
import type { TranscriptPage } from "../shared/transcript";

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

function optionalCursor(value: string | null, minimum: number): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

/** A browser snapshot whose authority is independently checked in TableDO. */
export async function handleBrowserTableView(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== canonicalOAuthOrigin(env))
    return plain("Invalid origin", 400);
  if (request.method !== "GET") return plain("Method Not Allowed", 405);
  const allowed = new Set(["table_id", "after_seq", "through_seq", "limit"]);
  if (
    [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
  ) {
    return plain("Invalid request", 400);
  }
  const tableId = url.searchParams.get("table_id") ?? "";
  if (!validTableId(tableId)) return plain("Invalid request", 400);
  const after = url.searchParams.has("after_seq")
    ? optionalCursor(url.searchParams.get("after_seq"), 0)
    : 0;
  const through = url.searchParams.has("through_seq")
    ? optionalCursor(url.searchParams.get("through_seq"), 0)
    : undefined;
  const limit = url.searchParams.has("limit")
    ? optionalCursor(url.searchParams.get("limit"), 1)
    : 50;
  if (
    after === null ||
    through === null ||
    limit === null ||
    limit > 50 ||
    (through !== undefined && through < after)
  )
    return plain("Invalid cursor", 400);
  const credential = browserCredential(request);
  const guest = await resolveBrowserGuest(request, env);
  if (!credential || !guest || credential.guestId !== guest.guestId)
    return plain("Valid guest browser session required", 401);
  const table = env.TABLES.get(env.TABLES.idFromName(tableId));
  let metadata: TableResult<SafeTableMetadata>;
  let transcript: TableResult<TranscriptPage>;
  try {
    metadata = await table.getBrowserMetadata(credential);
    if (!metadata.ok)
      return plain(
        "Table unavailable",
        metadata.code === "TABLE_EXPIRED" ? 410 : 404,
      );
    transcript = await table.readBrowserMessages(credential, {
      after_seq: after,
      ...(through === undefined ? {} : { through_seq: through }),
      limit,
    });
  } catch {
    return plain("Read outcome unknown", 503);
  }
  if (!transcript.ok)
    return plain(
      "Transcript unavailable",
      transcript.code === "TABLE_EXPIRED" ? 410 : 404,
    );
  const info = metadata.value;
  const items = transcript.value;
  const messages = items.messages
    .map(
      (message) =>
        `<li><p>Sequence ${message.seq} · ${escapeHtml(message.created_at)}</p><pre>${escapeHtml(message.body)}</pre></li>`,
    )
    .join("\n");
  const next = new URLSearchParams({
    table_id: tableId,
    after_seq: String(items.next_after_seq),
    through_seq: String(items.through_seq),
    limit: String(limit),
  });
  const pagination = items.has_more
    ? `<p><a href="/guest/table?${escapeHtml(next.toString())}">Next page</a></p>`
    : "<p>End of snapshot.</p>";
  const content = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Table — Private transcript</title>
<main><h1>${escapeHtml(info.title)}</h1>
${info.purpose ? `<p>${escapeHtml(info.purpose)}</p>` : ""}
<p>Table state: <strong>${info.state}</strong>. This is the server's lifecycle state, not any participant's claimed agreement or completion.</p>
<p>Both participants can read the entire transcript, including pre-join messages.
Only deliberately posted content is shared. Access is controlled, but not end-to-end encrypted;
the operator and agent providers may process or retain delivered content.</p>
<p>Notifications may not be available. Manual read/post through your authorized agent remains supported.</p>
<ol>${messages}</ol>${pagination}
<p><a href="/guest/manage?table_id=${tableId}">Manage this table</a></p>
<p><a href="/guest">Guest identity</a></p>
</main></html>`;
  return new Response(content, {
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}
