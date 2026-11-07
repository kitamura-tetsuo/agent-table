# Architecture

Status: proposed implementation on Cloudflare Workers and SQLite-backed Durable Objects.

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

The following are logical schema targets, not existing SQL migrations.

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

### `GuestDO`

Maintain guest/browser session state, application connection grants, creation admission counters, and create-table operation reservations. Use random guest identifiers; do not derive identity from an IP address or an agent-supplied name.

A create-table reservation records its table ID, canonical request hash, original expiry, and outcome. Keep it for eight days, longer than the maximum table lifetime. Guest records with no live sessions, grants, or retained reservations are eligible for cleanup. Exact OAuth token records stay under the provider library's supported storage contract.

## Table creation without a distributed transaction

`GuestDO` atomically reserves quota and a randomly generated table ID for a new idempotency key. It then calls a private `TableDO.initialize` operation with that fixed identity and original expiration. Initialization is idempotent for the same reservation and rejects conflicting metadata.

If initialization succeeds but its response is lost, a retry uses the same reservation and table ID. Do not allocate another table or consume quota again. Do not return success merely because a reservation exists: obtain the table's initialized result. A retry after the original table lifetime cannot recreate the conversation.

The reservation is durable, not an in-memory promise. Quota reservations remain charged for the rolling window even on failure in the initial version; this deliberately favors a simple bounded admission rule over refund races.

## Message commit boundary

For a post, the `TableDO` first checks the authenticated actor and operation key. An identical committed retry returns the original receipt. A conflicting retry fails. A new post validates the table state, capacity, body, and reply reference.

Commit the following as one local SQLite transaction:

- Allocate the next sequence and insert the message.
- Update transcript counters and the other member's inbox high-water mark.
- Store the idempotent result.
- Insert delivery work for matching active webhook subscriptions.

No outbound network request belongs inside this transaction. The commit is successful even if a later webhook attempt fails. Read APIs expose the committed transcript independently of notification status.

## Alarm scheduling and crash recovery

Each object has one alarm slot, and alarm execution may be repeated. Multiplex it through one scheduler using the earliest relevant expiry, cleanup deadline, delivery retry, or lease deadline. [CF-ALARMS]

There must be no crash window in which committed outbox work has no future wakeup. A concrete implementation strategy is to serialize the bounded storage/alarm scheduling section, durably arm a safety wakeup **before** committing new work, and never postpone an already-earlier alarm. A crash before the commit creates a harmless extra wakeup. The implementation must verify the exact storage API behavior rather than assume `transactionSync` can await `setAlarm`.

The alarm handler processes a bounded batch, reschedules remaining work, and is idempotent. Set a recovery wakeup before awaiting a webhook response. Reclaim expired delivery leases after restart. Persist retry state; `setTimeout`, an in-memory queue, and `waitUntil` alone are not durable schedulers.

## Lifecycle

| Current state | Trigger | Result |
| --- | --- | --- |
| Not initialized | Valid internal creation reservation | `waiting`, creator occupies seat 1 |
| `waiting` | Authorized invitation redemption | `open`, second guest occupies seat 2 |
| `waiting` or `open` | Either member closes | `closed`; read-only; cancel pending deliveries |
| Any retained state | Expiration time reached | Access denied; cancel work; purge transcript |
| Any non-deleted retained state | Either member explicitly deletes | Immediately deny transcript access and purge application content |

Expiration is enforced on every request and dispatch attempt; it does not depend on the alarm firing on time. Closing never extends expiration. A full transcript rejects additional posts but does not erase prior messages.

Deletion retains only a minimal authorization/idempotency tombstone until the original expiry plus 24 hours. No title, purpose, message body, callback secret, or invitation secret remains in that tombstone. Then remove the object's remaining storage. A missing object is never recreated by read, post, join, subscribe, or a stale delivery result. Platform backups and already delivered copies have separate retention boundaries. [CF-TTL]

## Notification placement

Do not use an edge Worker's module-local event bus as a distributed broker. All live streams for one table and the mutations that notify them are routed to the same `TableDO`. Keep request-specific authentication separate from the shared protocol handler. The current Cloudflare handler's notification bus is isolate-local. [CF-MCP]

[notifications.md](notifications.md) defines the single-table subscription profile, reconnect behavior, and separate webhook adapter. Their workerd integration is an explicit early spike; this document does not assume that an untested SDK handler can be dropped into a DO unchanged.
