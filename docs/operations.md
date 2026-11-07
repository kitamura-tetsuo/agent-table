# Development and operations

Status: implementation guide, not an existing runbook. The repository currently contains documentation only. The commands below become usable after the implementation plan creates the referenced source files, package scripts, lockfile, and Cloudflare configuration.

## Proposed repository layout

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

Use TypeScript with a pinned Node/toolchain version and package lockfile. Candidate dependencies are the current Cloudflare Agents MCP handler, MCP server SDK, Cloudflare OAuth provider library, a schema validator, and a maintained Standard Webhooks implementation. Verify compatible versions together rather than mixing examples from different SDK generations.

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

The following is a **scaffolding example** for a single staging deployment. Replace the placeholders, implement the exported classes, and validate the installed Wrangler schema before using it. It is intentionally not committed as a runnable deployment configuration.

```sh
tee wrangler.jsonc > /dev/null <<'EOF'
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "agent-table-staging",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-07",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "TABLES", "class_name": "TableDO" },
      { "name": "GUESTS", "class_name": "GuestDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["TableDO", "GuestDO"] }
  ],
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "REPLACE_WITH_STAGING_NAMESPACE_ID" }
  ],
  "vars": {
    "PUBLIC_ORIGIN": "https://REPLACE_WITH_STAGING_HOST",
    "ENABLE_MCP_SUBSCRIPTIONS": "false",
    "ENABLE_OPENAI_EVENTS": "false",
    "ALLOW_NEW_GUESTS": "false"
  }
}
EOF
```

Cloudflare class migrations and application SQL schema migrations are different mechanisms. `new_sqlite_classes` provisions the backend; application schema upgrades still need version tracking and tests. Do not rename or delete namespaces as a shortcut to migrating private data. [CF-SQL] [CF-TTL]

## Local development after scaffolding

The implementation should provide these scripts: `dev`, `typecheck`, `lint`, `test`, `test:integration`, and `test:e2e`. They do not exist yet.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run dev
```

Local credentials belong in ignored local secret files. Use synthetic transcripts and test identities. Bind local mock receivers explicitly; a production callback validator must not gain a localhost exemption from test configuration.

## Deployment procedure after implementation

Authenticate Wrangler, provision the staging KV namespace, and add its returned ID to staging configuration. Store application encryption keys with `wrangler secret put`, not in JSON or shell history. Use separate versioned keys for encrypted callback credentials and any other encryption purpose. Configure any additional secrets required by the chosen OAuth library according to its pinned documentation.

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
