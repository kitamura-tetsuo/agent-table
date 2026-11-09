# Manual browser pilot — implementation gate

Status: **partial / not a completed manual pilot**. Issue #17 REQ-001–008 remains open. This document describes the implemented session-authorized browser creation, invitation acceptance, transcript, invitation issuance and close slices. It is not evidence of named-host OAuth compatibility or autonomous wakeup.

## Joining a two-seat table

1. A creator uses the session-authorized /guest/create browser form or an independently authorized agent connection to create a private table, optionally posts a deliberate pre-join message through the agent, and issues a single-use invitation under a retained request key.
2. Share the resulting landing URL privately. The invitation secret appears only after its fragment marker (#). Do not place it in a query string, request path, logs, or an external page.
3. The recipient explicitly creates or reuses their own browser guest. If no valid session exists, open the guest identity page in a **separate tab**, make the choice, then reload the invitation tab.
4. The landing page explains that both people can read the full transcript, including earlier messages; the service is access-controlled but not end-to-end encrypted. Its same-origin script moves the fragment to an unsubmitted form field and clears the fragment from history. A GET, preview or HEAD request does not redeem a seat.
5. Clicking **Approve joining as this guest** POSTs the secret and original mutation key in the form body only. The existing browser session, Origin and CSRF checks apply. TableDO revalidates the browser session through GuestDO; both browser and agent paths commit the **same atomic** invitation and seat transaction. A browser session is never represented as a fabricated OAuth connection.
6. The guest may independently authorize an agent to read/post using standard MCP tools. A successful join is not an agent reply, agreement, or autonomous operation.

Do not silently retry uncertain mutations under a newly generated request key; retain and reuse the original key. Losing the guest browser cookie cannot be remedied with the invitation, table ID, or an unrelated connection.

## Implemented test boundaries

- Integration test: real GuestDO/TableDO creation, including browser session authorization without a manufactured OAuth grant, original-key replay, forged/invalid session rejection and independent read grant; plus pre-join post, issue, preview, session/Origin/CSRF denial, successful join, same-key retry, transcript history and unrelated guest denial.
- Browser test: Chromium fragment handling, no secret in request URLs, explicit approve click, and refusal of an unissued token.
- These tests do not establish complete REQ-001–008 acceptance. They do not run a real third-party host, deploy to Cloudflare staging, or enable public Events.

## Still required before merge

Complete the remaining navigation, consent and error-handling flows. Browser creation, invitation issuance/retry and member closure now use the existing authoritative GuestDO/TableDO transactions without manufacturing OAuth grants; the full pilot is not finished. Add the full two-browser/two-SDK manual pilot including consent denial, admission pause, expiry, destructive approval, safe rendering, and restart/retry. Document bounded agent instructions: disclose only deliberately submitted material, use original mutation keys, respect independent owner authority, seek explicit owner permission beyond delegation, stop on terminal states, and permit manual read/post fallback. Keep #23 real-host proof and #24 autonomy acceptance separate.

No operator-hosted webhook receiver or public IPv4 VPS is part of this browser flow.


### Authenticated browser transcript view (partial #17)

A guest with an existing table membership can open
`/guest/table?table_id=<table-uuid>` on the canonical origin. The Worker
checks the browser session, and TableDO independently verifies that same
session and current membership before returning metadata and a fixed-size
snapshot of persisted messages. A stranger receives the same generic
not-found response as an unknown table. It supports paginated snapshot
cursors, prints user-controlled text as escaped HTML, does not execute
embedded URLs or scripts, and distinguishes authoritative waiting/open/closed
state from message text. This view is read-only and never acknowledges
notifications or creates an OAuth grant.

The fragment-only invitation acceptance page links to the transcript only
after the server confirms a committed seat claim. The complete two-owner official-SDK manual pilot still
remains incomplete. The view does not establish named-host OAuth or autonomous
notifications and must not be used as evidence of a completed #17 gate.

### Browser invitation and closure (partial #17)

An authorized browser member may open `/guest/manage?table_id=<table-uuid>`
from the transcript. Only the creator can issue a single-use invitation while
the table is waiting for its second guest. The returned sharing link contains
the secret only in the fragment, and it is displayed on a no-store, no-script
page for deliberate private copying. An issue replaces any older unused link.
The same original request key can re-read an active invitation receipt after
an uncertain response; never create a new key automatically on failure.

A member may explicitly close the table with the same-session, same-origin,
double-submit-CSRF form. This delegates to the existing durable lifecycle
transaction and invalidates outstanding invitations. Deletion remains a
**separate** two-step guest-browser confirmation at `/guest/delete`. Neither
close nor issue grants the browser an OAuth connection or lets it post a
message. These pages are only a partial acceptance slice of #17.


### Browser creation form (partial #17)

A guest with a valid, existing browser session may open `/guest/create`.
The same-origin, double-submit-CSRF POST submits an unchanged title, optional
purpose, bounded TTL and a client-visible request key. On an unknown outcome
the exact inputs and key are rendered again; neither an ambiguous response nor
a user retry silently creates a new key. The form explains pre-join history,
the lack of end-to-end encryption and independent participant authority before
submission. Untrusted metadata is escaped and never executed as HTML.

GuestDO rechecks the actual browser session inside the existing quota and
reservation transaction; TableDO independently validates that session and
the GuestDO reservation before the same table-initialization transaction as
MCP. Browser creation does not issue an OAuth grant or bypass admission,
expiry, idempotency or session invalidation. An authorized agent connection
may subsequently read/post via ordinary MCP scopes. The focused integration
test verifies durable creation, replay and outsider/CSRF/session refusal;
it does **not** supply the required two-browser/two-official-SDK consent
and lifecycle pilot under REQ-008. #17 remains open.
