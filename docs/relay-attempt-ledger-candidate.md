# Immutable relay-attempt ledger candidate

Base: 042ff24. This change is deliberately not wired to any runtime profile,
outbox sender, alarm, restore workflow or registered schema migration. It does
not enable public Events, install keys, send requests or deploy anything.

## Ownership and boundary

The authoritative producer remains TableDO's existing SQL outbox reservation.
The integrator must copy its event, subscription, generation, attempt ordinal,
first-attempt time, token and deadline from committed SQL, not network input.
This module stores an immutable identity plus the original relay timestamp,
acceptance expiry, audience/caller and canonical operation digest. It stores
no callback URL, content, credential, signature or challenge response.

The producer must set acceptanceExpiresAt to exactly issuedAt + 60,000 ms,
matching the current signed relay wire's timestamp-derived acceptance window.
A shorter local value is not an authenticated shorter remote acceptance window
and is rejected, as is a longer value. Supporting a shorter remote deadline
requires a separately reviewed signed-wire change and matching consumers; this
candidate does not imply that such a deadline is authenticated. The execution
lease remains a distinct local boundary, not a replacement for wire acceptance.

Mutations run inside the caller's TableDO transaction. There are no awaits or
network calls in the state machine. SQLite constraints and triggers fence
identity rewrites and committed-result rewrites. SQL errors fail the caller;
callers must not interpret an exception as permission to send.

The migration is schema/candidates/013_relay_attempt_ledger.ts, NOT included in
schema/migrations.ts. Current deployed schema remains 12. The final version
must be reassigned if another migration lands first. Registering it requires
Workerd migration/retained-state tests and lifecycle erasure/recovery wiring.

## State and finite resume conditions

prepareRelayAttempt is identity-idempotent, not a send authorization. Repeating
it after expiry cannot extend the original operation. markRelayDispatched is
one-shot and must persist before I/O. A crash afterwards remains dispatched or
unknown and can never be dispatched again, even after lease or replay expiry.
An unresolved predecessor blocks any new attempt for that event, including a
new subscription generation. There is no automatic pruning or reset API.

Only an authenticated exact-operation definitive receipt can complete an
unknown attempt. Pending, missing, pruned or unavailable readback cannot.
A no-send receipt requires positive proof from the sender; deadline or exception
alone is not proof. Completion is immutable. An attempt never marked dispatched
cannot accept an HTTP completion even after being marked unknown.

readRelayDisposition returns evidence only for the exact still-in-flight
outbox tuple, including generation, ordinal, token and first-attempt budget.
A refreshed generation, accepted/cancelled target or superseding lease cannot
consume an old receipt. Evidence received after the execution lease expires is
explicitly flagged; it is NOT a fresh execution lease. After the original
one-hour retry horizon it cannot be applied through this API. Unknown records
remain unknown and retained even then; no time threshold turns them into no-send.

A definitive HTTP result may let an integrator use the existing bounded retry
rules: max 8 attempts, unchanged first-attempt time, one-hour horizon, existing
backoff and fresh grant/lifecycle/generation checks. This module does not classify
HTTP statuses or create new retries; nor does prepare by itself authorize them.
Persisted unknowns require new authoritative evidence or an explicitly reviewed
operator decision, not automatic expiry-based reset.

## Tests and integration still needed

Node built-in SQLite tests cover immutable identity/digest/timestamp/expiry,
one-shot dispatch, unknown retention and successor blocking, exact receipt
resolution, old-generation/current-state fencing, immutable outcomes, budget
preservation, retained close/reopen, and transaction rollback. These are actual
SQLite tests but not Workerd/Cloudflare deployment acceptance.

Before production connection, add real TableDO source joins, atomic pre-I/O
reservation, authenticated relay readback, fresh-authority reconciliation,
refresh races, close/delete cleanup, restore quarantine/future-schema tests,
expired-unknown diagnostics and bounded reconciliation scheduling. Do not
weaken existing settleOutboxAttempt lease checks to consume late receipts.
A separate exact-receipt reconciliation transaction is required.

Retry-After persistence and safe normalization are not invented here. Existing
429/5xx retry behavior must not be weakened when integration supplies those
fields. Challenge response recovery is separate from status-only delivery
receipts; no callback-control success can be inferred from a 2xx status alone.
