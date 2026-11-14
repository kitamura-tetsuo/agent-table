# Issue #51: corrected synthetic clearance proposal

**Status: the original proposal was stopped before signing or deployment. The
corrected proposal is prepared and requires approval of its replacement
configuration commitment. Both synthetic Workers remain quarantined.**

## Why the original proposal cannot clear quarantine

On 2026-11-15 JST, the owner replied `continue` directly to the prior concrete
clearance request. That continuation was recorded in
[Issue #51, comment 6885394764](https://github.com/kitamura-tetsuo/agent-table/issues/51#issuecomment-6885394764)
for the original exact proposal and its synthetic-only scope.

Pre-activation source review found that the original intended serving
configuration omits `RELEASE_PROFILE`. In the pinned source
[`3d65b9a`](https://github.com/kitamura-tetsuo/agent-table/blob/3d65b9ace98720afd2ef48275a3bb76a8638f76e/src/shared/release-quarantine.ts),
the actual application's `isRestoreQuarantined` gate requires the manual profile
for this staging configuration even after recovery authorization succeeds.
There is no default or implicit injection. A valid serve signature alone would
therefore leave the application quarantined. The protected recovery plan
validator already requires this profile; the defect was in preparing the
isolated unsigned proposal, not in the runtime's refusal behavior.

The original proposal is retained unchanged as historical evidence. It must
not be used as a working clearance configuration. Successful signature
validation is not proof that application ingress can leave quarantine.

## Exact correction and unchanged scope

The [replacement proposal](issue51-synthetic-clearance-proposal-v2.json) adds
exactly one behavioral configuration field:

```json
{
  "vars": {
    "RELEASE_PROFILE": "manual"
  }
}
```

Its configuration commitment is recomputed to include that field. The subject,
source, schema, operation, generation, all five namespace IDs, verification key,
all five disabled intake/capability flags, disabled public exposure and rollback
configuration remain identical to the original proposal. No application code
or production recovery workflow was changed.

| Commitment | Canonical SHA-256 |
| --- | --- |
| Original proposal, superseded | `06ae66192aaa4d2cd6345447a70bb519c38c287c3b59eb2e89f4030102b60cfb` |
| Original serving configuration, remains quarantined | `18d29f9b18e0fe67802427c2e18cf5a98ec8d1b4b9b7e7358a99adf851f82e0e` |
| Corrected proposal, awaiting approval | `020534bdd708a01c501d27829ff80d01f8ebb2b48336ac49d29196f9959046c9` |
| Corrected serving configuration | `58aaf16f7cacf06c3b0b568b4e3858c9c399d86b826348630c99a99f0a2330fa` |
| Existing quarantine/rollback configuration, unchanged | `56be00421e272f3415e9ee8a694998cfb95243c25462c4ac0b123f0bfdfceb07` |

The only clearance target remains `agent-table-pr51-recovery-staging`. The
schema-13 Worker, existing staging and production remain excluded. No additional
PITR, destructive reset, namespace replacement or user-data deletion is proposed.
Because the approval subject explicitly included an exact configuration digest,
the original continuation is not silently transferred to the replacement digest.

## Verification and observed live state

The [focused regression](../scripts/recovery-synthetic-clearance-proposal.test.mjs)
executes the actual application quarantine and recovery gates, bundled from
repository source. It uses fresh ephemeral test keys, never the hosted private
key. It proves that valid serving authorization with the original missing
profile stays quarantined, while the corrected manual configuration passes the
application gate. Missing or invalid authorization and enabled outbound features
remain denied. It also checks the fixed source/resource/operation/generation
subject, unchanged rollback, disabled flags/exposure, and the precise one-field
configuration correction.

The [read-only provider observation](issue51-clearance-preflight-20261115.json)
completed at **2026-11-15 07:47:05.653 JST**. Authenticated settings, deployments
and subdomain reads matched both final deployments from the original rehearsal:

| Worker | Active version | State |
| --- | --- | --- |
| `agent-table-pr51-recovery-staging` | `2b545b59-521b-48f9-b84c-4bb7d51bae2b` | Quarantined; five flags false; workers.dev/previews disabled |
| `agent-table-pr51-schema-staging` | `847f5f75-1679-4fb9-880f-b479d832710f` | Quarantined; five flags false; workers.dev/previews disabled |

Complete text bindings matched the finalized configurations. Namespace IDs
reported in these binding responses also matched. This was not a fresh namespace
ownership inventory, private ingress probe, custom-route/domain check, OAuth KV
inventory or canonical storage inspection. Those checks remain activation
preconditions; the expired reset certificate was not renewed to perform them.
No hosted certificate was issued, no Cloudflare configuration was changed and no
reset or clearance was executed during this continuation.

## Activation after replacement approval

Approval must identify the corrected proposal above. The operator must then
reverify the current exact provider deployment and namespace ownership, retaining
an independent continuation record outside restored DO/KV. If needed, refresh
only the same-operation, same-generation quarantined reset certificate to inspect
current canonical state with fresh nonces; never call reset or delete.

Only after successful verification may a separate serve authorization bind the
corrected configuration and original source/resources/evidence. Tests remain
restricted to authenticated private Service bindings. A failed clearance may
restore quarantine only in the same generation and namespaces. The original
reset checkpoint and finalized evidence remain immutable, and this manual
synthetic exercise supplies no protected Environment or production approval.
