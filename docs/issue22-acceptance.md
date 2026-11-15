# Issue #22 acceptance evidence

Evidence review date: **2026-11-15 JST**. This record maps the original
[Issue #22 requirements](https://github.com/kitamura-tetsuo/agent-table/issues/22)
to the release/recovery gates, test oracles and dated operational receipts.
The runbook corrections in this change must land through normal PR validation
and review before the parent issue is closed; its final disposition belongs
in the parent issue. This document does not authorize another deployment,
secret change, data reset or quarantine clearance.

## Accepted scope and decisions

- **Release:** [Issue #50 final acceptance](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6825493911)
  records separately approved staging and production **paused manual** releases
  on 2026-11-12. Production used source
  `381c4e7378b2d95a3b8342f045a3e4d5521ada00`, configuration SHA-256
  `303520c2b5da8854369661bfcb8af9a8c1d3bdcea0d17382fc57713052ffc945`,
  and version `ce3f4589-57f1-467c-88fa-a9adbfa3628d`. Original DO/KV namespaces
  were retained, all five intake/capability flags were false, and no snapshot
  restoration occurred. This is evidence for that release, not a statement
  that the latest repository commit is deployed.
- **Recovery:** the owner selected [verified fresh-start discard](restore-recovery-decision.md)
  in [PR #69 comment 6868721873](https://github.com/kitamura-tetsuo/agent-table/pull/69#issuecomment-6868721873),
  then separately approved the [exact v2 synthetic clearance](https://github.com/kitamura-tetsuo/agent-table/issues/51#issuecomment-6886616675).
  Restored private content is discarded and all pre-recovery authority is
  invalidated in retained namespaces, using an independently signed recovery
  generation. This is the explicitly approved privacy-preserving alternative;
  it does not reconstruct a lost revocation ledger or selectively recover old
  conversations. The [successful clearance](issue51-synthetic-clearance-evidence.md)
  completed at **2026-11-15 09:59:29.548 JST** only for
  `agent-table-pr51-recovery-staging`, version
  `2a456ec5-44ef-47ae-8b26-91390b98d0a1`, reviewed application source
  `3d65b9ace98720afd2ef48275a3bb76a8638f76e` and schema 12.
- **Retention and cost:** the owner accepted the [disclosed retention limits](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6824625669)
  and [proceeding without a finalized account invoice](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6824960944).
  Observed settings/usage and published policies/pricing remain separate from
  unverified account-wide backups, retained copies and charges. These decisions
  do not prove zero cost, universal erasure or an automatic billing stop.
- **Key handling:** the [approved K3 production injection](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6794647999)
  retained no recoverable offline key copy. The runbook's bounded rotation
  procedure must preserve that limitation; this record does not claim a
  production overlap-rotation rehearsal or newly require key escrow.

## Original requirement mapping

| Requirement | Enforced gate and test oracle | Operational evidence and acceptance boundary |
| --- | --- | --- |
| **REQ-001 — distinct validated environments** | [Structural preflight](../scripts/release-preflight.mjs) rejects missing/mixed configurations; [provider verification](../scripts/release-provider.mjs) checks actual Worker, SQLite DO/KV ownership, origins and secret names. [Configuration tests](../scripts/release-preflight.test.mjs) and [provider tests](../scripts/release-provider.test.mjs) exercise rejection paths. | [Staging receipt](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6814836152) and [final production/staging readback](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6825493911) establish separate resources for the recorded releases. Every later mutation rechecks its target; secrets/private data are not acceptance artifacts. |
| **REQ-002 — PR isolation and protected deployment** | [PR CI](../.github/workflows/ci.yml) runs validation/dry-runs with read-only repository permission. [Reviewed deployment](../.github/workflows/_deploy-reviewed.yml) checks repository, exact main SHA, workflow context, Environment approval and authenticated provider state before publication. [Authorization tests](../scripts/release-authorization.test.mjs) cover invalid/missing authority. | Separate approved [staging run #43151011535](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43151011535) and [production run #43229649298](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43229649298) succeeded. The [first production attempt](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6825250281) refused mismatched evidence before publish. |
| **REQ-003 — profile-specific readiness** | [Preflight](../scripts/release-preflight.mjs) binds checks to build/config/environment; [authenticated authorization](../scripts/release-authorization.mjs) permits manual and a separately bounded staging-only private profile, while rejecting unsupported public live/Events/autonomous profiles. Flags or syntactically valid evidence URLs alone cannot pass the authenticated gate. | #50 accepted only paused manual deployment. Original #22 explicitly permits manual tooling completion while optional notification/host evidence is absent. Private host evidence and any later public-profile implementation/activation retain their own scope and approval. |
| **REQ-004 — schema-safe rollback** | [Application schema guard](../src/shared/schema.ts) is separate from Wrangler class migrations. [Retained-SQL runtime tests](../test/integration/release-quarantine.test.ts) assert newer-schema refusal without erasure; [operations](operations.md) and the [rollback runbook](release-runbook.md#4-intake-pause-recovery-and-rollback) require a compatible reader or forward repair, preserving namespace identity. | #50 [same-config pinned code rollback](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6815095095) preserved the synthetic transcript. #51 [hosted schema-13 evidence](issue51-cloudflare-recovery-evidence.md) records actual schema-12 constructor/inspection/reset refusal and unchanged canonical state. This is not arbitrary older-version compatibility. |
| **REQ-005 — independently authorized restore quarantine** | [Quarantine](../src/shared/release-quarantine.ts), [signed recovery authority](../src/shared/recovery.ts), [object generation checks](../src/shared/recovery-storage.ts) and [OAuth prefix fencing](../src/auth/recovery-kv.ts) deny old/unverified authority. [Reconstruction tests](../scripts/recovery-transition-workerd.test.mjs) and [release continuity tests](../scripts/release-recovery.test.mjs) cover old snapshots, omitted historical objects, stale generations, missing journal and fence removal. | Accepted through the owner-approved fresh-start alternative. [Actual PITR/discard](issue51-cloudflare-recovery-evidence.md) plus [controlled clearance](issue51-synthetic-clearance-evidence.md) establish denial, canonical discard, independent exact-target decision and positive private checks. An old snapshot or an operator boolean is insufficient. |
| **REQ-006 — normal pause preserves close/delete** | [Admission controls](../src/shared/admission.ts) remain distinct from restore quarantine. The [actual Worker/DO regression](../test/integration/release-quarantine.test.ts) performs authorized close and browser-confirmed deletion while ordinary intake is paused. [Pause readback](../scripts/release-pause-readback.mjs) compares service settings with the active version. | [Staging browser acceptance](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6820766589) includes explicit Delete confirmation and independent table/transcript `TABLE_NOT_FOUND`. No claim extends deletion to already delivered copies or provider backups. |
| **REQ-007 — executable and truthful operations** | [Environment-bound provisioning/secret changes](operations.md#environment-bound-provisioning-and-secret-changes), [bounded key rotation](operations.md#bounded-key-rotation), [release/pause/rollback](release-runbook.md) and [fresh-start recovery](fresh-start-recovery.md) specify targets, deployment effects, preconditions and readback. The correction in this change must pass review before parent closure. | Actual HTTPS origins and protected releases are recorded in #50. Retention/cost acceptance and K3 limitations above remain explicit. No new provisioning, key rotation, production restore or public activation is claimed by this documentation correction. |
| **REQ-008 — actual gate tests and distinct evidence scopes** | [CI](../.github/workflows/ci.yml) runs configuration/authorization, retained-runtime, recovery, browser and build checks. [Local historical snapshot](../scripts/restore-snapshot-workerd.test.mjs), [generated runtime](../test/recovery-runtime/restore-restart.test.ts) and [fresh-start reconstruction](../scripts/recovery-transition-workerd.test.mjs) exercise real production code with isolated synthetic state. | #50 supplies actual staging/production release and ordinary pause evidence. #51 supplies isolated Cloudflare PITR, reconstructed denial/alarm behavior, schema refusal, failed-clearance compensation and successful private clearance. [PR #72 CI](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43661121037) and [merged-main CI](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43661421226) validate that recorded recovery implementation; the current correction's CI/review is tracked on its own PR. |

## Recovery evidence and limits

The original [hosted PITR report](issue51-cloudflare-recovery-evidence.md) is a
historical pre-clearance checkpoint. Its then-current quarantined/open status
is superseded, for the approved recovery Worker only, by the
[controlled-clearance report](issue51-synthetic-clearance-evidence.md) and
[Issue #51 completion](https://github.com/kitamura-tetsuo/agent-table/issues/51#issuecomment-6887102794).
The original artifact and its hashes remain unchanged.

The first controlled-clearance attempt failed verification and returned to
verified quarantine. The successor repeated canonical inspections, passed six
private application checks and verified the exact provider configuration.
All intake/capability flags remained false; workers.dev, previews, routes and
custom domains remained absent. The excluded schema-13 fixture stayed
quarantined. Existing staging and production were not changed by that exercise.

These limits remain part of acceptance:

- Every supported restore starts a fresh recovery generation **before**
  restoration. Direct same-generation PITR, replay of an entire old deployment
  outside the reviewed workflow and account-owner bypass are outside the
  supported guarantee. The independent journal must remain retained/protected.
- Old hosted credentials had also expired. HTTP 401 alone cannot identify
  whether expiry or reset caused rejection; canonical state inspections and
  complementary local OAuth/runtime tests supply the other oracles. No hosted
  issued-OAuth-token replay or direct TableDO read was inferred from the
  rejected browser transcript request.
- KV inventory/deletion does not prove global cache/backup erasure. Generation
  fencing remains necessary for historical objects, old prefixes and late
  writes even after observed cleanup.
- The manual synthetic continuation is not a protected production recovery
  run or production journal entry. Future recovery of existing staging or
  production data requires a fresh exact-target plan, current evidence and
  its own execution/clearance approvals.

## Parent closure boundary

After the runbook correction passes PR CI/review and is merged, record that
commit and validation outcome on #22 alongside this mapping, then close the
parent for the accepted release-tooling and verified fresh-start scope. Keep
its original requirements and historical PR #46 deferral available.

No additional production restore exercise is required merely to close this
implementation issue: original REQ-008 specifies synthetic isolated testing
and explicitly says not to deploy production to prove a tooling test. Public
Events/autonomous promotion, selective historical conversation recovery and
operations on existing users' restored data are separate decisions. Previously
accepted retention, invoice and K3 limits are not new pending approvals.
