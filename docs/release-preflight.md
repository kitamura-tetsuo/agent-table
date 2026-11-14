# Release configuration preflight (Issue #22 / Issue #50)

This script is a fail-closed **offline structural preflight**, not an independent proof of evidence or permission to expose private state. The separate protected-environment [authenticated release workflow](release-runbook.md) adds exact-main CI verification, fresh independently reviewed operator disclosures, live Cloudflare resource/secret/domain/version readback, approval and post-deploy verification. A signed-off PR or offline `PREFLIGHT_MANIFEST_VALID` cannot authorize a deployment. Production infrastructure, credentials, approvals and real-host evidence must still be supplied and executed separately; this document does not claim they exist. Reconciliation-based restore-quarantine **clearance** remains unimplemented and belongs to Issue #51. Do not use this script's output alone to enable Events/autonomous functionality.

The staging-only [`private-pilot-a-only` verification profile](compatibility/private-pilot-activation.md)
uses the same protected release path with a separately reviewed finite policy.
It gathers actual host evidence while global/public Events flags remain false;
it does not assert that the real-host compatibility gate has already passed.
Its separately reviewed `a-only-discovery` mode accepts an actual host callback
origin with zero outbound traffic and no active subscription. It requires an
empty target list, explicit private redacted observations and an active finite
window; it cannot be substituted for the reviewed `a-only` delivery policy.
Observation collection may be incomplete and cannot turn missing host evidence
into acceptance. Both modes retain the same exact-main protected release path.

## Boundaries

`scripts/release-preflight.mjs` evaluates one concrete target and a separate environment's candidate configuration. The target file must be JSON (a strict subset of JSONC). The script refuses unknown/placeholder OAuth KV IDs, HTTP/loopback origins, missing or misnamed four DO bindings, modified/reordered SQLite DO class migration declarations in either environment, foreign-worker DO binding delegation, missing strict public-fetch mode, missing environment markers, duplicate worker names, identical staging/production OAuth KV IDs or origins, and missing required named keyring secrets in an **externally captured inventory**. Both the target and peer configurations must explicitly disable `workers_dev` and `preview_urls`, and specify the expected Worker entry, public-fetch compatibility flag, correctly suffixed environment Worker name, independent restore-quarantine binding and complete boolean capability-switch set; the peer is not accepted merely because its KV ID and origin differ. Wrangler defaults `workers_dev` to `true`, so an omitted value is rejected instead of implicitly publishing an unreviewed `*.workers.dev` endpoint. The preflight and restore generator also reject Wrangler's nested `env` configurations, custom `build` hooks and `unsafe` bindings in **both** environments. Wrangler's `--env` can replace validated root-level bindings; in particular, an unreviewed nested environment could turn `RESTORE_QUARANTINE` off when the root candidate was verified as quarantined. These deployment surfaces are unsupported until the effective configuration selected by the intended deployment command can be separately verified. Keep one explicit, environment-specific Worker file, without nested profiles or custom build/binding overrides. This protects against common accidental configuration mixing. It does not inspect actual Cloudflare namespace ownership or guarantee that two Worker scripts cannot reference the same historical namespace: verify the deployed migration/class/namespace ownership in Cloudflare before any change.

A profile-specific evidence manifest must target the exact build SHA, environment, and SHA-256 digest of the exact target JSON bytes. Manual requires separate application, security, and browser test references. Live requires `live_runtime`; Events requires `egress`, `provider`, `delivery`, `real_host`; autonomous requires `autonomous_runtime` as well. Missing, failed, wrong-target or non-HTTPS references are rejected. Merely setting feature flags does not grant readiness. **References are syntactically checked, not fetched or independently authenticated**; synthetic or guessed links are not evidence. Review the underlying artifacts, their timestamps and actual target platform before any operator decision. A marked-pass JSON file is not a release authorization.

The Worker entry point also refuses **all requests**, including `/mcp`, consent, guest management and `/health`, when either `RELEASE_ENVIRONMENT` or `RESTORE_QUARANTINE` is absent, unknown or set to quarantine. The committed local scaffold explicitly uses `local` / `false`; in staging and production, only an operator-reviewed independent Worker binding may set quarantine to `false`. This slice guards ingress and the existing outbound-notification eligibility hook: even if its notification flag is true, missing, unknown, or quarantined release state makes that hook deny dispatch eligibility. The current TableDO durable Events outbox checks quarantine at dispatch eligibility, and its alarm exits before any outbox reservation, delivery or cleanup when quarantined; GuestDO's alarm also defers cleanup. This covers the implemented producer, not hypothetical future outbound paths, which must apply the same independent dispatch-time guard. A quarantined alarm parks its next wakeup for six hours without pruning private SQL records; this costs future alarm invocations until independently approved release. Cleanup on the next wakeup still requires current lifecycle authority, and these periodic wakeups are not evidence that external revocations or deletions were reconciled. The local integration fixture injects quarantine into a real DO alarm receiver over SQLite rows but does not emulate Cloudflare restore, redeploy or missed external revocations. Additional synthetic cases change an independent binding after DO eviction and verify that a retained old session cannot pass the ingress guard without reconciliation; a separate future-schema fixture invokes the real TableDO/GuestDO constructors on retained SQL rows to refuse rollback without erasure. Workerd regressions check a synthetic retained SQLite table before and after DO eviction, and separately exercise normal new-table pause with the actual close service and browser-confirmed deletion. These tests do not simulate Cloudflare deployment, restore from an older backup, an independently reconciled revocation ledger, or a staging/production restart. The eventual release process must independently reconcile post-snapshot deletion/revocation/expiry records before any clear operation. The checked-in synthetic `test/fixtures/quarantined-restore-generated.json` is produced with the actual `--prepare-restore` generation logic against stale-enabled configuration. A Node test compares that fixture with the generator, while a Workerd/retained-SQLite integration test applies its resulting bindings to the real Worker ingress after DO eviction, checking refusal and retained rows. This joins the *offline generated configuration* to the *local Worker runtime*; it does not simulate Cloudflare's deployment configuration binding, historical snapshot restoration, or independent authority reconciliation. The fixture contains only synthetic IDs and hostnames. It is never safe to treat this 503 guard alone as recovery evidence.

The inventory holds **names only**, not secret values. Generate it only after checking the corresponding Worker with an authenticated, narrowly scoped `wrangler secret list` or the Cloudflare dashboard and compare the actual target account/Worker. This script cannot prove that an inventory was genuine or that its secrets are decryptable. Never copy actual secret values or passwords to a file, PR, or CLI argument. Existing local `wrangler.jsonc` is not a deployable staging or production configuration; its placeholder KV ID must fail validation.

## Synthetic generated-configuration runtime oracle (local/CI only)

`npm run test:restore-runtime` launches a **separate isolated Workerd/Vitest project** with the exact checked-in `test/fixtures/quarantined-restore-generated.json` as its Wrangler configuration, not a hand-overridden `worker.fetch` binding. The small `test/fixtures/src/index.ts` shim only resolves the real application entry relative to the fixture; it does not replace the Worker or Durable Object code. The independent Node generator regression still checks the candidate bytes against `--prepare-restore`. This runtime test creates synthetic old SQLite session/table/message records, evicts the TableDO and GuestDO, checks real public Worker 503 refusals, and invokes **actual reconstructed DO alarm handlers without an injected env receiver**. It asserts expired data and apparently valid but potentially stale grants cannot be pruned or exposed while the generated quarantine binding is installed, and that alarm rearm remains bounded. A due synthetic Events outbox row is retained unchanged (pending, zero charged attempts and no lease) after the real quarantined TableDO alarm. Setting only the Worker request's flag while leaving reconstructed DOs unquarantined would fail this SQL/alarm oracle.

This is a **synthetic configuration and object-reconstruction check**, not a two-version Cloudflare deployment, an actual historical snapshot restore, or reconciliation of independently missing revocations/deletions. The test-only initial rows are seeded directly under the isolated fixture; it does **not** prove data migration across an actual deployment/version switch. Real **retained-private-state** staging/production restore/restart, independently sourced post-snapshot authority and operator **release** approval remain **NOT RUN / BLOCKED**. No quarantine-clear path is implemented or authorized.

An additional [isolated Cloudflare quarantine-only staging smoke](pr46-cloudflare-quarantine-evidence.md) was completed on 2026-11-10 UTC at tested source `473ee87`: Cloudflare settings and HTTP denial were read back after the first deployment and again after a second deployment with a new version ID, then the temporary `workers.dev` and preview routes were disabled. This verifies **real provider binding propagation and deny-by-default ingress across an empty-state redeployment**. It does **not** change the preceding limitation: no historical private-data restore or independently reconciled authority was involved, and no protected release workflow or quarantine clearance was exercised. In particular, this smoke cannot serve as the retained-state staging/production restart evidence required before an actual restoration decision.

The generated-config runtime also establishes a synthetic old session, connection grant, table membership and private transcript whose historical authority may have been revoked or deleted after the snapshot. With the real reconstructed TableDO under quarantine, direct internal `readMessages`, `postMessage`, `checkInboxSubscription` and `openInboxHintStream` requests must refuse despite that seemingly valid retained grant. Both agent and browser TableDO authorization helpers refuse in recovery mode, and a quarantined TableDO cannot emit new peer inbox hints. This covers a TableDO RPC path that the Worker HTTP ingress gate alone could not protect after the live-subscription implementation landed on `main`.

`scripts/restore-transition-workerd.test.mjs` additionally rehearses an **actual local Workerd lifetime/configuration transition** using persistent SQLite storage. Its first runtime creates and successfully reads a private table and subscribes with a real synthetic old guest session/connection under explicitly non-quarantined bindings. After that runtime is disposed, a second runtime uses the exact checked-in restore-generated configuration against the **same persistence directory**; HTTP entry points and direct TableDO read/write/subscription calls all refuse old authority, while SQL confirms the old message and session rows are preserved. A due historical Events outbox row also remains pending with zero attempts and no lease across the second and third Workerd lifetimes; the separate isolated generated-runtime test invokes the actual quarantined TableDO alarm and verifies the same invariant. A third quarantined runtime restart verifies the deny state remains in effect. CI runs this test alongside the other Node checks. This is stronger evidence than eviction in one runtime, but it is **still a local synthetic configuration change**: the first runtime is not a backed-up Cloudflare version, the data was not restored from a historical provider snapshot, and no external post-snapshot deletion/revocation ledger was reconciled. It grants no permission to clear quarantine or publish.

## Historical local snapshot rehearsal and remaining recovery decision

`scripts/restore-snapshot-workerd.test.mjs` takes a byte-checked copy of the
stopped local Workerd SQLite/KV persistence directory while synthetic authority
is still valid. A separate subsequent runtime revokes the connection,
invalidates the old browser session, confirms table deletion through the real
browser/CSRF flow, and observes a grant expire. It preserves these later
observations outside the snapshot before restoring the original files to the
same persistence path and namespace identities. The restored rows really do
contain the obsolete grant and deleted transcript again; reconstructed
quarantined Worker/DO instances must still deny them. Canonical SQL, unchanged
outbox attempts and captured outbound requests are the negative oracles.
Repeated reconstruction and a newer-schema refusal exercise preserve retained
private rows rather than resetting storage to make a test pass.

The direct boundary regressions in
`test/integration/recovery-boundaries.test.ts` cover GuestDO session/grant and
creation operations, direct cleanup, TableDO initialization/status/deletion
preview and event-candidate changes, and OAuthTokenDO provider entry. The
generated restore-runtime fixture seeds historical SQL directly: even fixture
setup must not imply that a quarantined GuestDO can create new sessions.
Constructors park their alarms under the same independent binding; the
generated-runtime tests invoke actual reconstructed alarm handlers and verify
that private state remains unchanged.

These checks establish **local historical-snapshot denial**, not a provider
PITR operation or a positive reconciliation/clearance decision. The
[Issue #51 decision proposal](restore-recovery-decision.md) records the missing
independent source, the unapproved privacy-preserving alternative and the
separate hosted/production acceptance still required. No new recovery-clear
command or deployment authorization is introduced by these regressions.

## Operator-only steps (not run in PR CI)

1. Create and independently review **two** environment-specific Wrangler configuration files outside this repository. Set root-level `workers_dev: false` and `preview_urls: false` on both; establish and verify intended HTTPS routing separately, because the preflight does not provision or attest the custom domain. Supply stable HTTPS origins, distinct Worker names ending `-staging` and `-production`, distinct actual OAuth KV IDs, four SQLite DO class bindings (TABLES, GUESTS, OAUTH_SERIALIZER, ADMISSION) and the existing chronological migrations. Set `vars.RELEASE_ENVIRONMENT` to the correct environment and `RESTORE_QUARANTINE` explicitly; leave quarantine `true` for any unverified restore. Keep notification feature flags false without separately verified capability evidence. Do not share secrets or callbacks across environments. Validate class migration history against the actual deployed namespace before editing old tags.
2. Capture a redacted secret-name inventory after confirming the actual account and worker. The JSON schema is `{ "environment": "staging", "workerName": "agent-table-staging", "bindings": ["INVITATION_RESPONSE_KEYRING", "CALLBACK_CREDENTIAL_KEYRING"] }`. Use `tee /secure/operator/secret-names.json <<'EOF'` on the authorized server if constructing this text file manually, and verify the names against the live secret-list result.
3. Collect **real**, non-secret evidence references for all required profile checks; create `/secure/operator/evidence.json` with `environment`, the exact 40-character `buildSha`, the SHA-256 of the target config bytes in `configSha256`, and `checks` entries of `{ "status": "passed", "refs": ["https://..."] }`. Do not substitute local SDK tests for provider or real-host events. Do not include tokens, cookies, personal IDs, callback URLs, or invitation secrets. Use the tested build SHA, not the current main by assumption.
4. Before any credential-bearing deployment operation, run the offline check:

```sh
node scripts/release-preflight.mjs \
  --environment staging --profile manual \
  --build-sha "$TESTED_BUILD_SHA" \
  --config /secure/operator/wrangler.staging.jsonc \
  --peer-config /secure/operator/wrangler.production.jsonc \
  --secret-inventory /secure/operator/secret-names.json \
  --evidence /secure/operator/evidence.json
```

`PREFLIGHT_MANIFEST_VALID` reports only structural consistency with `deploymentApproved: false`. `PREFLIGHT_BLOCKED` exits nonzero and intentionally prints no input content. This tool never runs `wrangler deploy`, mutates Cloudflare resources, or handles secrets.

## Prepare a fail-closed restore candidate (offline; not a clearance)

Before a restored snapshot is attached to an accessible Worker, an operator may generate a **new** configuration with quarantine and every public/ingress/outbound capability switch forced off. This transformation does not consult potentially stale restored session/grant data, does not approve deployment, and has no operation to clear quarantine:

```sh
node scripts/release-preflight.mjs --prepare-restore \
  --config /secure/operator/wrangler.staging.jsonc \
  --peer-config /secure/operator/wrangler.production.jsonc \
  --output /secure/operator/wrangler.staging.restore-quarantined.json
```

The command requires the operator-supplied counterpart configuration and checks distinct staging/production Worker names, HTTPS origins and OAuth KV namespaces, plus the peer's safe feature bindings and migration history. It validates the target's HTTPS origin, Worker entry/environment marker, DO bindings and immutable SQLite class-migration history, then writes the derived JSON exclusively (it refuses to overwrite any existing destination), with owner-only permissions on Unix. It prints **only** `RESTORE_QUARANTINED <config SHA-256>`, not the configuration or any secret. The output contains `RESTORE_QUARANTINE: "true"`, five disabled capability/intake switches, `workers_dev: false` and `preview_urls: false` regardless of stale snapshot values; it preserves the existing DO/KV namespace identifiers rather than renaming or deleting data. Review the generated file and validate it with new build/config-bound evidence before any separately authorized deployment.

**Independent reconciliation remains unavailable.** The command does not know later revocations, deletions, expiries, Cloudflare namespace ownership, secret validity or the real deployed configuration. The structural preflight still reports `deploymentApproved:false`, and no script provided here can convert a restored Worker to non-quarantined serving mode. A snapshot's old successful tests, grants, session rows, or `RESTORE_QUARANTINE:false` cannot be accepted as clearance. This is a reproducible synthetic configuration transition, not Cloudflare restore/restart evidence or authenticated provenance. An operator must retain quarantine when independent post-snapshot authority is unavailable.

## Authenticated Issue #50 release authorization and remaining operator blockers

- Separate manual staging/production workflows require the exact main SHA and a selected GitHub Environment. GitHub API readback on 2026-11-11 UTC confirmed required owner reviewers and protected-branch restrictions for **both** Environments; this is historical configuration evidence, not an approval of a deployment. The [protected staging credential check #42969129958](https://github.com/kitamura-tetsuo/agent-table/actions/runs/42969129958) verified staging-only read access to settings, **not** full release resource ownership or promotion.
- The protected workflow's **authenticated** `release-authorization.mjs` now emits a short-lived in-job `RELEASE_APPROVAL_VALID` only after exact-main CI provenance and live Cloudflare readback of both environments. `require-release-approval.mjs` must verify that manifest before publishing. Missing read tokens, production configuration, named secret inventory, selected domain, independently verified retention/usage disclosures, and required profile evidence remain **blocked**, rather than being replaced by fabricated metadata. See [release-runbook.md](release-runbook.md) for required Environment secret names, operator JSON schemas, current scope and the exact approval sequence.
- The authenticated gate supports `manual` and separately approved staging-only `private-pilot-a-only` verification. Public `live`, Events and autonomous releases and **independently reconciled restore-quarantine release** remain blocked. The private trial rechecks its exact recipient/table/callback scope, finite window and stop switch before new effects. Future DO-only outbound producers must apply the independent dispatch-time guard too. A restored copy of an older successful operator record does not clear missing post-snapshot revocations/deletions/expiry.
- A separately approved protected staging bootstrap and same-source,
  same-config, ID-pinned rollback **did** preserve retained synthetic Durable
  Object data [on 2026-11-12](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6815095095).
  A subsequent temporary-intake rollback exposed divergent service settings
  and active-version text bindings; a full canonical staging redeploy restored
  independently verified pause [receipt](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6818264043).
  The owner also completed synthetic browser Close/Delete
  [acceptance](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6820766589).
  Future paused-state claims must use the read-only
  `scripts/release-pause-readback.mjs` verifier. **Different-schema rollback
  and actual PITR restoration remain untested**; protected production
  deployment and private current-account backup/log retention and billed
  pricing/usage remain **not verified**. The checked-in constructor and
  Workerd oracle are still synthetic and do not replace those operator gates.

Local validation: `node --test scripts/release-preflight.test.mjs`. CI runs this automatically via `node --test scripts/*.test.mjs` and checks the new sources with Biome. No deploy command belongs in PR CI.

## Issue #24 autonomous evidence gate

The [two-owner ChatGPT pilot](compatibility/autonomous-pilot.md) supplies an
offline `probe:autonomous` collector/evaluator and a not-run selected record.
Under the owner's 2026-11-12 `a-only` condition, manually prompted Claude B posts
and idle ChatGPT A must automatically receive the event, run, read and reply.
The same B→A path must work after retained-state restart; exact-key retry,
pending-work cancellation and third-guest isolation remain required. B's
subscription or autonomous wake-up is not required, and an A-only pass cannot
be reported as bidirectional autonomy.

The report checks correspondence and receipt integrity; independent review
must establish origin. It is not release authorization or permission to enable
production Events. The [2026-11-12 #50 acceptance](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6825493911)
records the protected **paused manual** production release, superseding earlier
production-not-verified wording above only for that scoped release. A separate
private staging activation and concrete approval are needed for this pilot.
A no-restore restart is distinct from #51 historical restoration/quarantine
clearance; the latter must not be invented as a mandatory prerequisite for the
former. A manual approval, SDK result or different build's record supplies no
missing A-host causal evidence.
