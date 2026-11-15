# Relay TableDO integration checkpoint (#21 / #74)

This checkpoint does not enable production Events. `relayOutboxTransport()` returns
null; no configuration, key or relay endpoint is provisioned. Production readiness
remains false. Tests replace a private in-object seam, not a public RPC or binding.
Callback challenge activation is not implemented by this delivery checkpoint.

## Durable delivery

The existing TableDO alarm and fresh GuestDO authorization remain authoritative.
The relay path persists a distinct request ID, exact semantic digest, subscription
incarnation/generation, event ID, original ordinal/lease/budget and original signed
timestamp before I/O. Acceptance expiry is exactly timestamp + 60,000 ms, the
current authenticated wire window; a shorter remote deadline is not implied.
The same attempt is never re-forwarded with a new timestamp or extended expiry.

This is the existing #21 at-least-once contract, not exactly-once delivery. An
uncertain original attempt remains immutable evidence. After its recovery deadline,
readback uses that exact request/digest. If still unknown/unavailable, a separate
charged ordinal may retry the same event ID through existing bounded backoff,
maximum eight attempts and original one-hour/authority validity limits. Such a
retry may repeat receiver delivery. Nothing appends another transcript message.

Immutable local completed receipts take precedence over unavailable remote reads.
A recovery-only conditional transition may classify a late definitive receipt only
while the original outbox lease/generation/incarnation remains current and fresh
authority is available. It does not make the old execution lease live. Refresh,
cancellation, terminal state and deletion fence old completion; no upsert occurs.
Operational key/authority unavailability retains an existing relay lease and sets
a bounded reconciliation wakeup instead of erasing its result evidence.

Known Retry-After is measured from its original observation, never from readback.
Observed absent advice uses existing default backoff. Legacy unknown advice is
not called absent: transient HTTP results conservatively wait the existing maximum
15 minutes, still bounded by original retry horizon and validity. A conflict on
readback pauses that exact attempt with a bounded wakeup; expiry still terminates.

## Storage, deletion and recovery

Schema 13 adds metadata-only attempt receipts and a reconciliation deadline to the
outbox. It stores no callback URL, payload, signature, secret or response body.
Purge deletes relay metadata with the table. Recovery inventory includes the exact
new columns and two immutable-evidence triggers. The catalog hash binds complete
DDL; only those explicitly owned trigger names are allowed after the hash matches.
Missing, changed or foreign triggers fail recovery without erasing retained rows.

New current recovery certificates/journal writes require schema 13. Historical
schema-12 journal entries remain readable with their original digest. Transition
to schema 13 uses a new operation/generation, not a rewritten old signed record.
Fixed historical hosted clearance fixtures remain historical schema 12; they are
not presented as current schema-13 deployment evidence. Fresh schema-13 deployment
certificates and any migration approval are separate operator work.

## Evidence limits

Workerd tests exercise actual TableDO SQL, alarms, reconstruction and GuestDO grants,
with injected relay outcomes and synthetic subscribed/message rows. They cover
identity-before-forwarding, unknown reconstruction/new ordinal, eight-attempt cap,
original Retry-After clock, generation fencing, deletion, authority loss and local
receipt recovery after temporary decryption failure. These are not actual hosted
TLS/receiver observations or a complete authenticated subscribe/post acceptance.
The production profile, live signing key selection, challenge activation and hosted
receiver acceptance require subsequent independently reviewed integration.
