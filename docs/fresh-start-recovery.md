# Verified fresh start in retained namespaces

This implements the selected [Issue #51 policy](restore-recovery-decision.md).
The procedure loses all restored private content and pre-recovery authority.
It keeps the four application DO namespaces and the OAuth KV namespace.
Nothing here authorizes an actual destructive run or clearance by itself.

## Authority and supported threat model

The positive authority is the protected recovery workflow's verification of
actual reset outcomes, retained in the independent GitHub `recovery-records`
branch and bound to signed deployment authorization. The signing key belongs
in the appropriate protected GitHub Environment; it is never a Worker binding,
DO row, KV value, PR CI secret or public artifact. Staging and production use
separate signing keys. Pin each Ed25519 SPKI public key in the reviewed config.

The journal has an immutable record for each revision and a current file for
each environment. GitHub API reads verify repository access, the current ref,
exact commit/tree/blob contents and the complete bounded transition/digest
chain. Writes compare the observed head and predecessor digest, append history,
and update the ref without force. Competing writes fail. Retain and protect this
branch; do not delete it, force-rewind it, or reconstruct a missing record from
an owner-authored replacement. An artifact's 90-day retention is not the
journal's persistence policy.

The current Cloudflare binding and the journal together establish the current
generation for **mediated operations**. Runtime checks verify the pinned
signature, build/config/resource tuple and each object's durable marker.
Deployment checks verify journal continuity before accepting a configuration.
There is no per-session or per-grant revocation-ledger product.

Every supported restore must enter quarantine and allocate a new random
256-bit generation before restoring application data. A snapshot taken during
generation G cannot safely be restored while continuing to serve under G.
Direct Dashboard/PITR operations that bypass this step, old deployment replay
outside the workflows, and deliberate account-owner bypass are unsupported.
The implementation does not claim to detect them automatically.

## Records and runtime fences

| Record | Producer | Meaning |
| --- | --- | --- |
| Reset authorization | Protected recovery job after exact approval/source/provider checks | This operation may inspect/reset the named resources while quarantined, for at most one hour. It never permits normal access. |
| Verified journal revision | Protected job after inventory, canonical reset/readback and denial probes | The approved discard procedure completed its stated observations while quarantine remained enabled. |
| Serving authorization | Separately approved clearance job, or an endorsement job for an already cleared generation | This exact build/config may use the independently verified generation. Endorsement alone does not deploy anything. |
| Object marker | Canonical reset or initialization of genuinely virgin storage | The object's state belongs to a generation; it is not independent permission. |

Authorization envelopes use only Ed25519 with an explicitly pinned public key,
a fixed signing domain and strict bounded decoding. Reset permissions expire.
Completed recovery evidence is an immutable fact; serving authorization does
not deliberately cause a daily outage. Supersession and current main/resource
checks supply deployment freshness. A signature cache never caches time,
configuration, object-generation or positive-access decisions.

Application schema version **12** adds the object marker. Older application
readers refuse this newer schema. Existing markerless objects, even those with
empty application rows, cannot adopt a serving generation. Only storage known
to have no application SQL **before** schema initialization and no DO KV state
may initialize as new. Each private SQL effect rechecks the marker; paths that
await I/O recheck before committing or exposing results. Alarms park under
quarantine or a generation mismatch. Reset closes in-memory table streams.

The canonical reset retains schema and minimal fencing metadata, removes the
reviewed private rows and DO KV entries, and preserves the zero-byte transcript
usage singleton needed for new tables. Unknown tables/structures, invalid
metadata and future schema versions refuse reset. OAuth serializer and
Admission objects have explicit manifests too. Reset of a completed generation
is idempotent only while it remains canonically empty; a replay cannot erase
new data created after clearance.

OAuth keys use `agent-table:recovery:<generation>:` in the same KV namespace.
The adapter covers all used single/bulk/metadata/stream reads, writes, deletion
and paginated listing; returned names stay logical and cursors are bound to
their generation. Authorization, helper APIs, token/revocation serialization
and resource validation all use the adapter. There is no old-key fallback.

## Protected workflows

Use `recover-staging.yml` and `recover-production.yml`; both call
`_recover-reviewed.yml`. The corresponding normal deployment and recovery jobs
share `agent-table-deployment-<environment>` concurrency with cancellation
disabled. Their current-main, successful exact-main CI and actual owner
Environment-approval checks remain mandatory. Reruns cannot reuse an earlier
attempt's approval; use a new dispatch.

The Environment requires existing deployment/read tokens and account ID plus:

- `RECOVERY_SIGNING_KEY`: Ed25519 PKCS#8 private key, unique to the environment.
- `RECOVERY_PLAN_JSON`: the exact reviewed plan below, containing public
  configuration and resource metadata, without application credentials.

The source must export `RecoveryControl` before preparing a live plan. Its
`identity()` account-internal RPC returns namespace commitments and build/schema
metadata without reading private rows. The operator connects through a remote
Service binding; no public operator HTTP route is installed. Its `inspect` and
`reset` methods invoke the object's own signed-authority checks.

### Exact plan

`agent-table.fresh-start-plan.v1` contains exactly these fields:

| Field | Required value |
| --- | --- |
| `format` | `agent-table.fresh-start-plan.v1` |
| `environment` | `staging` or `production` |
| `operationId` | A new UUID v4 for each new recovery |
| `generation` | A new independently generated 32-byte lowercase hexadecimal value |
| `buildSha` | Exact current reviewed main SHA |
| `namespaceIdentity` | Account, Worker, all five provider namespace IDs and four runtime DO commitments |
| `quarantineConfig` | Exact manual config, all five capability/intake flags false, quarantine true, immediate DO code updates |
| `servingConfig` | Exact intended manual config with quarantine false; otherwise differs only in the two separately reviewed intake flags |
| `peerConfig` | Separate environment config used for live isolation checks |
| `ciEvidence` | Existing release evidence shape referring to one successful `workflow_dispatch` CI run on the exact current main SHA |

The namespace identity's `namespaces` keys are `TABLES`, `GUESTS`,
`OAUTH_SERIALIZER`, `ADMISSION`, `OAUTH_KV`; `commitments` uses the four DO keys.
Commitments are obtained from the live namespace's
`idFromName("agent-table/recovery-namespace/v1")`, then joined to authenticated
provider ownership. KV namespace identity is verified through provider/config
readback; the runtime does not pretend that the KV binding exposes its ID.

Use `recoveryDigest(plan)` from `scripts/recovery-configuration.mjs` for the
canonical plan hash. Workflow dispatch separately binds the exact current
active version and current journal digest. Those compare-and-swap preconditions
change on resume and are intentionally outside the immutable plan hash.

The configuration commitment is canonical JSON of the complete parsed Wrangler
configuration with only `vars.RECOVERY_AUTHORIZATION` and
`vars.RECOVERY_CONFIG_SHA256` removed. All other fields, string contents and
array order are retained. The namespace identity and verification key are
included. The complete final serialized bytes have a separate SHA-256 receipt.
This definition avoids a certificate hashing itself; it does not permit
arbitrary configuration normalization or omission.

### 1. Discard

Dispatch phase `discard` with the reviewed plan hash, current main SHA, current
active Worker version and current journal digest (empty only before first
recovery). Protected Environment approval applies to this exact destructive
plan. The job:

1. Authenticates approval, current main, successful exact CI, both environments'
   resource ownership, the active version and the independent journal.
2. Records `prepared`, deploys the signed quarantined config with immediate DO
   code updates, and reads back the same resources/configuration.
3. Enumerates every page of all four DO namespaces and the full OAuth keyspace.
   Every discovered object, including `hasStoredData:false`, must respond from
   the expected recovery build and pass canonical schema inspection before any
   object is reset. A fresh complete sweep must agree on object IDs and keys.
4. Records `quarantined` and `resetting`, performs schema-aware resets, checks
   every KV deletion acknowledgement, and independently inspects every object
   again using a fresh request challenge.
5. Verifies one-to-one canonical receipts, no observed residual KV keys, stable
   object discovery, exact provider/config readback and 503/no-store denial on
   health, private browser, join, MCP and OAuth routes.
6. Retains a `verified` journal revision and count/digest-only evidence. It leaves
   quarantine and all five flags enabled/disabled respectively as planned.

DO update strategy defaults to deferred adoption on Cloudflare. Recovery uses
`--durable-objects-code-update-mode immediate`; the option is write-only in the
provider API, so its execution is preserved in reviewed workflow code and
per-object expected-build observations rather than falsely claimed from GET
readback. See [Cloudflare code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/).

### 2. Resume or supersede after failure

Failures before serving retain quarantine. A new independently approved dispatch can resume
the same operation, generation, plan, build and config with a fresh short reset
permission. Obtain the current version/journal digest again. An object already
reset under that operation is checked for canonical emptiness before accepting
an idempotent retry.

If main has advanced, use a **new explicitly approved discard plan**, operation
and generation against the same namespaces. A pending operation may be
superseded under quarantine; earlier receipts do not carry forward. A failure
in `prepared` before quarantine deployed may also be replaced by an approved
fresh attempt. The journal refuses reuse of every historical operation and
generation, including abandoned operations. It never rewinds to an old record.

Do not restore an exposed old config as compensation. If clearance deployment
or verification fails after this run attempted serving, the code first checks
that the active certificate is its own and the verified journal predecessor is
unchanged. Only then does it attempt to restore the same new generation in
quarantine and verify readback. A conflicting newer operation is never
overwritten. A provider outage or runner termination can prevent compensation;
such a run is blocked and requires actual provider/journal readback before any
subsequent action. An error message alone is not proof that quarantine is active.

### 3. Separate clearance

Prepare the verified receipt, exact resources, current version, journal digest,
build/config/schema, data loss and rollback limits for the owner. Dispatch
`clear` only with that separate approval. It requires a `verified` record,
refreshes quarantine under the same operation, repeats canonical inspection
and denial/readback checks, then signs and deploys the exact serving config.
Clearance keeps **all five intake/capability flags false**. Public admission,
Events and live capability cannot be enabled by this phase.

The job records `cleared` only after serving health and exact provider/config
readback succeed. Keep the journal and signing key available for subsequent
release verification. No pre-recovery session, connection or client is reused.

### 4. Subsequent release endorsement

For a later build or separately authorized reopening of new-user/table intake,
prepare a new exact plan for phase `endorse`, keeping the cleared operation,
generation and namespaces. This phase verifies the current cleared journal and
live serving authority, then produces public authorization/digest fields for
the exact `servingConfig`. It performs **no deployment or data reset**. New guests
require the existing mandatory challenge configuration.

Reconstruct the candidate using that plan's `servingConfig`, canonical namespace
identity, the returned `RECOVERY_CONFIG_SHA256` and `RECOVERY_AUTHORIZATION`.
Use exactly `JSON.stringify(candidate)` bytes for the returned complete-config
hash. The normal release evidence/operations records must bind that exact hash,
and the normal deployment needs its own applicable Environment approval. Its
continuity gate verifies the latest cleared generation, unchanged pinned key,
resource tuple, and both live and candidate signatures. It refuses missing
recovery metadata, old generations, pending recovery and quarantined targets.

## Evidence limits

The completed [Issue #51 isolated Cloudflare rehearsal](issue51-cloudflare-recovery-evidence.md)
and its [public metadata record](issue51-cloudflare-recovery-evidence.json)
are actual synthetic PITR/reset evidence. They leave both Workers quarantined.
The separate [controlled-clearance proposal](issue51-synthetic-clearance-proposal.json)
is unsigned and unapproved; neither those files nor a code merge activates it.

Authenticated inventory is not a globally atomic snapshot. Unknown or omitted
historical objects remain denied by their missing/mismatched generation even
if discovery misses them. A never-seen old object is not automatically purged
or adopted by a user request.

Workers KV is [eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
Deletion acknowledgements plus an empty observed listing do not prove erasure
of every edge cache, backup or retained provider copy. Previously admitted
Worker requests can finish writing to an inaccessible old OAuth prefix after
cleanup. The generation prefix independently blocks old authority; receipts
report observed cleanup coverage rather than universal physical erasure.

Local retained-file snapshots are not hosted PITR. Cloudflare's
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
provides `getCurrentBookmark`, `onNextSessionRestoreBookmark` and a subsequent
instance restart for genuine hosted restoration, and states that PITR is not
available locally. An isolated synthetic fixture must separately observe
later revocation/deletion/expiry before restoring the earlier bookmark. Keep
future-schema refusal evidence in its own retained fixture so unsupported
storage is never erased to manufacture a successful discard receipt.
