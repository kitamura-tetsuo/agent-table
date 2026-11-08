# Development and operations

Status: local foundation runbook plus future deployment plan. The Worker/DO scaffold, dependency lockfile, test scripts, and PR-only validation workflow exist. No public or staging deployment, guest authorization, tables, event delivery, or host interoperability has been completed.

## Implemented foundation (Issue #2)

The committed `wrangler.jsonc` binds `TABLES` to `TableDO` and `GUESTS` to `GuestDO`, using the SQLite backend selected by Cloudflare class migration `v1`. It sets the local `PUBLIC_ORIGIN` and disables guest admission, MCP subscriptions, and OpenAI Events. `/` is a minimal HTML status page, `/health` is a JSON health check, and `/mcp` is a modern-only stateless MCP handler advertising **no** application operations. Internal Durable Object methods are not public HTTP routes.

The application schema has a separate per-object `__agent_table_schema` version row, initialized by the classes using a local SQLite transaction. `schema/001_initial.ts` is version 1. Object eviction preserves it; a newer version aborts reconstruction instead of resetting storage. Additional business tables will be future, numbered migrations.

Exact direct dependency pins (also recorded in `package-lock.json`):

| Component | Version |
| --- | --- |
| Node / npm | `24.22.1` / `11.9.0` |
| `agents` / MCP SDK server and client | `0.33.0` / `2.4.0` / `2.4.0` |
| `wrangler` / `@cloudflare/vitest-plugin` / `vitest` | `4.158.0` / `1.6.0` / `4.1.0` |
| TypeScript / Biome / Playwright | `6.0.3` / `2.6.6` / `1.65.0` |

The pinned Agents release declares the MCP SDK `2.4.0` optional peer version. Tests pin the official modern `2026-07-28` SDK client and use Cloudflare's workerd test plugin with a real SQLite Durable Object namespace; no Node-only storage mocks are the runtime oracle. The browser smoke suite uses a live Wrangler dev server and Chromium. The local test harness and CI perform no Cloudflare deployment.

## Future repository layout

```text
src/
  index.ts                     # Worker entry point and routing
  auth/
    provider.ts                # OAuth library integration
    guest.ts                   # Guest session and consent handlers
  objects/
    guest.ts                   # GuestDO identity, grants, admission ledger
    table.ts                   # TableDO state and transaction boundaries
  mcp/
    server.ts                  # Tool/resource definitions and SDK adapter
    subscriptions.ts           # Single-table live subscription profile
  notifications/
    openai-events.ts           # Pinned provider-compatible Events adapter
    egress.ts                  # Callback verification and safe HTTPS transport
    outbox.ts                  # Durable delivery state machine
  web/                         # Management routes and safe rendering
  shared/                      # Schemas, limits, IDs, safe errors
public/                        # Minimal static assets
schema/                        # Versioned per-object schema migrations
test/
  unit/
  integration/                 # Worker + real DO storage boundaries
  e2e/                         # Browser, MCP clients, and staged host checks
docs/
```

The implemented subset has `src/index.ts`, `src/mcp/server.ts`, `src/objects/{table,guest}.ts`, `src/shared/schema.ts`, `schema/001_initial.ts`, `test/{unit,integration,e2e}/`, and `.github/workflows/ci.yml`. OAuth provider, webhook, and browser-management dependencies will be selected by their respective implementation issues after reviewing compatibility.

Tests should run in Cloudflare's workerd-based harness for storage, bindings, alarms, and streams. Browser tests cover consent and invitation handling. Pure Node unit tests alone are not an adequate production oracle. [CF-TEST]

## Cloudflare resources

Use separate staging and production Workers, DO namespaces, KV namespaces, secrets, and origins. A test environment must never deliver to production callbacks. Reserve one stable production HTTPS origin before configuring public OAuth clients; no domain has been selected or deployed by these documents.

Initial bindings:

| Binding | Purpose |
| --- | --- |
| `TABLES` | SQLite-backed `TableDO` namespace |
| `GUESTS` | SQLite-backed `GuestDO` namespace |
| `OAUTH_KV` | Selected OAuth library's protocol storage |
| `ASSETS` | Optional Worker static-assets binding |

`wrangler.jsonc` is the committed local development/dry-run configuration. It contains **no** real account, namespace, KV, or secret identifiers. `PUBLIC_ORIGIN` must be changed to the intended HTTPS hostname in a separately reviewed staging/production configuration before deployment. The MCP handler uses that origin's hostname as its accepted Host/Origin allowlist (with loopback aliases only for local development). OAuth library KV bindings are not present yet because OAuth itself is not implemented. Do not deploy the local scaffold as a public guest service.

Cloudflare class migrations and application SQL schema migrations are different mechanisms. `new_sqlite_classes` provisions the backend; application schema upgrades still need version tracking and tests. Do not rename or delete namespaces as a shortcut to migrating private data. [CF-SQL] [CF-TTL]

## Local development and checks

Use the Node version from `.node-version`, then run the implemented commands:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npx playwright install chromium
npm run test:e2e
npm run dev
```

`npm test` runs the workerd-backed unit and integration tests; `npm run test:integration` explicitly runs the two Worker/SQLite integration files. MCP tests use the official SDK client with requests dispatched through the real Worker export and assert that obsolete clients and private operations are unavailable. Integration tests invoke actual `TABLES`/`GUESTS` bindings and inspect SQLite, including preserving storage over instance eviction. `npm run test:e2e` starts `wrangler dev` and uses the official SDK over live HTTP plus Playwright Chromium for a visible page and health smoke test. `npm run build` is only `wrangler deploy --dry-run --outdir dist`; it does not publish.

The GitHub Actions PR workflow repeats clean `npm ci`, type checking, linting, workerd tests, dry-run build, and browser smoke tests. It requests read-only repository permissions and no production secrets. Use local ignored `.dev.vars` for any future local credentials. Tests must use synthetic identities; a production callback validator must not receive a localhost exemption from a test configuration.

## Deployment procedure after implementation

After the guest/OAuth and later application stages have been implemented, separately approve staging publication, provision the OAuth KV binding if the selected library requires it, and set real staging origin/namespace configuration outside the committed local scaffold. Store encryption keys with `wrangler secret put`, not in JSON or shell history. Use separate versioned keys for encrypted callback credentials and any other encryption purpose. Configure additional secrets from the chosen OAuth library's pinned documentation. The following commands are a future operator workflow, **not** part of PR CI:

```sh
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
npx wrangler deploy --dry-run
```

These commands do not publish the service. After the validation gates pass, use an explicit staging deployment, then separately approve production deployment. CI should typecheck, lint, test, and build on pull requests; production deployment should be restricted to the intended repository/branch and environment. Use a narrowly scoped Cloudflare credential.

Enable capabilities one at a time. A tools-only deployment must omit unavailable notifications from discovery. Events must remain disabled when secure egress, signing, durable scheduling, or host compatibility is unverified. Never advertise a feature merely because its flag is enabled.

For OpenAI, first connect a private/custom plugin in the actual target account and perform the documented host tests. Public plugin submission is a separate step requiring its own packaging, domain, privacy, and review checks. This repository does not contain an approved plugin. [OPENAI-SUBMISSION]

## Operations and observability

Collect safe counters for accepted/rejected requests, live stream count/duration, DO requests and duration, storage reads/writes, outbox backlog age, delivery failures, invitation failures, expired-table cleanup lag, and admission denials. Use structured console logging into Workers Logs. Do not log transcripts, raw tool arguments, credentials, or callback URLs.

Alert on cleanup lag, a growing delivery backlog, repeated OAuth failure, and unexpected duration/storage consumption. Keep kill switches for new guests, table creation, and outbound delivery. Existing users must retain close/delete access during an admission pause.

When investigating a message failure, distinguish: not committed; committed but notification pending; receiver accepted; host run observed; reply committed. Only the transcript and corresponding delivery/host evidence establish progress.

## Cost model

SQLite-backed Durable Objects are available on the Workers Free plan; exceeding free allowances can fail operations. Free-tier availability is not a promise that a public deployment costs nothing or remains available without quotas. [CF-PRICING]

Budget for Worker requests/CPU, DO requests and active duration, SQL rows/storage, OAuth KV activity, logs, and optional domain/security features. Long-lived streams and retry loops may dominate a tiny transcript's storage cost. The product does not pay model inference bills, but it still pays its own infrastructure bill.

Measure a realistic quiet table, an active two-agent exchange, reconnect churn, and a failing callback. Record observed per-table request counts, active duration, row operations, and cleanup behavior. Use current official pricing at deployment time rather than freezing a speculative monthly price in this design.

## Retention, restore, and rollback

Enforce logical expiry synchronously; use alarms for physical cleanup. Test cleanup after a Worker deploy and a DO restart. Check both application tables and auxiliary credentials/receipts, not just message rows.

A restore must not resurrect a deleted table's access, an expired invite, or a revoked connection. Restoring a snapshot and changing a Worker version are separate operations. Apply a restore quarantine until expiration and revocation policies are reconciled. Publish the actual platform-backup and log-retention boundaries before public launch.

Use forward-compatible, versioned migrations. A Worker rollback must not run code that misinterprets a newer schema; refuse unsafe downgrade or deploy a compatible reader. Backups are not permission to retain public users' transcripts indefinitely.
