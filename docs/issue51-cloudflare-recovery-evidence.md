# Issue #51: isolated Cloudflare recovery evidence

**Outcome: the hosted synthetic PITR, quarantine, canonical discard and future-schema refusal checks passed. Both Workers remain quarantined, with all public routes disabled. No hosted clearance was performed; Issue #51 remains open for the separate approval gate.**

The rehearsal was finalized at **2026-11-14 01:55:03.459 UTC / 10:55:03.459 JST**.
The authoritative [public evidence JSON](issue51-cloudflare-recovery-evidence.json)
records run `b1a4ba80-b283-468f-85b3-ca9865c0f7bd`, 30 linked metadata records and
final state `verified-quarantine`. It explicitly records `permitsClearance:false`,
`productionJournal:false` and `certificatePhase:"reset"`. The separately prepared
[unsigned controlled-clearance proposal](issue51-synthetic-clearance-proposal.json)
is still `DRAFT_NOT_APPROVED`.

## Approval, source and execution provenance

The [owner's synthetic rehearsal approval](https://github.com/kitamura-tetsuo/agent-table/pull/69#issuecomment-6868721873)
covers the implementation and isolated synthetic staging work described in the
[recovery policy decision](restore-recovery-decision.md). It does not authorize
existing-user data destruction, production deployment, public intake, Events or
quarantine clearance. This manual approval is distinct from a protected GitHub
Environment approval.

| Item | Exact reference | Role in this evidence |
| --- | --- | --- |
| Deployed runtime source | [`3d65b9ace98720afd2ef48275a3bb76a8638f76e`](https://github.com/kitamura-tetsuo/agent-table/commit/3d65b9ace98720afd2ef48275a3bb76a8638f76e) | Pinned application and fixture source throughout the hosted rehearsal |
| Reviewed operator source | [`5f41a40f22fa1fe6dcc28c0238100ed944d18107`](https://github.com/kitamura-tetsuo/agent-table/commit/5f41a40f22fa1fe6dcc28c0238100ed944d18107) | Separately checked-out driver/API-client fix used to resume discard, future-schema checks and finalization |
| Runtime-source CI | [Validation #43541024226](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43541024226) | Successful validation for the deployed source |
| Operator-source CI | [Validation #43542406569](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43542406569) | Successful validation including 213 Node, 33 Python, 583 application, 318 integration, 2 restore and 10 end-to-end tests |

The driver retained the source checkout separately from its operator checkout.
The `operator-source-verified` records bind both commits and the compared-input
hash `c821070c3ff4cad126322ad7dc58daf817b7e1404474cb33d1ddd8672ace2f32`.
The proposal separately identifies the runtime-input path set and its tree hash
`bbf189d3f67d3b14f9105104ab9dbf2f005f196e65dcb62dc1e50d82b79b5b29`.
These hashes describe different comparisons; neither replaces the deployed
source SHA. Applying the reviewed API-client fix did not change the pinned
runtime, restore plan, operation or generation.

CI and the hosted observations are separate evidence. In particular, the
[local production-bundle reconstruction test](../scripts/recovery-transition-workerd.test.mjs)
covers the live browser/OAuth token and SDK path. The hosted fixture below covers
synthetic guest sessions, connection grants, table state and actual Cloudflare
KV keys; it does not claim a hosted OAuth-token issuance or SDK success run.

## Isolated resources and final deployment

The driver verified absence of the two intended Workers and matching storage
before provisioning. It created only the dedicated resources below in account
`0fbaae27d3ff021bc17109f1493d0b2d`. The existing `agent-table-staging` Worker and its
storage, production resources and DNS were untouched. The complete binding
commitments are retained in the [evidence JSON](issue51-cloudflare-recovery-evidence.json).

| Binding | `agent-table-pr51-recovery-staging` | `agent-table-pr51-schema-staging` |
| --- | --- | --- |
| `TABLES` | `3516bed8ba584fb0b3f6743c24b9b4cd` | `46a1be2c8d9d49a393cb495d3fb5058e` |
| `GUESTS` | `87ff46558f6747358c1edbbaa3fe750a` | `8e18320e2b734fbb92ccad02219d8637` |
| `OAUTH_SERIALIZER` | `6641d6933e6642e99fcb8b9f802a3330` | `c64a9e2de40f433a9e51282d7f89ba02` |
| `ADMISSION` | `f2752cc66c0646f48f571949cbf99a71` | `a5afe3a5a32d4a0aa6217bddfd27a374` |
| `OAUTH_KV` | `63247a13ec9f4e54912318f73c20dfa3` | `014faeb094104937bd21c12eb0081ee6` |

No existing namespace was replaced, renamed or deleted during the rehearsal.
Temporary fixture and forensic deployments retained the exact binding, namespace
and object identities. Both final deployments use the actual `src/index.ts`
application from the pinned runtime source.

| Final observation | Recovery Worker | Future-schema Worker |
| --- | --- | --- |
| Application version | `2b545b59-521b-48f9-b84c-4bb7d51bae2b` | `847f5f75-1679-4fb9-880f-b479d832710f` |
| Observed at, UTC | `2026-11-14T01:54:41.269Z` | `2026-11-14T01:54:53.027Z` |
| Complete deployed-configuration SHA-256 | `c281811405fbb82305d5c8940a82eb4a0586c7bdecc7d24c14063fcad5d9d480` | `f69ebc710d8cef86cd9fb53076a0b2d3017c8e885d7dc215785b27c217b7975a` |
| Storage disposition | Reviewed private rows and DO KV cleared; canonical schema, generation metadata and default usage row retained | Schema 13 and synthetic content retained unchanged |
| Final application ingress | Nine paths: all 503 and `Cache-Control: no-store` | Nine paths: all 503 and `Cache-Control: no-store` |

Ingress checks used authenticated private Service bindings. They are observations
of application handling through that transport. `workers.dev`, preview URLs and
custom routes remained disabled; the record reports zero custom domains and
zero configured routes. All five capability flags remained false:
`ALLOW_NEW_GUESTS`, `ALLOW_NEW_TABLES`, `ENABLE_MCP_SUBSCRIPTIONS`,
`ENABLE_OPENAI_EVENTS` and `ALLOW_OUTBOUND_NOTIFICATIONS`.

## Observed recovery sequence

The [hosted fixture](../test/recovery-hosted/worker.ts) exposes only private
Service-binding RPCs and is restricted to the two synthetic Workers. The
[driver](../scripts/recovery-hosted-rehearsal.mjs) keeps its checkpoint outside
restored DO/KV storage. The public record contains metadata and hashes, without
publishing synthetic credentials, snapshot bookmarks or private row bodies.

### Real snapshots precede later authority changes

The fixture established synthetic guest/session/connection and table state and
verified the expected authorized behavior through the real object methods. It
captured actual Cloudflare `getCurrentBookmark()` bookmarks for the GuestDO and
TableDO while their SQL and DO KV state was present. Capture preceded revocation,
deletion and the expiring grant's deadline.

It then invoked actual connection revocation and session invalidation, completed
the application's browser-confirmed deletion methods, and waited for actual
expiry. The independent driver verified denial after those events and retained
the observations outside the objects to be restored. The
`snapshot-and-later-events-verified` record at `01:36:21.770Z` confirms the ordering.
The hosted deletion check invokes the application's confirmation methods; it
is not a claim that a hosted browser UI or CSRF flow was exercised.

### PITR restores historical state while quarantine continues to deny access

Before requesting PITR, the driver retained a fresh recovery operation and
generation and deployed the signed reset configuration:

| Recovery authority field | Value |
| --- | --- |
| Operation | `4603a356-06f8-408c-bc13-f94f26484328` |
| Generation | `bbdca17200eeca1428bedb579c3461730ded3bb5155d763f8feaf9a514078ce4` |
| Application schema | `12` |

Restoration used actual Cloudflare `onNextSessionRestoreBookmark()` followed by
object abort and reconnection. Readback verified the pre-event canonical SQL/DO
KV hashes, including the historical revocation, session-invalidation and deletion
state returning to its snapshot values. This is historical PITR evidence; the
older [PR #46 rehearsal](pr46-cloudflare-quarantine-evidence.md) only established
retention across redeployment.

The `hosted-pitr-and-quarantine-verified` record at `01:37:25.160Z` reports private
access denied, actual inherited alarm handlers invoked and six-hour alarm
parking. Those checks retained the restored canonical state. A disconnected
restore RPC alone was never accepted as proof that PITR occurred.

### Production reset removes reviewed private state in the same resources

The driver deployed the actual application, enumerated all four DO namespaces
and the dedicated OAuth KV namespace, and invoked production
`RecoveryControl.inspect` and `RecoveryControl.reset`. It verified one canonical
receipt per inventoried object against the expected build, configuration,
operation, generation, schema and request nonce, then repeated inspection.

The successful `synthetic-discard-verified-quarantined` record at
`01:49:44.996Z` reports:

| Observed coverage | Result |
| --- | --- |
| `TABLES` objects | 1 |
| `GUESTS` objects | 1 |
| `OAUTH_SERIALIZER` objects | 0 |
| `ADMISSION` objects | 0 |
| OAuth KV deletion | 2 requested, 2 deleted, 1 batch |
| OAuth KV post-cleanup inventory | 0 observed keys |
| Alarm and clearance state | Six-hour parking verified; `cleared:false` |

The canonical readback verified removal of the reviewed private rows and DO KV,
with the minimal schema/generation metadata and zero-byte
`table_transcript_usage` singleton retained. It does not mean every SQL table has
zero rows. A temporary diagnostic fixture additionally checked old-credential
denial and invoked the real alarm handlers after reset, preserving the canonical
state. The driver returned the Worker to the actual application afterward.

Finalization re-inspected both inventoried recovery objects. The inventory hash
remained `84558c841a1dde8a1b15a62119ac2f27dea783ad4124c5c98471211b039696d0`;
the final inspection-summary receipt hash is
`d20ec8405aa1797110f08fd9335277a7e1d03e3147dd8a35c0162816034d7e47`.
These public summaries attest to checks performed by the driver. They contain
object counts and receipt hashes. A subsequent
[read-only inspection supplement](issue51-cloudflare-recovery-inspection.json),
completed at `2026-11-14T01:58:59.393Z` / `10:58:59.393 JST`, publishes the actual
inspection receipt metadata: full manifests, per-table counts, DO KV counts,
inventory, expected claims and request nonce. It binds the same evidence hash,
application version, operation and generation. Both objects report zero DO KV
entries; all reviewed private table counts are zero except the retained
`table_transcript_usage` singleton, whose count is one. OAuth KV inventory is
still empty. Re-running `verifyObjectResetReceipts` on this public metadata
reproduces the supplement's summary exactly. No private row values, keys or
authorization signatures are published, and the supplementary inspection
performed no mutation or clearance. It does not change the finalized
checkpoint or unsigned proposal hashes.

### Newer schema is refused and preserved

The separate schema Worker contained a real schema-13 table and synthetic
content. The schema-12 application constructor, inspection and reset refused it
with the specific unsupported-schema failure. A temporary read-only forensic
implementation observed the same object in the same namespace and confirmed the
schema, row counts, DO KV count and canonical digest were unchanged.

The `future-schema-retained-quarantined` record at `01:54:11.416Z` reports all
three refusals, `unchanged:true` and `cleared:false`, with canonical state hash
`411790ad1520b1294256175c99ce842709c42fdaa7d5db85508f7e6be2056436`.
The final deployment again uses the actual application. The schema-13 object
and its synthetic data were never discarded, renamed or replaced to obtain a
passing result. **This Worker is excluded from the clearance proposal.**

## Stops, diagnosis and resumption

Two operator-observed interruptions preceded the completed checks. The public
record retains the deployments and successful verification events; it does not
contain separate failure receipts for these interruptions.

First, the initial discard attempt stopped during provider inventory, before
`resetStartedAt` and before destructive reset RPCs. Cloudflare returned HTTP 200
with `success:true`, a valid result array and `errors:null`; the original client
rejected that null field. The reviewed operator fix accepts absent, null or empty
errors only when success is explicitly true. Nonempty/invalid errors and failed
or missing success still fail closed. Pagination and schema checks were not
relaxed. The resumed operation preserved its source, plan, operation, generation
and resource identities.

Second, the first future-schema attempt reached the specific production
inspection/reset refusals, then encountered a transient forensic readback RPC
failure. A read-only diagnostic of the same deployed version observed schema 13
and the matching hash. Resuming the committed phase reused the stored sentinel,
without reseeding or resetting it, repeated the strict refusals and forensic
comparison, and completed successfully. This narrative is an operator
observation; the final successful metadata above is the retained public result.

## Evidence boundaries

This is a manual, isolated synthetic rehearsal. It establishes actual hosted
historical PITR, later-event rollback, continued denial, reviewed discard and
future-schema preservation for the exact resources recorded above. It does not
establish a protected staging/production workflow approval or authorize a
recovery on existing application resources.

The independently retained synthetic checkpoint is separate from the production
`recovery-records` journal described in the [fresh-start runbook](fresh-start-recovery.md).
Its hash chain and reset signatures do not confer production authority. Only
reset certificates were issued; their expiry leaves quarantine active.

OAuth KV cleanup proves the reported inventory and deletion coverage. It does
not prove globally empty KV caches, erase provider backups or exclude late
writes under an old key prefix. The generation fence remains necessary after
cleanup. The supported procedure requires a fresh generation before every
restore; out-of-band same-generation PITR and replay of an old whole deployment
remain outside this safety claim. Selective recovery of old conversations was
not attempted.

## Separate controlled-clearance proposal

The [proposal](issue51-synthetic-clearance-proposal.json), created at
`2026-11-14T01:56:05.347Z`, prepares one controlled-clearance rehearsal for
**`agent-table-pr51-recovery-staging` only**, using its existing resources,
operation and generation. Its exact intended application configuration changes
`RESTORE_QUARANTINE` to false while retaining all five flags false and all public
routes/previews disabled. Verification would use authenticated private Service
bindings. The schema Worker, existing staging and production are excluded.

| Reviewable commitment | SHA-256 |
| --- | --- |
| Final public evidence, canonical JSON | `3cd59ec2fa2f69d44f9c471332e1e0eb5343a4df6c6ce5601cba185bef2ec0f7` |
| Final public evidence, file bytes | `374c36ef9ba6a7f8cefb042dfd1eb4c82f6db962697337e3f7219f09080215a2` |
| Read-only inspection supplement, canonical JSON | `badb737e8cda6dfff873eda4b01a56d4b7ea8f4ab8dd31175fbac06de826a489` |
| Read-only inspection supplement, file bytes | `f1892e9fdd7dabf037f864d6b515ad0995ab116a7557a55d044ec767c5d5c730` |
| Independent synthetic record head | `2567285e3fca23fdb7371cbd0644c3cfe57fffc6230d3050448a9f2faffa5d6b` |
| Unsigned proposal, canonical JSON | `06ae66192aaa4d2cd6345447a70bb519c38c287c3b59eb2e89f4030102b60cfb` |
| Intended serving-configuration commitment | `18d29f9b18e0fe67802427c2e18cf5a98ec8d1b4b9b7e7358a99adf851f82e0e` |
| Existing quarantine/rollback configuration commitment | `56be00421e272f3415e9ee8a694998cfb95243c25462c4ac0b123f0bfdfceb07` |

Configuration commitments exclude the authorization and the commitment field
itself. The complete deployed-configuration hash in the final deployment table
includes those fields, so it has a different value.

The proposal contains no serve signature and is marked
`authorizationIssued:false`, `deploymentPerformed:false`,
`authorizationAbsent:true` and `deployable:false`. Activation requires explicit
approval of the exact proposal, fresh authenticated provider and canonical
receipt readback, and separately issued authorization bound to the exact source,
resources, schema, generation, configuration and evidence. Its rollback is
limited to restoring quarantine in the same namespaces and generation; it
permits no new PITR, namespace change or destructive reset.

**Disposition:** hosted verification is complete and quarantine is retained.
Successful CI and this evidence do not supply clearance approval. Issue #51
remains open pending the separately authorized controlled-clearance gate.
