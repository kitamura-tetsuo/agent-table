# MCP Events wire adapter — implementation status

**Status (2026-11-10): Issue #20 registration implementation, NOT a
publicly advertised or delivering Events integration.**
The three OpenAI-compatible Events methods are registered on the existing
authenticated MCP endpoint. They use real OAuth and GuestDO connection-grant
checks, TableDO membership/lifecycle authority, encrypted durable candidates,
fenced activation/refresh/unsubscribe and bounded callback challenges. They
do **not** advertise Events capabilities in MCP initialize/discover, activate
delivery or prove hosted callback interoperability. Public Events flags and
transport readiness remain disabled.

## Pinned input contracts

- MCP Events draft design sketch at immutable commit
  [d5316be214be2e76e51462069c1d67e00a5a7619](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/d5316be214be2e76e51462069c1d67e00a5a7619/docs/design-sketch-proposal.md)
  (reviewed 2026-11-10; exploratory, not a final standard).
- [OpenAI MCP Events provider profile](https://developers.openai.com/plugins/build/mcp-events)
  (reviewed 2026-11-10, provider-controlled unversioned page).
- Standard Webhooks [v1.0.0 specification](https://github.com/standard-webhooks/standard-webhooks/tree/v1.0.0/spec);
  signing dependency standardwebhooks@1.1.1 is pinned in package-lock.json.

Provider profile differences remain explicit: the current OpenAI page documents
callback error -32015, while the reviewed draft uses -32027. The eventual
handler must match the provider variant and its pinned fixture tests, not
assume either code is universal across draft revisions.

## Implemented registration adapter

The module src/notifications/openai-events.ts provides the restricted
table.message.created webhook catalog, strict subscribe/unsubscribe arguments
(plus SDK-generated protocol `_meta`), a deterministic compound subscription
identity scoped to authenticated guest and application connection, finite
TTL, minimal committed peer-message payload, bounded challenge verification
and Standard Webhooks signing with optional two-key rotation signatures.
The low-level MCP registrations in src/mcp/server.ts do not impersonate tools
or turn on capability discovery.

The TableDO application schema is version **10**, with one subscription
state/generation ledger and one candidate per membership. A candidate's
signing key is sealed with the callback-credential AES-GCM keyring before
persistence. Pending verification never replaces the committed key. An
immutable candidate ID and monotonically increasing fence prevent delayed
verification from overwriting unsubscribe, a newer refresh, expiry or table
closure/deletion. Commit rechecks the actual GuestDO events:subscribe grant,
owner connection, table membership, live table state, candidate fence and
finite expiry immediately before its local SQLite transaction.

Expiry and rotation cleanup remove encrypted credentials; a successful
unsubscribe erases keys and destination while retaining an invalidation
generation ledger until table purge.

The separate get_table response reports only the authenticated caller's
own connection-local `notifications.status` (`active`, `expired` or `disabled`)
when live MCP subscriptions are disabled. With the independent
`subscriptions/listen` profile enabled, it preserves that profile's existing
`notifications.available` and reports the own webhook status under
`notifications.events`. The webhook status always has `available:false` and
`reason:"delivery_not_ready"`; neither shape exposes callback URLs,
encrypted keys, another application's connection or peer subscription state.

The unadvertised registration path requires an operator-reviewed allowlist
in the optional `EVENTS_REVIEWED_CALLBACK_TARGETS` binding. For example:

    [{"origin":"https://events.provider.example.org","pathPrefix":"/callback"}]

This is a **synthetic example**, not an approved production destination.
The binding is fail-closed when missing/invalid, and
`CALLBACK_CREDENTIAL_KEYRING` must be configured as a Wrangler secret.
An operator must review actual provider callback origins and path prefixes
before any live use; arbitrary caller-provided hosts are not permitted.

The callback verification helper uses the restricted Workers-native HTTPS
sender, requiring an operator-reviewed HTTPS origin and path prefix. That
sender refuses redirects and bounds response bytes and total time.
A passing challenge proves receiver control **only**, not final dialed-IP
inspection, same-attempt DNS rebinding safety, an agent run, or durable TableDO
activation. Opaque provider-generated paths and queries are accepted only
within an explicitly reviewed prefix.

The sender's header allowlist now supports X-MCP-Subscription-Id, not arbitrary
forwarded headers. Events contain no conversation text, purpose, private
credentials or agent instructions. Test keys and callback URLs are synthetic.

## Evidence and release boundaries

- REQ-001/002: `test/integration/events-subscriptions.test.ts` exercises
  real OAuth-authorized MCP extension methods and private table/connection
  boundaries, and the strict wire adapter rejects malformed/ID-only forms.
- REQ-003–006: the Worker/GuestDO/TableDO integration suite checks encrypted
  storage, finite expiry, one-destination ownership, refresh generation,
  unsubscribe, held challenges versus revocation/expiry/unsubscribe and newer
  concurrent refresh, and reconstruction.
- REQ-007: `test/fixtures/events/openai-profile-2026-11-10.json` is an
  independently computed synthetic provider-shaped request, response and
  HMAC fixture. The unit fixture and independent Standard Webhooks oracle
  check it; this does not claim a live provider signature.
- REQ-008: MCP capability discovery and
  `callbackTransportReadiness().enabled` remain disabled; per-dispatch
  authorization returns false while delivery is disabled. Successful
  registration is **not** an autonomous event subscription in ChatGPT.
- REQ-009: Worker + OAuth + actual TableDO SQLite tests are registration
  evidence. They use a controlled synthetic receiver at the HTTPS transport
  boundary. There is no hosted Cloudflare runtime test or live OpenAI
  callback/agent-run evidence in this PR.

**Issue #21** owns durable outbox/delivery/retries and dispatch-time checks.
**Issue #19**'s owner-approved native-fetch assumption remains limited-beta,
not GA proof of final-IP/TLS pinning or same-attempt DNS rebinding safety.
Deployment, hosted verification and public Events advertisement require
separate review and release gates. No production deployment or
provider-account action is part of this change.
