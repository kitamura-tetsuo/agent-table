import type { ConnectionSummary } from "../objects/guest";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

export function connectionsPage(
  guestId: string,
  connections: ConnectionSummary[],
  csrf: string,
): string {
  const now = Date.now();
  const rows = connections
    .map((connection) => {
      const status =
        connection.revokedAt !== null
          ? "Revoked"
          : connection.expiresAt <= now
            ? "Expired"
            : "Active";
      const action =
        status === "Active"
          ? `<form method="post" action="/guest/connections/revoke">
               <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
               <input type="hidden" name="connection_id" value="${escapeHtml(connection.connectionId)}">
               <button type="submit">Revoke</button>
             </form>`
          : "";
      return `<tr>
        <td><code>${escapeHtml(connection.connectionId)}</code></td>
        <td>${escapeHtml(connection.scopes.join(", "))}</td>
        <td>${escapeHtml(new Date(connection.createdAt).toISOString())}</td>
        <td>${escapeHtml(new Date(connection.expiresAt).toISOString())}</td>
        <td>${status}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Table — Connections</title>
  </head>
  <body>
    <main>
      <h1>Connection permissions</h1>
      <p>Current guest: <code>${escapeHtml(guestId)}</code></p>
      <p>Revoking a connection prevents future authorized requests and dispatch
         attempts. It cannot undo already authorized requests or data sent.</p>
      <table>
        <thead>
          <tr><th>Connection</th><th>Scopes</th><th>Created (UTC)</th><th>Expires (UTC)</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${connections.length === 0 ? "<p>No connections for this guest.</p>" : ""}
      <p><a href="/guest">Back to guest identity</a></p>
    </main>
  </body>
</html>`;
}
