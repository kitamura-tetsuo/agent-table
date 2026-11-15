# Disconnected message-only status sender (#74 checkpoint)

`createStatusOnlyPrototypeSender()` / `sendPinnedStatusOnlyPrototype` are opt-in
metadata-only candidates. They are **not** used by the relay application/ingress,
Worker, release profile or any deployment. No activation decision is included.
The existing `createPrototypeSender()` / `sendPinnedPrototype` challenge/body
contract retains its 2xx bounded-body result and fixed error behavior.

Both factories share the same validated destination, single DNS resolution,
public IPv4 literal pin, original hostname TLS identity, connected peer checks,
safe header policy, 16KiB request bound and 10-second total DNS/TLS/HTTP deadline.
The typed variant returns only:

- `{kind:"http",status:N,retryAfterSeconds?:S}` after final HTTP headers, with
  integer status 200..599 and optional integer delay 0..900 seconds.
- `{kind:"unknown",reason:"deadline"|"transport-error"}` for an exception,
  invalid request/result, DNS/TLS/socket failure, or timeout. This is never proof
  that no bytes were sent and never a retry authorization.

On final headers it destroys the response and owned request/agent without
retaining a body. It never follows Location or retries. A 2xx result means only
receiver HTTP response headers, not a completely read response body, callback
challenge verification, host event consumption or successful model execution.
This sender MUST NOT replace the challenge transport. HTTP 3xx is preserved as
observed status but remains a non-followed redirect, not successful delivery.

Retry-After accepts decimal integer seconds (up to ten digits) or canonical
IMF-fixdate HTTP-date. Past dates become zero; future values cap at 900 seconds,
matching the existing outbox's 15-minute cap. Malformed, duplicate/array,
fractional, control-containing or noncanonical values are ignored. Conversion
uses the injected/default trusted clock. Raw headers, dates, URLs, response
bodies and exception text never appear in the result or logs.

## Integration still required

The existing ingress expects a bounded 2xx response body and records successful
HTTP status only. It is not silently switched to the status-only contract.
Schema v2 readback retains status but has no Retry-After column. Preserving delay
across lost-response/restart readback requires a reviewed nullable bounded delay
field and atomic outcome migration; it cannot be invented from a status or
recomputed against a changed clock. Exact-once attempt identity, canonical
request commitment, known-outcome classification, original retry budget and
unknown reconciliation must be integrated together before activation.

The owning outbox classifies 410/413 as permanent, 429 and 5xx as retryable with
bounded Retry-After, and other non-2xx as payload rejection. This module does
not change those rules or turn a status read into permission to resend.

Tests exercise all final status classes, redirect no-follow, no response data
listeners, integer/date bounds, malformed metadata, DNS/network/deadline
unknowns and delayed DNS creating no late HTTP request. Shared transport tests
continue covering peer/TLS refusal and bounded old body behavior. Injected
status tests are not hosted public-network or receiver acceptance evidence.

## Retry contract clarification

The #21 contract permits at-least-once delivery: accepted response loss may
lead to a separately authorized next-ordinal attempt for the same event ID.
Unknown evidence remains retained, with original attempt ID, budget (8) and
one-hour horizon. The replay prohibition applies to replacing the ID of the
**same logical attempt**, not to that explicitly budgeted subsequent attempt.
Status readback does not itself authorize a retry. Shared active-capacity and
uncertain-process safety limits continue to apply independently.
