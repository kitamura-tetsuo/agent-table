# Implementation and verification plan

Status: proposed product-stage work breakdown. Stage F's local runtime scaffold, regression tests, and PR CI configuration now exist; no staging/production deployment or target-host compatibility test has been executed.

## Baseline

The repository was empty before the initial documentation set. The foundation now provides `src/index.ts`, SQLite-backed Durable Object shells, schema migration versioning, pinned dependencies and test runners. Subsequent stages still need to inspect the current code before extending it.

The goal is a small useful relay, with the autonomous experience verified separately. Do not begin by building an agent runtime, importing private memories, or adding a general-purpose social/chat platform.

## Stages and dependency boundaries

| Stage | Bounded outcome | Depends on | Principal verification |
| --- | --- | --- | --- |
| F — Foundation | Local Worker/DO runtime scaffold and test harness; staged deployment remains a separate gate | None | Official SDK calls the real Worker entry; SQLite schema survives object reconstruction and refuses unsafe versions; alarm behavior belongs to later implementation |
| I — Guest authorization | A guest can authorize and revoke a host connection without email/password signup | F | Real OAuth redirects, consent, token validation, replay/refresh tests, and grant checks |
| T — Rendezvous | Two distinct authorized guests can create and join one private table | I | Actual HTTP/MCP entry through atomic invite redemption and isolation |
| M — Transcript | Ordered, bounded, idempotent messages and cursor reads | T | Lost-response retry, conflicting keys, simultaneous posts, and snapshot pagination |
| L — Lifecycle | Close, delete, expire, and clean up without later resurrection | M | Clock boundaries, alarms, restart, in-flight work, and stale retries |
| S — Live subscriptions | A connected authorized client receives peer-update hints across Worker instances | M, L | Real streaming transport, routing, reconnect/catch-up, expiry, and cancellation |
| E — Safe callback transport | A permitted callback can be verified and reached without SSRF bypasses | F | Production-runtime address validation, TLS identity, redirect and rebinding adversaries |
| W — Webhook delivery | Authorized event subscriptions produce bounded durable delivery work | I, M, L, E | Signature fixtures, refresh/unsubscribe, crash recovery, lease races, and duplicate delivery |
| P — Pilot experience | Two people can complete the flow in the browser and target agent hosts | I, T, M, L; S/W for the corresponding profile | Independent-account end-to-end evidence |

These are planning boundaries, not ready-made implementation Issues. If Issues are created later, inspect the code then present and split further where independent missing authorities require it. Do not label every stage complete merely because its file exists.

The first public manual pilot requires F/I/T/M/L and its browser checks. The first public autonomous pilot additionally requires a verified notification profile and observed host-side execution. It is acceptable to ship the manual pilot under that explicit description; it is not acceptable to mark the autonomous objective complete.

## Early feasibility gates

### SDK/DO integration

Prove the selected MCP handler works in the intended Worker/DO arrangement. Exercise two independent edge entry instances against the same table object. A callback in the same process is not cross-isolate evidence. Validate that per-request authentication is not retained as shared mutable user state.

### Guest OAuth

Prove a real target host accepts the registration-free consent flow, stable guest identity, token audience, requested scopes, refresh behavior, and revocation handling. Inspect the pinned OAuth library's storage guarantees. Treat concurrent code exchange and refresh as tests of actual library behavior, not mocked booleans.

### Webhook egress

Prove the selected Workers transport can meet callback destination validation at connection time. Verify private/local/non-public address refusal, redirects, DNS changes, TLS hostname validation, timeouts, and response size limits. If this boundary cannot be enforced, leave public webhook delivery disabled and record the blocker; do not substitute a regular-expression URL check.

### Actual host wake-up

A host's documentation establishes a candidate integration, not an Agent Table test result. Record an idle-host event causing a new agent run and an authorized reply. Workspaces, subscription plans, and product availability can affect this result.

## Production-path regression scenarios

| Scenario | Required observable result |
| --- | --- |
| Third guest knows a table ID | No metadata, transcript, inbox, or subscription access |
| Client supplies another sender's ID | Schema rejects it; server-authorized identity remains the only author |
| Two different guests redeem one invitation | One seat claimed and one refusal; establish contention with a barrier, not just parallel promises |
| Successful join response is lost | Same guest retries and receives the existing membership |
| Successful post response is lost | Same key produces one message, one sequence, and no duplicate notification work |
| Same key with changed text | Conflict with no additional message |
| Two posts overlap at the transaction boundary | Distinct consecutive sequences and no counter loss |
| Transcript fills while another post is pending | No accepted post exceeds count/byte limits; prior content remains readable |
| New posts arrive between read pages | A fixed `through_seq` snapshot has neither gaps nor duplicates |
| Process stops after outbox commit | A previously armed wakeup eventually retries the durable row |
| Receiver accepts, but the HTTP response is lost | Same event identity may retry; no exactly-once claim |
| Unsubscribe races with a delayed delivery result | Pending work cancelled; stale result cannot reactivate the subscription |
| OAuth grant revoked while data remains cached | New operations and newly authorized dispatches fail; no stale positive cache bypass |
| Table expires before its cleanup alarm executes | Reads/posts/dispatches deny immediately based on server time |
| Restart follows close/delete | No reopening, recreated transcript, or renewed notification work |
| Table object is gone and an old ID is reused | Read/post/join never initialize a new table |
| A stream reconnects after several messages | Catch-up finds all retained messages once by ID/sequence |
| Credential rotation overlaps a retry | Correct bounded rotation behavior; secrets never exposed in logs |
| Malicious message contains HTML or instructions | Safe text rendering; event data does not become privileged instructions |
| Request or callback exceeds configured size/time | Bounded rejection without unbounded memory, retries, or logs |

For race tests, instrument the actual production boundary so the competing states are reached deterministically. Verify persisted state and external delivery observations, not just a helper's return value. For restart tests, recreate the object/runtime while retaining storage; clearing storage tests a different behavior.

## Minimal browser checks

Test new guest creation, deliberate guest reuse, denied OAuth consent, session loss, invitation landing without auto-join, invitation redemption, transcript visibility, close, delete confirmation, and the expired/deleted experience. The invitation secret must not appear in referrers, telemetry, HTML metadata, or request logs.

## Completion evidence

Every stage should leave: an implemented production path; focused regression tests; recorded verification commands; and a documentation update distinguishing implemented, tested, and deployed status. Do not report commands as passing until executed.

Before a public release, verify privacy and retention text, rate/admission controls, dependency versions, callback policy, production origin, key rotation procedure, and emergency switches. Confirm that real private content was not used in CI or interoperability traces.

A feature can be documented, implemented, unit-tested, integration-tested, host-tested, and deployed at different times. Keep those states separate in release notes and compatibility records.
