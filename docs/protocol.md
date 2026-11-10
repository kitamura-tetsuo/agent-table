# MCP and application contract

Status: partially implemented. The MCP 2026-07-28 `/mcp` transport, browser-consented OAuth authentication, connection grants, private TableDO initialization/metadata guards, public table/transcript tools, and authorized private-resource reads exist. Single-inbox resource-update subscriptions are implemented behind a default-off flag and locally verified; outbound webhook delivery, staged subscription cost evidence, and autonomous host execution are not implemented.

## Transport profile

The scaffold exposes `/mcp` under its configured `PUBLIC_ORIGIN` with a fresh server per request and modern-only discovery through the pinned SDK v2/Cloudflare handler. Local development uses HTTP; no public HTTPS origin has been deployed. Legacy requests are explicitly rejected. Future application releases must retain this canonical path without a user, table, or credential in its URL. The SDK owns protocol envelopes, version checks, and transport errors. [MCP-SPEC]

The first compatibility test uses the official SDK client. An older Streamable HTTP profile may be enabled only after the same authorization and application tests pass through it. Supporting an older tools-only profile does not imply support for legacy resource subscriptions or MCP Events.

Public OAuth discovery and static assets are separate routes. All table operations, private resources, and event subscriptions require authorization. Unsupported features must be omitted from capabilities rather than implemented as success-shaped no-ops.

## Common conventions

All requests use strict JSON schemas with unknown application properties rejected. IDs are opaque, bounded strings; possession of a table, membership, message, or subscription ID grants no access. The service supplies timestamps as UTC RFC 3339 strings. Sequences are nonnegative integers.

Every mutating application tool requires a caller-generated `request_id`, 16–128 ASCII letters, digits, underscores, or hyphens. Its scope is `(authenticated guest, operation name, request_id)` within the relevant table, or within `GuestDO` for table creation. Clients must reuse the same key and arguments when retrying an uncertain result.

Canonical request hashing sorts object keys and preserves message text exactly. Reuse with changed arguments returns `IDEMPOTENCY_CONFLICT`. Authenticate and authorize before looking up a receipt, so a known key cannot reveal another person's result.

## Tools

| Tool | Inputs in addition to `request_id` for mutations | Result / effects |
| --- | --- | --- |
| `create_table` | `title`, optional `purpose`, optional `ttl_seconds` | Creates a waiting table, creator membership, expiry, and own inbox URI |
| `create_invite` | `table_id` | Issues one single-use invite; a new request intentionally replaces a previous unused invite |
| `join_table` | `invitation` | Claims the second seat for the authenticated guest and returns table metadata |
| `get_table` | `table_id`; no request ID | Returns authorized metadata, membership IDs, effective limits, and own notification status |
| `read_messages` | `table_id`, optional `after_seq`, `limit`, `through_seq`; no request ID | Returns a bounded ordered transcript page |
| `post_message` | `table_id`, `body`, optional `reply_to_message_id` | Commits exactly one message per operation key and returns its receipt |
| `close_table` | `table_id` | Makes the shared table read-only and cancels future notification work |
| `delete_table` | `table_id` | Requests browser-confirmed shared deletion; reports the receipt after confirmation |

`create_table`, `create_invite`, `join_table`, and `get_table` are registered at the authenticated MCP endpoint. The remaining close/delete tools above specify future contracts and are **not** advertised as available capabilities.

Scopes and destructive-action confirmation are defined in [security.md](security.md). The creator alone issues invitations; either member may read, post, close, or request deletion subject to state, limits, and scope. No operation accepts a caller-selected sender identity.

`create_table` does not silently create an invitation. An invite result contains the table ID, invite ID, expiry, and an invitation string suitable for the landing page or `join_table`. Treat that string as a credential. Repeating issuance with the same key returns the same usable invite while it remains valid; after it is consumed, revoked, or expired, return its terminal status without disclosing the old secret. A new key is required for deliberate rotation.

`join_table` accepts a structured opaque invitation encoding the table ID, invite ID, and secret. Validate lengths before routing. Do not implement invitations as arbitrary URLs that the server fetches. Repeating a successful redemption by the same guest is safe; a different guest cannot reuse it. Once occupied, the second seat is not replaceable.

For an undeleted table, `delete_table` returns `confirmation_required: true` and an authenticated management-page URL, not a deletion-success result. Opening that URL does not delete anything. A browser approval POST by the same guest, with CSRF protection and a fresh membership check, performs deletion. The pending request is bound to guest, table, and request ID and expires after five minutes. Repeated tool calls with the same key report the same pending request or its final minimal receipt; an expired pending request requires a fresh key and confirmation. Do not accept a model-supplied Boolean such as `confirmed: true` as human approval. Direct browser deletion uses the same authorization and mutation boundary.

## Transcript semantics

The creator may post while the table is `waiting`; both members may post once it is `open`. Both read the entire shared transcript. Messages cannot be edited or individually deleted in the initial version.

A successful `post_message` result has this application shape:

```json
{
  "table_id": "tbl_example",
  "message_id": "msg_example",
  "seq": 7,
  "sender_membership_id": "mem_example",
  "created_at": "2026-11-07T03:00:00Z",
  "persisted": true
}
```

The server assigns all fields except the request's content. `persisted` is returned only after the message and its operation receipt commit; it does not assert that a peer read the message or that a notification was delivered. An identical retry returns the same message ID, sequence, and timestamp without emitting another event.

Reject empty or whitespace-only bodies and bodies exceeding the configured UTF-8 byte limit. Do not silently truncate. Preserve the original accepted text. A reply reference must identify an existing message in the same table. Reject references to another or missing table without revealing its contents.

Two simultaneous posts get distinct consecutive sequences in commit order, regardless of client timestamps or network arrival order.

## Cursor reads

`after_seq` defaults to zero and means strictly greater than that sequence. `limit` defaults to 50 and is bounded by the configured maximum.

The first page captures the current last committed sequence as `through_seq`. A caller can pass that value on subsequent pages to finish the same bounded snapshot while new messages arrive. Return messages where `after_seq < seq <= through_seq`, ordered ascending.

```json
{
  "messages": [],
  "next_after_seq": 7,
  "through_seq": 7,
  "has_more": false
}
```

`next_after_seq` is the last returned sequence, or the supplied `after_seq` when the page is empty. `has_more` refers only to the selected snapshot. Reject negative, non-integer, reversed, or future snapshot cursors rather than silently skipping data. To inspect later arrivals, start another read without `through_seq` using the last processed sequence.

Reads do not acknowledge events, consume messages, or advance shared server-side cursors. A host tracks its own successfully processed position. Webhook retries and notification reconnects therefore cannot consume unread messages accidentally.

## Private inbox resource

Expose a resource template:

```text
agent-table://tables/{table_id}/inbox/{membership_id}
```

Return the caller's concrete URI from `create_table`, `join_table`, and `get_table`. Only that membership's guest may read or subscribe to it. The other member can read the same transcript through tools but cannot subscribe as this member.

The resource is a small JSON status record: table ID, own membership ID, table state, `last_seq`, `latest_peer_seq`, and expiry. It is not the transcript. Update notifications are emitted for a newly committed peer message, not for the subscriber's own post. Use `read_messages` to retrieve content.

There is no public resource enumeration or table search. Static resource templates can be discoverable; private concrete resource identifiers cannot leak through global lists.

## State-dependent behavior

| Condition | Read | New post / join / invite | Close / delete |
| --- | --- | --- | --- |
| Waiting / open and authorized | Allowed | Allowed when role and operation permit | Close allowed; deletion requires browser confirmation |
| Closed and authorized | Allowed until expiry | Rejected | Idempotent close; browser-confirmed deletion allowed |
| Expired | No transcript access | Rejected | Minimal safe terminal result only |
| Deleted | No transcript access | Rejected | Minimal idempotent result while tombstone exists |
| Unknown table or nonmember | No disclosure | Rejected, except valid invite redemption | No disclosure |

An authorized retry of an already committed post may return its receipt after close, before expiry. It never produces a new post. Deletion and expiry take precedence over returning any result containing deleted content or secrets. Table-scoped receipts last until table cleanup; creation receipts have the separate retention described in [architecture.md](architecture.md).

## Errors

Use MCP's protocol errors for malformed JSON, unsupported methods, and invalid protocol parameters. Missing/invalid access credentials use the transport's authorization challenge. Expected application failures use an MCP tool result with `isError: true` and a structured application error:

```json
{
  "code": "IDEMPOTENCY_CONFLICT",
  "message": "The request ID was already used with different arguments.",
  "retryable": false
}
```

Application codes include `TABLE_NOT_FOUND`, `TABLE_CLOSED`, `TABLE_EXPIRED`, `TABLE_FULL`, `INVITE_INVALID`, `INVITE_EXPIRED`, `CONFIRMATION_EXPIRED`, `IDEMPOTENCY_CONFLICT`, `LIMIT_REACHED`, `RATE_LIMITED`, and `TEMPORARILY_UNAVAILABLE`. Return retry delay metadata for rate limits. Avoid leaking table existence to nonmembers: unknown and unauthorized table access share `TABLE_NOT_FOUND`.

A failed storage operation cannot return `persisted: true`. An uncertain response after a successful commit is retried with the same request ID. Do not advise a new request ID as a generic network-retry strategy.

## Tool metadata

Read tools have read-only annotations. Mutation tools declare their effects honestly; close/delete are destructive to the shared workflow, and posting may cause outbound delivery and another host's run. Idempotency annotations require actual durable deduplication. An annotation does not authorize an action, replace confirmation, or prove a host will run it automatically.

MCP Events methods are protocol methods—not ordinary tools named `events_subscribe`. Their separate adapter and compatibility contract are in [notifications.md](notifications.md).

## Implemented MCP table-tool composition (Issue #9)

The OAuth-protected `/mcp` endpoint registers `create_table` and `get_table`
against the pinned official MCP SDK. Argument schemas are strict, with no
caller-supplied guest or connection identity. `create_table` requires an
active `tables:write` grant and a 16–128-character ASCII `request_id`;
`get_table` requires `tables:read` and a canonical version-4 table ID.
A bearer token and fresh GuestDO scope decision are prerequisites, not table
membership. The table itself rechecks local membership and expiry.

Creation reserves one durable fixed table ID in GuestDO, asks exactly that
TableDO to initialize the waiting state and creator membership, verifies the
committed result's identity and original timestamps, then marks the reservation
as initialized. Uncertain RPC or receipt failures return
`TEMPORARILY_UNAVAILABLE` as an `isError` result; clients **must retry using
the same request ID and unchanged arguments**, even after object eviction.
Changed arguments conflict; expired receipts cannot revive creation.
Creation returns the caller's membership ID, inbox URI, effective limits, and
an explicit unavailable notification status; it never issues an invitation.

`get_table` delegates to TableDO's local member/expiry checks. Unknown and
nonmember IDs both report `TABLE_NOT_FOUND`; no private concrete resources
are advertised globally. The SDK validates strict tool argument schemas before
handlers run and returns a tool-level `isError` for invalid tool arguments;
malformed JSON-RPC transport envelopes are distinct protocol errors. Expected
conflicts, limits, and unavailable dependencies also return structured
application `isError` results. Missing or invalid OAuth credentials receive
the transport challenge. Both tools still revalidate the per-operation
grant inside the Durable Objects.

Runtime checks: `npm run typecheck`, `npm run lint`,
`npm run test:integration`, `npm run test:e2e`.


## Invitation runtime (Issue #10)

TableDO owns one active invitation at a time. Each invitation embeds table and invite UUIDs plus a 256-bit random secret in a bounded, versioned opaque token. Only a SHA-256 digest is stored as redemption authority; the optional same-key issuance retry is recovered from a purpose-bound AES-GCM invitation-response envelope, using an operator-supplied Workers secret keyring. Rotation, consumption, and expiry never disclose an old issuance secret. A new issuance key revokes the prior unused invitation, and TableDO records the revocation in retained SQLite state.

An authorized creator can invoke \`create_invite\` with \`table_id\` and \`request_id\` while the table is waiting and only the creator has a seat. The response includes an \`invitation\` credential and a \`landingUrl\`; the latter encodes the token after \`#\`, not as a query or MCP endpoint. \`GET /join\` only serves static informational HTML; it does not redeem or contact a third party. A guest invokes \`join_table\` with the opaque invitation and their own \`request_id\` after OAuth approval. The single SQL transaction inserts seat 2, consumes the invite, records the operation, and opens the table. A committed winner can retry with the same key (including after a lost response) without creating another membership, but a different claimant cannot replace the winner. The pre-join transcript will be readable once the separate transcript implementation lands.

The invitation-response keyring must be provisioned via a secret binding before invitation issuance. An absent or invalid keyring yields an unavailable error with no invitation written. No publicly hosted deployment or real host compatibility is claimed by this implementation.

## Implemented transcript runtime (Issue #11)

`post_message` and `read_messages` now execute through the authenticated SDK
and SQLite-backed TableDO. Accepted posts persist body/receipt, monotonically
allocated sequence, UTF-8 usage and peer-only inbox watermarks in one local
transaction. The immutable receipt is deduplicated by authenticated guest and
request ID; a retry of the same body and reply returns the committed identity
and timestamp rather than consuming capacity. Conflicting arguments fail.
A reply must refer to a message in this same table. No external call occurs
inside the transaction, and no post success claims webhook or host execution.

The centrally configured limits are 8 KiB per body, 256 accepted messages,
2 MiB aggregate body bytes and 10 successful posts per rolling 60 seconds.
Failures and retries do not advance sequence or counters. Snapshot reads
accept ascending `after_seq` and an optional fixed `through_seq` with pages
up to 100. Reads neither acknowledge events nor change processing cursors.

The table write returns an internal, best-effort `peerUpdateHint` only on a new
committed post with a different current member. The service boundary accepts
an optional synchronous observer that sees only the table ID, committed sequence,
and target peer membership ID after the TableDO transaction returns. Retries,
rollbacks, rejected posts, reads and pre-join self-only posts produce no hint.
Observer failure cannot invalidate a persisted receipt; the public MCP receipt
never contains the internal hint. This transient hook is not durable delivery
or an event outbox and must not be used as proof that an agent was awakened.

The private `agent-table://tables/{tableId}/inbox/{membershipId}` resource
template performs fresh OAuth connection and TableDO membership checks and
returns only the authenticated caller's watermark. Private concrete resource
instances are not globally enumerated. The guarded MCP `subscriptions/listen`
profile supports hints only for the authenticated member's canonical inbox URI
when enabled and freshly authorized. Hint streams are bounded, expire after at
most 60 seconds, and require explicit re-listening and durable cursor reads for
recovery; they do not imply outbound notifications or host wake-up. Future durable outbox integration
must add the corresponding pending notification row *within* the message
transaction instead of treating a post-commit side effect as durable delivery.


## Shared lifecycle and terminal boundaries (Issue #13)

`close_table(table_id, request_id)` is an authenticated destructive MCP tool.
Either participant with an active `tables:write` grant and local membership may
permanently close a waiting/open table. Requests use strict 16–128 ASCII
mutation keys. A repeated close returns the original `closed_at` and
`expires_at` without changing either timestamp or emitting a second
transient terminal hint. Public delete/purge tools do **not** exist.

A closed table is read-only until its immutable original expiry. Previously
committed `post_message` operations may be retried with identical arguments
and return their recorded receipt; conflicting keys remain conflicts. Newly
submitted posts, invitations, and joins are forbidden even if old invitation
material was retained by a client. Server-side expiry checks deny reads and
writes at the exact expiry boundary, independent of the alarm scheduler.

The private TableDO `purgeTable` method is reserved for the later
browser-confirmed deletion flow. It currently has no public route and cannot
be called as a model-provided confirmation. Purge deletes all implemented
message, receipt, membership, invitation/secret-envelope, transcript usage
and metadata rows in a single local transaction. A minimal tombstone retains
the opaque table ID, guest membership authorities, original expiry, terminal
state and cleanup deadline; it holds **no** title, purpose, message body,
invitation token or secret envelope. After original expiry plus 24 hours,
alarm processing removes the tombstone. A retained GuestDO reservation cannot
reinitialize a deleted/expired TableDO; once the tombstone expires, that same
reservation's original lifetime is already over.

The TableDO scheduler atomically arms initial expiry and private purge
deadlines with the associated SQL mutation, restores missing alarms after
reconstruction, and drains one bounded lifecycle action per invocation.
Dispatch consumers must recheck the internal `lifecycleStatus` before
each outbound side effect. The transient close/purge invalidation observer
is **not** a durable event outbox and cannot recall already dispatched bytes.
No public Events, host wakeup, production deployment, backup erasure or
browser deletion-approval success is implied by this lifecycle implementation.

### Browser-confirmed shared deletion (Issue #14 draft)

The authenticated `delete_table(table_id, request_id)` MCP tool requires an active
`tables:delete` connection and current local table membership. It **only**
creates/returns a durable five-minute pending confirmation and a management
link; it does not call the purge primitive. The request key is 16–128 ASCII
letters, digits, underscores or hyphens. Identical retries cannot extend its
original five-minute expiry; an expired or denied key cannot be reopened.

The link is `/guest/delete?table_id=...&request_id=...`. It carries routing
identity only, **not** permission. GET and link previews have no side effects.
A signed-in browser guest must perform an explicit same-origin, CSRF-protected
approval POST. TableDO revalidates the browser session with GuestDO and the
current local membership/expiry before the local SQL transaction. Approval
commits the private purge and a content-free replay receipt in the same
transaction. A failed commit cannot claim deletion. A denied request leaves
content intact, and a second key is needed for a fresh attempt.

The direct browser entry `/guest/delete?table_id=...` first requests
confirmation and then uses the same approval path. A lost browser cookie
cannot be recovered using a model connection, a link or table membership.
After purge, only minimal tombstone membership and successful-delete
idempotency identifiers remain until original expiry +24 hours; no message
body or invitation credential survives in the application table. Previously
delivered copies and provider backups remain outside the deletion guarantee.

This implementation is not deployed or an authority for unconfirmed deletion.
