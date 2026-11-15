# Relay admission ledger: supported topology and recovery boundary

This module is a production-integration candidate for Issue #74, not a deployed
service or an authorization to create storage, credentials or network exposure.

## Supported topology

`scripts/relay-admission-store.mjs` uses Node 24's built-in SQLite driver and a
dedicated database in an operator-controlled **local filesystem on one host**.
Multiple processes on that host may open the same database. Each admission uses
one `BEGIN IMMEDIATE` transaction to check replay, rolling per-caller/global
rate, active concurrency and record capacity, then persist the lease before
returning permission to send. FULL synchronization and DELETE journaling are
required. Busy/corrupt/unsupported stores fail closed.

This does not support NFS/SMB, multi-host replicas, independent per-container
volumes, asynchronous replication or a load balancer routing to unrelated
databases. Containers must share the exact same verified local database, with
SQLite filesystem locking preserved. A multi-host deployment needs a different
atomic shared store and its own correctness/operations review.

The database is bound to the explicitly configured environment (`production`
or `test`), service ID and numerical policy. A future schema, foreign database,
different environment/service or policy mismatch prevents opening; no automatic
configuration migration or reset occurs. Changing policy requires a separately
reviewed migration with preserved replay/leases, not deletion/recreation.

The directory is a trusted operator boundary. An already observable symlink or
nonregular database target is refused, but a hostile concurrent directory
replacement cannot be made safe by this pathname API. Provisioning must exclude
untrusted writes and preserve the database/journal together. The code neither
changes existing filesystem permissions nor generates deployment credentials.

## Data and limits

Only SHA-256 hashes of caller/request IDs, lease IDs, timestamps and state are
stored. No callback URLs, signatures, message bodies, TLS material or credentials
are stored or logged. Hashes are pseudonymous operational identifiers, not a
promise of anonymity against known-ID guessing.

Finished records remain until **both** their replay acceptance horizon and the
60-second rolling rate window have elapsed. Capacity exhaustion refuses new
work instead of evicting a live replay record. Duplicate requests do not create
another lease or consume another delivery attempt. A completed request's identity
cannot be reused while it remains inside the acceptance horizon.

A backwards wall-clock observation refuses mutations and does not perform
cleanup. Production still needs a trusted clock and must stop dispatch on severe
clock anomalies. The store never interprets an elapsed lease as proof that a
transport stopped.

## Transport completion and crash handling

The caller must not start outbound I/O before `acquire` succeeds. It owns the
returned lease ID and must call `finish` only after the corresponding transport
is known complete or confirmed stopped. Do not release a lease merely because
an HTTP client disconnected, an application promise timed out, or a process
heartbeat disappeared. An unknown network outcome must not be retried under a
new request identity.

Expired but unfinished leases remain active and count against global concurrency,
including after process restart or clock advancement. `listUncertainLeases`
returns bounded safe metadata for operator investigation, not permission to
discard it. A confirmed old process termination can support a separately
authorized reconciliation; this change supplies no automatic release/reset CLI.
Availability may remain blocked rather than risking overlapping external sends.

A stale completion uses the old unique autoincrement lease ID and cannot finish
a later generation, even after the original replay row has legitimately aged
out. Request-body changes using an existing ID are still duplicates; this ledger
does not infer semantic equivalence.

## Backup, restore and deployment approval

Restoring an older snapshot can erase knowledge of already-used request IDs and
live attempts. Never expose a restored ledger as ready solely because SQLite
opens. Keep intake/dispatch paused until independent replay/attempt authority is
reconciled, or a separately approved fresh service/caller epoch ensures old
signed requests cannot be accepted. An ordinary restart retaining the same
database is not a historical restore.

Before use, approve exact host/filesystem/database path, process topology,
environment/service ID, key ownership, retention, rate/concurrency policy,
monitoring, rollback and uncertain-operation recovery. Production and test must
use separate independently identified ledgers. No production configuration or
existing data was modified during implementation.

## Executed tests and limits

`node --test scripts/relay-admission-store.test.mjs` passes nine tests:
reopen replay; environment/service/config binding; two-connection rate/concurrency and independent per-caller limits;
crash-like close/reopen retaining expired active leases; backwards-clock refusal;
stale-finish fencing; foreign/future/busy failures; record capacity; and actual
eight-process contention for one duplicate identity and for a global cap of two.

These tests use fresh temporary SQLite databases and synthetic IDs. They are not
hosted filesystem/power-loss/fsync certification, operator recovery acceptance,
multi-host validation or permission to deploy. No external network traffic,
private payloads or live credentials are used.
