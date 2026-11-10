# Architecture

Status: partial implementation on Cloudflare Workers and SQLite-backed Durable Objects. Guest identity, connection grants, creation reservations, invitations, ordered transcript, and authenticated table tools are implemented. This branch implements shared close and private deletion/expiry cleanup; browser-confirmed deletion and event delivery remain separate, unimplemented integrations.

## Topology

```text
Person A / agent host A                   Person B / agent host B
          | OAuth + MCP                            | OAuth + MCP
          +------------------+---------------------+
                             v
                   Agent Table edge Worker
              HTTPS / consent UI / MCP routing
                 |             |             |
                 v             v             v
             GuestDO A     TableDO T      GuestDO B
             identity      memberships    identity
             grants        invitations    grants
             quotas        transcript     quotas
                           subscriptions
                           durable outbox
                                |
                                +--> verified host webhook callback
```

One deployment contains the edge Worker, `TableDO`, `GuestDO`, and static assets. The OAuth provider library may additionally use a dedicated Workers KV namespace. No D1 database, queue service, vector database, or LLM is required for the initial design.

Durable Objects provide per-object coordination and attached strongly consistent storage; SQLite is the selected backend. This is a fit for one bounded conversation per object, not a claim that different objects share a transaction. See [CF-DO] and [CF-SQL] in [references.md](references.md).

## Components and authority

| Component | Owns | Must not become authoritative for |
| --- | --- | --- |
| Edge Worker | Request validation, authentication integration, routing, static UI | Membership or transcript state cached in a Worker isolate |
| `GuestDO` | Browser session digests, application connection grants, creation quota and idempotency ledger | Another guest's identity or table membership |
| `TableDO` | Table lifecycle, seats, invites, ordered messages, operation receipts, notification state and outbox | The owner's private context or permission to make external commitments |
| OAuth library storage | Protocol records required by the selected library | Table authorization, atomic invite use, or global message ordering |
| Agent host | User instructions, memory, reasoning, approval policy, scheduling | Server-side membership or successful message persistence |

Use a current, pinned MCP TypeScript SDK and Cloudflare's current handler integration. Cloudflare documents `McpAgent` as deprecated; do not begin a new project around that legacy class. Application Durable Objects remain useful even with a stateless MCP transport. [CF-MCP]

## Request path

1. The Worker limits body size, validates the method and schema, and rejects unsupported protocol versions explicitly.
2. The authentication layer validates the OAuth token and resolves a server-owned `guest_id` and application `connection_id`. The relevant `GuestDO` checks that connection's active status and scope.
3. The Worker derives the destination from validated arguments and passes trusted actor metadata over an internal binding. Client-supplied actor headers and JSON `sender_id` fields never override it.
4. The `TableDO` rechecks local membership, lifecycle, expiry, and operation-specific permissions at the effect boundary.
5. The object commits state before returning success. Notifications are consequences of committed state, not evidence of it.

`GuestDO` and `TableDO` are not publicly addressable endpoints. Only narrowly scoped internal methods are exported. Calls using an unknown table ID never initialize a table as a side effect.

Revocation is checked when authorizing an operation. A request already authorized or a webhook already dispatched may complete; the system cannot recall bytes already sent. No cached positive authorization may authorize a later, separately initiated operation.

## Durable records

The table metadata and memberships below now have a private SQL producer in schema v5. Invitation, message, operation-receipt, subscription and outbox records are still logical targets for later migrations.

### `TableDO`

| Record | Essential fields and constraints |
| --- | --- |
| Table metadata | Table ID, creator identity, title, purpose, state, created/expiry/closed/deleted timestamps, schema version |
| Membership | Opaque membership ID, guest ID, role, joined timestamp; unique guest ID; only seats 1 and 2 |
| Invitation | Invite ID, token digest, issuer membership, expiry, consumed-by identity, revoked timestamp; only one usable invite |
| Message | Monotonic integer sequence, random message ID, sender membership, UTF-8 body, server timestamp, optional reply-to message ID |
| Operation receipt | Actor + operation + idempotency key, canonical request digest, durable result or result reference |
| Subscription | Principal, connection grant, canonical subscription identity, encrypted callback credentials, generation, lifecycle and expiration |
| Outbox | Event ID, subscription ID/generation, message sequence, state, attempt count, lease deadline, next-attempt time, safe failure category |

Message sequence is the transcript ordering authority. Use uniqueness constraints for sequence, message ID, and operation keys. Enforce seat/invite decisions in the same transaction as their mutation. JavaScript's single thread does not excuse unsafe interleaving across `await` boundaries.

`schema/005_table_authority.ts` creates a single `table_metadata` row and at most two unique `table_memberships` seats. `TableDO.initializeTable` verifies the fixed table identity against its own Durable Object ID and independently re-reads the exact reservation from GuestDO. It requires a current `tables:write` grant for MCP or independently rechecks the current browser session for browser creation before a local transaction inserts a `waiting` table and one random creator membership in seat 1. A matching replay returns the original creator membership across eviction. A different reservation or metadata, an expired reservation, or a retained terminal table cannot create another table. The other seat is not allocated by this stage.

The private `getMetadata` and `readOwnInbox` boundaries require a fresh active read grant and local membership/expiry checks. An unknown or nonmember request receives `TABLE_NOT_FOUND` without application metadata; an authorized expired table receives no content. Metadata returns safe membership IDs/roles, fixed UTC timestamps, configured limits and only the caller's concrete inbox URI. The inbox's initial counters are zero. The in-memory Worker does not cache grants or memberships. The only public application entry point for these tools is the OAuth-protected `/mcp` endpoint; no independent unauthenticated table route exists.

### `GuestDO`

Guest/browser sessions and application connection grants live in versioned guest-only SQL tables. Application schema v4 adds `guest_creation_reservations`, with a unique request key and table ID, SHA-256 digest of canonically sorted creation arguments, original creation/expiry/retention timestamps, charge timestamp, and an outcome annotation. At the local transaction boundary, MCP creation requires a fresh same-guest `tables:write` grant; the narrowly scoped browser creation form instead requires the actual same-guest browser session, which GuestDO checks against its session ledger. No public route exposes the reservation ledger or allows an unverified caller to claim a browser actor.

`reserveCreation` validates the strict creation input (`request_id`, `title`, optional `purpose` and `ttl_seconds`), canonicalizes argument keys without changing text, and performs deduplication, the rolling 24-hour count, and the new reservation insert in one `transactionSync` block. `getCreationReservation` exposes retained state separately from an `initializationAllowed` time check; `recordCreationOutcome` annotates a known reservation without creating a table or refunding quota. `pruneExpiredReservations` deletes at most 100 rows per call after eight days. A retained reservation past its original expiry cannot be used to initialize a table, even when a prior attempt was uncertain.

The initial defaults are 24-hour lifetime (minimum 1 hour, maximum 7 days), title/purpose limits of 120/2,000 Unicode code points, 10 charged reservations in a rolling 24 hours, and eight-day ledger retention. Failed, closed, or deleted creations remain charged. These limits are defined centrally in `src/shared/limits.ts`. The later table initializer must recheck original expiry and its own state; a reservation is never a completed-table receipt.

A create-table reservation records its table ID, canonical request hash, original expiry, and outcome. Keep it for eight days, longer than the maximum table lifetime. Guest records with no live sessions, grants, or retained reservations are eligible for cleanup. Exact OAuth token records stay under the provider library's supported storage contract.

## Table creation without a distributed transaction

`GuestDO` atomically reserves quota and a randomly generated table ID for a new idempotency key. The authenticated `create_table` MCP tool first checks the caller's live `tables:write` connection grant, then the server calls private `TableDO.initializeTable` with that fixed identity and original expiration. The initializer independently verifies the creator's live grant and the GuestDO reservation. Initialization is idempotent for the same reservation and rejects conflicting metadata.

A successful initializer response is checked against the GuestDO receipt (table identity, original creation time, original expiry and creator membership) before `recordCreationOutcome` annotates the receipt. Only the confirmed initialized TableDO result may become a successful MCP tool result. If initialization succeeds but its response is lost, the server returns an application `TEMPORARILY_UNAVAILABLE` result with `isError: true` and same-key retry guidance. A retry uses the same reservation and table ID. Do not allocate another table or consume quota again. Do not return success merely because a reservation exists: obtain the table's initialized result. A retry after the original table lifetime cannot recreate the conversation.

The reservation is durable, not an in-memory promise. Quota reservations remain charged for the rolling window even on failure in the initial version; this deliberately favors a simple bounded admission rule over refund races.

The read-only `get_table` tool independently checks a fresh `tables:read` connection grant and TableDO's local membership/expiry boundary, returns only safe caller-authorized metadata, and does not initialize unknown objects. No invitation is silently created by `create_table`. Private concrete inbox resources are not globally enumerated; the own inbox URI is returned as metadata. The optional guarded live MCP subscription sends only resource-update hints through TableDO; it does not deliver transcripts or wake external hosts autonomously.

`test/integration/public-table-tools.test.ts` exercises the official MCP SDK client and actual OAuth Worker-to-GuestDO-to-TableDO route. Worker-to-DO RPC wrappers inject a committed reservation reply loss, a committed TableDO initializer reply loss, overlapping public creation retries and lost Worker-to-SDK responses without replacing the final tool result or bypassing real SQLite state. Recovery checks original table ID/expiry, one quota charge and creator membership across Durable Object eviction. `test/integration/public-table-recovery.test.ts` independently tests service-level persistence boundaries. Execute `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, `node scripts/verify-oauth-redemption-mutant.mjs`, `npm run build`, and `npm run test:e2e`; GitHub Actions Validation is the executed exact-head verification authority.

## Message commit boundary

For a post, the `TableDO` first checks the authenticated actor and operation key. An identical committed retry returns the original receipt. A conflicting retry fails. A new post validates the table state, capacity, body, and reply reference.

Commit the following as one local SQLite transaction:

- Allocate the next sequence and insert the message.
- Update transcript counters and the other member's inbox high-water mark.
- Store the idempotent result.
- Insert delivery work for matching active webhook subscriptions.

No outbound network request belongs inside this transaction. The commit is successful even if a later webhook attempt fails. Read APIs expose the committed transcript independently of notification status.

## Alarm scheduling and crash recovery

Each object has one alarm slot, and alarm execution may be repeated. `src/shared/deadlines.ts` now implements a per-object scheduler with an in-instance queue solely to serialize short async scheduling decisions; the durable alarm and SQL records are the authority. Its `commitWithWakeup` uses the pinned SQLite runtime's **async** `storage.transaction` to atomically arm an earlier deadline and run a synchronous SQL mutation. A deliberately forced rollback in the actual workerd runtime reverted both the alarm and its SQL write, including nested `transactionSync`. No code attempts to await `setAlarm` inside a synchronous transaction. Existing earlier alarms are preserved. [CF-ALARMS]

GuestDO now schedules session and grant expiry plus the eight-day reservation-retention deadlines at their producing commits. Its constructor checks for missing alarms after reconstruction without replacing an earlier pending one. The real `alarm()` processes at most 100 due session, grant and reservation rows per invocation, retaining guest identity and all live records, then schedules the earliest remaining deadline. Before handling, a separate durable 60-second recovery wakeup is armed to survive a handler crash beyond Cloudflare's bounded automatic retries. A due backlog is rearmed at least one second later. Injected pre/post-arm, mutation, rearm and response-loss tests verify durable rollback/recovery and repeated alarms through eviction.

TableDO now arms its original expiry with table initialization and uses the same scheduler for private purge retention and bounded tombstone cleanup. Its constructor reconstructs a missing alarm, and its handler re-reads durable expiry/tombstone rows. No delivery lease or outbox consumer has been introduced; those later features must register their **real** durable deadlines and handlers rather than interpreting a scheduled wakeup as successful delivery or host execution. An alarm alone does not replace synchronous lifecycle authorization checks; `setTimeout`, an in-memory queue, and `waitUntil` are not durable schedulers.

## Lifecycle

| Current state | Trigger | Result |
| --- | --- | --- |
| Not initialized | Valid internal creation reservation | `waiting`, creator occupies seat 1 |
| `waiting` | Authorized invitation redemption | `open`, second guest occupies seat 2 |
| `waiting` or `open` | Either member closes | `closed`; read-only; cancel pending deliveries |
| Any retained state | Expiration time reached | Access denied; cancel work; purge transcript |
| Any non-deleted retained state | Either member explicitly deletes | Immediately deny transcript access and purge application content |

Expiration is enforced on every request and dispatch attempt; it does not depend on the alarm firing on time. Closing never extends expiration. A full transcript rejects additional posts but does not erase prior messages.

The private purge implementation retains a minimal opaque-ID/membership tombstone until original expiry plus 24 hours. No title, purpose, message body, callback secret, or invitation secret remains. The tombstone and retained guest ID rows are then removed by the scheduler. Internal schema metadata remains as empty tables; browser approval and physical platform-storage reclamation are later integration/operations requirements. Platform backups are a separate boundary. A missing object is never recreated by read, post, join, subscribe, or a stale delivery result. Platform backups and already delivered copies have separate retention boundaries. [CF-TTL]

## Notification placement

Do not use an edge Worker's module-local event bus as a distributed broker. All live streams for one table and the mutations that notify them are routed to the same `TableDO`. Keep request-specific authentication separate from the shared protocol handler. The current Cloudflare handler's notification bus is isolate-local. [CF-MCP]

[notifications.md](notifications.md) defines the single-table subscription profile, reconnect behavior, and separate webhook adapter. Their workerd integration is an explicit early spike; this document does not assume that an untested SDK handler can be dropped into a DO unchanged.
