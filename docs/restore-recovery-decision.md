# Restore recovery procedure decision (Issue #51)

**Status: DRAFT — NOT APPROVED. Issue #51 remains open and blocks recovery clearance.**

This is a reviewable proposal for the operator decision required by
[Issue #51](https://github.com/kitamura-tetsuo/agent-table/issues/51). It does
not authorize data destruction, a Cloudflare restore, a deployment, public
admission, Events, or changing `RESTORE_QUARANTINE` to `false`. A PR merge,
a successful CI run, and the older PR #46 fixture cannot supply that approval.

The current implementation work strengthens denial at internal boundaries
and rehearses a real local SQLite snapshot taken before later authorization
changes. It does not implement an approved reconciliation source or a
successful clearance path. This document does not replace the Issue's
requirements with a weaker acceptance contract.

## Decision requested

Select one of the following policies before implementing a recovery success
path. **Option A is recommended when restoring old conversations is not
necessary.** The selection concerns the procedure and its implementation;
actual destructive execution and clearance require later exact-environment
approval after the implementation and evidence are reviewable.

| Option | Basis for a safe result | User-visible result | Current prerequisite |
| --- | --- | --- | --- |
| **A. Discard restored private state and start fresh in the same namespaces** | Verified destruction/invalidation of all old private state, plus an independently enforced runtime fence that prevents old or unverified state from authorizing access | Restored conversations and invitations are lost. Browser sessions and agent connections must be created again. Users recreate their tables. Namespace identities remain unchanged. | Explicit approval of the data-loss policy and the new runtime-fence architecture; implementation and hosted proof remain necessary. |
| **B. Recover selected content using an independently preserved later authority** | A trustworthy source independent of snapshot A establishes which tables, sessions, grants and invitations are still valid after later revocation/deletion/expiry; unknown records stay denied | Only independently authorized content can return. Anything unverified remains unavailable. | Identify and approve a real source and its producer, provenance, coverage, freshness and conflict policy. No such source is evidenced in the current repository. |

Keeping quarantine enabled remains the outcome whenever either procedure
cannot be proved safe. Neither option permits an operator to assert that an
old snapshot is current merely because the operator owns the deployment.

### Proposed policy approval wording for Option A

The following text is a proposed decision, **not a recorded approval**:

> I select an in-place fresh start that discards all restored private content
> and pre-recovery authority while preserving the existing namespace IDs.
> I approve implementation of the verified discard procedure and its
> independently enforced recovery-generation boundary, and a separately
> prepared isolated staging rehearsal containing synthetic data only.
> I understand that conversations, invitations, sessions and connections
> will not be recovered by this policy. This decision does not authorize
> destruction of existing user data, production deployment, public admission,
> Events, or quarantine clearance. Present the exact environment, resources,
> build, configuration, schema, destructive operations and resulting evidence
> for separate execution and clearance approval.

A policy decision must be recorded with the authenticated operator identity,
actual time and exact proposal revision. An approval that explicitly includes
an isolated, synthetic-only staging rehearsal remains valid for that scope;
record and verify its concrete resources and commands before execution.
Request another decision only if the plan exceeds the approved scope or an
actual protected Environment gate requires it. Production execution and
clearance remain separate from staging approval and evidence.

## Existing authority audit

The baseline inspected for this proposal was
[`c1ef8522cef06eb6adbdfe4ca05b3d8611a1309d`](https://github.com/kitamura-tetsuo/agent-table/commit/c1ef8522cef06eb6adbdfe4ca05b3d8611a1309d).
The distinction between a denial mechanism and a source of current permission
is essential.

| Existing mechanism or evidence | What it establishes | What it cannot establish |
| --- | --- | --- |
| [Restore quarantine binding](../src/shared/release-quarantine.ts) | A Worker configuration outside restored DO SQL can deny ingress, private operations and alarm work. Missing or invalid configuration fails closed. | The binding is not proof of any post-snapshot revocation or deletion, or a durable independently authorized clearance decision. |
| [Authenticated release authorization](../scripts/release-authorization.mjs) and [release runbook](release-runbook.md) | Exact release checks and protected Environment approval; an already quarantined deployment is refused with `restore-reconciliation-required`. | An ordinary release cannot reconcile a snapshot or turn its own approval into recovery clearance. |
| [Quarantined restore configuration preparation](../scripts/release-preflight.mjs) | A restore candidate disables capabilities and exposure instead of inheriting old flags. | It deliberately has no clear-quarantine operation or later-authority source. |
| [PR #46 Cloudflare evidence](pr46-cloudflare-quarantine-evidence.md) | Isolated synthetic retention and denial across a hosted redeployment. | No historical snapshot restore, complete later-authority ledger, or approved recovered-content release. |
| [Application schema guard](../src/shared/schema.ts) | Unsupported newer schemas and invalid schema metadata refuse reconstruction without resetting storage. | Schema compatibility says nothing about the continuing validity of restored grants or deleted content. |
| [GuestDO](../src/objects/guest.ts), [TableDO](../src/objects/table.ts), [OAuth provider](../src/auth/provider.ts) and [token serializer](../src/auth/token-do.ts) | Canonical current application and OAuth authorization checks in an ordinary environment. | Restoring these records can restore stale authority. A row copied from snapshot A is not independent evidence about events after A. |

**Independent post-snapshot authority producer: none identified.** Existing
sampled logs, host observations, approval messages and the historical fixture
do not form a complete current authorization source. A future Option B
source might be an authenticated export from an unaffected authoritative
state after later events and an enforced write freeze; that is a candidate
to investigate, not a source this proposal claims exists.

A checksum only binds bytes. A signature can bind bytes to an authenticated
producer, but neither proves that the producer observed every relevant later
event. A signed owner-authored list, `approved: true`, an unverified evidence
URL, or the restored snapshot's own recovery receipt cannot satisfy source
authentication, completeness and freshness. Explicit operator approval is
necessary for the action; verified source or destruction outcomes are
separately necessary for its safety.

## Option A: proposed controlled fresh-start phases

These phases describe work still required after policy selection. They are
not executable clearance instructions.

### 1. Freeze and bind the affected environment

Maintain quarantine and disable new guests, new tables, live subscriptions,
Events and outbound notifications. Verify the same effective configuration
in Worker settings and the active deployed version. Deny internal DO calls,
queued OAuth work, existing streams and alarm/outbox wakeups before they can
read private data or cause an effect. An in-flight operation cannot be assumed
cancelled merely because a new version was deployed; the recovery protocol
must define and verify how the write freeze is established.

Authenticate readback of the Cloudflare account, release environment, Worker
identity, active version and code/build identity, exact configuration digest,
DO binding-to-namespace identities, OAuth KV namespace identity, and supported
stored schema for every affected component. Bind the recovery plan and later
receipt to that exact tuple, the procedure version, recovery generation,
independent verifier identity, approval reference and validity interval. A
mismatch, missing source or stale observation keeps quarantine enabled.

### 2. Inventory and independently fence old authority

Inventory every affected namespace and keyspace with authenticated provider
access, complete pagination and schema-aware inspection. The Cloudflare
[DO object listing API](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/)
provides cursor pagination. A first page, hand-picked known IDs, or a caller's
claim that an inventory is complete is insufficient. Pagination anomalies,
unknown object classes, partial reads or identity changes block completion.
The API inventory is a discovery input, not an assertion of authorization or
a transactionally frozen global snapshot.

Inventory alone is also insufficient for clearance. Workers KV is eventually
consistent, and updates can take more than 60 seconds to appear elsewhere;
negative lookups are cached too. One empty KV read, one successful deletion
response, or sleeping for a fixed interval cannot prove that all old OAuth
state is unavailable. See [Cloudflare's KV consistency documentation](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

**A separately enforced runtime generation or equivalent fence is required.**
It must deny every old or unverified guest, session, connection, table grant,
invitation, OAuth credential and queued effect even when an old object was
not enumerated or an edge returns cached KV data. New state may be admitted
only under a verified post-recovery generation; absence of a generation must
mean deny, not initialize-as-current. A receipt stored solely in the snapshot
being restored cannot supply this fence. Its authoritative producer and
storage must be outside the restoration scope, with explicit consistency,
freshness, failure and rollback behavior.

This is an architectural decision still requiring implementation and review,
not a new revocation-ledger product silently introduced by this proposal.
The selected design must prove its deployment and runtime enforcement before
clearance. Merely adding another environment boolean or trusting an
unverified generation string does not meet this condition.

### 3. Discard and verify all private state

Apply approved, resumable, schema-aware destructive operations only to the
bound environment while quarantine and the independent fence remain active.
Do not delete or rename namespaces, swap bindings to empty replacements,
or erase unsupported newer-schema storage to make recovery appear complete.
Keep only reviewed schema metadata and the minimum audit/fencing information
needed to prove denial and resume an interrupted procedure.

| State surface | Required discard/invalidation coverage |
| --- | --- |
| GuestDO SQL and DO key-value state | Guest identities, browser sessions, connections/grants, creation reservations/outcomes and retained private diagnostics. No old grant or session may regain validity. |
| TableDO SQL and DO key-value state | Metadata and private title/purpose, memberships, transcripts, invitations and encrypted responses, idempotency/join/delete receipts, subscriptions and callback credentials, event candidates and durable outbox. Old alarms and streams must remain unable to expose data or dispatch. |
| `OAUTH_KV` | Old protocol grants, authorization codes, access/refresh token state and any client/registration records that could preserve pre-recovery authorization. The pinned provider's actual keyspace must be audited; clearing DO SQL alone is insufficient. |
| `OAUTH_SERIALIZER` namespace | Any persisted state in the deployed serializer version, plus safe termination/refusal of queued provider operations. Do not assume a class has no relevant state from its name. |
| `ADMISSION` namespace and other retained metadata | Classify and inspect stored security counters and identifiers. Any permitted retention must be explicit, bounded and unable to authorize old private state; unknown contents block completion. |

Inspect actual canonical stored state and enforce negative access/effect
oracles after each phase and after reconstruction. Missing objects, unknown
schema, partial erasure, unexpected residual private rows or unverifiable
state prevent a completion receipt. The runtime fence must continue to deny
unverified objects independently of the physical cleanup's progress.

### 4. Rehearse rollback and generate a verifiable receipt

Exercise process restart, DO eviction, deployment replacement, scheduled
alarms, queued OAuth operations, stale KV responses and attempted restoration
of the old snapshot after discard. Every old credential and old private
object must remain denied; a configuration rollback must not remove the
independent fence. Unsupported newer schemas must refuse without data loss.
A partial failure must be resumable under quarantine, not cause automatic
rollback to exposed old state.

The receipt must link the exact source/build, configuration, namespace/schema
tuple and recovery generation to authenticated observations, recorded
canonical-state checks, negative access/effect results and unresolved limits.
Record source authentication separately from content hashes. Use metadata
and nonsecret identifiers; do not place transcripts, cookies, tokens or
callback credentials in CI logs, PRs or recovery evidence.

### 5. Obtain exact clearance approval

Present the verified receipt, unavoidable data loss, retained provider-copy
limits and rollback behavior to the operator and the protected GitHub
Environment reviewer. Re-read the resource/deployment tuple before execution;
changes invalidate the candidate decision. Persist an independently verifiable
authorization that survives the release workflow, restart and redeployment.

Ordinary deployment workflows must continue refusing a quarantined target.
They cannot clear `RESTORE_QUARANTINE` by copying a flag, substituting a
`no-restore` operations record or relying on an old approval. Only a separately
reviewed recovery workflow may consume a valid exact-environment clearance
receipt after the runtime fence is active and verified. Reopening public
admission or Events requires its own applicable approval and evidence.

## Concrete privacy and data-loss effects

Under Option A, both participants lose access to all restored table content;
there is no selective transcript preservation. Old invitation codes stop
working, pending notifications are abandoned, browser identities become
unusable, and agents must reconnect under fresh authorization. Clients may
also need new OAuth registrations, depending on the provider keyspace audit.
An accidental or interrupted run cannot be repaired by exposing the original
snapshot again. Recovery of private content would instead require Option B's
independent evidence and a new approval.

Deleting application records does not recall messages already delivered to
agents or copies retained in provider backups, logs or exports. Record their
actual retention boundaries separately; do not claim universal physical
erasure. The independent runtime fence remains necessary if an older provider
backup is restored later. None of these effects is authorized by this draft.

## Acceptance and evidence matrix

The following statuses describe this proposal, not an unrecorded successful
run. The PR's exact-head verification record may establish local denial
results; it cannot promote the other rows to passed.

| Issue #51 requirement / acceptance | Local implementation and CI evidence | Isolated hosted staging evidence still needed | Production decision |
| --- | --- | --- | --- |
| 1: independently approved source/procedure | Source audit and proposed alternatives only; **policy not approved** | Approved exact procedure and authenticated producer/fence identity | Separate actual-environment policy/execution approval |
| 2: exact-resource, build/config/schema reconciliation | Internal denial boundaries and failure tests; **no positive clearance path** | Verified resource inventory, integrity/provenance checks, canonical discard/reconciliation and fence refusal tests | Exact receipt plus protected Environment approval |
| 3: conservative treatment of deleted/revoked/expired/unknown state | Snapshot-before-change refusal rehearsal; Option A loss policy documented | Actual discard or independently evidenced selective reconciliation; unknown objects and stale OAuth KV must remain denied | Data-loss/privacy acknowledgment for the actual affected state |
| 4: survival across workflow, eviction, restart and redeployment | Retained local SQL and reconstruction checks can demonstrate denial while quarantined | Independently anchored generation, deployment/workflow integration and old-version/old-snapshot refusal | Reviewed operational rollback and durable authority |
| 5: genuine snapshot-before-change and newer-schema rehearsal | Local file snapshot of retained SQL, separately observed later changes and reconstructed instances; results belong to the exact-head PR record | Real Cloudflare PITR/restore rehearsal against retained synthetic state with source approval/denial or verified discard oracles | No production inference from CI or staging alone |
| 6: separate staging and production evidence/approval | No public release, Events or clearance is authorized | Fresh hosted record for the new procedure; PR #46 evidence remains historical and bounded | Separate production authorization, after staging acceptance |

Cloudflare's [SQLite storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
states that PITR is unavailable in local development. A genuine local file
snapshot/restart test therefore must be described as a local retained-SQL
rehearsal, not Cloudflare PITR evidence. Hosted testing is a later distinct
step, using approved isolated synthetic resources.

## Remaining work after policy selection

1. Name the authoritative producer and storage for the independent runtime
   fence, or the real post-snapshot source for Option B. Specify failure,
   freshness, coverage, conflict and rollback semantics before implementing
   a successful clearance decision.
2. Implement authenticated inventory and source/receipt validation, the
   schema-aware discard or reconciliation procedure, runtime enforcement,
   resumable failures and a recovery workflow separate from normal releases.
3. Test omitted/unrecognized objects, stale KV reads, interrupted operations,
   mismatched resources/build/config/schema, expired approvals, replayed
   receipts, eviction, restart, redeployment, newer schemas and old-snapshot
   reintroduction. Use canonical row state and denied effects as the oracles.
4. Prepare a concrete synthetic-only staging plan within the approved scope,
   satisfy any actual protected Environment gate, run the hosted
   restore/reconciliation rehearsal and retain metadata-only evidence with
   its actual limits.
5. Present the exact destructive plan and verified result for later operator
   and protected Environment decisions. Keep quarantine enabled until every
   required condition is satisfied, and keep Issue #51 open until its full
   implementation and acceptance contract is met.
