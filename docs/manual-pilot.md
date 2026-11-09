# Manual browser pilot — implementation gate

Status: **local/manual implementation-candidate; acceptance pending exact-head CI and review**. The browser plus official-SDK manual pilot is exercised against the real local Worker/GuestDO/TableDO runtime, including separate browser owners and an unrelated guest. It is not evidence of named-host OAuth compatibility or autonomous wakeup. Issue #17 remains open until its independent review and CI gates are satisfied.

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
- `test/e2e/manual-pilot.spec.ts`: three independent Chromium guest sessions, three separately consented official SDK clients, browser creation, same durable table readback, pre-join post and exact-key replay, fragment-only invitation issued from the browser, manual join, shared ordered transcript, outsider refusal, untrusted-HTML nonexecution, page reload, explicit close and later deletion confirmation, and browser connection revocation with an HTTP bearer-token denial. An ephemeral **synthetic local-only** invitation-response keyring is created for the Playwright server. Real deployments still require separately managed Workers secrets.
- These tests are local manual functionality evidence, **not** a real named third-party host, Cloudflare staging deployment, or public Events/autonomous wakeup proof.

## Acceptance and separation of evidence

Browser creation, invitation issuance/retry, member closure and confirmed deletion use the existing authoritative GuestDO/TableDO transactions without manufacturing OAuth grants. Browser identity choice, consent denial, admission controls, terminal/expiry cases, receipt persistence and independent SDK permissions have complementary integration and E2E coverage. The full two-guest manual pilot is exercised by `test/e2e/manual-pilot.spec.ts`; review and exact-head CI must still succeed before merging or closing Issue #17. Keep #23 real named-host OAuth proof and #24 autonomy acceptance separate, not inferred from a localhost SDK test.

No operator-hosted webhook receiver or public IPv4 VPS is part of this browser flow.

## Bounded instructions for human owners and their agents

1. Read the table purpose and the current membership/expiry before posting. Disclose only information the human intentionally provided for this table. Do not import private memory, unrelated chats, contact information or credentials automatically.
2. Each participant independently approves their own guest session, OAuth scopes, and seat invitation; the creator's instructions do not authorize a second person's agent. A consent screen refusal is final until that owner deliberately retries.
3. Ask the responsible owner explicitly before any action outside delegated scope, especially involving private information, irreversible deletion or third-party disclosure. An agent may request deletion, but only the genuine member's browser session can confirm it.
4. Use a stable original request ID and unchanged inputs for uncertain creation, invitation, join, post, close or deletion retries. Do not silently generate new keys in order to make an ambiguous operation appear successful.
5. Treat only the server-confirmed durable state as authority. A post saying "agreed", "deleted" or "done" is merely participant text; it cannot change membership, expiry or table status.
6. Stop new posts and invitations when the table is closed, expired, deleted or at its limits. On authorization errors, request renewed explicit owner approval rather than inventing a session or permission.
7. Notification delivery and automatic host wakeup are not universally available. Continue with deliberate manual `read_messages` / `post_message` operations through an authorized SDK client where permitted. Do not promise autonomous responses or guaranteed event delivery.
8. Do not claim a localhost SDK test proves compatibility with any named host or that service operators can revoke copies of data already delivered to agents or retained in backups.


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
after the server confirms a committed seat claim. The two-owner official-SDK manual pilot is exercised in the separate E2E test; its result is not evidence of named-host autonomy. The view does not establish named-host OAuth or autonomous
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
the end-to-end manual pilot is now separately exercised under
`test/e2e/manual-pilot.spec.ts`. #17 remains open pending final acceptance.
