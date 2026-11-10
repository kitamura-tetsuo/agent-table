# PR #46: isolated Cloudflare quarantine-only staging evidence

Date: 2026-11-10 (UTC). Tested source: [`473ee879a9a32220cb8ca705a11b770397cd2370`](https://github.com/kitamura-tetsuo/agent-table/commit/473ee879a9a32220cb8ca705a11b770397cd2370). Prior exact-head [GitHub Validation #42805111765](https://github.com/kitamura-tetsuo/agent-table/actions/runs/42805111765) completed successfully, including Playwright; it is **separate from** the Cloudflare observations below.

## Environment, ownership and limits

- Used the already-authorized Cloudflare account from the user's `uf` host. An account-scoped API token was verified **active** with Cloudflare's account-token verification endpoint. Its value was neither displayed nor stored in the repository.
- Read the account's Worker and KV inventories before writing. The existing `agent-table-staging` Worker and its `agent-table-staging-oauth-kv` were left untouched.
- Created only `agent-table-pr46-restore-staging` with its **new**, empty `agent-table-pr46-restore-oauth-kv` namespace (`7a61348960204372a8fd415253d41f4f`). The new Worker owns its own four SQLite DO classes (`TableDO`, `GuestDO`, `OAuthTokenDO`, `AdmissionDO`), using the v1/v2/v3 migration declarations from the reviewed source.
- The detached repository clone on `uf` checked out the exact tested commit. Wrangler 4.158.0 built the application with `--dry-run` against an isolated local QA configuration; no application secrets, private messages or real user sessions were supplied.
- The QA configuration was **not** the protected production workflow's approved configuration. It deliberately had no secret bindings, disabled all five intake/Events/outbound switches, set `RELEASE_ENVIRONMENT=staging` and `RESTORE_QUARANTINE=true`, and used a new KV namespace and Worker name. Its source was not silently substituted for a production/staging promotion manifest. The separate preflight's `deploymentApproved:false` guard was **not changed**.

## Executed Cloudflare checks

| Observation | Actual result |
| --- | --- |
| First isolated deployment | Version `412dad82-9f5a-4013-aa03-80fa6c4421b5`; temporary `workers.dev` route for denial probes |
| Live HTTP ingress | `GET /health`, `GET /guest/me`, `GET /guest/connections`, `POST /mcp` and `POST /oauth/token`: each **503** |
| Cache control | `GET /guest/me`: `Cache-Control: no-store` |
| Cloudflare API configuration readback | `RESTORE_QUARANTINE=true`, correct `staging` marker, all five public/intake/outbound switches `false`, four expected DO bindings, dedicated KV ID |
| Second deployment of the **same** source/config | New version `70fd62e0-19f0-4989-b1aa-f30d39c2c414` (2026-11-10 11:32:44 UTC) |
| Post-redeployment gate | `GET /health` and `POST /mcp` still **503**; Cloudflare API still reports quarantine and the same dedicated KV |
| Final exposure reduction | Re-deployed with `workers_dev=false`, `preview_urls=false`, and no custom routes; final version `c90477a3-2eaf-498d-be75-23120d91b352` |
| Final Cloudflare readback | Both subdomain and preview URLs **disabled**, `RESTORE_QUARANTINE=true`, five switches `false`, zero secret-text bindings, zero keys in the dedicated KV |
| Final public URL | `GET /health` returned **404** from the disabled `workers.dev` route |

The isolated Worker and empty KV namespace remain provisioned for inspection, but **no HTTP or preview route is enabled**. No credentials or customer data were migrated. No production service, DNS route or existing Worker was modified.

## What these observations do *not* establish

1. There was **no historical Cloudflare snapshot restore**, **no pre-snapshot private DO state seeded on Cloudflare**, and therefore no actual retained-message/guest-session SQL readback across Cloudflare versions. The local [two-lifetime synthetic Workerd test](../scripts/restore-transition-workerd.test.mjs) separately covers retention and fail-closed RPC authorization across a process/configuration transition; it is not a substitute for a provider restore receipt.
2. There was **no independent post-snapshot revocation/deletion/expiry authority** available for a clearance decision. Quarantine was never cleared. The empty staging namespace cannot establish that reconciliation is correct for older private data.
3. This was a deliberately isolated, direct **quarantine-only** Wrangler deployment using the already-configured account token on `uf`. It does **not** validate the protected GitHub staging/production environment reviewer configuration, build/config attestation, secret ownership, separate production namespace, or the deliberately blocked release-approval workflow. It is not a production promotion or a public manual-profile readiness result.
4. Cloudflare's first-party readback establishes effective deployed bindings and version IDs for this Worker. It does not independently attest the full provenance of a production release, nor authorize any profile, Events producer, autonomous mode, or merging Issue #22.

**Disposition:** isolated staging smoke **passed**; retained-state Cloudflare restore/reconciliation, protected deployment workflow and production release **NOT RUN / BLOCKED**. Keep PR #46 Draft until remaining Issue #22 requirements and operator authorizations are satisfied.
