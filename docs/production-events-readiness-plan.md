# Production Events implementation handoff

Status: investigation only; not an activation authorization or completed feature.
Base: c53b2b0e5fa8d3e1ca9e3fb789b9d295a2585b65 (2026-11-15).

## Requested scope

Make table.message.created available to every authorized production table participant, rather than a single table or staging pilot. Preserve OAuth scope, current connection authorization, membership/lifecycle fences, callback ownership challenge, encrypted credentials, signed delivery, idempotent outbox leases, finite retries and cancellation. This does not authorize any deployment or security configuration change.

## Blocking transport decision

The existing public gate in src/notifications/egress.ts callbackTransportReadiness is intentionally false. IMPORTANT CONTRACT CORRECTION: current Issue #19 is closed under the owner-approved 2026-11-09 limited-beta native-fetch risk acceptance; its current REQ-002/006 do not require proved application-level IP pinning for that limited beta. Historical strict-gate prose in docs/egress-feasibility.md must not be substituted for that updated contract. Unrestricted production activation remains a separate decision. Native Workers fetch does not expose the connected socket address or certificate chain; existing hosted observations cover request-to-request DNS changes, not validation-to-dial within one connection. A feature flag, success in the private staging pilot, or passing synthetic tests cannot satisfy that acceptance.

Do not turn this predicate true, relabel production as staging, broaden PRIVATE_PILOT_POLICY, or use DNS preflight followed by independent fetch. The closed raw-socket approach does not support Cloudflare-fronted callback hosts. A new relay would add infrastructure, credentials and another private-data processor; it is not an already authorized drop-in implementation.

## Ordered implementation once the transport boundary is resolved

1. Establish accepted production transport evidence against the existing requirements, or obtain an explicit revised product/security contract; record the exact implementation SHA and independent review. If a relay is chosen, specify and separately approve its destination, hosting, data handling and credentials before configuring it.
2. Add a distinct production Events release profile in the shared runtime/release parser. Do not reuse the time-limited private-pilot profile. Preserve recovery quarantine as an independent fail-closed boundary.
3. Wire authenticated Events capability discovery in src/mcp/server.ts for the production profile. Recheck events:subscribe and connection expiry/revocation. The current capability expression only admits privatePilotDiscoveryAllowed.
4. Carry the same profile through service subscribe/readback diagnostics, TableDO dispatch authorization, sendOutboxWebhook, and outboxDispatchEnabled. Public participant/table authorization must replace pilot identity/table/sequence caps, not remove lifecycle or credential-generation fences.
5. Extend scripts/release preflight, exact-config approval, postverify and rollback/pause readback for the new profile. Keep committed production flags off until the separately approved deployment.
6. Add positive two-owner/multiple-table tests plus cross-table denial, revocation, expiry, close/delete, refresh races, retries, duplicate delivery and restore-quarantine regressions. Exercise the actual MCP entry and durable outbox, not just helper predicates. Verify no private transcripts or callback secrets enter diagnostics.
7. Stage real host callback delivery and idle-agent wake/read/reply evidence against the exact release build. Obtain concrete production activation approval covering callback destinations and data disclosure. Deploy via the protected workflow and verify actual production subscriptions/delivery separately from CI and publishing.

## Current result

No application security predicate or runtime configuration has been changed. No production deployment, new credentials, callback request, table, invitation or subscription was created by this investigation. The isolated branch is a reviewable handoff, not evidence that production Events are implemented or enabled.

## Unconnected relay prototype (not production acceptance)

scripts/egress-relay-prototype.mjs is a Node library with no listener, CLI, service binding, credentials or production import. It uses the existing reviewed callback URL parser, resolves A records once, refuses mixed public/private answers, and pins the selected literal IPv4 address into TLS. It retains the original hostname for TLS identity and releases the socket to HTTP only after authorization and actual peer IP/port match. A per-request agent prevents cross-target pooling. The overall ten-second deadline includes DNS and pending TLS; cancellation destroys pending sockets. Headers are allowlisted, payload is snapshotted and limited to 16 KiB, response bytes to 64 KiB, with no redirects or retries. Response bytes are retained for the existing challenge verifier, not treated as proof of callback ownership.

Tracked by https://github.com/kitamura-tetsuo/agent-table/issues/74 . This prototype is deliberately IPv4-only; IPv6-only callbacks fail closed. Its dependency-injection factory is for trusted local tests, not a remote caller API. Production must never deserialize or accept transport overrides. The first transport-only revision had no inbound authentication. The additional offline implementation below now supplies a bounded authenticated listener library; it is not deployed.

Tests: node --test scripts/egress-relay-prototype.test.mjs passes eight test cases, including address policy, TLS/peer mismatch, original-host certificate check, forbidden headers, pending socket cancellation, bounded response, redirects, stream failure, and no late send after DNS deadline. These use injected DNS/socket/HTTP observations, not external traffic or a hosted connection. Independent review found the pending-TLS resource leak and challenge-response incompatibility; both were corrected. A real Node TLS/HTTPS joined-path integration test, real hosted DNS-change adversary, independent address-range audit and existing MCP challenge/outbox integration are still required.

## Operator choices before any connection or deployment

Recommended first step: review the isolated transport and its threat boundary; do not expose an unauthenticated relay listener. A Node service on an owner-controlled VM/container can enforce the literal socket boundary for Cloudflare-fronted receivers, unlike Workers raw sockets. This adds an outbound data-processing service and operational responsibility; existing development containers are not assumed approved relay hosts.

Required deployment decision: identify the exact host/service, public or private access path, operator/processor, network egress restrictions, capacity/rate limits, monitoring, retention policy, and who can administer it. Callback URL query values, signatures and message bodies must never enter logs. Prefer no durable payload storage; preserve existing TableDO outbox as retry authority.

Authentication options to review, not configured here:
- Mutually authenticated TLS between Worker and relay, where supported by the selected topology, with dedicated per-environment certificates, rotation/revocation and relay-side caller authorization.
- An authenticated private service path plus short-lived signed request envelope binding method, callback destination, payload digest, timestamp and unique request ID. Keep keys out of repository; verify replay/freshness before any DNS/dial.
- Neither a public bearer-only endpoint nor an unrestricted forwarding proxy is accepted by this prototype.

Before production, approve exact credential ownership and provisioning, supported callback origins, private message disclosure through that host, selected build/image and rollback/pause plan. Then implement authenticated intake, resource quotas, production profile/release integration, stage hosted adverse tests and real host wake-up evidence, obtain action-time production approval, and verify actual delivery. Local tests and this document authorize none of those actions.

## Additional offline intake and localhost integration

scripts/egress-relay-ingress-prototype.mjs adds an unconnected handler accepting only a configured caller's Ed25519 signature over method, fixed path, caller ID and the exact envelope bytes. Only public verification keys are injected. It enforces timestamp freshness, strict envelope shape, per-caller reviewed destinations and safe headers/body limits, atomic replay reservation before forwarding, and bounded per-caller/global rate and concurrency. Failure consumes the request identity; no retry under a new ID is implied by this handler. A deployment must reconcile outcomes with the existing outbox operation contract.

The replay-store interface must use shared durable atomic insert-if-absent through the acceptance horizon, including restarts and multiple instances. memoryReplayStoreForTests is explicitly not a deployment store. Local rate limits also need shared or single-instance admission semantics before scaling. The current offline additions below implement listener/store libraries; no keys, durable service, Worker binding or production integration has been installed. A deployment must additionally bound HTTP parsing/body ingestion before calling the in-memory handler.

Signature tests use the public RFC 8032 TEST 1 vector, not generated or usable account credentials. These verify exact-byte tampering, unknown caller, freshness, origin/header rejection, duplicate/concurrent replay, unavailable replay storage, rate limits and fixed safe errors.

scripts/egress-relay-local-tls.test.mjs uses an ephemeral one-day test-only certificate generated under a fresh temporary directory and removed in finally. The listener is bound only to 127.0.0.1. A real HTTPS control validates the certificate and returns synthetic text; the real Node HTTPS Agent path then rejects a private actual peer or wrong original hostname before any HTTP request reaches that listener. The production public-IP policy is not bypassed. This establishes a real negative connection boundary and TLS plumbing, not positive hosted public-IP acceptance. No external payload or real credentials are involved.

The latest user direction also requests all-table Events in the test environment and separately accepts the native-fetch DNS residual risk there. That is a separate test-only profile task; it does not change this production relay's safety contract or authorize production activation.

Independent review also found unbounded replay-store reservation wait. The handler now bounds that wait to two seconds (shorter trusted test seam), releases admission capacity on timeout and cannot send when a late reservation succeeds. The late reservation remains owned by the durable store and is not deleted or retried automatically. Seventeen local tests pass, including this regression. The injected send adapter must honor the transport bounded-completion contract; the candidate sender bounds its complete operation to ten seconds.

## Additional production building blocks (still not activated)

The HTTPS boundary in scripts/egress-relay-http.mjs limits headers, body size,
connections and ingestion time, accepts only the fixed signed POST route, and
does not expose an administrative toggle. It uses operator-injected TLS material.
Its shutdown tracks actual handler completion even when a caller disconnects;
timeout reports unresolved rather than falsely closing the backing store.

scripts/relay-admission-store.mjs implements SQLite atomic replay plus caller,
global and concurrency admission shared across actual processes on one local
filesystem. Its policy/environment/service binding survives reopen. Expired
unsettled attempts remain uncertain and consume capacity, rather than being
silently forgotten. See docs/relay-admission-store.md. This is NOT a multi-host
database, and NFS or independent replica files are unsupported.

scripts/egress-relay-application.mjs composes the listener, durable admission and
pinned sender. Every start is paused. Enabling requires an explicit local operator
operation and no expired uncertain attempts. No CLI, automatic bind, deployment
manifest or credential generation is supplied. The signed audience binds test or
production plus the selected service identity, including when public keys are
accidentally reused.

src/notifications/relay-client.ts is an unwired Worker WebCrypto adapter. It signs
the exact request and rechecks caller-supplied current authority after signing,
immediately before transport. A bounded deadline covers transport and response
streams even if an injected transport ignores AbortSignal. It never enables the
production readiness predicate.

### Remaining integration blocker, not an accepted limitation

The relay currently consumes replay identities but does not persist/retrieve
delivery outcomes. If the callback succeeds and only the relay response is lost,
a repeat is refused with 409 and the Worker cannot recover the challenge/result.
The existing outbox has legitimate bounded retries and lease renewal, so simply
using a new identity risks duplicate delivery, while permanently terminalizing
the operation would weaken that contract. Production integration MUST remain
disabled until durable outcome/readback and logical-attempt identity persistence
are implemented and independently tested. Persisting challenge/response bytes
would add a data-retention boundary and needs an explicit bounded storage design;
do not silently start saving private payloads.

Local verification covers signature/audience refusal, real loopback HTTPS,
disconnected-client drain, paused restart, real SQLite multiprocess uniqueness
and quotas, and Worker signing/deadline behavior. These are not hosted public-IP
success, real callback delivery, full MCP/outbox integration or host idle-agent
wake-up evidence. Production architecture, credentials, public endpoint, storage
and monitoring ownership, exact release/rollback and concrete activation approval
remain separate unperformed steps.
