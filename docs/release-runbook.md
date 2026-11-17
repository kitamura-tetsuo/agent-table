# Reviewed staging and production release (Issue #50)

## Status and hard safety boundaries

The repository contains an **authenticated, protected release gate**. It
checks the exact `main` commit, a successful independently fetched CI run,
fresh operator disclosures, the GitHub Environment deployment policy, and actual
Cloudflare Worker, SQLite Durable Object, KV, secret-name, domain and deployed
version state **before** permitting `wrangler deploy`. It reads the deployed
resources and public `/health` build receipt again after publication. A local
preflight success or a PR merge is never deployment authorization.

**Recorded acceptance reviewed on 2026-11-15 JST:** the owner-approved
protected staging and production **paused manual** releases passed on
2026-11-12. The [final Issue #50 receipt](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6825493911)
includes independent provider identity/configuration readback, HTTPS health,
staging retained-state code update/rollback and existing-guest browser
Close/Delete. The staging service-settings/active-version text-binding
mismatch was repaired and independently checked. The separately approved
[production run #43229649298](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43229649298)
deployed source `381c4e7378b2d95a3b8342f045a3e4d5521ada00` as version
`ce3f4589-57f1-467c-88fa-a9adbfa3628d`, with original namespaces retained,
all five intake/capability flags false and no restoration. These are dated
receipts for those exact targets, not proof that the latest `main` is deployed.

The owner accepted the disclosed [retention limits](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6824625669)
and [proceeding without a finalized invoice](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6824960944).
Actual account charges and account-wide retained copies remain unverified;
neither zero spend, universal erasure nor automatic billing shutdown is claimed.
New operations still need fresh target-bound inputs and operator records;
production releases and destructive recovery additionally need GitHub reviewer
approval. Ordinary staging releases do not. The
checked-in `wrangler.jsonc` is not a hosted release candidate. The
[Issue #22 acceptance map](issue22-acceptance.md) joins these release receipts
to the separate recovery evidence and original requirements.

The authenticated gate supports **`manual`** in staging and production, with
subscriptions, Events and outbound notifications all explicitly `false`.
The separate staging-only [private A-only verification profile](compatibility/private-pilot-activation.md)
binds a finite trial to one receiving connection, selected synthetic tables,
reviewed callback targets and the exact candidate configuration. It keeps
global/public Events advertisement off and requires its own concrete owner
approval; merging the implementation does not activate it. Both profiles
require `RESTORE_QUARANTINE=false` only for a verified no-restore release.
The private profile has a separately approved `a-only-discovery` mode for
learning the actual host callback origin without any outbound challenge,
delivery or subscription commit. Its finite window is checked even though
outbound is false. Discovery and optional `private-redacted` observations have
their own operator review fields; the protected manifest and post-deploy
readback bind those choices to the exact policy. See the profile document for
capture completeness and the separate transition to reviewed delivery targets.
Public `live`, `events` and `autonomous` profiles are not reachable by
editing a flag or inventing a successful test URL: they need separately
implemented provider/host evidence verification. Restored snapshots with
unknown post-snapshot revocations/deletions/expiries require a separately
approved recovery decision for that exact incident. Issue #51 implements the
[fresh-start procedure](fresh-start-recovery.md), with retained-namespace PITR,
discard and [controlled private synthetic clearance](issue51-synthetic-clearance-evidence.md)
exercised on 2026-11-14–15. That approval does not transfer to existing staging,
production or public intake.

The [approved recovery policy](restore-recovery-decision.md) selects a verified
fresh start in the retained namespaces. The [separate recovery workflow](fresh-start-recovery.md)
owns destructive execution and clearance; those still require exact approval.
Ordinary release authorization reads the independent recovery journal and
refuses pending recovery, removal of its runtime bindings, or a stale generation.
After clearance, a new build/config needs a signed endorsement for the same
generation before this ordinary deployment flow can accept it.

This flow assumes a **preexisting** target and peer Worker with known DO/KV
ownership. It deliberately rejects first-time bootstrapping of an unknown
Worker. Initial provisioning of an unknown Worker follows the separately
approved [environment-bound provisioning procedure](operations.md#environment-bound-provisioning-and-secret-changes),
with quarantine enabled, no public entry surfaces, and all intake and
outbound disabled. Do not copy a live Worker configuration, recycle namespace
IDs, rename a namespace, or publish an unreviewed candidate.

**One-time existing-staging migration only:** `deploy-staging.yml` now has a
`bootstrap_staging` opt-in and `expected_active_version_id` field. This is
restricted to the existing `agent-table-staging` Worker when precisely the
four `RELEASE_ENVIRONMENT`, `RELEASE_BUILD_SHA`, `RELEASE_PROFILE` and
`RESTORE_QUARANTINE` text bindings are absent from both its settings and
active version. Before publishing, the branch-protected staging Environment
readback, successful exact-main manual CI, actual retention/cost/restore
operator disclosures, intact four SQLite DO namespaces, OAuth KV, secret
names, custom domain and expected active version must all be verified. The
existing staging admission settings must be `true` while the approved
candidate switches **both** new-guest and new-table intake to `false`; all
outbound/subscription/Events flags remain `false`. This intentionally pauses
new admissions, not existing owner read/close/delete privileges. It is not
an exception for production, unknown Workers, changed namespaces, restored
snapshots, or already bootstrapped Workers. The bootstrap operations record
must specify `bootstrap.mode: "staging-legacy-identity"`, the exact current
version ID and `retainedStateImpactReviewed: true`; it must leave
`schema.nonDestructiveRollback: false` until a real retained-state staging
rehearsal succeeds. Never substitute this one-time waiver for a verified
rollback or clear a quarantine. The workflow read-checks the active version
again just before writing and performs normal strict post-deploy verification.

## 1. Resource and access preparation

1. Confirm the account identity and ownership of the **staging** and
   **production** Worker, each SQLite DO namespace (`TABLES`, `GUESTS`,
   `OAUTH_SERIALIZER`, `ADMISSION`), OAuth KV namespace, secret names, and
   selected custom HTTPS hostname. Each environment needs a distinct Worker
   name (`*-staging`, `*-production`), domain, KV and four DO namespace IDs.
   Never reuse an existing legacy KV-backed OAuth serializer as a new SQLite
   class; review the deployed migration tags before any change.
2. For initial provisioning, use the reviewed
   [environment-bound procedure](operations.md#environment-bound-provisioning-and-secret-changes)
   before establishing the approved domain binding. Keep `workers_dev: false`
   and `preview_urls: false`. Confirm these **live** settings and the paginated
   account namespace owner list, not just JSON. The release gate checks the
   active Worker version, named class handlers, migration tag, version-bound
   DO/KV IDs, provider-owned SQLite namespaces, an exclusive enabled domain
   route, and both exposure switches; missing settings fail closed.
   Cloudflare's optional declarative `script_runtime.exports` are checked if
   present, but are not required when the other independent version and
   namespace proofs exist. A valid custom domain must already resolve over
   HTTPS with a certificate for the intended host. Verify Host/Origin behavior
   and public security controls on that actual domain.
3. Inject secrets **interactively** and separately for each explicitly targeted
   Worker using the [secret-change procedure](operations.md#environment-bound-provisioning-and-secret-changes).
   `wrangler secret put` immediately deploys a new Worker version; it is a
   reviewed mutation, not offline preparation. Verify the approved target
   configuration before each change and the active version/bindings after it.
   Each Worker needs
   independent `INVITATION_RESPONSE_KEYRING` and
   `CALLBACK_CREDENTIAL_KEYRING`; admission with `GUEST_CHALLENGE_MODE=required`
   additionally needs `TURNSTILE_SECRET` and the selected public site key.
   Obtain actual secret-name inventory by authenticated Cloudflare readback;
   the gate never reads, saves, or logs their values. Follow
   [bounded key rotation](operations.md#bounded-key-rotation),
   respecting the seven-day maximum overlap and the grace-period expiry of
   old ciphertext readers. The approved production K3 policy retained no
   recoverable offline key copy; follow the unavailable-old-key branch instead
   of assuming seamless overlap rotation is possible. Rotate provider/OAuth
   client credentials through their own independent authorization flows.
4. Configure GitHub Environments with deployment branches restricted to
   protected `main`: `staging` has **no required reviewer** or waiting rule,
   while `production` requires explicit review by the owner. Destructive
   staging recovery uses a separate `staging-recovery` approval job with
   required owner review, then accesses staging credentials in the normal
   `staging` Environment. Verify these policies before use; the staging
   release verifier rejects an unexpected protection rule or loss of branch
   protection, and recovery rejects missing/wrong approval history.
5. Scope the **write** `CLOUDFLARE_API_TOKEN` to the intended account and Worker
   deployment operation only. Scope the **separate read token**
   `CLOUDFLARE_READ_TOKEN` to Worker scripts/settings, deployments/versions,
   custom-domain routes, secret *names*, and KV namespace metadata for the
   exact resources being checked. Do not give PR CI these tokens. Test both
   tokens using read-only operations first. GitHub's `GITHUB_TOKEN` for the
   approved workflow requires Actions Read to authenticate exact-main CI.

To verify the newly configured read tokens without publishing, dispatch
`Protected release read credential verification` from `main` once for each
`target_environment` (`staging` and `production`), supplying the exact current
`main` SHA. Staging starts without GitHub reviewer action; production starts
after the owner explicitly approves the protected Environment.
The job uses **only** that Environment's `CLOUDFLARE_READ_TOKEN` and reads
both Workers' settings, subdomain exposure, secret names, deployed versions,
KV namespace metadata, and account domain/SQLite namespace lists. A green
result proves the required GET access is available; it **does not prove the
token lacks write privileges**, nor does it authorize a release. Failed
probes must be resolved by changing token scope through the standard owner
approval process, never by temporarily enabling public routes or publishing.

**Account-wide read scope is required for the current verifier.** The Cloudflare
`GET /workers/domains` and `GET /workers/durable_objects/namespaces`
endpoints enumerate account resources; granting only `Individual Workers
Metadata Read-Only` to the two Worker IDs does not establish access to these
lists. The current verifier needs `Workers Scripts Read` and `Workers KV
Storage Read` at account scope for domain/namespace ownership and KV metadata
GETs. These scopes also grant wider read capabilities than this probe uses
(including Worker script content and KV values), so the owner must review that
trade-off before editing either token. Preserve separate staging/production
secrets and never grant write/DNS permissions for a GET-only probe. See
[Worker Domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/),
[Durable Object namespaces API](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/)
and [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

The probe batches independent metadata GETs first and version/KV GETs after
their IDs are validated. If multiple endpoints in one batch are refused,
`READ_CREDENTIAL_BLOCKED` lists deterministic endpoint labels separated by
commas, with no provider response body or credential material. An earlier
failed batch or structurally invalid response can prevent later dependent GETs;
a single failure report is **not** a complete permission audit.

The following protected Environment secrets are required for **each**
environment; the two sets must not share credentials or private resources:

| Name | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Actual 32-character account ID |
| `CLOUDFLARE_READ_TOKEN` | Limited readback of resources, metadata and release evidence |
| `CLOUDFLARE_API_TOKEN` | Separate narrowly scoped Worker publication credential |
| `RELEASE_CONFIG_JSON` | Exact staging or production Wrangler JSON bytes |
| `PEER_CONFIG_JSON` | Complete separately reviewed opposite-environment JSON |
| `RELEASE_SECRET_INVENTORY_JSON` | Redacted expected name-only inventory |
| `RELEASE_EVIDENCE_JSON` | Exact build/config-bound CI evidence manifest |
| `RELEASE_OPERATIONS_JSON` | Recent reviewed operational/retention/cost/rollback record |

`account_id` belongs in each *private* Wrangler JSON file. GitHub Environment
secrets contain no credential values in their **key/value manifests**; actual
Cloudflare Worker secret values are injected through its protected secret
mechanism and never committed to a repository, workflow log or issue.

Before approving either deployment, run the corresponding **no-publish**
`verify-staging-config.yml` or `verify-production-config.yml` from the
current `main` commit with `expected_sha` set to that commit's full SHA.
The owner must approve access to that environment's protected inputs. These
jobs intentionally carry no Cloudflare tokens, check the exact private config
bytes and peer/environment identity, and require `RELEASE_OPERATIONS_JSON` to
remain `pending` with unverified retention, cost, restore and rollback claims.
They cannot satisfy the later deployment gate. After any `main` change,
regenerate both environments' private config SHA-bound evidence rather than
reusing an earlier approval or an obsolete build identity.

## 2. Assemble exact immutable release inputs

Use a dedicated operator host and secret manager, not a public terminal log.
The configuration is strict JSON, with the existing chronological `v1`, `v2`,
`v3` SQLite class migrations; no nested Wrangler `env`, alternate entrypoints,
unsafe bindings, custom build, assets, alternate route or trigger.

Example of writing **synthetic/redacted templates**, not real credentials,
with nonsecret data replaced before private use:

```sh
umask 077
tee /secure/operator/secret-names.json <<'EOF'
{
  "environment": "staging",
  "workerName": "agent-table-staging",
  "bindings": ["INVITATION_RESPONSE_KEYRING", "CALLBACK_CREDENTIAL_KEYRING"]
}
EOF
```

Determine the immutable 40-character main source SHA and hash the **exact
`RELEASE_CONFIG_JSON` bytes**, without whitespace normalization:

```sh
TESTED_BUILD_SHA="$(git rev-parse origin/main)"
sha256sum /secure/operator/wrangler.staging.json
```

That config must include `vars.RELEASE_BUILD_SHA` equal to the exact SHA and
`vars.RELEASE_PROFILE: "manual"` on the target; peer config also needs a
valid recorded build SHA/profile for its currently reviewed state. Do not
replace the peer's current build identity with the target's without checking
actual deployment state.

After running the **full `Validation` workflow manually on that exact main
SHA**, take the successful workflow run URL (the same run for all three
categories). Example manifest template:

```sh
tee /secure/operator/evidence.json <<'EOF'
{
  "environment": "staging",
  "buildSha": "<exact-40-character-main-sha>",
  "configSha256": "<sha256-of-exact-config-bytes>",
  "checks": {
    "application": {"status": "passed", "refs": ["https://github.com/kitamura-tetsuo/agent-table/actions/runs/<id>"]},
    "security": {"status": "passed", "refs": ["https://github.com/kitamura-tetsuo/agent-table/actions/runs/<id>"]},
    "browser": {"status": "passed", "refs": ["https://github.com/kitamura-tetsuo/agent-table/actions/runs/<id>"]}
  }
}
EOF
```

The gate fetches the actual run from GitHub and requires a successful
`workflow_dispatch` from `main` at the exact SHA, in `Validation`, with one
successful `verify` job and required named steps: typecheck, lint, unit,
Workerd integration, restore runtime, browser E2E and Wrangler dry-run.
Synthetic manifests are never sufficient.

Before each approval, record a current deliberate operator decision, with
verified URLs to current Cloudflare backup/log retention policies and a real
environment-specific measurement. Example *shape* (values are illustrative,
not proof):

```sh
tee /secure/operator/operations.json <<'EOF'
{
  "environment": "staging",
  "profile": "manual",
  "buildSha": "<exact-40-character-main-sha>",
  "configSha256": "<sha256-of-exact-config-bytes>",
  "origin": "https://<approved-staging-hostname>",
  "review": {"operator": "kitamura-tetsuo", "decision": "approve", "reviewedAt": "<actual-UTC-ISO-timestamp>"},
  "retention": {
    "backup": {"status": "operator-verified", "reviewedAt": "<actual-UTC-ISO-timestamp>", "policy": "<actual-observed-recovery-window-and-limits>", "source": "https://<actual-policy-source>"},
    "logs": {"status": "operator-verified", "reviewedAt": "<actual-UTC-ISO-timestamp>", "policy": "<actual-access-and-retention-policy>", "source": "https://<actual-policy-source>"}
  },
  "schema": {"testedVersion": 15, "nonDestructiveRollback": true, "rollbackRunbook": "https://github.com/kitamura-tetsuo/agent-table/blob/<exact-40-character-main-sha>/docs/operations.md"},
  "restore": {"type": "no-restore", "independentlyReviewed": true},
  "cost": {"usageObserved": true, "measurementSource": "https://<actual-cloudflare-metric-receipt>", "currentPricingSource": "https://developers.cloudflare.com/workers/platform/pricing/"}
}
EOF
```

The JSON `reviewedAt` fields must be at most 24 hours old. Approval metadata
does **not** independently prove backup configuration, actual cost, restore
reconciliation or successful rollback. Do not claim `operator-verified` or
`usageObserved:true` before you have reviewed those facts. The current
schema version is `15`; update its explicit acceptance check when schema
changes, never silently reuse an old rollback proof.

Do an offline preflight first, then commit those **private JSON bytes only to
their intended protected Environment secrets**; never add them to git:

```sh
node scripts/release-preflight.mjs \
  --environment staging --profile manual \
  --build-sha "$TESTED_BUILD_SHA" \
  --config /secure/operator/wrangler.staging.json \
  --peer-config /secure/operator/wrangler.production.json \
  --secret-inventory /secure/operator/secret-names.json \
  --evidence /secure/operator/evidence.json
```

Expected success is `PREFLIGHT_MANIFEST_VALID` with
`deploymentApproved:false`. If anything is missing or mismatched, stop.

## 3. Deployment authorization

1. Dispatch `deploy-staging.yml` on the **exact** `main` SHA with
   `expected_sha`. The `staging` Environment has no GitHub approval step.
   The GitHub policy readback must still confirm protected-branch restriction
   and absence of reviewer/wait rules. Provide fresh reviewed operational and
   capability evidence through its Environment secrets. For production,
   dispatch `deploy-production.yml` and explicitly approve the owner's GitHub
   Environment review before proceeding.
2. The job checks checkout SHA, runs application tests and a
   fresh Wrangler **dry-run without deployment credentials**, then reads
   Cloudflare **and GitHub** with separate read-only tokens. For production,
   GitHub's review-history endpoint must show explicit approval by the verified
   owner `kitamura-tetsuo` for this exact run; for staging it verifies the
   actual reviewer-free Environment policy instead. Workflow reruns remain
   forbidden: dispatch a new run after a failure. The gate requires the currently
   advertised `main` head to match the tested SHA and rechecks this immediately
   before the publish write. The identity
   readback includes both deployed Workers, actual four SQLite DO namespace
   IDs and version exports, OAuth KV namespaces, named secrets, one enabled
   custom domain each, and disabled workers.dev/previews. Missing/inconsistent
   state aborts **before publication**. It also refuses a previously
   quarantined live Worker; clearing an old restore is Issue #51, not #50.
3. A single in-job `RELEASE_APPROVAL_VALID` manifest binds the approved
   environment, SHA, exact config digest, CI run, bound run/attempt and
   redacted provider receipt. `require-release-approval.mjs` verifies it
   before the job receives the write credential. There is no checked-in
   static override or manual `deploymentApproved:true` file.
4. Only then does Wrangler deploy exactly the SHA-256-pinned candidate. The
   post-step re-fetches Cloudflare resource identity, active version and all
   release settings, then performs a bounded HTTPS `/health` read requiring
   the expected environment, manual profile and SHA. Capture the redacted
   postverify receipt and job URL. The job removes its temporary private
   inputs on every outcome.
5. Run targeted real-host staging checks: accepted manual browser access,
   invite/create/join/read/post against synthetic test participants, closed
   and deleted table denial under **normal intake pause**, SQLite state
   preservation across an update/restart, rate limits and a genuine Turnstile
   round trip **if public guest admission is enabled**. Confirm older schema
   rollback refusal without touching private storage. These are host tests,
   not substitutions by mocks, local Workerd fixtures or the `/health` route.
6. Only after staging is demonstrably acceptable, repeat with a separately
   reviewed production origin, actual production credentials and resources,
   new exact-main evidence and a new protected `deploy-production.yml`
   approval. **Never copy staging tokens, DO/KV IDs or consent decisions**.

The release job **does not** post a success notification outside GitHub,
automatically revert a failed deployment, or turn on outbound messages.
Failed verification after publish is an incident needing monitored human
action; it is not permission to delete or reset private namespaces.

## 4. Intake pause, recovery and rollback

- **Normal pause:** make a separately approved no-intake release that sets
  `ALLOW_NEW_GUESTS=false`, `ALLOW_NEW_TABLES=false`,
  `ENABLE_MCP_SUBSCRIPTIONS=false`, `ENABLE_OPENAI_EVENTS=false`, and
  `ALLOW_OUTBOUND_NOTIFICATIONS=false` while keeping verified current
  `RESTORE_QUARANTINE=false`. Confirm on the *real* host that new admission
  and table creation stop, but existing owner browser close/delete and
  authorized reads/exports continue to work. Record the observed status and
  current DO state, not just intended bindings. A successful Wrangler command
  is insufficient: **both** service settings and active-version text bindings
  must independently show all five switches disabled and must agree with the
  reviewed canonical config.
- **Normal-pause provider receipt (read-only):** after a no-intake deploy or a
  version rollback, first independently obtain the expected 100%-traffic
  active version ID, then run the following script on an authorized operator
  host with the environment's `CLOUDFLARE_READ_TOKEN` available in the
  process environment. Both config files must be the real, reviewed private
  JSON inputs; the peer config is required to verify environment isolation.

  ```sh
  node scripts/release-pause-readback.mjs \
    --config /secure/operator/wrangler.staging.json \
    --peer-config /secure/operator/wrangler.production.json \
    --expected-version-id '<independently-observed-version-uuid>'
  ```

  The only success receipt is `PAUSE_READBACK_VERIFIED` with environment,
  Worker, active version, deployment ID and build SHA (no secrets/private
  data). On any `PAUSE_READBACK_BLOCKED` code, treat the pause as **unverified**
  and stop promotion; do not trust a provider version selector or proceed to
  production. In particular `provider-version-config-unverified` means
  Cloudflare service-level settings and the active version's bindings disagree.
  This exact condition was observed after the 2026-11-12 staging
  `ALLOW_NEW_TABLES` temporary-admission rollback, despite Wrangler reporting
  success. It was resolved only by a **separately owner-approved, byte-for-byte
  canonical paused-config redeploy** followed by independent dual-surface
  verification. For a repeat incident, preserve evidence, evaluate ongoing
  exposure and seek fresh authorization for the contained settings repair;
  **never automatically redeploy, clear quarantine, delete namespaces or
  silently declare intake stopped**. Follow a verified pause receipt with
  real HTTPS health, admission-denial and existing-guest lifecycle tests.
- **Bounded pre-launch relay trial stop:** a separately approved stop may keep
  the same schema-compatible build, private profile, finite policy, relay config
  and signing identity while setting all five switches above to false. This
  stops new guest/table admission as well as notifications. It need not restore
  the old production build, change to manual, delete old content or reset storage.
  Verify this exact paused configuration with the full-pause readback path;
  retained config/key presence is not removal or uninstallation. The active and
  stop config hashes differ and each needs its applicable exact protected
  authorization. A notification-only stop preserving intake cannot receive the
  full-pause receipt.
  This procedure does not waive `testedVersion`/`nonDestructiveRollback` or prove
  them true: the operator must review applicable actual test/operational evidence
  and the exact-build runbook before making that declaration. Fixture inputs or
  an intention not to preserve pre-launch content are not successful rollback
  evidence. Keep local/CI and hosted observations distinct.
  Hold the relay's private foreground controller until pause/drain/stop, and
  enforce the separately verified environment-side deadline from setup start.
  Missing stop output, forced kill or unknown finish is not success/no-send.
  Preserve original event/request/digest/attempt receipts and read back uncertain
  operations before retry. Current authority and original retry budgets still
  apply; a permitted next ordinal is not a same-ID replacement.
  Verify the production-bound host subscription's stop control before enabling
  it. Apply only the approved synthetic session/table terminal action under the
  current lifecycle contract, and stop its monitoring; already started host
  work is not recalled. If provider APIs are unavailable, separately prove local
  process cessation and leave Worker pause/remote cleanup pending until exact
  target readback. Timer exit or policy expiry does not prove those changes.
- **Security incident, unknown backup history or stale authority:** first
  stop external intake/delivery, then install a separately approved
  `RESTORE_QUARANTINE=true` candidate using the offline
  `--prepare-restore` generator. This intentionally returns 503 on **all**
  public routes, including browser deletion. It preserves SQL and prevents
  alarm cleanup/dispatch; route operators to independent recovery, not to
  normal close/delete. **Never** clear this mode from a copied Worker
  snapshot or the manual release workflow. Use independently verified later
  authority, or the separately approved [fresh-start discard procedure](fresh-start-recovery.md),
  before an exact, independently approved clearance decision.
- **Compatible Worker rollback:** identify the prior actually deployed
  version ID and current schema version. Verify the old version understands
  all persisted schema versions (currently `15`), secret formats, and
  migration history before an independently reviewed Wrangler rollback.
  Roll back Worker *code*, **not** KV/DO namespace ownership or historical
  private SQL. The app must refuse unsupported newer-schema constructors;
  if an older reader is unsafe, leave the data quarantined and deploy a
  forward-compatible repair instead. Recheck both Worker versions, domain,
  secrets, active DO/KV identity, public `/health` and lifecycle invariants.
  Run the normal-pause dual-surface readback above; a code-version rollback
  may **not** restore the old text-binding service settings. The successful
  same-config staging rollback is not proof of older-schema compatibility.
- **Point-in-time restoration** is not code rollback. The recovery candidate
  remains inaccessible until independent authority reconciliation. The
  platform's advertised backup window is not a substitute for measured
  recoverability or current consent. Never destroy newer DO storage to
  rehearse a rollback. Use isolated synthetic test tables or an explicitly
  approved data-preserving staging plan.

Consult [Cloudflare SQLite DO point-in-time recovery](https://developers.cloudflare.com/durable-objects/reference/sqlite-in-workers/#point-in-time-recovery),
[Workers rollback](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/),
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
and [current Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
at operation time. Publish the account's **actual** backup recovery window,
log retention, query accessibility and safe deletion policy; vendor defaults
can change, and privacy data cannot be guaranteed erased by rollback.

## 5. Recorded evidence and operation-time gates

These dated receipts establish the scope actually exercised. Recheck the
current provider state before another operation; historical approvals do not
authorize a new deployment, key change, public profile or recovery incident.

| Acceptance item | Current proof | State |
| --- | --- | --- |
| Structural preflight, fail-closed checks and generated-restore local oracle | Local and CI tests, PR #46 | Implemented code; not hosted approval |
| Staging secret/config access | [protected config readback #43115024418](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43115024418), commit `70cfe1c`, SHA-256 `22b619dd3af71bce1688a7f3ec2e451654cea0a28ac6e166f70bfa98513bb867` | Verified no-publish only; stale after new `main` commit |
| Environment policies | Historical reviewer/`main` readback 2026-11-11 and staging/production Cloudflare GET access [#43104683889](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43104683889), [#43104688167](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43104688167) | Current policy: staging branch-protected without GitHub review; production and staging-recovery retain owner review. Reverify at dispatch |
| Both true Cloudflare Worker/DO/KV identities, origins, inventories | [Staging provider receipt](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6814836152) and independent staging/production readback in the [final acceptance](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6825493911) | **Verified** for the recorded 2026-11-12 builds and configurations; recheck before next release |
| Staging protected deploy, host smoke, retained-state update/rollback | [Staging bootstrap](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6814836152), [same-config update + pinned rollback](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6815095095), [binding-drift finding and canonical repair](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6818264043) | **Passed** for same-source/same-config retained synthetic data; this #50 rehearsal did not restore a snapshot or establish arbitrary older-schema compatibility. #51 separately exercised PITR and newer-schema refusal below |
| Normal pause and existing-guest browser Close/Delete | [7-day synthetic fixture and settings repair](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6818264043), [browser Close/Delete and independent `TABLE_NOT_FOUND` postconditions](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6820766589) | **Passed** on staging; prior browser POST refresh showed CSRF rejection and stale response label, but a fresh GET confirmed closed |
| Staging pause after text-binding change | Independent provider check rejected a Wrangler rollback with settings/version divergence; fully canonical redeploy yielded active version `f0701beb-db3a-4c6a-b224-7e988d438bc4` and matching disabled intake [receipt](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6818264043) | **Repaired and verified**; perform new readback before subsequent changes |
| Production origin, scoped tokens, protected deploy and host smoke | [Approved production run #43229649298](https://github.com/kitamura-tetsuo/agent-table/actions/runs/43229649298) and [independent readback](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6825493911): `agent-table.outliner-online.com`, build `381c4e7378b2d95a3b8342f045a3e4d5521ada00`, version `ce3f4589-57f1-467c-88fa-a9adbfa3628d` | **Passed** for the separately approved paused manual release; no restore, public Events or autonomous support claim. Another release needs new exact-target approval |
| Backup/log retention disclosures | [Owner-accepted limits](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6824625669): production dashboard Logs/Traces disabled, earlier Logpush off; published SQLite PITR policy disclosed separately from actual production recoverability | **Accepted with explicit limits** for #50. Production PITR was not drilled; account-wide retained diagnostics/backups and third-party copies are not independently attested or universally erasable |
| Measured hosted usage and deployment-time pricing | [Provider/dashboard measurement scope](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6824625669) and [invoice waiver](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6824960944); account billing API returned 403 | **Accepted with actual charges UNKNOWN**, not zero. Selected zero-valued metrics are not account-wide storage/cost proof; no automatic cost-stop mechanism was configured or tested |
| Post-snapshot recovery and controlled clearance, #51 | [Real hosted PITR/discard/schema-refusal evidence](issue51-cloudflare-recovery-evidence.md) and [approved private synthetic clearance](issue51-synthetic-clearance-evidence.md), 2026-11-15 | **Verified for the isolated synthetic recovery Worker only**; existing staging/production recovery and public exposure require their own exact approvals |

Record each actual deployment in a separate staging/production issue comment
or retained operator log with UTC timestamp, GitHub run ID/attempt, source
SHA, config digest, origin, profile, redacted Cloudflare account/Worker/KV/DO
namespace identifiers, old/new version IDs, observed schema, expected versus
actual release flags, health/host checks, absence of Events capability,
backup/log-retention limits, observed usage and exact pricing reference.
Never record private table content, tokens, callback addresses, secret values,
session IDs, or unredacted provider responses.
