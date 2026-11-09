# Manual browser pilot — implementation gate

Status: **partial / not a completed manual pilot**. Issue #17 REQ-001–008 remains open. This document describes the implemented guest invitation-acceptance slice. It is not evidence of named-host OAuth compatibility or autonomous wakeup.

## Joining a two-seat table

1. A creator with an independently authorized agent connection creates the private table, optionally posts a synthetic pre-join message, and issues a single-use invitation under a retained request key.
2. Share the resulting landing URL privately. The invitation secret appears only after its fragment marker (#). Do not place it in a query string, request path, logs, or an external page.
3. The recipient explicitly creates or reuses their own browser guest. If no valid session exists, open the guest identity page in a **separate tab**, make the choice, then reload the invitation tab.
4. The landing page explains that both people can read the full transcript, including earlier messages; the service is access-controlled but not end-to-end encrypted. Its same-origin script moves the fragment to an unsubmitted form field and clears the fragment from history. A GET, preview or HEAD request does not redeem a seat.
5. Clicking **Approve joining as this guest** POSTs the secret and original mutation key in the form body only. The existing browser session, Origin and CSRF checks apply. TableDO revalidates the browser session through GuestDO; both browser and agent paths commit the **same atomic** invitation and seat transaction. A browser session is never represented as a fabricated OAuth connection.
6. The guest may independently authorize an agent to read/post using standard MCP tools. A successful join is not an agent reply, agreement, or autonomous operation.

Do not silently retry uncertain mutations under a newly generated request key; retain and reuse the original key. Losing the guest browser cookie cannot be remedied with the invitation, table ID, or an unrelated connection.

## Implemented test boundaries

- Integration test: real GuestDO and TableDO creation, pre-join post, issue, preview, session/Origin/CSRF denial, successful join, same-key retry, transcript history and unrelated guest denial.
- Browser test: Chromium fragment handling, no secret in request URLs, explicit approve click, and refusal of an unissued token.
- These tests do not establish complete REQ-001–008 acceptance. They do not run a real third-party host, deploy to Cloudflare staging, or enable public Events.

## Still required before merge

Build browser creation, metadata, transcript, invite issue, close, and navigation for existing confirmed deletion and revocation. Add the full two-browser/two-SDK manual pilot including consent denial, admission pause, expiry, destructive approval, safe rendering, and restart/retry. Document bounded agent instructions: disclose only deliberately submitted material, use original mutation keys, respect independent owner authority, seek explicit owner permission beyond delegation, stop on terminal states, and permit manual read/post fallback. Keep #23 real-host proof and #24 autonomy acceptance separate.

No operator-hosted webhook receiver or public IPv4 VPS is part of this browser flow.
