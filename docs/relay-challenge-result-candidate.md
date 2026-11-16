# Result-only callback-control verification candidate (#74)

## Existing contract and unchanged oracle

The existing Worker produces a random UUID challenge, signs the verification
webhook, accepts a successful bounded transport response only when its UTF-8 JSON
has the challenge field and no other key, and compares the exact challenge string.
A 2xx status alone is not callback-control evidence. Candidate activation still
requires a subsequent TableDO transaction with current grant, membership, expiry
and generation checks.

The byte-to-boolean oracle now lives in src/notifications/challenge.ts and is
shared by the existing Worker verifier without a behavior change. The unconnected
scripts/egress-relay-challenge.mjs candidate invokes that same oracle on actual
bounded response bytes and returns only verified/failed plus the semantic
operation digest. The signed original verification body determines the expected
challenge, not an independent caller-supplied success assertion. Exceptions,
invalid/non-2xx/status-only responses and oversized bodies remain unknown.

## What this avoids and what it changes

No callback response bytes, expected UUID, URL, signature or key are persisted
by this candidate. Only the result and exact-operation commitment would be
stored by a future atomic receipt adapter. This avoids adding encrypted raw
response storage and its encryption-key/retention choices.

It does move callback-control validation to the selected relay as the
authoritative evidence producer. The Worker must trust the authenticated relay
result, its build and the shared verifier, and bind that result to its own
persisted subscription candidate, original operation, callback generation,
current grant and full semantic digest. A result for a different operation,
old generation, expired/revoked candidate or mere HTTP success cannot activate
a subscription. The current function is not itself an authenticated API or
replay store and cannot satisfy those requirements by itself.

## Alternatives still available

1. Result-only evidence: no response-body retention; review the trusted verifier,
   atomic immutable result storage and authenticated exact-operation readback.
2. Encrypted bounded response retention: preserve Worker-side original-byte
   verification, but specify host, storage purpose, maximum bytes, lifetime,
   encryption-key ownership/rotation, access, erasure and recovery before use.
   No such storage or key has been configured.
3. Keep verification fail-closed after an unknown operation. This is safer than
   inventing success, but does not meet the full recovery objective.

## Executed evidence and limits

Synthetic tests include exact-match success, wrong challenge, suffix/NUL, extra
JSON fields, malformed UTF-8, message-vs-verification confusion, callback errors,
oversized responses, operation-ID changes and absence of raw data in receipts.
They do not prove authenticated replay handling, persistence, real callback
ownership, production deployment or host Events wake-up.

Before connection: add signed challenge-only path/kind, immutable exact-operation
reservation/result transaction, candidate original challenge/attempt binding,
readback and false-success/cancellation/restart tests. Do not resend an unknown
verification under a new ID or promote a result because only its status is 2xx.
