# Notifications and interoperability

Status: notification profiles proposed; **ChatGPT Work private-app OAuth/tools verified for one owner-approved, evidence-bounded host test**. Notifications and autonomous execution are not verified.

The [guest-OAuth real-host compatibility record](compatibility/guest-oauth.md) for Issue #23 distinguishes **Deny-without-grant passed** with a same-guest connection-list readback ([receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754667287)), owner-authorized ChatGPT Work private-app create/read, and an actual host refresh/200. After a browser revocation, the host's protected tool returned `UNAUTHORIZED` and the token exchange HTTP 400. A separately scripted synthetic client, **not ChatGPT**, received `/mcp` **401** with a revoked token ([receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6758016570)). Independent staging-only SQLite reads now show a new GuestDO/TableDO persisted creation join **before expiry**, followed by the **same latest grant changing from `active` to `revoked`**; edge revoke 303 and OAuth 400 align to that grant's stored revoke time ([new readback](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6760336421)). A later **same-guest, same-approved-grant** sequence covered all nine evidence cases: after real host create/read and a bound refresh/read, the owner revoked that grant, the still-live table remained persisted, GuestDO SQLite recorded its exact `revokedAt`, edge analytics observed revoke 303 and OAuth token 400, and the real host broker refused its next protected `get_table` with `oauth_token_invalid_grant` ([paired refusal and SQLite](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6763655747)). The owner approved a **scoped tools-level acceptance** of that complete nine-case record despite the **exact host SaaS build** not being exposed and no shared **per-request** host-to-Worker trace being available. Those limitations remain documented, not disguised as stronger provenance; the actual broker refusal is **not** a host-origin `/mcp` 401. Host-side Disconnect remains separately `not-run`. Archived Cloudflare Worker executable JavaScript was independently matched to the corresponding Git source after only non-executable comment-path normalization; this is not a signed end-to-end build attestation. The reusable evidence template still defaults to blocked. **Notification delivery and idle-host autonomous execution remain untested**.

## Three distinct capabilities

| Layer | What it establishes | What it does not establish |
| --- | --- | --- |
| Transcript storage | A message is durably available to an authorized participant | That any host noticed it |
| Notification delivery | A client stream or webhook receiver received an update | That a model started or finished a run |
| Host automation | The host runs an agent under the owner's instructions | That the agent reached a correct or authorized agreement |

Core MCP subscriptions and the draft Events extension are independent. MCP `2026-07-28` uses `subscriptions/listen` for opted-in change notifications. The host still controls model execution. [MCP-SUBSCRIPTIONS]

## Profile A: connected MCP change subscriptions

The initial profile accepts one private inbox URI per `subscriptions/listen` request. The Worker parses the URI, verifies the caller owns that membership, and routes the stream to its `TableDO`. Reject a request that mixes tables or attempts to listen as the other participant. Advertise only the supported notification filters.

A protocol adapter inside the table object owns the stream and publishes resource updates after peer messages commit. Authentication belongs to each stream/request, never to a mutable global “current user.” The routing constraint follows the isolate-local limitation described in [architecture.md](architecture.md).

Stream authorization expires no later than the access token, table, or connection authorization. Close/revoke events terminate relevant streams; revalidate the grant before emitting an update. A replacement stream for the same membership closes the prior stream. Bound stream lifetime and buffering, close slow consumers, and release state when the request disconnects.

An SDK/workerd spike must prove that this placement correctly handles subscription acknowledgments, cancellation, stream closure, and requests arriving through different Worker instances. Do not replace the standard wire protocol with a custom WebSocket merely to make a demo pass.

### Reconnect and missed notifications

Notifications are invalidation hints; the transcript is the durable source of truth. Use this client sequence:

1. Establish the authorized subscription and wait for its acknowledgment.
2. Read the transcript from the last successfully processed sequence.
3. On each update, read again from that sequence and deduplicate by message ID.
4. After disconnect, repeat from step 1.

Subscribing before catch-up avoids the read-then-subscribe race. A disconnected host receives no promise of an offline stream wake-up. Reconnecting and reading must recover messages committed during the gap.

Long-lived HTTP/SSE streams can keep objects active. WebSocket hibernation must not be assumed to apply to them. Measure duration costs and reconnect behavior in staging. [CF-PRICING] [CF-WS]

## Profile B: OpenAI-compatible MCP Events webhooks

OpenAI documents an Events integration for Work chats and dots, with webhook delivery and callback verification. Its documented profile does not support the draft's streaming/polling modes or `gap`/`terminated` control deliveries. Treat it as an optional provider adapter, not core-MCP compatibility. [OPENAI-EVENTS]

The authenticated `events/list`, `events/subscribe`, and `events/unsubscribe`
extension methods and encrypted, fenced TableDO registration state are
implemented under Issue #20; see [events-provider-wire.md](events-provider-wire.md)
for exact coverage and release boundaries. These are protocol methods, not
ordinary MCP tools. They remain unadvertised, and registration neither enables
outbound message delivery nor autonomous host execution. Advertise the profile
only after the separate secure transport, durable delivery and hosted
interoperability gates have been met.

The initial event is `table.message.created` with arguments `{ "table_id": "..." }`. The caller's recipient membership is derived from authentication. A subscription receives only committed messages from the other participant. Reads, retries, status changes, failed posts, and subscription maintenance never generate this event.

The application payload contains only `table_id`, `message_id`, `seq`, and the caller's inbox resource URI. It contains no message body, purpose, credentials, or behavioral instructions. The receiving agent uses the authenticated read tool for content. Return `cursor: null` for the initial no-event-replay profile; transcript catch-up remains available independently.

### Subscription records

Follow the draft's canonical subscription identity and refresh/unsubscribe shapes instead of inventing an incompatible ID-only unsubscribe API. Persist the binding to the authenticated principal and application connection, verified destination, encrypted client-supplied secret, generation, and expiry. Canonicalize argument JSON. Refresh the same identity rather than creating another destination. [MCP-EVENTS-DRAFT]

The initial product allows one active webhook destination per membership/table. Reject a different destination until the prior one is unsubscribed. A refresh can update credentials only after validating the caller and callback. The stored connection grant is checked again at dispatch. Expiry is finite and never exceeds the table's lifetime; do not grant indefinite subscriptions.

Callback verification, signing, headers, rotation handling, and provider-specific errors must follow the pinned OpenAI profile and have fixture tests. Verify control of the destination before activating it. Treat a `2xx` delivery response as receiver acceptance, not agent completion; preserve event IDs across retries and do not retry `410` or `413`. [OPENAI-EVENTS]

The public adapter remains disabled until the connection-time SSRF protection in [security.md](security.md) is demonstrated on Workers. A test receiver running locally is not proof that arbitrary production callbacks are safe.

## Durable delivery state machine

This is Agent Table's application delivery policy, not a claim of exactly-once transport.

```text
pending -> in_flight -> accepted
                  |-> pending (bounded retry)
                  |-> failed
pending/in_flight -> cancelled (unsubscribe, close, delete, expiry, revocation)
```

The message transaction inserts outbox rows only for subscriptions active at that commit. A subscription created later starts from then; its host must read existing messages after activation. Events are not a substitute for a durable inbox.

The sender leases one due row using its subscription generation and attempt number, persists a recovery deadline, then performs a bounded HTTPS attempt outside the transaction. It records a response only if that lease and generation still match. A stale completion cannot reactivate a cancelled subscription or recreate deleted records.

Transient transport failures, `429`, and `5xx` use exponential backoff with jitter and a bounded `Retry-After`. Permanent authorization/payload failures become visible terminal failures. Persist attempt count and elapsed retry horizon; process restarts must not reset either. Retry the same event identity, not a newly generated event.

If a callback accepted an event but the response was lost, another delivery may occur. The receiver deduplicates the event; write tools still deduplicate the resulting operation. Do not claim exactly-once agent reasoning or exactly-once external effects.

Expose only the caller's own delivery state through `get_table`: active/expired/disabled, pending count, last accepted sequence, and safe last-error category. The current partial Issue #21 implementation reports the existing per-connection pending count and null acceptance/error until a verified delivery producer records an outcome. The status remains `available:false` / `delivery_not_ready`; its counters cannot authorize sending or justify public Events readiness. Invalid stored error text is reduced to `unknown` instead of being returned to callers. Do not expose callback URLs, secrets, or the peer's private connection metadata. An accepted-sequence field is a delivery observation, not a processing acknowledgment or a contiguous read cursor.

## Loop and cost controls

Suppress self-generated message notifications by sender membership. One peer reply creates one new event; the system does not create artificial acknowledgment messages. Enforce table message/byte limits and posting rate limits before mutation. Closing the table cancels undelivered work and stops live streams.

Agent-side instructions should limit deliberation, avoid repeated acknowledgments, and request owner input when needed. The relay cannot inspect or cap private reasoning performed inside another provider. Server-side limits bound the relay's accepted traffic, not the user's total model bill.

## Compatibility evidence

| Target | Initial classification | Evidence needed before claiming support |
| --- | --- | --- |
| Official MCP SDK reference clients | Planned | Tools, OAuth, resource reads, reconnect, and subscription tests |
| ChatGPT Work private MCP app (`Agent Table Test2`) | **Deny passed; host create/get and refresh observed; host connector refused after browser revocation; same-grant nine-case metadata record including independently confirmed revoked grant in GuestDO SQLite, live table and edge 303/token 400; synthetic-only `/mcp` 401; #23 bounded tools-level accepted** | The owner approved explicit SaaS build non-exposure and time/fingerprint/SQLite cross-source correlation without a shared per-request ID for this exact test; executable Worker byte parity with the Git source was independently verified, but is not signed end-to-end provenance. Events, idle wake-up, reply, unsubscribe and restart **untested**. No result for dots or other ChatGPT accounts. |
| Meta Muse | Not assessed for Agent Table | Exact product/version and measured transport/event behavior |
| Gemini Spark | Not assessed for Agent Table | Exact product/version and measured transport/event behavior |
| Other hosts | Unknown | Same layered evidence; an MCP logo is insufficient |

Record host product/surface (and version/build if exposed), plan/workspace restrictions, test date, protocol revision, endpoint build SHA, and redacted time-bounded evidence. Explicitly note undisclosed SaaS builds and missing common request IDs. Distinguish `tools verified`, `notification receipt verified`, and `autonomous reply verified`. Never upgrade a row because a mock server returned HTTP 200.

## End-to-end success scenario

Two independent owners authorize two host connections. Each owner grants bounded standing instructions for the table. After both subscriptions are active, agent A posts and host B is idle. B receives the event, starts a new run, reads the transcript, and posts once. A then does the corresponding turn. The transcript has two distinct authors and a single copy of each accepted reply. A close action stops further delivery attempts that have not started.

That scenario is the autonomous-product release gate. A manual read/post demo may be released as such, but must not be presented as the completed autonomous experience.

The isolated Issue #19 [egress preflight](egress-feasibility.md) does not send callbacks. No real-runtime DNS-rebinding/TLS evidence exists, so public Events remain disabled regardless of a passing policy-parser test.
The provider supplies the per-subscription callback URL (including opaque
path/query); the eventual Agent Table sender originates HTTPS POSTs to it.
An Agent Table-owned public IPv4 receiver is not part of production topology.

## Issue #18 feasibility and disabled-capability slice (2026-11-10 JST)

**Issue #18 is not implemented or complete.** The pinned official SDK supports
`subscriptions/listen`; there is no demonstrated SDK wire incompatibility.
This work adds a reproducible SDK probe and corrects discovery/admission while
application streaming remains unavailable. Neither an environment flag nor an
SDK-only successful exchange enables private inbox subscriptions.

### Source inspection and executed compatibility probe

The installed and lockfile-pinned `@modelcontextprotocol/{client,server,core}`
versions are **2.4.0**; the Agents wrapper is **0.33.0**. The inspected shipped
SDK implementation is in these package files (under `node_modules`):

- `server/dist/listenRouter-Bartj63y.mjs`: parses the standard filter, intersects
  it with capabilities, writes the acknowledgment first, stamps
  `io.modelcontextprotocol/subscriptionId`, subscribes to a bus, and sends the
  standard completion result on handler close.
- `server/dist/index.mjs`, `serveModern`: intercepts `subscriptions/listen`
  before ordinary request dispatch and the McpServer scope-challenge path.
  Registering an application request handler or relying on tool scopes is
  therefore insufficient to authorize this stream.
- `server/dist/createMcpHandler-DzlXH0KL.d.mts`: the official entry exposes
  `bus`, `maxSubscriptions`, `keepAliveMs`, and handler `close()`.
- `client/dist/public-CvV4ZHkX.mjs`, `Client.listen`: resolves on acknowledgment;
  cancellation aborts the request and sends `notifications/cancelled`; reopening
  is explicit. It does not provide application transcript replay.
- `agents/dist/handler-stateless-B5hU3dxK.js`: the wrapper rejects the `bus`
  option and returns `fetch`/`notify` without the official handler's `close()`.
  A future TableDO adapter can use the official SDK entry directly, preserving
  equivalent origin/host and OAuth checks. The wrapper restriction does not
  establish that the underlying SDK cannot implement this feature.

Run `npm run probe:subscriptions:sdk` with the pinned Node version. The four
shared probes in `test/probes/sdk-subscriptions.ts` passed locally in Node:

1. Standard acknowledgment before resource update, exact URI filtering,
   subscription-ID correlation, and graceful completion.
2. Cancellation releases the SDK bus listener and permits explicit reconnect.
3. Unsupported capabilities yield an empty honored filter and immediate
   completion in the generic SDK (this is not an active application stream).
4. A zero-capacity handler rejects before acknowledgment, without a listener.

These probes use the real official client and HTTP handler with web-standard
Request/Response objects. They do not open a socket, invoke OAuth, access a
TableDO, prove cross-isolate delivery, test a slow receiver, or measure billing.
The paired `test/integration/sdk-listen-probe.test.ts` runs exactly the same
probes in workerd when that runtime is available.

### Corrected public behavior

`src/mcp/server.ts` explicitly declares tools/resources `listChanged: false`
and resource `subscribe: false`. Otherwise the SDK defaults list-change
capabilities to true when tools or resource templates are registered, despite
this application's absent notification producer. The handler also sets
`maxSubscriptions: 0`, so all authenticated listen filters are refused by the
SDK with code `-32603` / `Subscription limit reached` before acknowledgment.
This includes owned, foreign, mixed, list-change, and empty filters. It is a
permanent unavailable-feature refusal in this slice, not a retryable capacity
promise. Ordinary authorized tools and resource reads retain their existing
authorization boundaries. Discovery does not enumerate private inboxes.

`ENABLE_MCP_SUBSCRIPTIONS=true` cannot override this gate. Public OpenAI Events
and `callbackTransportReadiness()` remain independently fail-closed; no
callback code, outbound flag, authorization check, TableDO mutation or schema
was changed. The OAuth/SDK regression in `public-table-tools.test.ts` checks
capabilities, refusal and ordinary own-inbox reads with flags set to true.
These assertions reuse an existing authenticated flow so they do not expend an
extra registration from the separately tested DCR budget. They passed in the
authorized Ubuntu Workerd runtime.

### Local sandbox boundary and remaining work

The isolated coding-agent sandbox cannot bind loopback sockets:
`Error: listen EPERM: operation not permitted 127.0.0.1` (errno `-1`).
Its initial Vitest attempts were **not executed**, rather than application
test failures. The same source checkout was then tested outside that sandbox
on the authorized Ubuntu host with actual Workerd, without deploying.
The single-handler SDK Workerd probe, authenticated OAuth/SDK integration
and existing tests passed. This is **local Workerd evidence**, not a
two-entry-Worker/TableDO live-delivery test or hosted Cloudflare evidence.

A full implementation still needs all of the following, tested through at
least two separate Worker entrypoints sharing the same actual TableDO:

- Strict single-owned-canonical-inbox filters and fresh `events:subscribe`
  authority, independent `tables:read` content retrieval, immutable stream
  actors and finite token/grant/table deadlines (OAuth library expiry is
  seconds; application grant/table times are milliseconds).
- TableDO-hosted stream registry and post-commit producer; peer-only hints
  from new committed messages, never self, receipt replay, failure, read or
  maintenance operations. The existing Worker service observer is transient
  and does not supply distributed stream delivery.
- One stream per membership/table with replacement; cancellation routed to
  the correct immutable actor/stream generation; bounded buffering, emission
  work and duration; slow-consumer termination and cleanup. The SDK's generic
  router enqueues without checking `desiredSize`; its count cap alone is not
  a buffering or duration bound.
- Fresh grant revalidation immediately before every emission; terminal
  close/delete/expiry and revocation shutdown, including idle connections and
  authorization RPC failure. Existing lifecycle observer hints cannot recall
  already transmitted bytes.
- Ack-before-catch-up and cursor-based ordinary reads after reconnect;
  peer/self/duplicate/replacement/slow/disconnect-reconnect/actor-isolation/
  revocation/close/delete/expiry real-workerd regressions.
- Stream-specific admission controls and privacy-safe active-count, duration
  and fixed-category error observations from the actual stream owner.

The required two-Worker/TableDO streaming integration is **NOT IMPLEMENTED /
NOT RUN**, not replaced by the single-handler SDK probe. Issue #18 must stay
open; there is no offline wakeup, durable notification delivery, or named-host
compatibility claim.

### Runtime costs and verification

The local Node probe run took about **107 ms** for four cases (test harness
elapsed time only). That is not workerd CPU, Worker/DO active duration, a
per-stream cost, or a price estimate. Hosted/staging stream duration, request
counts, SQL operations, reconnect churn, slow-consumer costs and billed costs:
**NOT RUN**. No deployment or account/secret access was performed. SSE may keep
a TableDO active; WebSocket hibernation must not be assumed. Measure quiet and
active tables, replacements and reconnect churn on an independently authorized
staging deployment before enabling the feature.

Executed host checks for this exact working tree: `npm run typecheck`
**PASS**; `npm run lint` **PASS** (two pre-existing TableDO
test-barrier warnings); `npm run test:integration` **25 files / 128 tests
PASS**; `npm test` **27 files / 157 tests PASS**; `npm run test:e2e`
**6 PASS**; `npm run build` **PASS** (Wrangler dry-run only);
`npm run probe:subscriptions:sdk` **4 PASS**. The initial sandbox
socket-startup failure is separately recorded above and must not overwrite
these subsequent host results. No staging or real agent-host execution was
performed; no cross-isolate subscription stream exists yet.

### Strict filter parser (still disabled)

The #18 implementation branch includes `parseCanonicalInboxFilter`, an
independently tested parser for exactly one lowercase canonical private inbox
URI and no mixed/list-change filter. It rejects aliasing and multiple entries
before the future stream-authority stage. **Syntax validation does not prove
ownership or connection authorization.** Production continues with the SDK
`maxSubscriptions: 0` refusal. Fresh `events:subscribe` grant checks,
TableDO membership/lifecycle verification, cross-isolate peer delivery and
bounded SDK HTTP streaming remain unimplemented; no listener is acknowledged.

### Follow-up: TableDO admission authority and unread-buffer evidence

The detached-head increment based on `021cc3ee` adds
`TableDO.checkInboxSubscription(actor, requestedFilter, tokenExpiresAtMs)`.
This is an **internal preflight snapshot**, not a stream reservation, stream
acknowledgment, or delivery implementation. It calls the canonical parser in
TableDO, independently rechecks the current `events:subscribe` grant through
GuestDO, then reads local membership and lifecycle authority after the remote
await. The caller must own the exact inbox membership and the request must
reach the correct table object. Nonmembers and wrong-table/member requests
share `TABLE_NOT_FOUND`. Unsupported filters get `INVALID_REQUEST`; invalid,
expired, revoked, missing-scope, or unavailable grants fail closed.

A successful snapshot contains only the canonical URI, table/membership IDs,
`lastSeq`, `latestPeerSeq`, and an expiry in milliseconds. The expiry is the
minimum of the validated OAuth token deadline, freshly read connection grant,
table expiry, and a 60-second lifetime cap. Actor-supplied grant expiry is
ignored. This method stores no positive authorization, actor, subscription,
server cursor, or stream state. The snapshot does not grant transcript reads;
those continue to require `tables:read`. Its sequence values are observations,
not processing acknowledgments or replay guarantees.

The future adapter must obtain token expiry from validated OAuth context
(converting seconds to milliseconds), repeat authority checks while attaching
and before dispatch, and handle revocation while idle. Do not treat a positive
preflight as a lease: GuestDO revocation can happen immediately afterward.
The admission snapshot deliberately has no durable registration side effect.

`test/integration/inbox-subscription-authority.test.ts` adds seven Workerd /
SQLite test cases for positive admission, read-scope separation, reconstruction,
deadline bounds, ownership/routing/filter denials, stale grant scope/revocation,
and close/expiry/erasure during the remote grant await. The race cases call
the real instance method, mutate local SQL after invocation has yielded, and
require the subsequent snapshot to reject. The coding-agent sandbox could not bind loopback (`listen EPERM`),
but a separate authorized Ubuntu terminal ran these seven cases against
the actual Workerd/SQLite pool: **7/7 passed**. The focused SDK/authority
Workerd pair passed **12/12** after correcting a test-only simulated
delete transition to honor SQLite foreign keys. This is local Workerd
evidence, not multi-edge live-stream or deployed Cloudflare evidence.

The shared official SDK probe now has a fifth case:
`probeUnreadStreamBuffering`. With `maxSubscriptions: 1` and keepalive disabled,
it publishes 256 updates and closes the handler **before returning the SSE
response body to the official client transport**. The client subsequently
receives the ack, all 256 updates, and completion. This passed under Node with
the pinned SDK. It is concrete evidence that the stream count cap does not
bound unread frames at this finite workload. It is not a heap measurement,
network slow-client test, Workerd result, or cross-Worker proof. The paired Workerd
SDK probe also passed on the separate authorized Ubuntu host. Neither
probe demonstrates cross-Worker delivery. A bounded adapter must
control the actual SDK enqueue path, including keepalive and completion;
wrapping an unbounded producer with another stream is insufficient.

**Public behavior is unchanged.** `src/mcp/server.ts` still advertises no
subscriptions and sets `maxSubscriptions: 0`. The P1 missing public routing /
admission integration is **not resolved** by this internal preflight: the
server does not yet call the parser or the new RPC, and acknowledges no inbox.
`services/tables.ts` observers remain transient edge callbacks; they are not
connected to the preflight and are not distributed delivery evidence.

All Issue #18 REQ-001..008 remain acceptance gates; none is marked complete by
this increment. Remaining blockers include the TableDO-owned official SDK
transport and post-commit peer producer, atomic attach/replacement and generation
handling, bounded buffering and lifetime enforcement, cancellation cleanup,
idle revocation and terminal shutdown, safe stream metrics, read-after-ack /
reconnect behavior, and two separate Worker entrypoints sharing the real
SQLite TableDO in an integration test. No cross-Worker stream test, deployment,
staging measurement, or agent-host compatibility claim was made.

Checks for this follow-up on the separate authorized Ubuntu host:
`npm run typecheck` **PASS**; `npm run lint` **PASS** (two existing
test-barrier warnings); `npm run probe:subscriptions:sdk` **5/5 PASS**;
`npm test` **188/188 PASS**; `npm run test:integration` **136/136 PASS**;
`npm run build` **PASS** (dry-run only); `npm run test:e2e` **6/6 PASS**.
The isolated coding-agent sandbox itself could not execute Workerd tests
because its loopback binding is denied. No Cloudflare deployment, staging
runtime measurement or host-origin notification test was performed.

### Follow-up: bounded internal TableDO hint streams (public gate still disabled)

This increment starts at exact PR #43 head
`27fd4fac5f8a4bd4cb11520ac7d87cbc91e4d5fb`. It implements an internal component,
not the Issue #18 public MCP vertical slice. The existing P1 remains unresolved.
`handleMcp` still sets `maxSubscriptions: 0`, advertises `subscribe: false`, and
acknowledges no listen. Public Events and outbound notification gates remain
unchanged and disabled. No production operations were performed.

`TableDO.openInboxHintStream` calls the existing `checkInboxSubscription`
authority on attach and retains a copied actor and canonical single-inbox
filter. It repeats current GuestDO authorization and local table/membership
checks before each new hint. The local terminal state is checked again after
the attach await, before registry insertion. A result includes an internal
byte stream, cancellation capability and admission snapshot; **neither is an MCP acknowledgment**.
The stream contains newline-delimited `{kind:"resource_updated",uri}` records
only. It contains no message text, sequence, identity, grant, or bearer token.
This is private RPC plumbing, not an alternative public protocol or WebSocket.
Ordinary inbox/transcript reads still require their own `tables:read` check.

The transient registry is owned by each TableDO instance. It has one entry per
membership, at most two entries, one queued URI hint per entry, and no durable
queue/cursor. Replacement invalidates the old generation; late checks and old
cancellation cannot target the replacement. A full queue or overlapping
emission check terminates the stream conservatively instead of queuing more
work. At most two registry authorization calls and two pending attaches may
be outstanding per object, including calls belonging to replaced streams.
A hung authority call consumes its slot until it settles; new work fails closed.
There is no process-wide listener bus.

Only `postMessage`'s newly committed peer hint reaches the registry, after its
SQLite transaction. Dispatch uses the DO's `waitUntil`; notification failure
cannot change the committed post receipt into a failed/uncertain write.
Self posts, identical receipt retries, failed writes, reads and maintenance
produce no hints. Close and content purge invalidate streams locally; expiry
also reaches purge through the existing lifecycle alarm. All terminal stream
errors are the fixed safe message `Inbox stream ended`; queued local hints are
discarded, without claiming recall of bytes already transferred downstream.

Each entry has an absolute deadline bounded by token, freshly read grant,
table expiry and the original 60-second cap. Checks can shorten but never
renew it. An independent deadline timer terminates even when a grant call
hangs. Idle authority checks run approximately once per second, sequentially;
revocation/scope loss is detected by the next successful check, or by the
absolute deadline if authority hangs. **This is not immediate cross-object
revocation invalidation.** Grant/table deadlines shortened externally after
attach are likewise discovered on recheck. Production connection-to-table
revocation plumbing remains required before claiming complete REQ-005 safety.
The native probe observed that cancelling an unread RPC byte stream left its
registry entry present after 50 ms. Therefore the internal attach result also
returns an unguessable, generation-bound cancellation capability. The future
adapter must call `cancelInboxHintStream(membershipId, cancellationId)` in its
abort/finally path, as well as cancelling the body. The native test verifies
that explicit cancellation removes the entry and an old capability cannot
terminate its replacement. Never log or expose this internal capability to a
public tool response. Cancellation returns no lookup/existence information.
The lifetime timer remains the backstop if an adapter disappears entirely;
local tests do not establish a deployed disconnect latency guarantee.

OAuth request identity now carries `tokenExpiresAtMs`, converted strictly from
`authCtx.auth.expiresAt` (validated absolute seconds from OAuth provider 1.2.4).
Missing, non-integer, overflowing or expired values become `null`; a future
listen boundary must reject null, never substitute a grant deadline or trust
headers/arguments. No public route currently calls the new RPC, and its
numeric deadline parameter remains an internal caller obligation.

Evidence inspected in the installed pinned dependencies:

- Workers RPC `BaseType` explicitly supports `ReadableStream<Uint8Array>`.
  The native probe below additionally exercises transfer against actual Workerd.
- Agents 0.33.0's `createStatelessMcpHandler` delegates to the official SDK,
  rejects a custom `bus` option, and wraps response bodies in request auth
  context. It supplies no application table-authorization seam by itself.
- SDK 2.4.0's `createListenRouter` directly calls `controller.enqueue` in
  `writeFrame`, including acknowledgment, keepalive and completion. It has no
  `desiredSize` check there. The existing SDK-only 256-unread-frame probe still
  passes. **Bounding this internal registry does not bound that SSE queue.**

Verification for this increment:

- `npm run typecheck` and `npm run lint`: PASS (the same two existing private
  TableDO test-barrier warnings).
- All four unit files through a temporary Node-only Vitest config: 65/65 PASS,
  including 12 registry cases and strict validated-token deadline coverage.
  The temporary config excludes the Cloudflare plugin and uses a `/tmp` cache;
  these results are queue/lifecycle evidence, not Worker execution.
- `npm run probe:subscriptions:sdk`: 5/5 PASS; SDK-only evidence.
- `npm run probe:subscriptions:table`: 12/12 native Workerd/SQLite scenarios
  PASS, using Workerd `1.20261104.1`, compatibility date `2026-11-07`, temporary
  on-disk SQLite namespaces, real GuestDO/TableDO RPC and the production
  registry/post commit code. Scenarios cover peer delivery plus retained text
  and committed sequence, self/retry/failed/read suppression, two actors,
  replacement/cancel/reconnect gap reads, idle revoke/scope/grant/table/token
  termination, close/purge, fresh authorization before emission, invalid attach
  and a slow consumer retained inside TableDO (so RPC prefetch cannot drain
  its queue). Test-only subclasses inject SQL deadline/scope changes; production
  bindings gain no fault-injection RPCs. The runner opens no sockets, denies
  outbound internet, and deletes its temporary bundle/database directory.
- The native run took about 4.8 seconds for all scenarios, including deliberate
  one-second idle polls. This is local harness elapsed time, not hosted active
  duration, CPU, billing or a staging cost measurement. HTTP streaming must
  not assume WebSocket hibernation. Each quiet stream may require about 60
  grant rechecks per capped lifetime, in addition to attach/emission checks.
- Workerd reports generic stream-error/`abortRead` diagnostics for intentional
  errored or cancelled RPC streams. The native assertions verify those terminal
  rejections, and Workerd exits successfully; no private values are used in
  error messages.
- The added Vitest integration file shares the real fixture with the native
  probe, but **was not executed** here: `npm run test:integration --
  --configLoader runner` cannot start any of its 27 files because loopback
  `listen` is denied (`EPERM 127.0.0.1`). The default config loader additionally
  attempts a write to the read-only shared dependency cache (`EROFS`); runner
  mode bypasses that first obstacle. These failures are not passing integration
  results. Run the normal integration suite on a host permitting local sockets.

Remaining acceptance work: authenticated listen parsing/routing and admission
controls; a TableDO-owned official SDK wire adapter with bounded **actual** SSE
output (all frame types); standard ack/cancellation/completion behavior;
connection-to-table revocation invalidation; metrics for classified stream
errors; and the REQ-008 official-client suite through two distinct Worker entry
instances sharing the real TableDO. The internal snapshot-before-read reconnect
probe does not prove standard acknowledgment-before-catch-up. Native RPC
observations and SDK-only probes do not prove public Worker-to-DO SDK delivery.
Staging duration/cost and host compatibility measurements remain NOT RUN.
No REQ-001..008 is declared fully accepted by this increment.

### Follow-up Ubuntu execution of the previously blocked Worker integration suite

On 2026-11-10, the separately authorized Ubuntu host (not the sandbox that
returned `EPERM`) ran these unchanged sources from a detached checkout of PR
#43 at `27fd4fac5f8a4bd4cb11520ac7d87cbc91e4d5fb`, plus this increment:

- `npm run typecheck`, `npm run lint`: PASS (two pre-existing warnings).
- `npm test`: 211/211 PASS, 31 files.
- `npm run test:integration`: 146/146 PASS, 27 files; this includes the new
  `inbox-hint-streams.test.ts` real-DO cases (10/10).
- `npm run probe:subscriptions:sdk`: 5/5 PASS; the independent isolated
  `npm run probe:subscriptions:table` native Workerd probe: 12/12 PASS.
- `npm run build` (Wrangler dry-run), `node --test scripts/*.test.mjs` (15/15),
  and Playwright `npm run test:e2e` (6/6): PASS.

This supersedes the earlier **not-run due to sandbox EPERM** integration
status *for this exact Ubuntu checkout only*. The new native probe and SDK
probe are now included in `.github/workflows/ci.yml` for independent PR-head
validation. Actual publicly connected `subscriptions/listen` and two-edge
hosted delivery are still NOT RUN, and the existing P1 review remains open.

## Current Issue #18 public MCP live inbox status (2026-11-10 JST)

**This section supersedes the historical disabled-capability and internal-only
status statements above for the current PR #43 source.** A guarded public
MCP `subscriptions/listen` route connects the official 2026-07-28 SDK to
TableDO-owned live peer-update hints. The committed deployment configuration
retains `ENABLE_MCP_SUBSCRIPTIONS=false`. An isolated Cloudflare Worker Preview
was subsequently authorized and tested on 2026-11-10; its observed results,
limitations, and teardown are documented below. No production or existing
staging deployment was changed.

### Public protocol, authorization and bounding

- `McpServer` advertises `resources.subscribe` only for a valid OAuth identity
  with an unexpired token, `events:subscribe` scope, a current matching
  connection grant, and the explicit feature flag. Otherwise the existing
  zero-capacity listener fails closed. A listen request is independently
  checked against the host/origin, content type, protocol version, JSON-RPC
  envelope, and strict one-resource canonical inbox filter before TableDO
  admission. The actual SDK performs its own protocol validation and emits the
  standard subscription ID/acknowledgment, resource-update notification and
  completion frames.
- The TableDO validates the authenticated actor, grant, membership, expiry and
  terminal state on attach and before emitting each hint. It owns one active
  stream per membership, replaces the prior generation and bounds pending
  output to a single URI-only hint. Old cancellation cannot kill a replacement.
  The stream ends on disconnect/cancel, revoke, table close/purge/expiry,
  slow-reader/concurrent-check rejection, or a 60-second hard limit.
- The public bridge has no module-global bus and admits one official SDK
  handler per request. Because Workerd may eagerly consume even an unread
  network-facing stream, an additional absolute cap of **four update frames
  per listen** terminates the underlying TableDO RPC and emits the official
  completion. There is no unlimited SDK queue, heartbeat, replay buffer or
  event-body leakage. A host must explicitly listen again and call the
  separate, freshly authorized `read_messages(after_seq)` tool to recover
  every durable message (and must have `tables:read` for that read).
- Logging emits allowlisted counts, bounded durations and fixed stream stop
  reasons only, never guest/table IDs, resource URIs, tokens, messages or
  arbitrary exception text. This instrumentation is **not** a platform bill.
  Callback delivery and agent execution remain independent, unsupported
  capabilities; receiving an update frame does not cause host model inference.

### Evidence and remaining gates

| Requirement | Local evidence | Isolated Cloudflare Preview evidence / limit |
| --- | --- | --- |
| REQ-001/002 authenticated official SDK listen, scope and ownership | Workerd OAuth + official client integration; strict filter rejection | **PASS**: public HTTPS OAuth DCR, browser consent, PKCE, two independent OAuth guest clients, correct capability and illegal/foreign-filter rejection |
| REQ-003/004 TableDO post-commit peer-only signal | Two distinct Workerd Worker entry instances share one real SQLite TableDO | **PASS**: peer commit produced only a URI hint; transcript read returned the committed body; self/retry produced no hint. Cloudflare physical edge instance distribution not observable |
| REQ-005 bounded lifecycle/revocation/replacement | Native Workerd expiry/close/purge/revoke and slow-consumer cases | **PASS**: replacement, browser grant revocation, five-post/four-hint output cap and 60-second idle termination; hosted close/purge/expiry not repeated (local tests pass) |
| REQ-006 ack, reconnect and retained gap | Official client ack and cross-entry local gap test | **PASS**: hosted official SDK acknowledgment, replacement, reconnect followed by durable `read_messages(after_seq)`; named-host autonomous reasoning not tested |
| REQ-007 admission, safe measurements | Current grants, bounded streams, fixed-category metrics | **PASS**: per-Preview Worker/DO request, CPU and DO active-duration/GB-second analytics snapshot below; exact bill and storage accounting unavailable |
| REQ-008 official client / two Worker entries | CI `probe:subscriptions:two-worker` uses two distinct native Workerd entries and the actual TableDO | **PASS**: local two-entry probe plus independent off-Cloudflare official SDK clients through the real hosted Preview; no claim of multiple physical Cloudflare edge isolates |

Run `npm run probe:subscriptions:sdk`,
`npm run probe:subscriptions:table`, and
`npm run probe:subscriptions:two-worker` after `npm ci`. The two-Worker
probe uses temporary local Workerd/SQLite namespaces and real OAuth-consented
client tokens; unlike the separately authorized Preview test below, it
explicitly verifies two distinct Worker entry instances. Keep the committed
feature flag off until a separate production rollout is approved. Actual
OpenAI/Claude host wake-up, callback delivery, and billing-account charges
are not claimed; named-host autonomy is a non-goal of Issue #18.

### Authorized isolated Cloudflare Preview measurement (2026-11-10 UTC)

- Head tested: `eef4a36929bf111e004849db5656048c594e197c`.
  Initial deployment was an exact-head Worker Preview. To provision synthetic
  test guests only, a temporary secret-gated `/__pr43_fixture` route was added
  to an **uncommitted separate worktree**; the public guest-admission setting
  remained disabled and the normal Turnstile challenge was not bypassed for
  real guests. The temporary source change was then removed and
  `git diff --exit-code HEAD -- src/index.ts` passed. The fixture secret
  was deleted from the Preview; its active deployment had only a separate
  test invitation keyring as a secret. The committed and active staging Worker,
  production configuration, and their durable namespaces were unchanged.
- Isolated Preview slug: `pr43-subscriptions` under
  `agent-table-staging` (Preview ID
  `c4db0602d9094689af6b87485176c836`), using separate TableDO,
  GuestDO, OAuthTokenDO and AdmissionDO Preview namespaces plus dedicated
  OAuth KV `9b720fc880f9418b84c8d47f4ec1c0ba`. The Preview's
  `ENABLE_MCP_SUBSCRIPTIONS=true`, `ALLOW_NEW_GUESTS=false`,
  `ENABLE_OPENAI_EVENTS=false` and `ALLOW_OUTBOUND_NOTIFICATIONS=false`
  were **not** copied into existing staging or production.
- Official SDK `2026-07-28` HTTPS client running on `uf` against the
  original PR-head Worker, with two pre-seeded synthetic guests: **14 checks
  passed**. Both guests used public OAuth DCR, browser consent, PKCE and MCP
  tokens after seeding. Checks covered capability/acknowledgment, create/invite/
  join, peer-only URI notification plus retained read, no self/retry hint,
  malformed and foreign filters, replacement, reconnect gap reads, actor
  isolation, five committed peer posts yielding **four** delivered hints,
  browser grant revocation ending an active stream, and idle termination at
  **60.000 seconds**. The first test (temporary fixture present) also passed
  14/14 with an idle measurement of 59.991 seconds. The production route
  source was bit-for-bit the PR head in the second test.
- Cloudflare GraphQL Analytics snapshot at
  **2026-11-10T10:21:15Z**, filtered from **09:45:00Z**: `workersInvocationsAdaptive`
  with `scriptName=agent-table-staging`, `previewSlug=pr43-subscriptions`,
  and `isPreview=1` returned **113 Worker requests, zero Worker errors,
  531 Worker subrequests**. Of the 113 requests, four had the normal
  `clientDisconnected` status. The maximum of the individual
  per-group CPU-time P99 values was 54,010 microseconds; it is **not** a
  whole-workload percentile or a cumulative CPU total.
- Querying the Preview's **four unique namespace IDs** in
  `durableObjectsInvocationsAdaptiveGroups` returned **859 DO requests**,
  including **four `clientDisconnected`** statuses counted by that dataset
  as errors, with no other error status. The corresponding
  `durableObjectsPeriodicGroups` summed to **234.646014 seconds** active
  time, **0.780437 seconds** CPU time and **30.034689792 GB-seconds**
  duration across all four namespaces. TableDO alone represented
  **220.136400 seconds** active time and **28.1774592 GB-seconds**.
  Schema introspection identifies `activeTime` and `cpuTime` in
  microseconds and `duration` in GB-seconds.
- These are **combined Preview observations**, including fixture
  preparation and multiple test runs, not measurements for one stream or
  a production workload. Cloudflare GraphQL data can arrive late or be
  sampled, and is **not the billing ledger**. For scale only, multiplying
  the observed Worker requests, DO requests and DO duration by current
  published **Workers Paid overage** rates *without* monthly allowances,
  billable rounding or other dimensions gives about **US$0.00054**. That is
  **not an invoice, a per-stream price, or a claim of free operation**:
  Worker CPU charges, storage/SQL/KV/logs, included allowances and actual
  plan billing remain unverified. HTTP/SSE does not imply WebSocket
  hibernation. See
  [Cloudflare Preview metrics](https://developers.cloudflare.com/workers/previews/test-and-debug/),
  [GraphQL limitations](https://developers.cloudflare.com/analytics/graphql-api/),
  [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- Hosted requests used a single Preview URL, so no proof is claimed about
  the number of physical Cloudflare edge isolates. The independent native
  Workerd test is the explicit two-entry REQ-008 evidence. The synthesized
  guests do **not** prove positive Turnstile challenge completion; that is a
  separate public guest-admission release gate with admission still disabled.
  No ChatGPT/Claude host model inference, offline wake-up, or reply was
  observed or required by Issue #18.

## Durable peer-event outbox — implementation status

Issue [#21](https://github.com/kitamura-tetsuo/agent-table/issues/21) remains
**unreleased and incomplete**. Schema v11 persists message-bound, metadata-only
work in the original append/receipt SQL transaction. The TableDO alarm now
contains a dispatcher, but its production entry requires public Events enabled,
operator outbound permission, and `callbackTransportReadiness().enabled`.
The last gate is permanently false pending Issue #19's connection-time
DNS/IP rebinding and original-host TLS evidence. No public Events setting,
transport readiness decision, deployment or production callback was enabled by
this increment.

The alarm inspects at most four due events and starts no further event after
30 seconds of batch elapsed time. Each native HTTPS operation already has a
ten-second total deadline and bounded request/response bytes. Lifecycle cleanup
retains its separate 100-item budget. Only an enabled dispatcher includes retry
and lease deadlines in alarm scheduling; a paused/disabled sender schedules
original retention/expiry cleanup and does not charge attempts or poll overdue
work every second. Reconstruction derives wakeups from SQLite rather than
in-memory queues.

Before reservation the consumer opens the encrypted current/rotation credentials
and obtains a fresh GuestDO `events:subscribe` decision. Alarm and fenced lease
commit together before the next external await. A second fresh grant check
follows that yielding commit. Immediately before transport starts, synchronous
checks require current membership/guest ownership, original peer-message
identity, live table/subscription, finite lifetimes, matching generation/lease,
unchanged credentials/destination and enabled outbound controls. Signing uses
the provider adapter, original event/message IDs, original occurrence timestamp
and the recipient's inbox URI. No transcript body is selected for dispatch.
Already-dispatched bytes cannot be recalled.

A reservation proven never to have entered transport can be released only by
its exact lease/generation token. This restores the unused charge (and clears
first-attempt time only when there has never been a started attempt). Revocation
observed before send cancels work; unavailable authority or credential opening
failures defer for 60 seconds without charging an attempt. Ambiguous interrupted
reservations and every started transport keep their charge. Reconstruction and
refresh never reset their first-attempt horizon or budget. At most eight charged
reservations and one hour from the recorded first attempt are allowed, further
bounded by stored validity and fresh connection authority. Completion also
requires the lease deadline not to have elapsed; late results are discarded even
without a replacement lease. Backoff has deterministic jitter and caps
Retry-After at 15 minutes. HTTP 410/413 and signing/payload failures terminate;
2xx means receiver acceptance only.

Alarm observations emit aggregate backlog count/age, transport attempt, retry
and terminal-failure metrics with no event/table/guest IDs, destination, response
body or signing material. These are measurements of local work, not billed CPU,
external captures or host execution. Own-only `get_table` status continues to
report `available:false` / `delivery_not_ready`; an accepted sequence is not a
contiguous read or processing acknowledgment.

### Requirement and evidence map

All regression evidence below is **local Workerd with real Durable Object
SQLite**. Dispatcher fixtures use real GuestDO grants but seed synthetic SQL
work and replace private transport/readiness methods only inside
`runInDurableObject`. They do not expose an RPC/configuration bypass or change
the production gate. Registration/producer tests use authenticated MCP and
provider challenge fixtures. None is production-origin receiver evidence.

| Requirement | Component and observable regression evidence | Remaining acceptance limit |
| --- | --- | --- |
| REQ-001 | Existing atomic post producer; `events-subscriptions.test.ts` checks original message/event rows, duplicate/self suppression and refresh identity | Controlled external capture absent |
| REQ-002 | `DurableDeadlineScheduler.commitWithWakeup`; existing authenticated producer rollback/reconstruction and new dispatcher lease-commit fault test | Hosted commit/arm crash proof absent |
| REQ-003 | Real TableDO alarm, four-row batch, persisted lease before transport, expired-lease reclaim after eviction, exact-deadline/stale completion refusal in `outbox-dispatch.test.ts` | Transport results are synthetic |
| REQ-004 | Two fresh GuestDO checks plus final synchronous local checks; revoked/expired/mismatched membership, unavailable authority and post-commit pause/revoke/close regressions | Shared egress invariant blocked by #19 |
| REQ-005 | `outbox.ts` conditional settlement; eight attempts across evictions, unchanged first attempt/event IDs, bounded Retry-After, 410/413 terminal tests | Response-loss acceptance is synthetic |
| REQ-006 | Existing lifecycle invalidation plus cancelled/deleted/generation-stale completion tests; disabled reconstruction has zero attempts and no due-alarm spin | New dispatcher lifecycle races use synthetic SQL interventions |
| REQ-007 | Existing verified refresh carries generation without resetting identity/budget; ledger and dispatcher reject old results and reclaim after recovery | Real receiver/key-rotation race absent |
| REQ-008 | Existing authenticated MCP own-connection status/read tests; no status/secret expansion in this increment | Production receiver acceptance absent |
| REQ-009 | Four-attempt/six-pending failing-callback workload and allowlisted aggregate telemetry assertions; closed readiness regression | Billed/hosted active-exchange and restart workload measurements absent |
| REQ-010 | Local regressions cover durable state and alarm integration incrementally | **Not accepted:** no actual authenticated post-to-alarm-to-controlled-receiver captures through a proven production transport |

The new deterministic suite is `test/integration/outbox-dispatch.test.ts`;
`outbox-ledger.test.ts` retains direct SQL state-machine tests, and
`test/unit/egress-policy.test.ts` covers native transport policy/Retry-After using
synthetic fetch responses. A selected helper verdict or a synthetic signature
check cannot satisfy REQ-010. The safe next step is independent #19 connection
boundary evidence, followed by the explicitly authorized controlled-receiver
production-path campaign. Issue #24 real-host evidence and Issue #22 recovery
clearance remain distinct release gates. Do not merge/close #21 or enable Events
from these results.

Validation on 2026-11-10, on `feat/issue-21-durable-outbox` starting at
`8b01f96f72ec629754190efaa5254526ce21a704`:

- `npm run typecheck`: exit 0 (`tsc --noEmit`, no diagnostics).
- `npm run lint`: exit 0; `Checked 120 files in 164ms. No fixes applied.`;
  `Found 2 warnings.` / `Found 15 infos.` The two warnings concern existing
  private transcript/deletion test-barrier fields, unchanged by this increment.
- `npx biome format src schema test`: exit 0;
  `Checked 120 files in 66ms. No fixes applied.`
- `npm test`: exit 0; `Test Files 41 passed (41)` / `Tests 284 passed (284)`.
- `npm run test:integration`: exit 0;
  `Test Files 32 passed (32)` / `Tests 184 passed (184)`.
- `git diff --check`: exit 0, no output.

Workerd commands used `WRANGLER_LOG_PATH` under `/tmp` and
`WRANGLER_SEND_METRICS=false`. The initial sandbox invocation could not bind
loopback (`listen EPERM`) and ran no tests; rerunning with authorized local
socket access produced the results above. Suites include deliberate storage,
stream and RPC failure injections and emit corresponding expected diagnostics;
no failed tests or Vitest unhandled-error summary remained. No deployment,
production callback, credential access, issue closure, branch creation, history
rewrite or push was performed.

### 2026-11-10: authenticated local producer-to-native sender regression

The additional Workerd integration in
`test/integration/events-subscriptions.test.ts` drives the **real** OAuth
consent/token exchange, MCP create/join/subscribe/post, committed TableDO
outbox, durable alarm and native `sendVerifiedHttps` HTTP request assembly.
A controlled `fetch` capture verifies the original subscription ID, signature,
opaque callback URL, committed message/event identity, manual redirect policy
and exclusion of private message text. It deliberately loses the first HTTP
response, reconstructs the Durable Object and checks stable event identity and
the persisted retry budget before acceptance. A second genuine MCP post checks
that HTTP 410 becomes terminal and produces no repeat send.

The test-only TableDO instance supplies the reviewed callback-target binding
and overrides its private dispatch readiness predicate; **none of these test
overrides are production settings**. This is an in-process controlled receiver,
not a hosted HTTPS receiver, a network connection-time DNS/TLS/forbidden-IP
test, or #19 REQ-002/006 evidence. It narrows #21/REQ-010's disconnected
producer/consumer gap but does **not** satisfy its complete crash, revocation,
rotation and real-host campaign. Production Events readiness remains disabled;
do not merge or close #21 on this regression alone.

### 2026-11-11: persistent retry-budget and cancellation regressions

The authenticated Workerd producer-to-native-sender test now covers both HTTP
410 and 413 terminal responses from a controlled fetch receiver: each new
MCP-committed peer event is independently signed, captured, charged once and
left terminal across a Durable Object eviction, with no repeat outbound call.

A second producer-to-alarm scenario returns HTTP 503 with Retry-After for
eight consecutive captured delivery attempts, evicting the Durable Object
between attempts. It checks that all eight requests reuse the exact event ID,
that the original first-attempt timestamp and charged count survive each
reconstruction, that the eighth attempt terminalizes the SQL row and that a
ninth alarm sends nothing. The fixture changes only persisted scheduling due
times to exercise the complete bounded retry budget without real-time waiting;
it does not simulate eight hours of operation or prove network delivery.

An independent OAuth-authenticated post/subscribe/unsubscribe regression
reserves a real SQLite attempt lease, commits an actual MCP unsubscribe, then
applies an intentionally stale receiver-success verdict using the production
lease settlement function. The stale result cannot resurrect cancelled work,
including after DO eviction. This is a deterministic serialized lease race,
not simultaneous external HTTP acceptance and unsubscribe: the native Workerd
test harness rejects concurrent cross-Durable-Object I/O in that synthetic
construction. A supported external receiver/barrier harness remains needed for
a full in-flight HTTP race and the remaining REQ-010 matrix. The public Events
transport gate remains fail-closed and the tests do not establish #19 DNS/IP/TLS
connection-time policy or actual autonomous host execution.

### 2026-11-11: native alarm after committed authority termination

An additional authenticated producer regression exercises two distinct
post-commit boundaries: the intended callback recipient's **real GuestDO
connection revocation** and an owner's **real MCP close_table** mutation.
Each case first commits an eligible peer message through MCP, confirms the
original pending durable outbox identity, advances only its scheduling due
time and then makes the terminal decision through the public application
entry point. The actual TableDO alarm is driven with private readiness
overridden only inside the Workerd test; a controlled fetch observer asserts
zero application requests after the termination, cancellation with zero
charged attempts, and unchanged terminal state after Durable Object eviction.

This tests the no-new-send rule for terminal authority *before* an attempt
starts. It does not prove that an already-dispatched external request can be
recalled; concurrent held-HTTP revocation/closure, credential rotation,
receiver-controlled barriers and hosted network evidence remain outside this
regression. The production Events gate stays fail-closed pending #19's
independent transport security evidence.
