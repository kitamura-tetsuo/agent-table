# Development and operations

Status: local foundation runbook plus staged verification plan. The Worker/DO scaffold, guest sessions, OAuth, table operations, private Durable Object authorities, test scripts, and purpose-separated encrypted-secret primitive exist. An operator reported a dedicated staging deployment on 2026-11-09; the hosted same-zone Worker ingress test found a rate-limit bypass, so staging has not met release acceptance. There is no approved production/public guest rollout, and callback/event delivery is not implemented.

## Implemented foundation (Issue #2)

The committed `wrangler.jsonc` binds `TABLES` to `TableDO` and `GUESTS` to `GuestDO`, using the SQLite backend selected by Cloudflare class migration `v1`. It sets the local `PUBLIC_ORIGIN` and disables guest admission, MCP subscriptions, and OpenAI Events by default. `/` is a minimal HTML status page, `/health` is a JSON health check, and `/mcp` is a modern-only MCP handler with authenticated table tools. Live inbox resource subscriptions are advertised only with the explicit flag and current OAuth grant. Internal Durable Object methods are not public HTTP routes.

The application schema has a separate per-object `__agent_table_schema` version row, initialized by the classes using a local SQLite transaction. `schema/001_initial.ts` is version 1. Object eviction preserves it; a newer version aborts reconstruction instead of resetting storage. Additional business tables will be future, numbered migrations.

Exact direct dependency pins (also recorded in `package-lock.json`):

| Component | Version |
| --- | --- |
| Node / npm | `24.22.1` / `11.9.0` |
| `agents` / MCP SDK server and client | `0.33.0` / `2.4.0` / `2.4.0` |
| `wrangler` / `@cloudflare/vitest-plugin` / `vitest` | `4.158.0` / `1.6.0` / `4.1.0` |
| TypeScript / Biome / Playwright | `6.0.3` / `2.6.6` / `1.65.0` |

The pinned Agents release declares the MCP SDK `2.4.0` optional peer version. Tests pin the official modern `2026-07-28` SDK client and use Cloudflare's workerd test plugin with a real SQLite Durable Object namespace; no Node-only storage mocks are the runtime oracle. The browser smoke suite uses a live Wrangler dev server and Chromium. The local test harness and CI perform no Cloudflare deployment.

### Secret-envelope implementation (Issue #3)

`src/shared/config.ts` validates the two independent encryption keyrings, and `src/shared/secret-envelope.ts` seals/opens authenticated v1 AES-256-GCM envelopes. `src/env.d.ts` declares their optional Worker secret bindings. They are deliberately **not** defined in `wrangler.jsonc` variables, nor used by a public endpoint. See [security.md](security.md) for the envelope and authorization boundaries.

The workerd integration suite tests both purposes, authenticated metadata and record-ID binding, tampering, secret-safe errors, old-key overlap/deadline refusal, and ciphertext persisted through an actual SQLite-backed `TableDO` eviction and reconstruction. Run just that production-function suite using `npx vitest run test/integration/secret-envelope.test.ts`. Application consumers and credential records are future issues; these tests do not claim the service can already issue invites or deliver callbacks.

### Durable creation reservations (Issue #7)

`schema/004_creation_reservations.ts` applies only to GuestDO. The private `reserveCreation` binding commits one random table identity and one quota charge per valid new `(guest, create_table, request_id)`; identical retries within the original table lifetime return the same reservation. Changed arguments conflict. The current policy never refunds reservations, even if TableDO initialization later fails. The internal `getCreationReservation`, `recordCreationOutcome`, and bounded `pruneExpiredReservations` methods support recovery and eight-day retention. Neither this milestone nor a recorded `initialized` outcome implements the public `create_table` tool, creates membership, or authorizes reviving an expired table.

Run `npx vitest run test/integration/creation-reservations.test.ts` for real workerd/SQLite binding tests covering grant revocation, original expiry, eviction/retry, and two requests held at the final quota decision boundary. No external account, deployment or OAuth host compatibility is claimed by these tests.

### Private table identity and membership (Issue #8)

`schema/005_table_authority.ts` adds table-only metadata and member tables; the common migrator applies component-specific statements without creating guest state in TableDO or table state in GuestDO. `TableDO.initializeTable` takes the original request, a claimed reservation and a server-verified writer. It checks the real GuestDO receipt and current grant, the routed Durable Object ID and fixed expiry before committing table and creator membership together. The result is idempotent across object eviction. Private `getMetadata` and `readOwnInbox` check a new read grant, local membership, table state and deadline; the inbox is initially empty and belongs only to the requesting member.

Run `npx vitest run test/integration/table-authority.test.ts` for real binding/SQLite checks, including forged and relocated reservations, unknown-table noncreation, membership isolation, inbox ownership and terminal/expiry denial. The tests use synthetic guests; a second-seat fixture tests access boundaries but does not implement invitation acceptance. This is not yet a public `create_table` implementation or proof of OAuth/host interoperability.

### Crash-safe deadlines (Issue #12)

`src/shared/deadlines.ts` provides per-object atomic alarm-plus-SQL commit and bounded alarm draining. The implementation uses the pinned Cloudflare SQLite `storage.transaction` API (which can contain awaited alarm operations and synchronous SQL), not an in-memory timer or an assumption that `transactionSync` awaits alarm writes. Actual workerd tests in `test/integration/deadline-runtime-probe.test.ts` demonstrate paired SQL/alarm commit and rollback. `test/integration/deadline-scheduler.test.ts` forces crashes at the alarm/commit/rearm boundaries, tests response loss and competing deadlines, then reconstructs storage. `test/integration/guest-cleanup.test.ts` drives production `GuestDO.alarm` through batches exceeding 100 expired records and verifies live sessions, grants and reservations remain.

GuestDO's alarm handles only physical cleanup of the existing session, connection and creation-reservation records. It schedules a separate 60-second recovery wakeup before processing and a one-second follow-up for already-due backlog; valid records keep their original deadlines and server-side authorization remains synchronous. TableDO now has lifecycle cleanup and a durable Events outbox alarm consumer. Its dispatch requires independently enabled outbound settings, current grant validation and transport readiness; restore quarantine parks the alarm before cleanup or any delivery attempt. Do not interpret a successful alarm as public Events readiness, actual callback delivery or backup reconciliation. See the separate recorded synthetic Cloudflare quarantine evidence in [pr46-cloudflare-quarantine-evidence.md](pr46-cloudflare-quarantine-evidence.md).

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

The implemented subset has `src/index.ts`, `src/mcp/server.ts`, `src/auth/guest.ts`, `src/web/guest.ts`, `src/objects/{table,guest}.ts`, `src/shared/{schema,config,random,secret-envelope}.ts`, versioned `schema/001_initial.ts`, `schema/002_guest_sessions.ts` and `schema/003_connection_grants.ts`, `test/{unit,integration,e2e}/`, and `.github/workflows/ci.yml`. Guest browser identity and private grant authority/browser revocation are implemented; OAuth provider, webhook, and consent-issuance dependencies remain pending.

Tests should run in Cloudflare's workerd-based harness for storage, bindings, alarms, and streams. Browser tests cover consent and invitation handling. Pure Node unit tests alone are not an adequate production oracle. [CF-TEST]

## Cloudflare resources

The offline release preflight and restore generator require a canonical
HTTPS DNS origin; IP literals, single-label/internal hostnames and trailing-dot
origins are rejected. They also refuse alternate Wrangler entry points
(routes, static site/assets and cron triggers) for both target and peer
configurations and require explicit `workers_dev: false` and
`preview_urls: false` in both. The restore-config generator forces both
exposure flags off even when the stale input omitted or enabled them. These structural checks cannot prove DNS ownership, TLS
validity, the live Cloudflare route or the absence of an implicit workers.dev
endpoint. Independently reviewed authenticated deployment evidence remains
mandatory, and this offline preflight never grants publication approval.

Use separate staging and production Workers, DO namespaces, KV namespaces, secrets, and origins. A test environment must never deliver to production callbacks. Reserve one stable production HTTPS origin before configuring public OAuth clients; no domain has been selected or deployed by these documents.

Initial bindings:

| Binding | Purpose |
| --- | --- |
| `TABLES` | SQLite-backed `TableDO` namespace |
| `GUESTS` | SQLite-backed `GuestDO` namespace |
| `OAUTH_KV` | Selected OAuth library's protocol storage |
| `ASSETS` | Optional Worker static-assets binding |
| `INVITATION_RESPONSE_KEYRING` | Workers secret: invitation-response encryption keys |
| `CALLBACK_CREDENTIAL_KEYRING` | Workers secret: callback-credential encryption keys |

`wrangler.jsonc` is the committed local development/dry-run configuration. It contains **no** real account, namespace, KV, or secret identifiers; its `OAUTH_KV` namespace ID is deliberately a placeholder. `PUBLIC_ORIGIN` must be changed to the intended HTTPS hostname and `OAUTH_KV` must use a separate real namespace in a reviewed staging/production configuration before deployment. The MCP handler uses that origin's hostname as its accepted Host/Origin allowlist (with loopback aliases only for local development). Do not deploy the local scaffold as a public guest service.

Cloudflare class migrations and application SQL schema migrations are different mechanisms. `new_sqlite_classes` provisions the backend; application schema upgrades still need version tracking and tests. Do not rename or delete namespaces as a shortcut to migrating private data. [CF-SQL] [CF-TTL]

**OAuth Durable Object storage compatibility:** `OAuthTokenDO` is declared under the SQLite `new_sqlite_classes` migration `v2`. New KV-backed Durable Object namespaces are unavailable on Workers Free accounts and on Cloudflare accounts without an existing legacy KV namespace. SQLite-backed Durable Objects retain the KV storage API used by the OAuth token serializer. The `scripts/wrangler-sqlite.test.mjs` regression checks the declared classes. This configuration is for new namespaces and environments that already applied the SQLite `v2` migration; **editing the historical `v2` definition cannot convert an already-deployed legacy KV-backed `OAuthTokenDO` namespace into SQLite**. Before applying it to any existing environment, inspect its actual deployed migration/backend and preserve its data. If a legacy KV-backed `OAuthTokenDO` exists, stop and design a separate, reviewed migration rather than reusing the tag or deleting the namespace.

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

New guest admission is disabled by default (`ALLOW_NEW_GUESTS=false`). For a temporary, isolated local browser session test, start `npm run dev -- --var ALLOW_NEW_GUESTS:true`; the Playwright web server uses that override, while the standard `npm run dev` does not. Browser routes are `/guest` (explicit choice UI), `/guest/session` (same-origin CSRF-protected POST only), `/guest/me` (read-only validated session check), and `/guest/connections` (session-protected connection list) with POST-only `/guest/connections/revoke`. The `__Host-` session cookie needs HTTPS except on loopback during development. Version 2 of the application schema adds guest identity/session tables **only in GuestDO**. It migrates existing version 1 objects transactionally and rejects unsupported newer versions without clearing state. The SHA-256 session digests remain durable across instance eviction; raw session credentials must never enter SQL, logs, or diagnostic artifacts.

### Authenticated, reviewed deployment workflow (Issue #50)

The repository has **manual-only** dispatch entries
`.github/workflows/deploy-staging.yml` and `deploy-production.yml`. An exact
expected **main** SHA, successful fresh CI run, configured protected GitHub
Environment with an independent human reviewer, and an in-job authenticated
Cloudflare identity/readback manifest are all required **before** the same
reviewed config bytes can be deployed. The post-deploy gate verifies the active
Worker version, four SQLite DO namespaces, OAuth KV ID, actual secret names,
domain, release vars and HTTPS `/health` build/profile. PR CI never receives
release credentials; approval from a repository collaborator or a Slack DM
alone does not bypass the protected Environment. The restricted implementation
supports the `manual` profile only. Worker deployment is **not authorized**
until all missing operator inputs and explicit approvals are provided.

The full operator inputs, separate read/write Cloudflare tokens, private
environment-scoped secrets, evidence schemas, rollback and measured hosted
acceptance checklist are in [release-runbook.md](release-runbook.md). It
records **not run** for staging and production actual #50 deployments; the
previous settings-only [credential read](https://github.com/kitamura-tetsuo/agent-table/actions/runs/42969129958)
did not authorize release or verify private DO/KV ownership.

## Deployment procedure after implementation

After the guest/OAuth and later application stages have been implemented, separately approve staging publication, provision the OAuth KV binding if the selected library requires it, and set real staging origin/namespace configuration outside the committed local scaffold. Store encryption keyrings with `wrangler secret put`, not in committed configuration, shell history, deployment logs or test artifacts. Configure additional secrets from the chosen OAuth library's pinned documentation. The following commands are a future **interactive quarantined bootstrap** preparation workflow, **not** a release approval and **not** part of PR CI:

```sh
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
npx wrangler secret put INVITATION_RESPONSE_KEYRING
npx wrangler secret put CALLBACK_CREDENTIAL_KEYRING
npx wrangler deploy --dry-run
```

These commands do not publish the service. After the validation gates pass, use an explicit staging deployment, then separately approve production deployment. CI should typecheck, lint, test, and build on pull requests; production deployment should be restricted to the intended repository/branch and environment. Use a narrowly scoped Cloudflare credential.

Provision and rotate the purpose-specific keyrings as follows:

1. Generate independent 32-byte random AES key material per purpose in a trusted operator environment; encode each key as unpadded base64url. Protect it in your secret manager; do not paste it into commands, tickets, chat, or CI. Choose non-secret, unique version IDs for the `current` entries. Keep `previous` empty until rotation. Each keyring is a JSON object, entered through the interactive Wrangler secret prompt, not a committed file.
2. To rotate, create fresh independent key material for the purpose being rotated; make it `current`. Move the former current key to `previous` with exact UTC `.sssZ` `retiredAt` (rotation start) and `acceptUntil` (no more than seven days later). Existing ciphertext remains encrypted under its recorded `keyId`; new writes use the new current ID. Deploy the new secret before relying on it, and check in staging that old reads and new writes work. Keep different environments' keyrings separate.
3. Plan to retire/revoke or otherwise safely complete any still-needed old invitation responses and callback credentials before `acceptUntil`. At the deadline, opening a record under the former key fails with `key-expired`; remove the old key entry from the Worker secret promptly. Removing it earlier causes `key-unavailable`. Neither failure authorizes reissuance, access restoration, a plaintext fallback or silent resealing.
4. If a keyring is absent, corrupt, lost or wrong for its purpose, the helper fails closed with a safe error. Recover only from an authorized protected key backup or rotate affected credentials through their future ownership flows. Do not log inputs to diagnose the failure. Never extend the overlap beyond seven days as a shortcut.

The envelope contains only ciphertext and non-secret format/key metadata; the owning record retains its own stable ID. Restrict decryption to the owning consumer after separate authorization and expiry checks. Encryption does not protect table transcripts end-to-end; Worker operators and connected agent hosts may process their content.

Enable capabilities one at a time. A tools-only deployment must omit unavailable notifications from discovery. Events must remain disabled when secure egress, signing, durable scheduling, or host compatibility is unverified. Never advertise a feature merely because its flag is enabled.

For OpenAI, first connect a private/custom plugin in the actual target account and perform the documented host tests. Public plugin submission is a separate step requiring its own packaging, domain, privacy, and review checks. This repository does not contain an approved plugin. [OPENAI-SUBMISSION]

## Operations and observability

Collect safe counters for accepted/rejected requests, live stream count/duration, DO requests and duration, storage reads/writes, outbox backlog age, delivery failures, invitation failures, expired-table cleanup lag, and admission denials. Use structured console logging into Workers Logs. Do not log transcripts, raw tool arguments, credentials, or callback URLs.

Alert on cleanup lag, a growing delivery backlog, repeated OAuth failure, and unexpected duration/storage consumption. Keep kill switches for new guests, table creation, and outbound delivery. Existing users must retain close/delete access during an admission pause.

When investigating a message failure, distinguish: not committed; committed but notification pending; receiver accepted; host run observed; reply committed. Only the transcript and corresponding delivery/host evidence establish progress.

### Privacy-safe telemetry pilot (Issue #16)

The Worker now emits `agent-table.telemetry.v1` allowlisted JSON console records for **HTTP responses** (safe route category, HTTP code, duration, random per-request correlation token), **durable message/table commits** (operation and elapsed time), and **completed or failed cleanup alarms** (component, committed row count, observed lag, duration). A successful HTTP response is **not** evidence of a message commit. A commit is **not** evidence of notification delivery, receiver acceptance, actual host execution, or a peer reply. Transport exceptions are recorded as `exception` with a generic 500 response; the error object and original request are never serialized to the operational sink. Alarm uncertainty has null processed/lag fields rather than false zeros. This is local code instrumentation, not a claim that all Cloudflare billing or storage metrics are readable from Workers.

**Platform logging boundary:** Cloudflare [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) documents that automatic invocation logs include the method and full URL, independent of this code's safe console record. The checked-in `wrangler.jsonc` explicitly disables invocation logs (`observability.logs.invocation_logs=false`) while enabling custom Workers Logs. Do not re-enable invocation logs for guest/OAuth/event routes carrying opaque values. This setting has **not** been verified on an actual deployment, and it does not control other account-level logs, WAF/security analytics, external proxies or platform-generated diagnostics; those surfaces require a separate privacy review. This commit neither deploys nor inspects private host activity.

The event encoder allows only fixed event/route/operation names, non-negative bounded measurements, HTTP codes and ephemeral random 12-hex correlation IDs. It does **not** log guest or table IDs, raw URLs, titles, purposes, bodies, cookies, OAuth parameters, callback paths, invitation secrets, authorization headers or exception strings. There is no log-derived identity or transcript analysis. TableDO now records local stream active count/duration and emits fixed-category stream-stop reasons, including replacement, revocation and slow-reader termination; the public SDK output cap emits its own fixed-category termination metric. TableDO records bounded outbox backlog, attempted delivery, retry and terminal-failure measurements, but these do not establish end-to-end provider delivery or configured alerting. DO SQL volume and billed active duration are not inferred from these counters.

Invitation metrics are emitted at the authenticated application result boundary, not inferred from HTTP status: MCP invitation errors may return HTTP 200. The allowlisted `invitation` record has only fixed `create_invite`/`join_table` operation, `accepted`/`rejected`/`unknown` outcome, bounded failure category and duration. A retryable DO transport failure is `unknown`, not evidence of a failed SQL transaction. Neither successful invite issuance nor joining counts as a peer host run. The OAuth/MCP integration regression captures actual invitation and post events against independent SQLite message/receipt counts, including retries and a lost client response. It verifies secret sentinels never occur in these records; no account-wide platform logging claim is implied.

Local synthetic measurements: run `npm run measure:synthetic` on an isolated Workerd/Vitest environment. The quiet case creates/reads one synthetic table and checks zero transcript rows; the active case commits two synthetic posts and retries one request ID, then compares two persisted rows and two receipts to its observations. The harness emits only profile names and numeric observed counts/storage sizes. Such evidence is reproducible **local Workerd observation only**, not production traffic, CPU billing, exact read/write operation count, long-lived stream hibernation, webhook delivery, or agent-host execution. Record real deployment SHA, fixture, duration, Cloudflare dashboard Worker/DO request, CPU, duration, database size and billing figures separately when an authorized isolated deployment becomes available; missing results must be marked **not run** rather than measured zero. Refresh official pricing at the time of any approved deployment.

Operator diagnostics: review HTTP 429 by safe route category for admissions, 401/403 on OAuth/protocol routes for authorization failures, 5xx/exception rates, and cleanup alarm `backlogLagMs` plus `processed` for an accumulating physical cleanup backlog. Treat repeated cleanup lag above 60 seconds for several alarms, a rising 5xx/429 ratio, or unexpectedly growing DO storage size as *investigation triggers* to calibrate from actual workload measurements, not pre-proven service-level thresholds. Alerting on persistent outbox pending-age or delivery failures must be calibrated from actual counters and verified monitoring configuration; the metrics hooks alone do not provision alerts. Limit Workers Logs retention and access separately through the deployment account; this commit does not provision a logging vendor or modify deployment settings.

## Cost model

SQLite-backed Durable Objects are available on the Workers Free plan; exceeding free allowances can fail operations. Free-tier availability is not a promise that a public deployment costs nothing or remains available without quotas. [CF-PRICING]

Budget for Worker requests/CPU, DO requests and active duration, SQL rows/storage, OAuth KV activity, logs, and optional domain/security features. Long-lived streams and retry loops may dominate a tiny transcript's storage cost. The product does not pay model inference bills, but it still pays its own infrastructure bill.

Measure a realistic quiet table, an active two-agent exchange, reconnect churn, and a failing callback. Record observed per-table request counts, active duration, row operations, and cleanup behavior. Use current official pricing at deployment time rather than freezing a speculative monthly price in this design.

## Retention, restore, and rollback

Enforce logical expiry synchronously; use alarms for physical cleanup. Test cleanup after a Worker deploy and a DO restart. Check both application tables and auxiliary credentials/receipts, not just message rows.

A restore must not resurrect a deleted table's access, an expired invite, or a revoked connection. Restoring a snapshot and changing a Worker version are separate operations. Apply a restore quarantine until expiration and revocation policies are reconciled. Publish the actual platform-backup and log-retention boundaries before public launch.

Use forward-compatible, versioned migrations. A Worker rollback must not run code that misinterprets a newer schema; refuse unsafe downgrade or deploy a compatible reader. Backups are not permission to retain public users' transcripts indefinitely.

### Guest challenge preflight (Issue #15, partial)

The draft admission controls support an optional `GUEST_CHALLENGE_MODE=required` for **new guest creation only**, with a public `TURNSTILE_SITE_KEY` and a separate `TURNSTILE_SECRET` provisioned as a Worker secret. The browser renders the official Turnstile widget with the `create_guest` action; the server validates each token against Siteverify (success, exact public-origin hostname, action and freshness) before allocating a GuestDO or session. Invalid/missing tokens, unknown challenge modes, absent site keys/secrets and verifier outages refuse new guest creation. The Siteverify response is streamed with a 4 KiB decoded-byte ceiling and refused before JSON parsing on excess body bytes or a malformed/oversized declared length; the test uses synthetic verdicts and is not a hosted Turnstile acceptance receipt. Guest reuse and existing-owner deletion/close are not contingent on this bot challenge. Do not commit the Turnstile secret, or treat a client-supplied `human=true` field as verification. The default local mode is `off`; public admission must not be enabled without separately provisioned challenge policy and rate limits.

**Draft #15 quota implementation (not release acceptance):** `AdmissionDO` adds an SQLite-backed rolling 60-second rate authority shared across Worker isolates. Each edge source is hashed into a durable-object identity before storage; it never persists raw IP, table content or credentials. Authenticated MCP requests are charged to the verified *guest principal* across connections, independently of TableDO's transactional accepted-post and GuestDO's daily table-creation quotas. Retries count as application requests without duplicating stored messages. The configured edge controls cover guest creation, DCR, OAuth protocol (including protected-resource metadata discovery), MCP application requests, guest/connection browser reads (including `/`, `/guest`, `/guest/me`, and `/guest/connections`), and the public join page; rate refusals return HTTP 429 with a bounded `Retry-After`, while authority/configuration failures refuse with 503. The streaming ingress preflight limits request bodies even on unsupported HTTP methods before charging the edge budget; this is a request-size defense, not permission to use that method. Workerd regression tests assert a refused oversized `DELETE /mcp` request does not consume a rate-limit slot or echo payload data. Pre-admission streamed reading has a **10-second total deadline** (not a per-chunk timeout): a client that sends a short prefix and never completes receives a generic HTTP 408/no-store refusal before edge quota consumption. Both request-body tee branches are canceled on timeout or byte overrun. A local Workerd regression covers a stalled partial body with an accelerated test deadline; this is not a hosted Cloudflare slow-client or edge/WAF verification receipt.

Default rolling-minute limits are: edge guest **30**, edge DCR **30**, edge protocol **120**, edge application **600**, edge invitation **60**, and authenticated principal application **60**. The corresponding optional configuration strings are `EDGE_GUEST_RATE_PER_MINUTE`, `EDGE_DCR_RATE_PER_MINUTE`, `EDGE_PROTOCOL_RATE_PER_MINUTE`, `EDGE_APPLICATION_RATE_PER_MINUTE`, `EDGE_INVITATION_RATE_PER_MINUTE` and `PRINCIPAL_RATE_PER_MINUTE`; each must be a decimal integer between 1 and 10,000 or that path refuses closed. Cloudflare's directly served public Worker edge must overwrite `CF-Connecting-IP`; never trust caller-supplied `X-Forwarded-For`, a direct untrusted proxy, or a guest ID as network identity. Absent/malformed edge information shares one fallback bucket instead of bypassing admission. **Worker-origin subrequests also consume a second, shared SQLite rate bucket** (`edge-v1:worker-subrequest`) in addition to their normal IP bucket whenever the request carries `CF-Worker`. Cloudflare documents that it adds this header to Worker `fetch()` subrequests. The header value is not trusted as an identity: changing its value, `x-real-ip`, or `CF-Connecting-IP` cannot create a new shared Worker quota. A direct caller forging `CF-Worker` still has to consume the ordinary IP quota, so this header cannot be used as an admission bypass. This conservative shared cap can throttle unrelated legitimate Worker-based callers (noisy-neighbor limitation) and adds a second Durable Object admission operation per Worker-origin request. It does not authenticate individual Worker zones or guarantee protection if the platform omits its documented header; deployed behavior must be verified. The new `AdmissionDO` binding and SQLite migration `v3` must be present before any public use. **Deployment prerequisite:** the Cloudflare [header trust documentation](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests) explicitly distinguishes direct edge requests (trusted `CF-Connecting-IP`) from same-zone Worker subrequests, where `x-real-ip` can be altered by the calling Worker. Before turning on public new-guest admission, validate the direct edge route and the Worker shared quota with real hosted probes. Enforce an independently verified Cloudflare WAF/route policy for untrusted subrequests where available, or provide another reviewed ingress trust source. **The locally generated WAF policy and local Workerd regression are not hosted acceptance evidence.** A request can never bypass the per-principal durable counter via a caller-supplied guest identifier, but these controls do not cover distributed IP churn or guarantee zero cost.

### Same-zone Worker ingress WAF guard (staging rollout)

The 2026-11-09 operator-run staging test demonstrated that a same-zone Worker could change `x-real-ip` and obtain a different downstream `CF-Connecting-IP` edge bucket: after five successful requests from one spoofed source and a 429, the same Worker got a 200 by changing the claimed source. The direct-edge spoofed-forwarding-header test did not bypass the limit. This establishes a hosted same-zone weakness, not a general Internet visitor's ability to deploy a Worker in this zone.

A subsequent operator report exercised a WAF rule that matched the literal incoming **`CF-Worker` HTTP header**: forged external headers were blocked but genuine same-zone subrequests passed. Cloudflare explicitly documents that the platform adds `CF-Worker` **after** WAF custom-rule evaluation; matching that request header is therefore not a valid proof that the WAF can stop genuine Worker subrequests. The managed rule below instead matches the WAF-specific `cf.worker.upstream_zone` field.

On 2026-11-09, the `cf.worker.upstream_zone` rule was installed on `outliner-online.com` (rule ID `02d4fc2969a241238eb3a77895ecb093`) and verified via hosted probe tests. The hosted results established two platform behaviors:
1. **WAF boundary finding:** Cloudflare Custom WAF rules using `cf.worker.upstream_zone` do **not** block same-zone Worker-to-Worker subrequests on this configuration; subrequests from same-zone probe `probe-test.outliner-online.com` bypassed WAF evaluation and reached the application handler (HTTP 400). However, edge WAF does reliably block external requests carrying a forged `CF-Worker: outliner-online.com` header (HTTP 403).
2. **Application defense confirmation:** Hosted testing confirmed that the application-level defense (`edge-v1:worker-subrequest` added in `5e0e5a7`) successfully enforces an independent shared quota across all subrequests bearing `CF-Worker`. When tested with `EDGE_DCR_RATE_PER_MINUTE=2`, rotating synthetic `x-real-ip` headers failed to bypass admission: subrequests 1 & 2 passed to the application handler, while subrequests 3 & 4 were throttled with HTTP 429 `RATE_LIMITED` (`Retry-After: 59`). Direct external clients retain their own source-IP quota and are not throttled by the Worker bucket.

For a **dedicated Agent Table hostname**, the managed WAF guard rule is:

`(http.host eq "agent-table-test.outliner-online.com" and cf.worker.upstream_zone eq "outliner-online.com")`

Action: **Block**. This also blocks legitimate same-zone Worker clients on that hostname; confirm this is acceptable for any intended agent-host topology before applying the same policy to production. Direct browser/API requests remain unaffected by this predicate. Cross-zone Worker subrequests are not blocked by this rule and still require quota monitoring; the policy is not a global DDoS guarantee.

Use the narrowly scoped, idempotent WAF management script, with a zone-scoped API token that has WAF/Rulesets read and write access. Do not pass the token on the command line or commit it. Replace `<ZONE_ID>` with the verified `outliner-online.com` zone ID. Each command is explicitly scoped to the staging hostname:

```sh
node scripts/manage-ingress-waf.mjs --mode=plan --hostname=agent-table-test.outliner-online.com --zone-name=outliner-online.com --zone-id=<ZONE_ID>
node scripts/manage-ingress-waf.mjs --mode=check --hostname=agent-table-test.outliner-online.com --zone-name=outliner-online.com --zone-id=<ZONE_ID>
node scripts/manage-ingress-waf.mjs --mode=apply --hostname=agent-table-test.outliner-online.com --zone-name=outliner-online.com --zone-id=<ZONE_ID> --confirm-hostname=agent-table-test.outliner-online.com
```

The script only adds the exact rule if absent, places it before existing zone-level custom rules, and refuses to replace a matching but altered rule. It never rewrites unrelated rulesets. A missing `CLOUDFLARE_API_TOKEN` or HTTP 403 is an explicit stop condition, not a reason to change unrelated Cloudflare permissions or bypass account controls. The read-only `check` command returns a nonzero code while the guard is missing; `plan` makes no API calls.

**Post-apply verification is mandatory:** repeat the same-zone two-`x-real-ip` probe through the test Worker and confirm whether both attempts are blocked **before** reaching Worker/AdmissionDO, while direct browser/API requests continue reaching the application. Independently, disable or remove the WAF rule in a controlled staging-only experiment and verify the application now returns HTTP 429 after the shared Worker bucket is exhausted despite repeated source-IP mutation. Confirm the shared persisted counter, then restore the WAF rule as appropriate. Check WAF events and any earlier account-level skip/exception rules. Preserve sanitized evidence including policy rule ID, exact staging hostname, test requests/results and source revision. If the hosted tests are not run, treat same-zone ingress protection as **BLOCKED**, not passed. Do not enable public new-guest admission or merge based on a locally generated policy expression alone.

Cloudflare references: [Worker request header trust](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests), [WAF Worker-subrequest matching](https://developers.cloudflare.com/waf/custom-rules/use-cases/block-worker-subrequests/), [zone custom rule API](https://developers.cloudflare.com/waf/custom-rules/create-api/).

**Still unmet #15 release gates:** while hosted tests have confirmed the WAF rule behavior, application-level Worker shared quota enforcement under IP rotation, and negative Turnstile rejection paths, **a genuine positive Cloudflare Turnstile human challenge round trip** remains required and cannot be substituted by automated mocks or CI. Per-source admission is charged before the shared Worker-subrequest bucket: an already-exhausted source cannot drain that shared bucket by adding a forged `CF-Worker` header. However, a direct caller with remaining source quota can still spend the shared bucket with such a header; the application cannot authenticate that header and must not substitute this defense for the independently verified hosted WAF/trusted-ingress gate. A shared edge bucket is an abuse barrier, not an absolute protection against distributed IP or network rotation, paid-resource consumption, or a zero-cost service. Neither the Siteverify mock tests nor a green CI proves a real Cloudflare challenge round trip. Public guest admission remains disabled by default (`ALLOW_NEW_GUESTS=false`). See https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ for the required official server-side verifier and response fields.

### Issue #18 local live inbox stream (2026-11-10 JST)

MCP `subscriptions/listen` for the authenticated caller's single canonical
inbox resource is implemented through the pinned official SDK and a TableDO
stream. The feature is **disabled by default** in `wrangler.jsonc`. Enabling
`ENABLE_MCP_SUBSCRIPTIONS=true` alone is insufficient: the token must still
include `events:subscribe`, its connection grant must be current, the token
deadline must be valid, and TableDO must confirm table membership/lifecycle.
Reading actual private content separately requires `tables:read`. No client
may request another participant's inbox, a wildcard or a mixed filter.

The TableDO instance enforces one stream per membership, one queued URI hint,
grant checks before dispatch, a 60-second lifetime and explicit generation-
bound cancellation. The public SDK bridge sends at most four update frames
per listen request and then completes; clients reconnect explicitly and use
their last persisted `after_seq` cursor to catch up. It does not store events
for replay or wake up the user's AI by itself. OpenAI Events and external
callback delivery remain unavailable.

Verification: `npm run probe:subscriptions:sdk` tests the official SDK wire;
`npm run probe:subscriptions:table` tests the private TableDO streaming RPC;
`npm run probe:subscriptions:two-worker` runs the official client over two
distinct native Workerd Worker entries sharing the same SQLite TableDO and
OAuth/guest authority. The latter covers committed peer hints, filtering,
reconnect, replacement, bounded slow consumption and terminal/revoked grants.
All three are included in CI. They are local runs, so they do not
independently prove any Cloudflare deployment or a named AI host's action.
**Later authorized 2026-11-10 isolated Preview evidence supersedes the
historical NOT RUN Cloudflare measurement status:** exact-head official SDK
OAuth/stream checks passed twice, the five-post/four-hint output bound and
60-second idle termination were observed, and separate Preview/DO namespace
GraphQL analytics yielded request, CPU, active-time and GB-second totals.
The synthetic guest fixture was subsequently removed, with no production
or existing staging change. This is not a bill or real agent inference.
See the [current Issue #18 verification and measured limitations](notifications.md#current-issue-18-public-mcp-live-inbox-status-2026-11-10-jst).
