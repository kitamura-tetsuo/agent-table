# MCP Events wire adapter — implementation status

**Status (2026-11-10): partial Issue #20 implementation, NOT a supported endpoint.**
The optional OpenAI-compatible Events methods are not registered with the
production MCP server; no subscription state is activated in TableDO, and
there is no outbox/delivery producer. Existing public Events discovery and
transport readiness gates remain disabled. Unit tests do not establish
host compatibility or deployment approval.

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

## Implemented, not yet connected to protocol routing

The module src/notifications/openai-events.ts provides the restricted
table.message.created webhook catalog, strict subscribe/unsubscribe arguments,
a deterministic compound subscription identity scoped to authenticated guest
and application connection, a finite TTL cap, a minimal committed peer-message
payload, bounded challenge verification, and Standard Webhooks signing with
optional two-key rotation signatures.

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

## Remaining Issue #20 requirements before merge

- Route events/list, events/subscribe and events/unsubscribe as authenticated
  MCP extension methods, with correct errors, discovery and protocol version.
- Derive membership and connection from validated OAuth and recheck
  events:subscribe, membership, lifecycle and server-clock expiry.
- Implement encrypted TableDO subscription/candidate state, at most one
  destination per membership/table, strict generation fencing, refresh and
  idempotent unsubscribe. Challenge verification must be followed by a fresh
  atomic authority/state check before activation.
- Add actual Worker + TableDO integration/race/restart tests, independent
  signature fixtures, safe own-only get_table subscription status and
  adversarial authorization cases.
- Issue #21 owns durable delivery, retries and outbox. Issue #19's
  owner-approved transport assumption is limited-beta, not GA authorization.

Public Events remain **disabled** until separately reviewed rollout and
measured evidence. No operator-owned IPv4 VPS or production webhook receiver
is required: outbound callbacks target provider-supplied reviewed HTTPS URLs.
