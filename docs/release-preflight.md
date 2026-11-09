# Release configuration preflight (partial Issue #22)

This is a fail-closed **offline structural preflight**, not a deployment workflow, an independent proof of evidence, or permission to expose private state. All production promotion, restore quarantine and rollback authority remains **unimplemented**. Until the complete Issue #22 runtime and deployment gates are proven, an operator must **not** use this script's output to deploy publicly or enable Events/autonomous functionality.

## Boundaries

`scripts/release-preflight.mjs` evaluates one concrete target and a separate environment's candidate configuration. The target file must be JSON (a strict subset of JSONC). The script refuses unknown/placeholder OAuth KV IDs, HTTP/loopback origins, missing or misnamed four DO bindings, foreign-worker DO binding delegation, missing strict public-fetch mode, missing environment markers, duplicate worker names, identical staging/production OAuth KV IDs or origins, and missing required named keyring secrets in an **externally captured inventory**. This protects against common accidental configuration mixing. It does not inspect actual Cloudflare namespace ownership or guarantee that two Worker scripts cannot reference the same historical namespace: verify the deployed migration/class/namespace ownership in Cloudflare before any change.

A profile-specific evidence manifest must target the exact build SHA, environment, and SHA-256 digest of the exact target JSON bytes. Manual requires separate application, security, and browser test references. Live requires `live_runtime`; Events requires `egress`, `provider`, `delivery`, `real_host`; autonomous requires `autonomous_runtime` as well. Missing, failed, wrong-target or non-HTTPS references are rejected. Merely setting feature flags does not grant readiness. **References are syntactically checked, not fetched or independently authenticated**; synthetic or guessed links are not evidence. Review the underlying artifacts, their timestamps and actual target platform before any operator decision. A marked-pass JSON file is not a release authorization.

The Worker entry point also refuses **all requests**, including `/mcp`, consent, guest management and `/health`, when either `RELEASE_ENVIRONMENT` or `RESTORE_QUARANTINE` is absent, unknown or set to quarantine. The committed local scaffold explicitly uses `local` / `false`; in staging and production, only an operator-reviewed independent Worker binding may set quarantine to `false`. This slice guards ingress and the existing outbound-notification eligibility hook: even if its notification flag is true, missing, unknown, or quarantined release state makes that hook deny dispatch eligibility. **No outbound notification producer is implemented**, so this is not a complete outbound dispatch boundary; pending Durable Object alarms and any future outbound paths need their own direct quarantine enforcement. Workerd regressions check a synthetic retained SQLite table before and after DO eviction, and separately exercise normal new-table pause with the actual close service and browser-confirmed deletion. These tests do not simulate Cloudflare deployment, restore from an older backup, an independently reconciled revocation ledger, or a staging/production restart. The eventual release process must independently reconcile post-snapshot deletion/revocation/expiry records before any clear operation. It is never safe to treat this 503 guard alone as recovery evidence.

The inventory holds **names only**, not secret values. Generate it only after checking the corresponding Worker with an authenticated, narrowly scoped `wrangler secret list` or the Cloudflare dashboard and compare the actual target account/Worker. This script cannot prove that an inventory was genuine or that its secrets are decryptable. Never copy actual secret values or passwords to a file, PR, or CLI argument. Existing local `wrangler.jsonc` is not a deployable staging or production configuration; its placeholder KV ID must fail validation.

## Operator-only steps (not run in PR CI)

1. Create and independently review **two** environment-specific Wrangler configuration files outside this repository. Supply stable HTTPS origins, distinct Worker names ending `-staging` and `-production`, distinct actual OAuth KV IDs, four SQLite DO class bindings (TABLES, GUESTS, OAUTH_SERIALIZER, ADMISSION) and the existing chronological migrations. Set `vars.RELEASE_ENVIRONMENT` to the correct environment and `RESTORE_QUARANTINE` explicitly; leave quarantine `true` for any unverified restore. Keep notification feature flags false without separately verified capability evidence. Do not share secrets or callbacks across environments. Validate class migration history against the actual deployed namespace before editing old tags.
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

## Remaining Issue #22 release blockers

- Separate approval-protected staging/production workflows and authenticated Cloudflare resource/secret ownership checks are not yet implemented.
- Runtime profile-bound gating, newer-schema rollback refusal tests, and **independently reconciled restore-quarantine release** still need implementation. The current ingress guard uses a Worker binding outside the restored snapshot, but it does not block any future DO-only outbound path. Until independently reconciled revocation/deletion/expiry authority exists, restored data must remain offline.
- A complete production deployment/restore runbook needs verified backup and log retention disclosures, consented stable origin, incident pause, key rotation and measured usage. No production environment or external host is authorized or verified here.
- The manual pilot is verified only to the scope of #17's SDK/browser tests; named-host OAuth, subscriptions, outbound Events, and autonomous operation have separate unresolved gates.

Local validation: `node --test scripts/release-preflight.test.mjs`. CI runs this automatically via `node --test scripts/*.test.mjs` and checks the new sources with Biome. No deploy command belongs in PR CI.
