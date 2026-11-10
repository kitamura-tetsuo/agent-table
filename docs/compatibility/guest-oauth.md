# Guest OAuth interoperability — actual host evidence gate

Status: **TOOLS-LEVEL HOST OAUTH ACCEPTED FOR THE TESTED PRIVATE CONNECTION;
NOTIFICATIONS / AUTONOMY UNTESTED** as of 2026-11-10.
The owner-authorized ChatGPT Work private MCP app (`Agent Table Test2`) completed
Deny → same-guest Allow → synthetic create/read → real host refresh →
post-refresh read → same-grant browser revoke → host broker refusal
against an isolated staging Worker. Independent GuestDO/TableDO SQLite rows,
a bound token-refresh audit, and sampled Cloudflare edge receipts corroborate
the original four-scope grant and live table; the table had not expired when
the final host call was refused. The archived executable Worker `index.js`
was independently matched to Git source; this is not signed deployment
provenance.

The owner explicitly accepted **(a)** an undisclosed ChatGPT SaaS build ID
and **(b)** bounded, independently corroborated evidence without a common
host-to-Worker request ID for this isolated test. The nine-case redacted
record now passes the metadata **completeness** gate. This is a
**product/surface/account/date-scoped tools interoperability observation**,
not a blanket claim about ChatGPT, dots or future SaaS builds; metadata
completeness does not authenticate external receipts.
Deny is supported by owner browser observation and independent absence of
a new same-guest grant, not a raw `access_denied` callback. Following the
owner's browser revocation, the real host's next protected `get_table`
was refused at its broker with `oauth_token_invalid_grant`, not a host-origin
`/mcp` HTTP 401; the latter came from a separate synthetic client.
Host-side Disconnect remains explicitly `not-run` and has **not** been
equated with service revocation. Notifications and idle autonomous execution
remain untested. No production deployment took place; temporary staging
audit/diagnostic bindings and secret were removed and the unauthenticated
diagnostic endpoint returned 404.

## Latest single-guest, same-new-grant sequence — 2026-11-10 08:15–09:19 UTC

The redacted record
[`evidence.chatgpt-work-2026-11-10-same-grant.json`](../../test/e2e/host/evidence.chatgpt-work-2026-11-10-same-grant.json)
references **all nine** named host/browser cases in sequence for the same
synthetic guest and the grant approved at **08:23:39.606 UTC**. Unlike the
earlier snapshots below, create/read, host refresh, browser revocation and
protected-tool refusal all concern that **same grant**. Deny occurred before
that grant existed. `passed` refers to the paired client/server metadata
observations. Under the owner's documented evidence standard, the **nine-case
tools-level gate is accepted for this one tested surface and date**; it does
not establish universal compatibility or notification/autonomy support.

| Window UTC | Real-host/browser observation | Independent or bounded Worker-side corroboration |
| --- | --- | --- |
| 08:15–08:23 | Owner selected Deny, reused the same guest, then explicitly selected Allow | Edge `/authorize` 200/302 sequences; owner list and independent GuestDO SQLite showed **no Deny-era grant** and exactly one new four-scope Active grant after Allow ([Deny](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6762531457), [Allow/SQL](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6762767961)) |
| 08:25 | Actual ChatGPT Work MCP `create_table` and `get_table` returned matching synthetic waiting table/Seat 1 metadata | Independent initialized GuestDO reservation and live TableDO row matched creator, request fingerprint, timestamps and seat; sampled `/mcp` 200 ([cross-DO receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6762767961)) |
| 08:39–08:40 | Same authorized host connection read successfully when refresh was needed, and again afterward | Staging metadata audit identified `refresh_token` HTTP 200, guest+grant fingerprint and unchanged four-scope set; sampled `/oauth/token` 200 and `/mcp` 200; SQLite still Active ([refresh receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6762934030)) |
| 09:14–09:18 | Owner revoked that grant in the same-guest browser. The next actual-host protected `get_table` was refused with `UNAUTHORIZED` / `oauth_token_invalid_grant` and no table data | GuestDO SQLite matched the **same** grant fingerprint and persisted `revokedAt=09:14:59.588`; edge revoke 303 at 09:14:59 and `/oauth/token` 400 at 09:15:45; TableDO still retained the live waiting table ([revoke/refusal receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6763655747)) |
| 09:19 | Test instrumentation removed | Temporary SQL diagnostic and audit disabled; temporary secret removed; only three preexisting secret names; unauthenticated diagnostic 404; 100%-serving staging version `e3951afe-8f3c-4d53-9264-80e86d52882e`. No production deployment ([teardown receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6763655747)) |

Cloudflare's immutable archived executable `index.js` SHA-256
`f674eabff6883c99a5d3cc910d3832e7e471820b968e847e0711cefa8fac97f8`
matched the staging bundle reconstructed from source
`a560900dc9ebbbd108bb5c49e312512e1e626553`; inspected deployment
versions had different runtime bindings. There is **no signed chain of
provenance**, no shared host/broker/Worker request trace, and the **exact
ChatGPT Work SaaS build remains undisclosed**. A failed broker token exchange
is evidence of host protected-operation denial; it is **not** a host `/mcp`
401. The browser Deny lacked a captured raw `access_denied` callback.
Host Disconnect remains `not-run`, and notifications/autonomous execution
remain unverified. The owner approved the documented non-exposure of the
SaaS build and cross-source correlation without a common request ID on
2026-11-10. The revised metadata evaluator returns
`structurallyValid=true`, `completeRecord=true` for this nine-case snapshot;
that result is **not** a signed transcript or independent replay.

## Scope and inputs

Use one explicitly authorized private connector surface of a candidate
personal-agent host. Record its exact product/surface, version/build ID **if
exposed** (otherwise the explicit `not-exposed-in-tested-host` marker),
account/workspace eligibility, test UTC date, protocol/transport, canonical
resource, and the independently attributed Agent Table git SHA. The marker
must not stand in for unknown host eligibility or an untested connection.
A product landing page,
connection badge or SDK compatibility assertion does not count as host origin.
Do not purchase accounts, publish a connector, deploy to production or alter
permission/identity recovery rules merely to perform this test.

Use a separate staging Worker and isolated SQLite Durable Objects with a
synthetic owner guest, synthetic table title and no real conversation. Confirm
the Worker build SHA out-of-band; `https://<isolated-host>/mcp` must be the
canonical OAuth resource/audience for that exact deployment. Capture the
host product/version and whether this account can actually add a private MCP
connection. A candidate described in provider docs is not automatically
eligible for an individual account.

## Reproducible execution procedure

1. Create a synthetic run tag and copy
   `test/e2e/host/evidence.template.json` into an **uncommitted**
   local record. The template is deliberately all blocked; update only from
   observations. Retain real host/server traces only in authorized private
   evidence storage, redacted before review. Do not put secrets in Git.
2. From the **actual host UI**, try a private MCP connection with the
   canonical staging resource and observe discovery, dynamic client
   registration (if supported) and explicit browser guest selection/reuse.
   Record exact client-visible actions separately from Worker's safe request
   and grant observations.
3. Deny the OAuth consent once. Verify that no usable grant was issued and
   protected host-origin calls are denied. Repeat with deliberate consent
   for the selected guest and only the requested bounded scopes.
4. In the **real host session**, call `create_table` and `get_table`;
   correlate the returned ID with the stored table and verified guest and
   connection grant. A successful HTTP response or interface badge alone
   is not a protected-operation oracle. Do not log the raw table content.
5. Observe the **host's** actual refresh-token exchange and its next
   authenticated protected read. Correlate it with the same original guest,
   connection, canonical audience and scopes. A local token refresh fixture
   does not count.
6. Revoke the grant using that guest's browser connection-management page.
   Observe the host's next protected request being refused and confirm the
   persisted grant state. Record the host's own disconnect behavior
   separately; service revocation does not imply host-side disconnect.
7. Review redacted client- and server-origin evidence references for every
   required case. Run the evidence-schema regression in CI. Mark tools
   verified **only after a human reviewer validates the actual host/server
   receipts**. Keep notifications and autonomous idle-host execution
   *untested*; those are separate Issues #18–#24.

## Evidence format and fail-closed interpretation

`test/e2e/host/evidence.ts` exports the strict, metadata-only Zod schema
and `evaluateHostEvidence`. It requires both client-side (host or browser)
and server-side redacted observation references for each of nine test cases:
consent denial, guest choice, consent approval, create, get, real host refresh,
post-refresh read, browser revocation and host's post-revocation refusal.
Each case is `not-run`, `blocked`, `failed` or `passed`; no missing case
is silently interpreted as passed. Only an actually eligible host, actual
host-origin path and pinned isolated SHA/resource can yield a structurally
complete record. The validator deliberately does **not** authenticate or
replay external observations: completeness is not proof they occurred.

Keep evidence references to opaque, redacted IDs only, not URLs with tokens,
auth codes, cookies, unredacted headers or personal identifiers. Reject extra
JSON fields instead of accidentally retaining secret material. Store private
source traces outside Git under explicit access controls. If a wire-level
incompatibility is observed, add a separate synthetic/reduced OAuth regression
case; do not loosen PKCE, redirect, scope, audience, guest identity or
revocation rules. Use exact product/surface, tested date, build identity when exposed
(or explicitly disclosed non-exposure), and pinned endpoint/source SHA in any
compatibility claim, not a blanket provider label. Under this one owner-approved
test, time-bounded edge samples, matching GuestDO grant fingerprints, TableDO
creation fingerprints and actual-host tool results can be accepted without a
shared per-request trace ID. State the residual causal-correlation limitation;
never represent a broker token 400 as a host-origin resource 401.

## Observed 2026-11-09 UTC — partial, redacted

- **Actual host:** ChatGPT Work owner-authorized **private MCP app**
  `Agent Table Test2`. The account could register and use the private app.
  The host SaaS build/version was **not exposed** in the captured host UI or
  connector responses. This is an eligibility observation for **this** account
  and surface, not all ChatGPT accounts, dots, or other hosts.
- **Endpoint/transport:** `https://agent-table-test.outliner-online.com/mcp`
  over HTTPS MCP, on `agent-table-staging` with separate staging Durable
  Object and OAuth bindings. The owner selected/reused the same synthetic guest.
  No production origin or personal conversation was used.
- **Deployment provenance limitation:** Cloudflare identifies distinct
  deployed versions, not the Git SHA of the uploaded bundle. Revocation
  occurred under version `6296bab9-d3cf-45b5-a9b5-f2a408938556` at
  13:54:04Z; refresh-token audit under
  `0bf4b7b6-6221-43dc-9e49-c26a1b67a8fe` at 15:59:42Z; audit-off
  cleanup under `aede0218-480c-46e3-b3a8-dd39a44a6bc7` at 16:12:26Z.
  The audit deployment was reported as built from
  `8c92fec397b22c15cbff4a87c01bfe965357e333`, **not independently
  attested by Cloudflare**. These observations must not be represented as a
  single exact-head run.
- **Correlation limit:** Cloudflare Zone HTTP Analytics supplied redacted
  time/method/path/status. The metadata-only live tail supplied
  `grant_type=refresh_token`, HTTP 200, a validated binding digest and
  identical approved/issued four-scope arrays. The tail lacked a shared
  request ID and per-event timestamps: correlation is by the narrow test
  window. The [independent Cloudflare HTTP re-query](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6753587348)
  reproduced the old-grant revoke 303 / next MCP 401 and refresh-window token
  200 / MCP 200 results; it cannot independently replay the previous private
  grant-type/binding audit or create a shared trace ID.

| Required host case | Observed result | Evidence and remaining limitation |
| --- | --- | --- |
| Denied consent without grant | **PASSED FOR TESTED GUEST (OWNER STATE READBACK)** | Owner selected Deny, host showed connection failure, Cloudflare `/authorize` 200/302 matches and same-guest DO-backed connection list contains the same two prior rows with no new grant ([edge receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754509851), [state readback](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754667287)). Direct independent DO export and raw `access_denied` callback were not captured. |
| Deliberate guest choice/reuse | **OWNER OBSERVED** | Same guest shown across old revoked and fresh active grants; [browser report](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6743908128) |
| Approved consent | **OBSERVED** | Actual reconnect Allow and `/authorize` 200/302 followed by token 200; [client report](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6743908128), [server status](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6744413982) |
| Host `create_table` | **HOST TOOL + PERSISTED STATE OBSERVED** | Actual private-app tool result and independent 04:55 GuestDO reservation/TableDO waiting-row join for the new synthetic table; source is operator-labeled, not bundle-attested ([earlier host](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754828876), [cross-DO receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6759493658)) |
| Host `get_table` | **HOST TOOL + PERSISTED TABLE OBSERVED** | Host read matched its new create result; independent GuestDO/TableDO creation fingerprint and Seat 1 matched before the one-hour table expired. There is no shared HTTP request trace ID ([cross-DO receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6759493658)) |
| Actual host refresh token | **PASSED ON SOURCE-LABELED STAGING** | Real ChatGPT host `refresh_token`/200 and binding fingerprint matched the owner's Active guest connection; scope arrays identical ([same-version receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754963099), [older audit](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6744941273)) |
| Authenticated read after refresh | **PASSED ON SOURCE-LABELED STAGING** | Host `get_table` succeeded immediately after the independently bound active-connection refresh; edge `/mcp` 200 in the same short window, no shared request ID ([same-version receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754963099)) |
| Same-guest browser revocation | **PASSED; INDEPENDENT GRANT-STATE READBACK** | Owner revoked the current grant in browser. Earlier window: revoke 303 and broker token 400. Latest window: GuestDO SQL showed the previously active 04:51 grant `revokedAt=05:17:10.343 UTC`, edge revoke 303 at that second and subsequent token 400 ([older window](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6756230954), [independent SQL/edge](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6760336421)) |
| First host call refused after revocation | **PASSED AT HOST REFUSAL LAYER; NO HOST `/mcp` 401 CLAIM** | An actual-host `get_table` returned connector `UNAUTHORIZED` / `oauth_token_invalid_grant` with no table data. The latest new-grant run adds exact GuestDO `revokedAt` plus sampled revoke 303 and later `/oauth/token` 400, but still no host-origin resource 401 or per-request trace. The stale-token `/mcp` 401 is from a separate synthetic client ([latest host refusal](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6760062073), [independent SQL/edge](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6760336421), [synthetic resource 401](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6758016570)) |
| Host-side Disconnect | **NOT RUN** | Service-side Revoke and host-side Disconnect are distinct |
| Notification receipt / idle autonomy | **UNTESTED** | Not part of #23 OAuth gate; separate #18–#24 |

The default `evidence.template.json` intentionally remains entirely blocked
for **new** test runs. The redacted, **incomplete** snapshots
`evidence.chatgpt-work-2026-11-09.json`,
`evidence.chatgpt-work-2026-11-10-pinned.json` and
`evidence.chatgpt-work-2026-11-10-deny.json` and
`evidence.chatgpt-work-2026-11-10-refresh.json`,
`evidence.chatgpt-work-2026-11-10-revocation.json` and
`evidence.chatgpt-work-2026-11-10-sql-revocation.json` preserve **distinct**
deployment/test or connection windows. The last snapshot intentionally has
no single `buildSha`: its real-host create/get, browser revocation and
post-revocation SQLite readback span several staging Worker versions.

The Deny case passes on the owner's same-guest DO-backed list; actual-host refresh and subsequent read pass in a
separate staged run; browser revocation passes in its own later staged run.
The `rejectedAfterRevocation` case in the revocation snapshot records a **host
protected-tool refusal** at the broker's failed OAuth exchange, **not** an
actual-host `/mcp` HTTP 401. The latter was observed only in a separate
standalone client experiment. All overall records remain **incomplete**.
Validation cannot authenticate external receipts or merge older observations
into a newer version's result.

### Source-labeled staging smoke test — 2026-11-09 22:39–22:43 UTC

- With a **clean** Git checkout at
  `ffb8676010dae337c08c70db91f29429afbe22e5`, deployed to the same
  isolated staging Worker. Wrangler/Cloudflare independently returned version
  `8a44a405-6ed3-4f8d-b392-234313f322dd` with a deployment annotation
  naming that full Git SHA, three preserved secret bindings and
  `OAUTH_AUDIT_MODE=off`. The version annotation records the operator's
  deploy command; it is **not a cryptographic binary/source attestation**.
  An intermediate superseded version had an incorrect short-SHA annotation
  and is deliberately excluded from acceptance evidence.
- From the existing live ChatGPT Work connection, a fresh synthetic
  `create_table` followed by `get_table` returned matching table identity,
  state and Seat 1 metadata. The owner connection was **not** revoked or
  reauthorized. One-hour table expiry bounds the test data.
- Read-only Cloudflare Zone HTTP Analytics corroborated `/oauth/token` 200
  at 22:41:41Z and `/mcp` 200 at 22:41:44Z, 22:41:50Z and 22:43:18Z.
  Only UTC time/path/status were queried. These are matching-window edge
  receipts, **not** independently joined Durable Object write/read evidence.
  The token's grant type was not observed with audit off.
- See the [redacted PR receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6753521454).
  Host SaaS build remains undisclosed; the metadata-only schema must reject
  sentinels such as `not-exposed` as a completed build identity.

### Post-Deny use of existing authorized connection — 2026-11-09 23:56 UTC

- The real ChatGPT Work private app `Agent Table Test2` invoked
  `create_table` and `get_table` on another synthetic one-hour table.
  The two responses agreed on table identity, title, state, creator Seat 1
  and expiry. No personal content, invitation or grant mutation was involved.
  This demonstrates continued protected tool access through the **existing
  authorized connection**, not approval of the separately denied attempt.
- A fresh read-only Cloudflare Zone `httpRequestsAdaptive` query for
  23:56:20–23:57:25Z returned `/oauth/token` **200** at 23:56:48Z
  and `/mcp` **200** at 23:56:51Z and 23:56:57Z. Wrangler still identified
  source-labeled staging version `8a44a405-6ed3-4f8d-b392-234313f322dd`
  as the latest 100% deployment. These are time-aligned edge observations,
  not independent TableDO writes or a grant/guest request-ID join.
- The token request's **grant type is unknown**, so this observation does
  **not** pass the real-host refresh case. Without a server-side binding and
  table receipt, the protected create/read cases remain incomplete.
  [Redacted evidence](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754828876).

### Separate owner-origin Deny attempt — 2026-11-09 23:35 UTC

- The owner configured another ChatGPT Work private MCP connection to the same
  staging resource, selected **Deny** at OAuth consent and returned to
  `https://chatgpt.com/plugins`, which displayed a connection failure. This is
  owner-reported actual-host UI evidence; no raw callback URL was retained.
  The existing `Agent Table Test2` connection was not revoked.
- A fresh, read-only Cloudflare HTTP Analytics query for
  23:35:00–23:38:00Z observed three **pre-consent** `/mcp` **401** events,
  OAuth discovery 200, `/oauth/register` **201** at 23:35:35Z, `/authorize`
  **200** at 23:35:51Z and **302** at 23:35:56Z. The narrow sampled result
  contained no `/oauth/token` request. By itself this matches Deny but
  establishes neither post-Deny protected refusal nor the absence of a
  persisted grant. [Redacted PR receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754509851).
- Wrangler still reports staging version
  `8a44a405-6ed3-4f8d-b392-234313f322dd`, tagged with the full source SHA
  `ffb8676010dae337c08c70db91f29429afbe22e5` and `audit=off`.
  `src/auth/provider.ts` has no diff between that SHA and the current PR head.
  In this source, `decision=deny` calls `oauth.denyConsent` and returns 302
  **before** `guest.createConnection`. Both Deny and Allow can produce 302,
  so a status-only observation cannot prove the branch executed. The version
  annotation is operator-provided provenance rather than a cryptographic
  deployed-bundle attestation.
- The owner subsequently supplied the same guest's post-Deny browser
  `Connection permissions` list: the only rows are the **unchanged** Active
  connection created at 15:23:34.309Z and Revoked connection created at
  13:55:38.644Z, both **before** the 23:35:56Z Deny. `GuestDO.listConnections()`
  reads all that guest's persisted rows (including revoked entries) ordered
  newest-first, with a 200-row limit; with only two returned, no fresh grant
  appears for that guest. This is a **server-backed UI readback supplied by the
  owner**, not an independent raw DO export or captured OAuth callback.
  The case is marked `passed` with those evidence limitations.
  [Redacted review](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754667287).

### Same-connection real-host refresh — 2026-11-10 00:04 UTC

- Temporarily enabled the existing **metadata-only** OAuth audit on isolated
  staging Worker version `c30937eb-7fe9-4730-8dc6-0f049a2929eb`,
  deployed at 00:04:08Z with operator annotation `source_sha=e067bf2`.
  The handler records only fixed grant categories, HTTP status, an opaque
  12-byte SHA-256 guest/connection binding fingerprint, and scope names.
  It does not record token values, OAuth request bodies, cookies or IPs.
- The existing real ChatGPT Work private connector invoked `get_table`
  on the short-lived synthetic table from 23:56. Live `wrangler tail`
  reported `grant_type=refresh_token`, HTTP **200**, and a successfully
  validated binding whose approved and issued scopes contained the same
  four expected scopes. The fingerprint recomputed from the owner's
  post-Deny guest/connection list matched the **Active connection** exactly
  and did not match the Revoked connection. Raw IDs and fingerprint are
  omitted from public evidence.
- Cloudflare Zone HTTP Analytics separately returned `/oauth/token`
  HTTP **200** at 00:04:37Z and `/mcp` HTTP **200** at 00:04:40Z.
  The real host `get_table` result succeeded on the existing table.
  This is a same-deployment, narrow-window causal sequence, though it
  lacks a shared per-request trace ID or independent TableDO storage export.
  The refresh and post-refresh read cases therefore pass for this
  owner-authorized active connection, not for all hosts or versions.
- Afterward the metadata-only tail was stopped; staging config and live
  Worker were restored to `OAUTH_AUDIT_MODE=off`, with confirmed version
  `78faef17-37cb-42bf-a740-2946d097621f` deployed at 00:07:23Z.
  Source and audit-on annotations are operator claims, not cryptographic
  bundle attestations. [Redacted host/server receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6754963099).
  The separate
  `evidence.chatgpt-work-2026-11-10-refresh.json` documents these two
  passed cases without combining Deny, table creation or revocation from
  different deployment windows.

### Current-connection revocation and token refusal — 2026-11-10 00:58–01:22 UTC

- The owner revoked the connection that had previously matched the successful
  refresh audit. No subsequent Allow/reconnection was performed before the
  protected `get_table` attempt. ChatGPT's private app returned
  `UNAUTHORIZED` / `oauth_token_invalid_grant` and requested
  reauthentication instead of returning table metadata.
- Read-only Cloudflare Zone `httpRequestsAdaptive` returned the same
  staging host's `/guest/connections` HTTP 200 at 00:58:35Z and 00:58:38Z,
  `/guest/connections/revoke` HTTP **303** at 00:58:38Z, then
  `/oauth/token` HTTP **400** at 00:59:43Z. The deployed staging Worker was
  version `78faef17-37cb-42bf-a740-2946d097621f`, marked
  `source_sha=e067bf2`, with metadata audit disabled. In the implemented
  route, HTTP 303 is returned only after the authenticated GuestDO revocation
  transaction completes; unknown/unauthorized targets return 404/401.
- This is **actual server-side refusal** of post-revocation token exchange,
  consistent with the host's invalid-grant error. It does **not** prove an
  `/mcp` HTTP 401 for the freshly revoked connection: the ChatGPT broker
  may stop before making a protected tool request. Neither an independent
  GuestDO state export nor a shared trace ID was collected. The
  `revokedInBrowser` case passes with these stated limits. The
  `rejectedAfterRevocation` case also passes **only at the actual-host refused
  protected-tool boundary required by REQ-003**, preserving the distinction
  between OAuth 400 and protected-resource 401.
  [Redacted HTTP/client receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6756230954).
  The matching metadata snapshot is
  `evidence.chatgpt-work-2026-11-10-revocation.json`.

### Reconnected host and independent resource check — 2026-11-10 02:53–03:18 UTC

- After a new explicit **Allow** in the owner-authorized ChatGPT Work
  private app, live `create_table` and `get_table` returned the same
  short-lived synthetic table. The owner then revoked that connection in
  the same guest's browser UI. The **next real-host `get_table`** failed
  `UNAUTHORIZED` / `oauth_token_invalid_grant`; the host did not deliver
  table data. A separate sampled Cloudflare edge query showed `/mcp` 200
  before revocation, `/guest/connections/revoke` 303 at 02:58:32Z and
  `/oauth/token` **400** at 02:58:50Z. This is a refused host operation
  **at the OAuth broker**, not a measured host-origin `/mcp` 401.
  [Redacted host/edge receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6757741647).
- A **different, standalone synthetic OAuth client**, using explicit browser
  approval of a new `tables:read` grant and PKCE, received an access token
  with 900-second TTL at 03:12:18Z. Before revocation, its deliberately
  uninitialized `tools/list` MCP request returned **400**, *not* 200 or
  a successful protected tool. After owner browser revocation, the **same
  unrefreshed, unexpired in-memory access token** received `/mcp` **401**
  at 03:15:30Z and again at 03:18:19Z. Live Worker tail independently
  observed the latter `POST /mcp` 401; sampled edge analytics did not
  include the post-revocation 401s. These are **resource-server revocation
  checks only**, never claimed as real ChatGPT-origin calls.
  [Standalone client and live-tail receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6758016570).
- Neither sequence captured a shared host/Worker/GuestDO/TableDO trace
  identifier or a direct independent SQLite Durable Object row export. The
  real-host refusal case can be recorded **as host-refused**, but the full
  interoperability acceptance remains open until independently paired
  grant/table evidence and host/deployment identity requirements are resolved.

Before closing #23, independently review the paired host/Worker/DO grant and
table receipts for all cases, and ensure
any **new** head-specific acceptance run uses the tagged deployment instead
of pooling historical refresh/revocation versions.
Then review and merge only after all six requirements are satisfied. Host
disconnect remains separately identified, not silently presumed. No public
IPv4 receiver or production deployment is needed for this OAuth gate.

### Temporary staging-only Durable Object SQLite inspection

The PR includes a deliberately dormant `POST /__staging/evidence` route for
CLI-operated, independent SQLite row checks. It cannot be activated unless
`PUBLIC_ORIGIN` is exactly the isolated test origin and
`STAGING_EVIDENCE_MODE=read-only`. It also requires a separately generated,
64-character lowercase hexadecimal `STAGING_EVIDENCE_KEY` secret supplied via
the `X-Agent-Table-Staging-Evidence` request header. The committed staging
operator's normal staging configuration is **off**; the temporary enabled configuration and secret must
not be committed or used with production. Only the operator with this separate
secret may use the probe.

A bounded JSON POST accepts exactly a UUID-v4 `guestId`, and optionally
`tableId` and `connectionId`. The Worker uses exact-name DO stubs, and the
DOs query their own SQLite rows (not the normal HTTP response), including up
to eight newest grants with randomized-ID fingerprints and bounded scope lists:
`guest_identity`, `guest_connections`,
`guest_creation_reservations`, `table_metadata`,
`table_memberships`, and a terminal tombstone if present. Responses have
`Cache-Control: no-store`, statuses, timestamps, ownership booleans and a
truncated SHA-256 fingerprint of the independently random creation request ID.
The same fingerprint appearing in the GuestDO reservation and TableDO
metadata provides an exact operation join without publishing the request ID.
The probe does **not** return original guest/connection/table IDs, table titles,
message bodies, cookies or OAuth tokens. It accepts neither SQL text nor an
arbitrary object name. Absence of a row is evidence of absence **at the probe
time**, not evidence that no expired row ever existed.

Run from the trusted staging operator's CLI with a high-entropy temporary
secret installed through `wrangler secret put` using the temporary staging
configuration. Pin the deployed Worker version and source SHA, query only
owner-authorized synthetic IDs, then restore the **off** staging configuration,
delete the temporary Cloudflare secret and confirm HTTP 404 on the diagnostic
route. Securely discard the local secret. Keep only redacted outcome metadata.
A staging SQL receipt is **not** an actual-host tool receipt or a complete
host/product build attestation; #23 must remain open until the independent
host/origin/refresh/revocation acceptance evidence is complete.

### CLI-inspected staging SQLite receipts — 2026-11-10 04:47–04:58 UTC

- A separately generated 256-bit key activated only the isolated
  `agent-table-staging` Worker on the canonical test host. Authless diagnostic
  POST returned **401**; authenticated POST returned **200**. The first version
  (`390e171d-96f5-4b40-a3dc-1d06521c19c1`, annotated source
  `14f258d30ecd`) directly found an old, initialized GuestDO reservation
  with an expired TableDO tombstone. Because the table body had already been
  purged, this old result **does not** establish a persisted-row join.
- Under an owner-authorized reconnection of the **actual ChatGPT Work private
  MCP app**, the host made a fresh synthetic `create_table` followed by
  `get_table`; both returned the same metadata for a one-hour waiting table.
  The new grant was created at **04:51:35.627 UTC**, followed by the table
  creation at **04:52:06.146 UTC**. The host did not expose an exact
  SaaS client build or durable request-level trace ID.
- A second temporary staging version
  `ddd0e763-ad29-4b38-82fe-9fbc1e511ba8`
  (operator-annotated source `756c21b9ee6e`) read the **independent SQLite**
  rows at **04:55:15.770 UTC**. GuestDO reported the creator identity present,
  an `initialized` reservation, and request fingerprint
  `4610bca73dd2bd4a84a8db7e`. TableDO reported persisted `waiting`
  metadata, matching created/expiry timestamps, matching fingerprint,
  matching creator guest, and Seat 1 creator membership. This is a direct
  cross-DO creation-request join, not an HTTP-success inference.
- The same GuestDO read showed a most-recent **active** grant with fingerprint
  `0d804cfcce827de1052d34bd`, creation time
  **04:51:35.627 UTC**, and exactly the bounded scopes
  `tables:read`, `tables:write`, `tables:delete`,
  `events:subscribe`. Four older grants were `revoked` in independent
  SQLite storage. This provides independent same-guest, time-correlated
  grant state but **not** a per-call cryptographic match of that grant to the
  host broker's token or a post-revocation refusal in this new run.
- The operator restored `STAGING_EVIDENCE_MODE=off` in staging version
  `63d7d80a-c17c-4d37-8cfa-fd1e769c3250`, deleted the one-time
  Cloudflare secret (which produced version
  `a5eb0215-eb2e-4968-b840-a846f3c185da`), removed the local key and
  temporary enabled configuration, and verified the probe returned
  **404** afterward. No production Worker was deployed.
- **Status at this earlier 04:58 cutoff:** Revocation for the newly active
  grant had not yet been performed. The owner subsequently revoked it, and
  independent persisted-state and HTTP readbacks are now documented in the
  following section. The host SaaS build and exact per-request joins remain
  unavailable; the refresh and denial windows are distinct. Version-to-source
  mappings are operator annotations, not cryptographic bundle attestations.
  Host Disconnect remains not run; #41 stays Draft and #23 stays open.

### Post-revocation independent GuestDO SQLite and edge readback — 2026-11-10 05:17–05:55 UTC

- The owner reported revoking the latest `Agent Table Test2` connection,
  which had created and read a synthetic table at 04:52 UTC. The actual
  browser click is owner-reported; it is not an independent browser recording.
- A separately authenticated, staging-only SQLite read at
  **05:54:32.033 UTC** found that the **same connection fingerprint**
  `0d804cfcce827de1052d34bd`, observed `active` in the earlier
  04:55 GuestDO read, was now **`revoked`**. Its creation timestamp remained
  **04:51:35.627 UTC**, and the persisted `revokedAt` was
  **05:17:10.343 UTC**. All four allowed scope names were unchanged;
  the other four bounded recent grants were also revoked.
- A read-only, sampled Cloudflare zone HTTP query independently observed
  `/guest/connections/revoke` HTTP **303 at 05:17:10 UTC**, followed by
  `/oauth/token` HTTP **400 at 05:19:34 UTC** on the canonical staging host.
  The browser revocation route's persisted timestamp and the edge 303 align
  to the second. The exact token and grant type were not captured.
- An actual ChatGPT private-app `get_table` call after revocation returned
  connector `UNAUTHORIZED`, reason `oauth_token_invalid_grant`,
  and requested reauthentication. No new connection was approved. The call
  used a previously known synthetic table ID from an older run; it proved
  host connector refusal, **not** an actual host-origin `/mcp` HTTP 401.
- The newly created table's one-hour retention had ended at
  **05:52:06.146 UTC**. GuestDO still retained the `initialized`
  creation reservation and fingerprint `4610bca73dd2bd4a84a8db7e`,
  while TableDO reported no live metadata and an `expired` tombstone.
  Its earlier **pre-expiry** 04:55 persisted-row join remains the
  creation/read authority. This later expired row is not silently counted
  as a live table.
- Independent GuestDO history also showed the separate earlier host-refresh
  connection created at **2026-11-09 15:23:34.309 UTC** was revoked at
  **2026-11-10 00:58:38.921 UTC**, matching the earlier browser
  revocation/edge-303 window by guest and time; this does **not** fabricate
  a missing shared per-request trace ID.
- For the follow-up read, the operator briefly deployed
  `STAGING_EVIDENCE_MODE=read-only` with a new 256-bit in-memory key
  (version `c690bc0c-b3a3-4a6c-a3cf-dcc3f0412d63`, operator-labeled
  source `a560900dc9ebbbd108bb5c49e312512e1e626553`). The Worker was
  promptly restored to `off` (version
  `75effa87-fb15-4e29-99c1-238c33d512c7`), the temporary secret
  deleted (final version `7fc7d091-614e-4c43-812d-d75ca2d42308`),
  the secret-list checked, and unauthenticated diagnostic HTTP **404**
  re-confirmed. No production deploy.
- Cloudflare's version metadata independently provides hashed script-content
  ETag `4769f6048a81c2f49b0429731eae329d170c74ac1405576ce16140cba565dcd6`
  for both the temporary active and final disabled builds. The ETag
  identifies equal deployed script bytes between those versions; it does
  **not** itself prove those bytes equal the operator-annotated Git SHA.
  The exact ChatGPT Work SaaS build is still not exposed.

[Redacted paired host/edge/SQLite receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6760336421).
The observation upgrades **post-revocation grant-state evidence**, but not
full single-run nine-case host acceptance. At this inspection cutoff, no
independent executable-script/Git-source byte comparison had been recorded;
that follow-up is documented below. Exact SaaS build and shared
host-to-Worker per-request joins remain unavailable; refresh and denial
were observed in distinct earlier windows. Host Disconnect remains
separately untested. Keep #41 Draft, #23 open, and notification/autonomy
claims untested.

### Archived executable Worker script against source — 2026-11-10 06:22–06:30 UTC

- Independently queried Cloudflare's read-only [Worker deployment list](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)
  to identify the **100%-serving Worker version at each event time**. Queried
  each immutable [Worker version's code modules](https://developers.cloudflare.com/api/typescript/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/)
  with `include=modules`, decoded `index.js.content_base64` in memory,
  and calculated SHA-256. No source contents, bindings, or API tokens were
  printed or committed.
- Independently checked out each source commit in a temporary detached Git
  worktree. With the same unchanged package lock, installed Wrangler
  **4.158.0**, and the staging-only `wrangler.staging.jsonc` configuration,
  `wrangler deploy --dry-run --config wrangler.staging.jsonc --outdir
  <temporary-directory> --var STAGING_EVIDENCE_MODE:off` generated a local
  `index.js` without deploying anything. The mode is a runtime binding,
  not embedded JavaScript. The staging config is a local operator-supplied
  file, not itself Git-committed provenance.
- In the two temporary worktrees, the shared `node_modules` symlink made
  esbuild label 33 non-executable source-file comments as
  `// ../../home/ubuntu/src/agent-table/node_modules/...` instead of the
  deployment's `// node_modules/...`. Replacing **only that exact leading
  comment prefix**, in memory, restored **byte-for-byte equality** with the
  archived executable module. No runtime JavaScript was ignored or rewritten.
  Building from the current original worktree required no normalization.

| Actual staging interval/event | 100%-serving version | Git source reconstructed | Archived executable `index.js` SHA-256 | Exact comparison |
| --- | --- | --- | --- | --- |
| Host create/read at 04:52 UTC (04:47:24–04:54:55) | `390e171d-96f5-4b40-a3dc-1d06521c19c1` | `14f258d30ecd29efe96881f5d4c72a153e43c553` | `9b31fd8cd6a3d61a7b273e623db5d8efe83a3d92e453df5d839f233ad0055d9f` | **Equal after 33 comment-path normalizations** |
| Independent creation readback at 04:55, browser revoke at 05:17, broker 400 at 05:19 (04:54:55–05:54) | `ddd0e763-ad29-4b38-82fe-9fbc1e511ba8`, then `a5eb0215-eb2e-4968-b840-a846f3c185da` | `756c21b9ee6e5eadf2089624721f79962e83b5f2` | `68cbc9ebbe5781be96c829ff4a3e552cf82d80ee9558597dc6652ed3074c56f5` | **Equal after 33 comment-path normalizations** |
| Post-revocation SQLite readback and final disabled Worker at 05:54 | `c690bc0c-b3a3-4a6c-a3cf-dcc3f0412d63`, then `7fc7d091-614e-4c43-812d-d75ca2d42308` | `a560900dc9ebbbd108bb5c49e312512e1e626553` (same `src/` and lockfile as `2ea1e36`) | `f674eabff6883c99a5d3cc910d3832e7e471820b968e847e0711cefa8fac97f8` | **Raw executable module SHA-256 equal** |

- The live script-content API also returned `index.js.map`, whose bytes
  differed from the local dry-run source map. **Only the executable
  `index.js` module was verified**; this is not an end-to-end signed build
  or artifact provenance statement. Version metadata and the 100% deployment
  intervals are Cloudflare API observations, not merely operator annotations.
- This materially improves Git-source-to-runtime-code attribution for
  each event window, but does **not** make the different windows a single
  deployed-build/connection acceptance run or expose the exact ChatGPT Work
  SaaS build. No shared per-request host-to-Worker/DO trace exists.
  Keep #41 Draft and #23 open.
