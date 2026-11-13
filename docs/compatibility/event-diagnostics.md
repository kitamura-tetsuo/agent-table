# Events diagnostics

`get_event_diagnostics({ table_id })` reports the effective Events configuration
and recent protocol stages for an authenticated table member. Use it when a
host reports a generic subscription validation failure without the underlying
MCP error. It requires both `tables:read` and `events:subscribe`; it grants no
additional membership or subscription authority.

An existing host catalog can also call `get_table({ table_id })` during an
active private discovery window. For the exact configured recipient and table,
the response adds `eventDiagnostics` after the same fresh scope and membership
checks. This compatibility path uses the existing input schema, so a catalog
rescan is not required. Ordinary metadata reads continue when optional
diagnostics fail; a missing field or `status: "unknown"` is not evidence that no
request occurred. Other profiles, expired windows and unmatched callers do not
receive this additional payload.

## What the tool reports

- The Worker, TableDO and GuestDO runtime contexts: release environment,
  profile, build, policy validity, active window and recipient/table matches.
  Comparing these values can reveal a stale or inconsistent runtime binding.
  `tableAllowed: null` means that the component did not evaluate table scope.
- A bounded record of protocol arrival, authentication, capability construction,
  actual Events handler entry, parameter validation and the returned result.
  Rejected parameters have fixed categories such as `metadata`, `arguments`,
  `delivery`, `secret`, `cursor` and `ttl`; their values are never retained.
- The canonical HTTPS callback origin from the most recent successful,
  authorized discovery observation, when it remains within the same policy and
  retention scope. The full callback URL, path, query and signing key are absent.
- The table's lifecycle and the caller's notification state. These observations
  do not activate a subscription or send a callback.

The method on an ingress record is an allowlisted, untrusted routing hint.
An actual `handler / received` record is a separate observation. A
`capabilities / enabled` record means that the server constructed Events
capabilities; it does not prove the host accepted them. A `table / received`
record is written only after the TableDO RPC returned, not before dispatch.
`operator_review_required` remains the expected discovery-only refusal.

## Storage and access

Detailed collection runs only during an active staging `a-only-discovery`
policy with `private-redacted` observations. Each HTTP request has a fresh
server-generated diagnostic ID. No client-supplied ID, authentication token,
header value, message body, exception text or private identity is copied into
a diagnostic record. Unmatched authenticated connections may produce coarse
recipient/authorization categories but cannot read the selected recipient's
records.

A single GuestDO KV value holds at most 64 records, written in batches of at
most 16. Reads include a discarded-record count. The ring is bound to the
exact effective policy and is replaced when its scope changes. Matching
records remain readable for one hour after the policy expires; after that,
they are hidden and a subsequent permitted write replaces them. This is not
a claim of immediate physical deletion from provider backups.

Routine `tools/call` and `tools/list` routing hints are excluded so diagnostic
reads do not evict Events traces. Requests rejected before edge admission do
not open a new diagnostic persistence path. Writes run in the request's
background lifetime and failures do not change the application's result.
The tool returns `unknown` when an authorized read cannot obtain the records.

## Using the result

1. Read the tool for the intended table and compare the three runtime contexts.
2. Make one native host subscription attempt using the intended connection.
3. Read the tool again and examine the matching time interval and diagnostic
   IDs. Use actual handler entries and fixed rejection categories to choose
   the next correction; do not infer a cause from a generic host error alone.
4. If discovery reaches `operator_review_required`, review the observed origin
   before enabling the separate callback-verification/delivery stage.

Missing records remain unknown: writes, a request or its response can fail,
and a bounded ring can discard history. An HTTP success, diagnostic record,
callback origin or subscription acknowledgement does not establish delivery,
a new autonomous host run, an authenticated read or a committed reply. The
real-host acceptance requirements in Issue #24 and PR #63 are unchanged.
