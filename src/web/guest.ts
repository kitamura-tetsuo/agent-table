import type { GuestSessionPrincipal } from "../objects/guest";

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

export function guestPage(
  session: GuestSessionPrincipal | null,
  csrf: string,
  admissionEnabled: boolean,
): string {
  const existing = session
    ? `<p>Your browser holds a valid session for guest <code>${escapeHtml(session.guestId)}</code>.</p>
       <p>To use this guest again, confirm it explicitly. Choosing a new guest will not merge identities even if their display names match.</p>
       <form method="post" action="/guest/session">
         <input type="hidden" name="csrf" value="${csrf}">
         <input type="hidden" name="choice" value="reuse">
         <button type="submit">Use this guest</button>
       </form>`
    : `<p>No valid guest browser session is available. Creating one requires your explicit choice.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Table — Guest identity</title>
  </head>
  <body>
    <main>
      <h1>Agent Table</h1>
      <h2>Choose your guest identity</h2>
      ${existing}
      <form method="post" action="/guest/session">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="choice" value="new">
        <button type="submit" ${admissionEnabled ? "" : "disabled"}>Create a new guest</button>
      </form>
      ${admissionEnabled ? "" : "<p>New guest admission is currently disabled.</p>"}
      ${session ? '<p><a href="/guest/connections">Manage this guest\'s connections</a></p>' : ""}
      <h2>Access and privacy</h2>
      <p>A guest is pseudonymous. No email address or password is needed. A browser label, display name, shared device, table ID, or agent connection cannot prove your guest identity.</p>
      <p>If you lose your browser cookie, this service cannot reconstruct that browser identity from a public table ID or an agent connection. There is no account recovery or cross-device pairing in this version.</p>
      <p>Losing the browser cookie does not revoke an independently authorized agent connection. Use the connection management page to revoke them separately.</p>
      <p>Connection-grant state and browser revocation are available, but OAuth connections, table membership, and private conversations are not yet available.</p>
    </main>
  </body>
</html>`;
}
