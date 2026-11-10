# PR #46: isolated Cloudflare quarantine-only staging evidence

Date: 2026-11-10 (UTC). Tested source: [`473ee879a9a32220cb8ca705a11b770397cd2370`](https://github.com/kitamura-tetsuo/agent-table/commit/473ee879a9a32220cb8ca705a11b770397cd2370). Prior exact-head [GitHub Validation #42805111765](https://github.com/kitamura-tetsuo/agent-table/actions/runs/42805111765) completed successfully, including Playwright; it is **separate from** the Cloudflare observations below.

## Approved 2026-11-10 22:13 UTC synthetic Cloudflare restore/redeployment rehearsal

**Outcome: PASS on the isolated Cloudflare Worker, then fully returned to quarantine with no published route.** The user authorized a bounded temporary non-quarantined *synthetic-only* probe, not any production rollout or clearance of real user data.

The rehearsal ran from 22:13:21 to 22:13:46 UTC on the **same dedicated Worker** `agent-table-pr46-restore-staging`, the **same dedicated KV** `7a61348960204372a8fd415253d41f4f`, and the same four SQLite DO namespaces. The pre- and post-restore versions were actual Cloudflare deployments rather than solely a local test. Before any live deployment, Wrangler's local persistent Workerd rehearsal passed the same SQL/read/post/subscribe/alarm assertions, TypeScript, Biome and three dry-run bundles.

| UTC step | Version ID | Runtime / observed result |
| --- | --- | --- |
| 22:13:22, temporary **seed** | `cde7a86b-f721-45ec-82cf-e88354112f15` | A standalone fixture Worker with `RESTORE_QUARANTINE=false`, capable of **only** a 256-bit-token-authenticated `POST /__pr46/seed`. All other routes returned 503; unauthorized seed returned 404. It seeded one synthetic guest session, connection, private table, membership and transcript, then verified live authorized read and subscription. No customer/real user data. |
| 22:13:28, **reviewed application quarantine** | `2fc1bea5-a71d-4883-8314-42279b8e909e` | The *actual* `src/index.ts` application with `RESTORE_QUARANTINE=true` and all five public/intake/outbound flags false replaced the fixture code, retaining DO namespaces. Public `GET /health`, `GET /guest/me`, `POST /mcp`, and the old probe path each returned **503**. |
| 22:13:34, bounded **state audit** | `6fcc1783-8f9e-450a-81a9-7d0584aadb45` | The temporary token-gated audit wrapper, with `RESTORE_QUARANTINE=true`, invoked the real TableDO/GuestDO methods and the provider's durable SQLite SQL interface on **the same retained IDs**. Unauthorized audit was 404 and ordinary routes 503. |
| 22:13:41–46, **final safe state** | `4234628f-995b-428c-96d4-6ad46b4ce788` | Replaced the audit wrapper with ordinary `src/index.ts`; quarantine remained true, five flags false, `workers_dev=false`, preview URLs false, zero custom routes. Public `GET /health` and probe `POST /__pr46/audit` returned **404**. |

The audit response reported `ok=true`, `denied=true`, `retained=true`, and `rearmed=true`:

- The previously authorized synthetic TableDO read and post both returned `TABLE_NOT_FOUND`; subscription returned `TEMPORARILY_UNAVAILABLE`. No private message was added by the attempted quarantined post.
- Before **and after** the denied operations and real `alarm()` calls, actual persisted TableDO SQL had **one message** (exact synthetic body), **one membership** and **one metadata row**; GuestDO SQL had **one session** and **one connection**. This is provider-backed retained-data readback through *temporary privileged test-only DO methods*, not a backup-restore or external audit API.
- The TableDO and GuestDO quarantine alarms each rearmed for **21,600,000 ms** (six hours); no retained row was erased.
- Cloudflare's final API readback confirmed exactly the expected four DO bindings and one dedicated KV binding, no probe/token/keyring variables, no secret-text bindings, zero keys in the dedicated KV, all five flags false, quarantine true, and **both** `workers.dev` and preview exposure disabled.
- The fixture used a locally generated, temporary 256-bit bearer credential, verified only by its SHA-256 digest in the Worker; the actual credential was neither logged nor committed. Ordinary public application routes were never enabled in non-quarantine mode. The existing `agent-table-staging` Worker, its storage, production, and DNS were untouched.

**Boundary:** this establishes live Cloudflare **cross-version persistent DO retention and denial after a quarantined redeploy**, including real Worker routing and DO SQL/alarm behavior. It **does not** establish a historical backup/snapshot restore, cross-account transfer, independently known later revocations/deletions/expiries, or an approved quarantine-clear decision. The temporary fixture never used real users, an existing application environment, or a production release. Keep this distinction when evaluating #22/REQ-004/005/008.

## Environment, ownership and limits

- Used the already-authorized Cloudflare account from the user's `uf` host. An account-scoped API token was verified **active** with Cloudflare's account-token verification endpoint. Its value was neither displayed nor stored in the repository.
- Read the account's Worker and KV inventories before writing. The existing `agent-table-staging` Worker and its `agent-table-staging-oauth-kv` were left untouched.
- Created only `agent-table-pr46-restore-staging` with its **new**, empty `agent-table-pr46-restore-oauth-kv` namespace (`7a61348960204372a8fd415253d41f4f`). The new Worker owns its own four SQLite DO classes (`TableDO`, `GuestDO`, `OAuthTokenDO`, `AdmissionDO`), using the v1/v2/v3 migration declarations from the reviewed source.
- The detached repository clone on `uf` checked out the exact tested commit. Wrangler 4.158.0 built the application with `--dry-run` against an isolated local QA configuration; no application secrets, private messages or real user sessions were supplied.
- The QA configuration was **not** the protected production workflow's approved configuration. It deliberately had no secret bindings, disabled all five intake/Events/outbound switches, set `RELEASE_ENVIRONMENT=staging` and `RESTORE_QUARANTINE=true`, and used a new KV namespace and Worker name. Its source was not silently substituted for a production/staging promotion manifest. The separate preflight's `deploymentApproved:false` guard was **not changed**.

## Earlier quarantine-only Cloudflare checks

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

## What the combined evidence still does *not* establish

1. **No historical snapshot or backup restoration:** the later authorized rehearsal seeded *synthetic prior-version state directly on the isolated Cloudflare Worker* and verified storage preservation across deployed versions. It did not restore an actual Cloudflare backup or prove compatibility with a different account/namespace or a future schema rollback.
2. **No independently reconciled post-snapshot authority:** there is no authoritative external ledger for later revocations, deletions or expiries, so the implementation correctly refuses stale-looking credentials and **never clears quarantine as a recovery decision**. The short-lived non-quarantined *synthetic test fixture* was an explicit, tightly scoped test, not a release authorization for real retained state.
3. **No protected staging/production promotion proof:** the direct `uf`-authorized Wrangler probe does not verify protected GitHub environment required reviewers, approved production secret ownership, signed approval, build/profile release provenance, actual rollback from a future schema or the deliberately blocked release gate (`deploymentApproved:false`). The final code and bindings are quarantined and unpublished.
4. **No assertion that issue #22 is fully accepted:** synthetic cross-version restoration and SQL retention are now positively evidenced on Cloudflare, but the separate independent reconciliation, production-readiness and approval boundaries remain blocked. No Events/public/autonomous mode was enabled.

**Disposition:** isolated staged quarantine smoke and authorized controlled **Cloudflare synthetic persistence/redeployment rehearsal PASSED**. No external historical snapshot restore or independent post-snapshot reconciliation was attempted; protected production release/clearance remains **BLOCKED**. Keep PR #46 Draft and do not merge or close #22 on this evidence alone.
