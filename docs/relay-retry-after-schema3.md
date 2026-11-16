# Schema 3 / message-only relay candidate (#74)

Disconnected integration checkpoint based on PR75 `4afb097`. No live key,
configuration, exposure, deployment or runtime Worker profile is enabled.

## Typed HTTP receipt

`src/notifications/relay-outcome.ts` defines a shared strict parser and type:

- `{kind:"http",status,retryAfterState:"unknown"}`: legacy/missing delay evidence.
- `{kind:"http",status,retryAfterState:"absent"}`: sender observed no usable
  Retry-After advice (absent or invalid), so existing default backoff can apply.
- `{kind:"http",status,retryAfterState:"known",retryAfterSeconds,retryAfterObservedAt}`:
  integer 0..900 seconds and original positive epoch milliseconds at the HTTP
  header observation. Both are immutable; raw header/body is not persisted.

Known delay is anchored at `retryAfterObservedAt + retryAfterSeconds*1000`.
A delayed/repeated readback must not start that interval again. For retryable
429/5xx, unknown delay is NOT proof the provider supplied no advice and must not
silently select default backoff. Such legacy operations require reconciliation.
Other status classification remains with the existing owning outbox contract.

Old `{kind:"http",status}` is normalized to explicit unknown only when parsing
legacy state, never inferred as absent. New message direct responses require
known or absent. A successful relay HTTP request does not mean callback status
was 2xx; non-2xx is preserved, not flattened to transport failure.

## Atomic migration and retention

Relay SQLite v1/v2 migrate to v3 in one transaction preserving identity, active
uncertain leases, replay/rate data and prior completion. Added columns store
state, bounded seconds and original observation timestamp. Existing rows get
`unknown`, no invented delay. Fixed environment/service/numerical configuration
must match before migration. Future/foreign versions remain refused.

`finish` validates the observation falls between admission and trusted completion
clock; changed seconds/state/time conflicts with an existing immutable receipt.
Status-only `readOutcome` and authenticated HTTP readback carry the same fields.
Pruned/missing operations remain unknown; neither migration nor a read can
release uncertain work or mint a new request identity/expiry.

## Message/challenge separation

The new path is exactly `POST /relay/v1/message`. Signature input is UTF-8
`POST\n/relay/v1/message\n<CALLER-ID>\n` plus raw envelope bytes. The envelope
includes exact `kind:"message"` alongside existing version/audience/requestId/
original timestamp/destination/headers/payload. Semantic commitment uses
`kind:"message"`; it cannot equal the legacy `kind:"forward"` commitment.

The legacy `/relay/v1` body-returning sender remains unchanged for callback
verification. Message receipts have only metadata and MUST NOT verify a
challenge. Signature/path/kind confusion is rejected. The application exposes
message routing only through operator construction option `messageDelivery:true`
(default false), while retaining its independent paused-on-start gate. This is
an offline composition option, not operator approval or a deployed setting.

`sendRelayMessage` is a separate unwired Worker adapter. It signs the dedicated
path, preserves the original operation timestamp/id, snapshots inputs, rechecks
authority after signing and bounds metadata response to 1KiB. It returns
`{ok:true,outcome}` for a validated known HTTP outcome and a fixed failure
otherwise. There is no automatic retry or unknown-result ID replacement for the same logical attempt. A subsequent
#21 bounded logical attempt remains a separate caller-authorized operation,
retaining original event ID and unknown history rather than resetting budgets.
`relayOperationDigest` accepts explicit `kind:"message"`; callers must persist
the exact semantic bytes and original operation identity before dispatch.

## Verification and remaining work

Focused tests cover v1/v2 migration, unchanged known delay after reopen,
immutable/invalid delay fields, real SQLite plus authenticated message/status
readback, domain separation and duplicates, and actual Worker Ed25519 signatures,
strict receipt parsing, input snapshots and authority denial. Existing replay,
TLS, bounded-body challenge and test-native behavior are retained.

This is not all-table production readiness. TableDO/retry integration, unknown
reconciliation, concrete approved transport/hosting/credentials, protected
release evidence and actual provider/host acceptance remain separate gates.
Challenge-result storage is not introduced by schema3 and response bodies are
never stored here. No raw payload, URL, signature or credential is added to logs
or relay database. Existing docs describing schema2 are historical; this schema3
record supersedes their status-only wire shape and Retry-After limitation.

## Retry contract clarification

The #21 contract permits at-least-once delivery: accepted response loss may
lead to a separately authorized next-ordinal attempt for the same event ID.
Unknown evidence remains retained, with original attempt ID, budget (8) and
one-hour horizon. The replay prohibition applies to replacing the ID of the
**same logical attempt**, not to that explicitly budgeted subsequent attempt.
Status readback does not itself authorize a retry. Shared active-capacity and
uncertain-process safety limits continue to apply independently.
