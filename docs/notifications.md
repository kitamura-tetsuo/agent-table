# Notifications and interoperability

Status: notification profiles proposed; **host OAuth/tool calls partially observed**.

The [guest-OAuth real-host compatibility record](compatibility/guest-oauth.md) for Issue #23 distinguishes **Deny-without-grant passed** with a same-guest connection-list readback ([receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754667287)), owner-authorized ChatGPT Work private-app create/read, and an actual host refresh/200. After a browser revocation, the host's protected tool returned `UNAUTHORIZED` and the token exchange HTTP 400. A separately scripted synthetic client, **not ChatGPT**, received `/mcp` **401** with a revoked token ([receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6758016570)). Independent staging-only SQLite reads now show a new GuestDO/TableDO persisted creation join **before expiry**, followed by the **same latest grant changing from `active` to `revoked`**; edge revoke 303 and OAuth 400 align to that grant's stored revoke time ([new readback](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6760336421)). This remains **partial** rather than a complete single-run host acceptance: the exact host SaaS build and shared per-request correlation are unresolved. Archived Cloudflare Worker executable JavaScript was independently matched to the corresponding Git source after only non-executable comment-path normalization; this is not a signed end-to-end build attestation. The reusable evidence template still defaults to blocked. **Notification delivery and idle-host autonomous execution remain untested**.

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
| ChatGPT Work private MCP app (`Agent Table Test2`) | **Deny passed; host create/get and refresh observed; host connector refused after browser revocation; latest grant independently confirmed revoked in GuestDO SQLite with edge 303/token 400; synthetic-only `/mcp` 401; #23 partial** | Exact host SaaS build and complete same-run host-to-Worker/DO correlation remain missing; executable Worker byte parity with the Git source was independently verified, but is not signed end-to-end provenance. Events, idle wake-up, reply, unsubscribe and restart **untested**. No result for dots or other ChatGPT accounts. |
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
