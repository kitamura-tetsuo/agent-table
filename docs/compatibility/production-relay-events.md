# Production relay profile integration checkpoint (#74)

Status: **not deployable; no live Events activation**. This change adds a
non-secret candidate-configuration parser and truthful diagnostics, not a new
approved private-data processor. No relay URL, key, transport attestation,
operator approval, or hosted acceptance is provisioned by this change.

## Implemented boundary

`production-relay-events` is recognized in diagnostic output. The independent
Worker restore quarantine continues rejecting the profile. Offline preflight
rejects it explicitly with `production-relay-integration-incomplete`. Existing
protected approval/provider/post-deploy gates continue rejecting unsupported
profiles; no allow-list was widened. MCP discovery, subscription challenge,
TableDO registration and outbox transport are **not wired** to this candidate.
The native test exception is neither inherited nor a production readiness proof.

`EVENTS_RELAY_CONFIGURATION` is optional non-secret JSON with exact keys:
`version` (1), `environment` (production), `buildSha` (matching the release),
`origin` (canonical reviewed HTTPS origin), `callerId` (16–128 safe characters),
and `audience` (`production:<service-id>`). The parser rejects extra keys,
credentials, malformed destinations, stale build/environment bindings and
mixed pilot/test-native configurations. Existing callback origin/path policy
remains required. Parsing an origin is syntax validation, not operator review
or DNS/connected-peer evidence. No private signing key is part of this JSON.

`productionRelayReadiness()` always returns `enabled: false`. Diagnostics expose
only fixed `relay-configuration-invalid` / `relay-integration-incomplete`
classifications, not the origin, caller ID, callback URL or secret. Outbound
pause does not enable anything. These declarations do not clear quarantine.

## Why the Worker sender is not connected yet

The existing durable outbox can reclaim expired in-flight leases and produce a
new lease token, bounded by its existing retry budget. The candidate relay's
store prevents duplicate admission but does not yet expose an authenticated,
durable result/readback protocol. The client currently maps non-200 responses
to transport failure. Therefore:

- Using a fresh lease token after unknown delivery could forward a duplicate.
- Fixing one request ID to the entire event would incorrectly prevent legitimate
  retries after known transient failure.
- Marking unknown results terminal would silently weaken the existing retry
  contract and would not prove non-delivery.
- Subscription callback verification creates a challenge and candidate; it needs
  the same durable identity/readback semantics, not a new verification request
  after an uncertain result.

REQ-001 and REQ-007 require retaining retry semantics **and** original unknown
identities. Neither is replaced by local success. Next implementation needs:

1. Persist a logical relay attempt identity and exact request commitment before
   send; reuse identity for uncertain-result reads, not new sends.
2. Define authenticated durable outcomes (known no-send, completed response,
   unresolved) and reconciliation, expiry and restart behavior. Model response
   retention explicitly: verification challenges/callback response bodies can
   contain private data. Do not silently store arbitrary bodies in the existing
   metadata-only replay database.
3. Only after known outcome classification may a legitimate retry advance its
   original attempt budget/identity. Preserve cancellation, generation fences,
   revoked grants, close/delete and outbound pause across signing and readback.
4. Integrate real MCP/service/DO paths and release config generation, live
   protected approval, provider readback, postverify and pause/rollback together.
5. Obtain separate transport/hosting/privacy review and concrete owner approval
   for exact build/config/destinations/data handling before any live setting or
   deployment, then prove actual committed event → host receipt/read/reply.

## Tests and evidence limits

Focused tests cover malformed/cross-environment/stale non-secret configuration,
no readiness from complete configuration, diagnostic redaction, retained native
staging rejection in production, explicit release preflight refusal, and actual
Worker HTTP + two independent TableDO entry points staying quarantined with no
candidate/outbox row or external fetch. These are negative activation tests,
not successful all-table delivery or hosted TLS/DNS acceptance evidence.
