# Candidate-bound result-only verification (#20 / #74)

This source-only candidate extends the integrated schema13 checkpoint with
schema14. Production selection is now wired through strict protected-deployment configuration
and matching key validation; this does not provision or approve live settings. No live credential, hosting configuration, relay exposure or
application deployment is created.

## Exact operation before callback

The internal service accepts an injected, trusted relay adapter. It creates the
existing signed provider verification request and derives a challenge-domain
commitment. Before any send, TableDO records its request ID, original timestamp,
acceptance expiry, caller/audience and semantic digest, bound to the existing
candidate ID, membership, canonical subscription, guest/connection, observed
fence and candidate expiry. This metadata contains no challenge/request/response
body, callback URL or credential. The original encrypted candidate credential
stays in its existing purpose-bound field.

The server-owned candidate verification mode is relay for a production-relay
candidate; preparation also marks an injected relay candidate as relay. A relay
candidate cannot use the native commit method without matching verified evidence,
including when its proof is missing or the runtime profile later differs.

After asynchronous signing, TableDO rechecks actual GuestDO authority, local
candidate/fence/lifecycle/expiry, quarantine and outbound readiness and atomically
marks the operation dispatched once. A second authorization cannot send it again.
The receipt must be exactly a challenge verified/failed result for the same
recorded operation. HTTP2xx alone is not proof. The ordinary guarded activation
transaction still rechecks ownership, current generation/fence, grant, table
state and finite expiry. No remote observation alone creates an active row.

## Interrupted work and retention

The existing 15-second candidate lifetime is unchanged. Exceptions and ambiguous
transport outcomes retain the original metadata and do not automatically discard,
replace, resend or extend that operation. An ambiguous send result may perform one authenticated status read using the original request ID and digest. Fresh read authorization and final commit still require the original live candidate; pending/unknown/HTTP-only receipts never activate it. This checkpoint adds no autonomous
recovery activation and no new challenge retry. If verified evidence was persisted
but activation was interrupted, a guarded commit within the original candidate
window can use only that exact evidence; expiry/revoke/refresh/unsubscribe/delete
still fence it. A later explicit subscription request follows the existing new
candidate behavior; it is not an automatic replay or completion of an old unknown.

Verification metadata is retained across ordinary candidate expiry/refresh for
unknown-operation evidence until the existing table lifecycle purge or authorized
recovery reset. Both ordinary deletion and table expiry remove it. It contains
only bounded scalar metadata, not a transcript or callback body. Operational
capacity/retention sizing must be reviewed before enabling a public deployment;
this checkpoint does not claim production capacity evidence.

## Evidence limits

Focused Workerd tests exercise actual GuestDO grants, table-creation service,
subscription service and TableDO persistence/guards. The original focused candidate tests inject the external relay
outcome and transport seam. A separate production-selection integration exercises
real MCP/service/DO selection with only external relay fetch controlled. They cover signed
provider payload shape, one-shot send, reconstruction, unknown preservation,
wrong operation/digest, failed/bare HTTP evidence, commit interruption, expiry,
revocation, unsubscribe, competing candidate, actual close/browser-approved delete,
ordinary expiry purge and missing-proof fail-closed behavior. They are not actual
public relay ownership or host wake-up evidence. Existing native Events tests
remain separate regression coverage. The approved release selector, hosted relay
security proof and actual MCP-to-host acceptance remain required before readiness.
