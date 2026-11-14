# Restore recovery policy decision (Issue #51)

**Status: Option A / `FRESH_START_POLICY` approved for implementation and an
isolated synthetic staging rehearsal. Actual user-data destruction, production
deployment and quarantine clearance are not authorized by this policy decision.**

## Recorded decision

The owner approved `#51 FRESH_START_POLICY 承認` in the active ChatGPT conversation.
The decision was recorded on 2026-11-14 at 00:43:41 UTC / 09:43:41 JST in
[PR #69, comment 6868721873](https://github.com/kitamura-tetsuo/agent-table/pull/69#issuecomment-6868721873).
It accepts the exact Option A proposal at
[`0ee8361e47d20b31b143490e57a3ffae9559589f`](https://github.com/kitamura-tetsuo/agent-table/blob/0ee8361e47d20b31b143490e57a3ffae9559589f/docs/restore-recovery-decision.md).
The historical proposal, including the authority audit and alternatives, remains
available at that immutable revision.

The selected procedure discards restored private content and pre-recovery
authority **in the existing namespaces**. It does not selectively recover old
conversations. Browser identities, OAuth clients, sessions, connections,
invitations and tables must be created again after a separately authorized
release permits new intake. The namespaces are neither deleted nor renamed,
and bindings are not replaced by empty resources.

The approval covers implementation of the verified discard procedure, an
independently enforced recovery-generation boundary and a separately prepared
synthetic-only staging rehearsal. It does not authorize destruction of existing
users' data, production deployment, public admission, Events or quarantine
clearance. A protected Environment approval, when applicable, is an additional
actual gate; this policy record does not impersonate one.

## Approved procedure, implemented trust boundary

The [fresh-start recovery runbook](fresh-start-recovery.md) describes the
implementation, exact plan format, independent authority and failure behavior.
Its relevant boundaries are:

1. A protected recovery workflow verifies the current reviewed main source,
   exact CI, actual owner Environment approval, live provider resources,
   deployed version and current independent recovery journal.
2. It establishes a fresh unpredictable recovery generation in a quarantined
   deployment, uses immediate DO code updates, and verifies each discovered
   object's actual build and canonical schema before any reset.
3. It removes reviewed private rows and DO key-value records while retaining
   schema and the minimal generation marker. It inventories and deletes old
   OAuth keys in the **same** KV namespace. Unknown/newer schemas refuse reset.
4. Each private object independently checks its marker against signed
   deployment authority. Missing markers on historical objects never become
   permission. OAuth uses a new generation prefix and never falls back to old
   or unprefixed keys. This fence remains necessary even after observed cleanup.
5. Actual canonical readback and denial checks produce a verified result while
   quarantine remains enabled. A **different, explicitly approved workflow run**
   is necessary for clearance. Ordinary release workflows cannot perform it.

The retained GitHub `recovery-records` branch and current provider deployment
are outside restored application DO/KV storage. Signed deployment authorization
binds the exact generation, resources, build, configuration and schema to the
verified procedure. The marker inside a restored object is not its own approval.

### Supported operations and limits

All supported restores, recoveries, releases and rollbacks must use these
reviewed procedures. **Every restore, including another snapshot from the
currently serving generation, starts a new generation before restoration.**
Direct Dashboard/PITR rollback that preserves a serving generation, manual
replay of an entire old deployment, deletion of the independent journal, and
account-owner bypasses are outside this supported safety claim. Neither an
object marker nor a separate current-generation service could detect a
same-generation snapshot rollback without an independently mediated restore.

API inventory is discovery, not an atomic global snapshot. Missing or late
objects remain denied by their durable marker. Workers KV caches, provider
backups and previously admitted calls completing writes in an old key prefix
prevent a claim of universal physical erasure. The new prefix makes that old
authority unusable; receipts separately report observed deletion coverage.

## Evidence and remaining approvals

Implementation tests and CI, local retained-SQL snapshot tests, isolated
Cloudflare PITR evidence and protected deployment approval are separate forms
of evidence. None substitutes for another. The older
[PR #46 fixture](pr46-cloudflare-quarantine-evidence.md) is historical evidence
only; it is not an Issue #51 restore or clearance receipt.

A policy decision, successful CI or a PR merge does not clear quarantine.
Before any actual clearance, present the exact environment, retained resource
IDs, reviewed build, configuration commitment, schema, generation, verified
result, data loss, residual-copy limits and rollback behavior. Staging and
production approvals remain distinct.

The [isolated Issue #51 Cloudflare rehearsal](issue51-cloudflare-recovery-evidence.md)
completed on 2026-11-14 at 10:55 JST. It verified real PITR, later-event rollback,
private denial, canonical discard in retained namespaces and unchanged
future-schema refusal. Both synthetic Workers remain quarantined and private.
The [unsigned controlled-clearance proposal](issue51-synthetic-clearance-proposal.json)
targets only the reset synthetic recovery Worker, keeps all five intake and
capability flags false, and still requires a separate explicit approval. It
does not authorize clearance of the retained future-schema fixture or any
existing staging/production resources. Issue #51 remains open for this gate.

No independent post-snapshot authorization source for selective content
recovery was identified. Option B therefore remains unselected and unavailable.
