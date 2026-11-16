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

Only SHA-256 hashes of caller/request IDs, an optional semantic-operation
commitment, lease IDs, timestamps, state and a fixed completion kind / numeric
HTTP status are stored. No callback URLs, signatures, message bodies, TLS material or credentials
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
heartbeat disappeared. An unknown network outcome must not be reissued as the same logical attempt
under a fresh request identity. Separately authorized next-ordinal retry under
#21 retains the original event ID, unknown-attempt evidence, 8-attempt budget
and one-hour horizon; its distinct logical-attempt identity is not a reset.

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

`node --test scripts/relay-admission-store.test.mjs` passes fourteen tests:
reopen replay; environment/service/config binding; two-connection rate/concurrency and independent per-caller limits;
crash-like close/reopen retaining expired active leases; backwards-clock refusal;
stale-finish fencing; foreign/future/busy failures; record capacity; and actual
eight-process contention for one duplicate identity and for a global cap of two;
durable status readback and immutable completion, caller/commitment isolation,
unknown versus no-send, v1 migration, independent-process completion/readback,
and readback fail-closed validation/clock/locking.

These tests use fresh temporary SQLite databases and synthetic IDs. They are not
hosted filesystem/power-loss/fsync certification, operator recovery acceptance,
multi-host validation or permission to deploy. No external network traffic,
private payloads or live credentials are used.

## Schema v2: status-only durable readback

`acquire({callerId, requestId, expiresAt, operationDigest?})` accepts an optional
64-character lowercase SHA-256 semantic commitment. Legacy callers without a
commitment retain admission behavior but cannot recover a known outcome.
Canonical semantic operation bytes must include schema/kind, audience, caller,
destination, headers and payload; exclude re-signable timestamp and signature.
The ingress producer must define a single canonical encoding, calculate it after
authenticating the caller, and reject ambiguity. This module does not hash or
store raw request contents. A hash commitment is not encryption or anonymity.

`finish(leaseId, outcome?)` is called only when transport is completed or proven
stopped. Supported explicit outcomes are `{kind: "http", status: N}` (numeric
HTTP status only) and `{kind: "not-sent"}`. The latter requires positive sender
proof that forwarding did not start, such as rejection before dial; a general
exception, disconnected client or deadline is **not** no-send. Omitting the
outcome records unknown. Completion is immutable: same completion is idempotent;
a conflicting result, including upgrading unknown to no-send, is refused.
Neither a status code nor finish is permission to create a new logical attempt.

`readOutcome({callerId, requestId, operationDigest})` is metadata-only. The ingress
MUST authenticate a separate readback request and bind its audience/service and
caller ID; a caller ID supplied by an HTTP query is not authentication. The
method performs the same atomic/clock/fail-closed checks but does not dispatch,
release a lease, charge a send, or manufacture a new request ID. It returns:

- `pending`: current committed lease remains active before its deadline.
- `unknown`: expired active lease, finished ambiguous operation, missing/pruned
  evidence, or a legacy record without a semantic commitment. **Never no-send.**
- `completed`: exact matching operation's persisted HTTP status or proven no-send.
- `conflict`: same caller/request exists but semantic commitment differs.
- `invalid` / `unavailable`: malformed input, closed/busy/corrupt state or clock
  regression. None authorize a retry.

A different authenticated caller cannot inspect another caller's status. The
API exposes no lease token, URL, response payload, error text or credential.
A completed HTTP status is enough only for consumers whose contract uses that
status. It cannot recover/verify a callback challenge response. Challenge body
storage, encryption, retention and replay remain a separate unimplemented
privacy decision; this change stores no response bytes.

Schema v1 migrates transactionally to v2 by adding nullable commitment/outcome
columns without resetting any admission, rate or uncertain-lease state. Old
finished rows are unknown, not inferred successes. An environment/service/policy
mismatch is rejected before migration. Future/foreign versions remain refused.

Readback retention is bounded by the original replay horizon. Consumers must
persist original attempt identity/commitment/expiry and never extend expiry or
re-sign/re-send old work merely because readback is unknown after pruning.
An authenticated readback endpoint and the Worker durable-attempt integration
are not supplied by this module. Their protocol must enforce the original
acceptance horizon. No status result alone grants retry authority.

## Candidate authenticated HTTP readback (not deployed)

The disconnected ingress/listener now recognizes exactly `POST /relay/v1/status`
with a maximum 1024-byte body. Its signature domain is UTF-8
`POST\n/relay/v1/status\n<CALLER-ID>\n` followed by the original body bytes.
The independent send domain remains `POST\n/relay/v1\n<CALLER-ID>\n`.
Requests have exactly `version:1`, `audience`, `requestId`, `timestamp` and
`operationDigest`. Audience must equal the operator-bound environment/service;
timestamp must be within 60 seconds; caller/key and exact Ed25519 signature are
validated against current trusted configuration, including after async readback.
The signed status request may use a fresh timestamp; it never retransmits a send.

The ingress computes send commitment as lowercase SHA-256 of UTF-8 JSON with
this insertion order (no whitespace): `{version:1,kind:"forward",audience,
callerId,requestId,destination,headers,payload}`. `headers` is recreated from its
entries sorted by ASCII key comparison, preserving exact values; payload is
canonical base64. The envelope timestamp and ingress signature are excluded.
Callback webhook timestamp/signature headers ARE semantic content and remain
included. The Worker must preserve original callback bytes/headers for an
unknown attempt rather than regenerating them. A readback digest cannot grant
fresh delivery authority.

Successful wire responses contain only `{state:"pending"}`, `{state:"unknown"}`
or `{state:"completed",outcome:{kind:"http",status:N}}` / a proven `not-sent`
outcome. No `ok`, lease identifiers or timestamps are returned. Authentication
failure is 401, invalid envelope 400, commitment mismatch 409, rate limit 429,
and unavailable evidence 503. Unknown/missing/pruned records remain unknown.

Operational send pause permits authenticated status reads; service shutdown
blocks both. Removing/rotating a caller key blocks later reads even if the
caller originally sent the operation. Targets/public keys are reloaded from
current operator configuration, not a cached old policy. Listener drain refuses
new HTTP requests. Readback never calls send or acquires/releases send leases.

Status traffic has independent bounded **per-process** per-caller/global rate
limits (default 30/100 per minute), 2-second storage wait, 1KiB body, listener
connection/header/request limits, and fixed output shape. Rate counters are
not durable nor multi-process global. A deployment must bound replica/process
count or add an approved shared read-rate policy; do not advertise these as
shared durable send quotas. The database provides separate atomic send limits.

Only a validated successful response returned by the pinned sender is currently
persisted as an HTTP completion. That sender throws on non-2xx/partial/timeout
results; these remain unknown, never inferred no-send or success. Recovering
known non-2xx statuses requires a typed sender-result contract. Neither this
endpoint nor status-only readback recovers a callback challenge response body.
The Worker/outbox/candidate protocol remains disconnected until full identity,
retry, expiry and body-free challenge reconciliation requirements are met.

Four additional tests cover actual SQLite close/reopen and authenticated reads,
current caller removal/invalid replacement and post-await revocation, send-pause
versus read-disable, domain/audience/digest/freshness failures, read rates without
send reservations, canonical commitments, and actual localhost HTTPS path/body
limits. Temporary test certificates and published RFC8032 fixture keys are not
live credentials. There is no external network transfer or deployment.

## Retry contract clarification

The #21 contract permits at-least-once delivery: accepted response loss may
lead to a separately authorized next-ordinal attempt for the same event ID.
Unknown evidence remains retained, with original attempt ID, budget (8) and
one-hour horizon. The replay prohibition applies to replacing the ID of the
**same logical attempt**, not to that explicitly budgeted subsequent attempt.
Status readback does not itself authorize a retry. Shared active-capacity and
uncertain-process safety limits continue to apply independently.
