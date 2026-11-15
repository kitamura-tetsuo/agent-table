# Unconnected result-only verification relay (schema 4, #74)

## Wire contract and authority

POST /relay/v1/challenge signs exactly `POST\n/relay/v1/challenge\n<CALLER>\n`
plus raw JSON envelope. The envelope requires `kind:"challenge"`. Its semantic
SHA256 commitment also uses kind challenge; forward/message signatures or
commitments cannot authorize or substitute this operation. Current caller key,
audience, reviewed target, request freshness, paused state and durable admission
are rechecked before any callback. No request caller supplies a success Boolean.
The verifier extracts the expected UUID only from the signed verification
payload and applies the original shared challenge predicate to actual bounded
2xx response bytes. Invalid/non-2xx/network outcomes remain unknown.

Only `{kind:"challenge",verification:"verified"|"failed"}` is retained.
Neither raw response, expected UUID, URL, headers, keys nor payload is persisted.
A completion response is returned only after atomic store finish reports success;
write-result failure stays unavailable and is not blindly repeated. An unknown
operation is reconciled by its original authenticated requestID and commitment.

The authenticated status endpoint returns the same exact two-field outcome under
`{state:"completed",outcome}`. It never exposes the local lease ID. HTTP2xx status
metadata, not-sent, missing/pruned records and another operation's receipt do not
prove verification. Worker activation still must check its persisted original
candidate, generation, current permission/membership, expiry and operation digest.

## Atomic migration

Schema4 transactionally rebuilds the receipt table from v1/v2/v3 while retaining
IDs, autoincrement high-water mark, active leases, replay/rate histories, digests,
HTTP outcomes and Retry-After metadata. It adds only nullable verification metadata.
Legacy rows never acquire inferred challenge success. SQLite CHECK constraints
make challenge evidence mutually exclusive with HTTP status/delay fields. Repeated
identical finish is idempotent; a changed verification or result kind conflicts.
Environment/service configuration equality remains required before migration.

## Scope and tests

This disconnected constructor option `challengeVerification:true` defaults off;
it is not an approved configuration or a live deployment. Application startup
still pauses sends. Existing body-returning verification and message-only paths
retain their separate behavior. The verifier is injected into ingress; application
composition imports it without introducing ingress/verifier circular initialization.

Tests exercise actual Ed25519 domain binding, actual SQLite restart/readback,
immutable verification, kind confusion, no response-body retention, legacy
migration and failed durable-write handling. No external callback, hosting,
production key or deployment was used. These tests are not proof of hosted
receiver ownership or successful host Events wake-up.

#21 permits separately budgeted next-ordinal delivery retries for the same event
ID after an unknown delivery outcome. It does not permit replacing the requestID
of the same logical attempt or resetting the original evidence/budget/horizon.
Candidate verification retry policy remains separately governed by its owning
contract; no new automatic verification retry has been implemented here.
