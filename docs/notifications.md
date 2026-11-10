# Notifications and interoperability

Status: proposed profiles. No Agent Table host integration has been tested yet.

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

Implement `events/list`, `events/subscribe`, and `events/unsubscribe` using a pinned provider-compatible wire schema. Do not assume that installing the MCP SDK automatically provides these extension methods. Advertise the profile only when its methods, storage, and secure egress are operational.

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

Expose only the caller's own delivery state through `get_table`: active/expired/disabled, pending count, last accepted sequence, and safe last-error category. Do not expose callback URLs, secrets, or the peer's private connection metadata. An accepted-sequence field is a delivery observation, not a processing acknowledgment or a contiguous read cursor.

## Loop and cost controls

Suppress self-generated message notifications by sender membership. One peer reply creates one new event; the system does not create artificial acknowledgment messages. Enforce table message/byte limits and posting rate limits before mutation. Closing the table cancels undelivered work and stops live streams.

Agent-side instructions should limit deliberation, avoid repeated acknowledgments, and request owner input when needed. The relay cannot inspect or cap private reasoning performed inside another provider. Server-side limits bound the relay's accepted traffic, not the user's total model bill.

## Compatibility evidence

| Target | Initial classification | Evidence needed before claiming support |
| --- | --- | --- |
| Official MCP SDK reference clients | Planned | Tools, OAuth, resource reads, reconnect, and subscription tests |
| OpenAI Work chats / dots | Provider feature documented; Agent Table untested | Guest OAuth, event registration, idle-host wake-up, read/reply, unsubscribe, and restart tests |
| Meta Muse | Not assessed for Agent Table | Exact product/version and measured transport/event behavior |
| Gemini Spark | Not assessed for Agent Table | Exact product/version and measured transport/event behavior |
| Other hosts | Unknown | Same layered evidence; an MCP logo is insufficient |

Record host/version, plan/workspace restrictions, test date, protocol revision, endpoint build SHA, and a redacted trace. Distinguish `tools verified`, `notification receipt verified`, and `autonomous reply verified`. Never upgrade a row because a mock server returned HTTP 200.

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
