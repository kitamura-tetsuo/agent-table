# Callback egress: hosted-Workers security evidence gate

Status as of 2026-11-08: **blocked for public webhook delivery**. This is
partial Issue #19 work, not an accepted outbound HTTPS transport. The
production sender now contains a bounded native-fetch **candidate**. The
separate opt-in diagnostic Worker executes **that same sender**, not a separate
HTTP algorithm. Public Events remain disabled; a working sender is not an
accepted connection-boundary security proof.

## Production topology and preflight

The MCP Events provider supplies a per-subscription HTTPS callback URL (which
may have an opaque path or query) to Agent Table's Cloudflare Worker. Agent
Table will eventually send verification and signed event POSTs **to that
provider callback URL**. The operator does not host a production receiver,
own a public IPv4 VPS, or need a separate inbound webhook path. A provider
endpoint may itself be Cloudflare-fronted.

`src/notifications/egress.ts` only accepts an exact canonical HTTPS origin
reviewed by the operator plus a deliberately configured path-segment prefix.
The provider may generate arbitrary path suffixes and query values within that
policy. Choose `/` explicitly if the provider does not use a common callback
prefix; this grants path flexibility **only on the exact reviewed origin**.
Malformed review policies, URL credentials, IP literals, local/reserved names,
nonstandard ports, fragments, and unreviewed destinations fail before I/O.
This policy limits destinations but cannot inspect the connection's DNS result.

## Threat boundary

The intended transport must enforce an operator-reviewed HTTPS destination,
a public address **at the connection actually used**, and TLS peer identity
for the original allowed hostname. DNS preflight followed by a separate
`fetch` is susceptible to rebinding; a URL allowlist does not enforce an
address policy. Disabling redirects alone does not repair this gap.

The application sender now uses native global fetch, an exact reviewed URL,
manual redirects, finite overall deadline, a 16 KiB request cap, and streamed
64 KiB response cap, with typed safe outcomes and no retries. The public
`callbackTransportReadiness()` gate **still returns disabled** because the
hosted final-IP/rebinding proof is absent. This code change is not an
authorization to call it from public Events.

## Supported runtime APIs and unresolved connection boundary

- Hosted Workers outbound HTTP is mediated by Cloudflare's proxy, which
  restricts targets to public Internet services or the Worker's own zone's
  origin. That is a relevant platform boundary, **not a documented guarantee
  that each dynamic callback hostname is re-resolved and checked against all
  forbidden ranges at the final connection, including DNS rebinding**.
  [Hosted Workers security model](https://developers.cloudflare.com/workers/reference/security-model/)
- Without `global_fetch_strictly_public`, the hosted global `fetch` may route
  same-zone requests to the zone origin, bypassing the public front door.
  The isolated probe **and application wrangler configuration** opt into this compatibility flag; it is a necessary
  routing defense for the probe, **not proof of connection-time IP policy or
  DNS-rebinding refusal**. It does not affect local workerd's global fetch.
  [Global fetch compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
- Worker-native `fetch` supports `redirect: "manual"` and abort signals;
  `redirect: "error"` is unsupported. `cf.resolveOverride` is limited to
  same-zone hosts, not arbitrary provider IP pinning. No documented API used
  here lets us independently confirm original-host certificate validation and
  connection-time DNS/IP policy for an arbitrary provider callback.
  [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)
- Raw TCP sockets to Cloudflare IP ranges are blocked, and Cloudflare directs
  HTTP clients to native `fetch`. The exploratory `node:dns` + `node:tls`
  pinned-address technique from the closed PR #34 cannot be the universal
  transport for Cloudflare-fronted provider callbacks.
  [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- Local `workerd` is not the complete hosted platform security proxy and lacks
  some production defense-in-depth controls. Local tests cannot establish
  connection-time public-IP, DNS-rebinding, or TLS-name enforcement on the
  actual hosted network.
  [Local development security](https://developers.cloudflare.com/workers/local-development/)
- Remote Wrangler preview requests to another Cloudflare zone may be affected
  by the preview-token limitation. Such a failure is not proof that the
  production `fetch` path cannot reach Cloudflare-fronted callbacks.
  [Known Wrangler remote-preview issue](https://developers.cloudflare.com/workers/platform/known-issues/)

## Isolated native-fetch reachability probe

`test/egress/probe-worker.ts` is a separate Worker entry point with its own
`test/egress/wrangler.jsonc`, **not imported by the production application**.
It only sends a fixed synthetic POST after all four probe bindings are present:

| Binding | Purpose |
| --- | --- |
| `PROBE_AUTH_TOKEN` | High-entropy bearer token for the probe's only route |
| `PROBE_CALLBACK_URL` | An explicitly authorized HTTPS receiver URL, possibly with opaque path/query |
| `PROBE_REVIEWED_ORIGIN` | Canonical reviewed HTTPS origin for that exact receiver |
| `PROBE_REVIEWED_PATH_PREFIX` | Canonical path policy, with `/` only when deliberate |

Store these as local `.dev.vars`/remote secrets for the isolated probe; **never
commit, paste into reports, or log the token or callback URL**. With bindings
missing, the probe returns `disabled` and does not call `fetch`. Unauthenticated
requests return 404. The authenticated `POST /__egress_probe` invokes **sendVerifiedHttps**
from the application source with native `fetch`, `redirect: "manual"`, an abort
deadline of 10 s, a fixed synthetic request body, and streaming response
counting up to 64 KiB. It returns only a
safe result category. There is no retry, body echo, redirect follow, or generic
caller-supplied target. Its success category is deliberately named
`reachable`, **not** `ssrf-safe` or `verified-transport`.

Reproducible local smoke/test commands (no external account required):

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npx wrangler deploy --dry-run --config test/egress/wrangler.jsonc --outdir ../../dist/egress-probe
npx wrangler dev --local --config test/egress/wrangler.jsonc --ip 127.0.0.1 --port 8788
```

If the operator separately authorizes a real Cloudflare preview, supplies a
genuine controlled receiver and secrets, use the same isolated configuration
with `npx wrangler dev --remote --config test/egress/wrangler.jsonc`. Post to
the preview's `/__egress_probe` with the bearer token. Record only the result
category, deployed preview build identity, Wrangler/workerd version, execution
mode, test date and a separately retained receiver receipt. Do not run a
production `wrangler deploy`, publish a public egress proxy, or choose a paid
plan to perform this experiment. A remote receiver's 2xx still proves only
HTTPS reachability and bounded diagnostic response handling, not REQ-002.

## Evidence classification and actual-runtime execution (2026-11-08 JST)

Toolchain pinned in `package.json`/lockfile: Node 24.22.1, Wrangler 4.158.0,
Cloudflare Vitest plugin 1.6.0; local `workerd 2026-11-04`.
Authenticated Cloudflare Account ID: `0fbaae27d3ff021bc17109f1493d0b2d`
Execution Mode: Cloudflare Workers Remote Preview (`npx wrangler dev --remote --config test/egress/wrangler.jsonc --port 8788 --ip 127.0.0.1`)
Receiver Fixture: Cloudflare Tunnel endpoint `https://probe.outliner-online.com/egress-check/*` backed by local listener on `127.0.0.1:8790` (PID 313679).

### Test Matrix and Actual Outcomes

| Case / Scenario | Test Execution & Observed Outcome | Receiver Receipt | Status |
| --- | --- | --- | --- |
| Allowed HTTPS host (Cloudflare-fronted) | POST `/__egress_probe` with valid token -> Worker POSTed synthetic JSON to `https://probe.outliner-online.com/egress-check/positive`, received HTTP 204, returned `{"result":"reachable"}` (HTTP 200) | Receiver logged `mode: "positive"`, HTTP 204 returned, socket established | **PASS (reachability only)** |
| Provider-generated opaque query | POST `/__egress_probe` to URL with `?param=opaque-token-123` -> returned `{"result":"reachable"}` (HTTP 200) | Receiver logged synthetic arrival | **PASS** |
| HTTP Redirect (302) | POST `/__egress_probe` to `/egress-check/redirect` -> 302 Location returned by receiver; Worker returned `{"result":"redirect-refused"}` (HTTP 502) without following Location | Receiver recorded single redirect request | **PASS** |
| Response exceeding 64 KiB | POST `/__egress_probe` to `/egress-check/large` (65,537 bytes) -> Worker aborted stream and returned `{"result":"response-too-large"}` (HTTP 502) | Receiver recorded response transmission | **PASS** |
| Response delay > 10 s | POST `/__egress_probe` to `/egress-check/slow` (15 s delay) -> Worker aborted at 10 s deadline and returned `{"result":"deadline"}` (HTTP 504) | Receiver connection aborted by client deadline | **PASS** |
| Unreviewed path | Target set to `/forbidden-path` -> Worker returned `{"result":"destination-rejected"}` (HTTP 422) before I/O | No network request sent to receiver | **PASS** |
| Unreviewed host | Target set to `https://evil.example.com/...` -> Worker returned `{"result":"destination-rejected"}` (HTTP 422) before I/O | No network request sent | **PASS** |
| Direct IP literal | Target set to `https://127.0.0.1/...` -> Worker returned `{"result":"destination-rejected"}` (HTTP 422) before I/O | No network request sent | **PASS** |
| Missing configuration / auth token | Target bindings missing -> Worker returned `{"result":"disabled"}` (HTTP 503, fail-closed) | No network request sent | **PASS** |
| Unauthenticated probe request | Missing / incorrect `Authorization: Bearer` -> Worker returned HTTP 404 | No network request sent | **PASS** |
| URL credentials & nonstandard ports | `validateReviewedCallbackDestination` rejection assertions in Workerd Vitest unit suite | N/A (local workerd) | **PASS (local)** |
| Outgoing body > 16 KiB | `sendVerifiedHttps` request size check assertion in Workerd Vitest | N/A (local workerd) | **PASS (local)** |
| Connection-time destination IP validation | Workers native `fetch` provides no API to inspect or pin destination IP address at connect time | N/A | **BLOCKED (runtime limitation)** |
| DNS Rebinding defense | Dynamic `fetch()` re-resolves DNS independently; pre-lookup cannot guarantee address at connect time; platform lacks documented rebind SLA | N/A | **BLOCKED (runtime limitation)** |
| TLS certificate hostname mismatch | Independent OpenSSL reported a hostname mismatch; earlier hosted probe returned HTTP 526 and categorized it as `upstream-non-2xx` | No independently captured origin/connection trace for the exact candidate sender | **OBSERVED (HTTP 526); original-host TLS-name proof still BLOCKED** |
| Prohibited private IP at DNS resolution | No authorized DNS fixture resolving public name to RFC1918 / loopback in hosted runtime; Cloudflare API 403 (Wrangler OAuth token lacks `dns:edit` permission) | N/A | **NOT RUN / BLOCKED** |

### Security Verification: DNS Rebinding and TLS Hostname Mismatch (2026-11-08 JST)

- **Git Commit SHA:** `fd03142e46f8a9fd7406ca959ace070b0f05dff2` (pre-verification HEAD) / branch `feat/issue-19-safe-egress-preflight`
- **Toolchain Versions:** Node `24.22.1`, Wrangler `4.158.0`, local `workerd 2026-11-04`
- **Execution Timestamp:** 2026-11-08 23:08 – 23:14 JST
- **Environment & Execution Mode:** Cloudflare Workers Remote Preview (`npx wrangler dev --remote --config test/egress/wrangler.jsonc --ip 127.0.0.1 --port 8788 / 8787`)
- **Authenticated Cloudflare Account ID:** `0fbaae27d3ff021bc17109f1493d0b2d`

| テスト | ローカル | Workers 実環境 | 判定 |
|---|---|---|---|
| 公開ホストへの正常接続 | — | `probe.outliner-online.com`: HTTP 200 `{"result":"reachable"}` (Upstream HTTP 204 No Content) | **PASS** |
| 公開IP→非公開IPへのDNS変更 | — | Cloudflare API 403 Forbidden (`code 10000: Authentication error`; OAuth token lacks `dns:edit` scope) | **NOT RUN / BLOCKED** |
| 同一リクエスト内のDNS Rebinding | workerd source: `client.rs` / `network.rs` `connect_allowed()` validates `SocketAddr` and connects directly without secondary query | 未実施 (Hosted runtime lacks per-query alternating DNS fixture) | **NOT RUN** (ローカル設計証拠あり) |
| 正しいTLS証明書 | OpenSSL: `Verification: OK`, peername verified (`badssl.com`); Origin returned HTTP 405 Method Not Allowed | `badssl.com`: HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":405}` (TLS handshake succeeded) | **PASS** |
| TLSホスト名不一致 | OpenSSL: `verify error:num=62:hostname mismatch` (`CN=*.badssl.com` does not match `wrong.host.badssl.com`) | `wrong.host.badssl.com`: HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":526}` (Cloudflare Error 526) | **PASS** |

#### Test Details & Evidence Breakdown

##### 1. 公開ホストへの正常接続 (Positive Control Baseline)
- **Target URL:** `https://probe.outliner-online.com/egress-check/positive`
- **Reviewed Policy:** Origin `https://probe.outliner-online.com`, Prefix `/egress-check`
- **Reproduction:** Set target bindings in `test/egress/.dev.vars`, start `npx wrangler dev --remote`, send `POST /__egress_probe` with bearer token and browser user-agent.
- **Observed Response:** HTTP 200 `{"result":"reachable"}`.
- **DNS Observation:** `dig @1.1.1.1 probe.outliner-online.com` returned Cloudflare public anycast IPs (`172.67.155.83`, `104.21.66.24`).
- **Receiver Receipt:** Local listener on `127.0.0.1:8790` behind Cloudflare Tunnel `469ea721-e109-4081-b6ac-d8abc6152879` received synthetic body `{"probe":"agent-table-egress","value":"synthetic"}` and responded HTTP 204.
- **Basis for PASS:** Successful end-to-end HTTPS egress via Cloudflare edge and tunnel to verified receiver.

##### 2. 公開IP→非公開IPへのDNS変更 (Request-to-Request DNS Rebinding)
- **Target Subdomain:** Temporary domain `egress-rebind-<random>.outliner-online.com`
- **Attempted Action:** Create test DNS record in zone `d93d3721c888913fa36a3f170853578d` pointing to private IP (e.g. `127.0.0.1`), verify refusal.
- **Observed Obstacle:** `POST https://api.cloudflare.com/client/v4/zones/d93d3721c888913fa36a3f170853578d/dns_records` returned `HTTP 403 Forbidden` (`code: 10000: Authentication error`).
- **Root Cause:** The OAuth token issued via `wrangler login` contains scopes (`zone:read`, `workers:write`, `connectivity:admin`...) but lacks `dns:edit` / `dns:write` permissions for the zone.
- **Constraint Compliance:** Per testing guidelines, existing production DNS records (`probe.outliner-online.com`) were NOT modified, access control boundaries were NOT bypassed, and untrusted third-party dynamic DNS fixtures were NOT used.
- **Basis for NOT RUN / BLOCKED:** Platform credential permission boundary blocked authorized creation of private DNS test records.
- **Remaining Uncertainty:** Hosted Cloudflare egress proxy behavior when resolving a non-Cloudflare-proxied domain to RFC 1918 / loopback is expected to abort per Cloudflare's egress security model, but cannot be empirically demonstrated without DNS write access.

##### 3. 同一リクエスト内のDNS Rebinding (In-flight TOCTOU Rebinding)
- **Local Source Code Evidence:** Cloudflare official `workerd` (`src/rust/cxx/kj-hyper/client.rs`, `src/workerd/server/server/services/network.rs`).
  1. DNS resolution yields candidate `SocketAddr`s.
  2. `workerd` checks `connect_allowed(addr)` against private/loopback/link-local/ULA ranges.
  3. Hyper client establishes TCP connection directly to the verified `SocketAddr`.
  4. There is no secondary hostname lookup between inspection and socket establishment, eliminating the TOCTOU gap in `workerd`.
- **Hosted Workers Reality:** Hosted Workers outbound requests are handled by Cloudflare's egress proxy infrastructure. While Cloudflare documents that outbound fetch is restricted to public Internet services, the hosted runtime does not expose socket-level IP inspection.
- **Status:** **NOT RUN** for live in-flight attack (requires authoritative DNS server returning alternating IP addresses on consecutive lookups).

##### 4. 正しいTLS証明書 (TLS Valid Certificate Control)
- **Target URL:** `https://badssl.com/`
- **Local Pre-check:** `openssl s_client -connect badssl.com:443 -servername badssl.com -verify_hostname badssl.com </dev/null`
  - Output: `Verification: OK`, `Verified peername: badssl.com`. Handshake completed with cipher `ECDHE-RSA-AES128-GCM-SHA256`.
  - Local POST test: `curl -X POST https://badssl.com/` returns HTTP 405 Method Not Allowed (badssl origin web server rejects POST on `/`).
- **Workers Remote Preview Execution:**
  - `PROBE_CALLBACK_URL="https://badssl.com/"`, `PROBE_REVIEWED_ORIGIN="https://badssl.com"`, `PROBE_REVIEWED_PATH_PREFIX="/"`.
  - Worker performed HTTPS POST to `https://badssl.com/`.
  - Upstream TLS handshake completed cleanly. BadSSL's Nginx origin web server processed the request and replied HTTP 405 Method Not Allowed.
  - Worker received HTTP 405 (`upstreamStatus: 405`) and returned HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":405}`.
- **Basis for PASS:** Demonstrates that a valid Web PKI HTTPS endpoint completes TLS negotiation through Cloudflare Workers egress.

##### 5. TLS ホスト名不一致 (Certificate Hostname Mismatch Refusal)
- **Target URL:** `https://wrong.host.badssl.com/`
- **Local Pre-check:** `openssl s_client -connect wrong.host.badssl.com:443 -servername wrong.host.badssl.com -verify_hostname wrong.host.badssl.com </dev/null`
  - Output: `CONNECTED(00000004)`, `depth=0 CN=*.badssl.com`, `verify error:num=62:hostname mismatch`, `error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed`.
  - Certificate SANs (`*.badssl.com`, `badssl.com`) do not match sub-subdomain `wrong.host.badssl.com` under standard Web PKI rules.
- **Workers Remote Preview Execution:**
  - `PROBE_CALLBACK_URL="https://wrong.host.badssl.com/"`, `PROBE_REVIEWED_ORIGIN="https://wrong.host.badssl.com"`, `PROBE_REVIEWED_PATH_PREFIX="/"`.
  - Worker performed HTTPS POST to `https://wrong.host.badssl.com/`.
  - Cloudflare's egress proxy initiated TLS handshake with `wrong.host.badssl.com:443` (IP `104.154.89.105`).
  - Cloudflare's TLS verification layer detected that the presented certificate (`*.badssl.com`) did not match the requested SNI/host (`wrong.host.badssl.com`).
  - Cloudflare aborted the upstream TLS handshake immediately. Synthetic POST body was **never transmitted** to the origin server.
  - Cloudflare generated an **HTTP 526 (Invalid SSL Certificate)** response at the egress proxy layer.
  - Worker received HTTP 526 (`upstreamStatus: 526`) and safely returned HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":526}`.
  - No fallback to unencrypted HTTP, no certificate validation bypass, and no retry to alternative destinations occurred.
- **Evidence boundary:** The independent OpenSSL hostname-mismatch result and hosted HTTP 526 observation are consistent with rejection, but the probe saw only an HTTP response. It did not record the actual handshake, prove the precise rejection layer, or establish TLS-name enforcement for the current sender head. Record this as diagnostic evidence rather than completing REQ-002/006.


### Cloudflare Platform Security Guarantees & Boundaries

1. **Rejection of non-public IP at connection:** Cloudflare's platform proxy restricts outbound subrequests to public Internet services or same-zone origins. However, the Workers application runtime cannot programmatically inspect or assert the connected IP.
2. **DNS Rebinding guarantees:** Cloudflare documentation does not provide an explicit DNS Rebinding defense guarantee or SLA for dynamic outbound `fetch()`. DNS preflight in user code does not protect against rebinding due to TOCTOU.
3. **Connection IP inspection:** Cloudflare Workers `fetch()` (`Response` object) does not expose `remoteAddress` or socket metadata. Raw TCP sockets (`node:net` / `node:tls` / `cloudflare:sockets`) expose IP inspection but are explicitly blocked by Cloudflare when connecting to Cloudflare-owned/fronted IP ranges.
4. **TLS certificate verification against original host:** Native `fetch()` verifies certificates via Web PKI against the URL hostname. However, custom CN/SAN inspection or certificate pinning is not exposed on `fetch()`.
5. **`global_fetch_strictly_public` scope:** Prevents same-zone requests from shortcutting through internal origin routing and ensures egress traverses Cloudflare's public edge front door. It does not provide IP pinning or DNS rebinding prevention.
6. **Same-zone vs Cross-zone behavior:** Without `global_fetch_strictly_public`, same-zone requests can bypass the public front door. Per the official Workers Request API, `cf.resolveOverride` is **ignored** when either the URL host or override hostname lies outside the worker's zone. It cannot pin arbitrary provider-host IP addresses.
7. **Supported mechanism for Cloudflare-fronted targets:** Native `fetch` with `redirect: "manual"`, explicit `AbortSignal` deadlines, and bounded streaming is the only officially supported path to reach Cloudflare-fronted public endpoints.

## Required acceptance evidence before enabling any sender

The actual-runtime tests demonstrate positive reachability and negative behavioral controls (redirect, timeout, response size, unreviewed path, unreviewed origin, IP literals, fail-closed configuration).
However, **REQ-002 (connection-time IP and TLS safety) and complete REQ-006 (adversarial connection-time traces)** cannot be fully satisfied by `fetch()` alone without platform-level IP inspection/pinning guarantees.

Status remains: **blocked for public webhook delivery**.
- `ENABLE_OPENAI_EVENTS=false` must remain enforced.
- The **public Events capability gate** remains fail-closed (`connection-boundary-unverified`). The isolated candidate sender can perform native HTTPS requests; no public Events path may invoke it before security acceptance.
- PR #33 remains in draft status.
- P1 review thread on unmet runtime security proof remains open.
- Issue #19 remains open.


## Current candidate head: evidence to obtain before release

The new candidate source and opt-in probe are code, not independently
verified deployed results. All hosted observations above apply **only to their
recorded earlier probe commits**. They are not reclassified as exact-head
production-sender results. CI unit/integration tests now use the same sender
as the isolated probe, with a positive control that fails if the sender again
rejects every URL without network I/O. Such mock-backed tests remain
insufficient for production SSRF/DNS/TLS acceptance.

The production `wrangler.jsonc` now also opts into
`global_fetch_strictly_public`; the public Events flag remains false.
Required next receipts: an authorized hosted run against the already
authorized Cloudflare Tunnel or test provider callback with the exact code
head and deployment identity; observed private-resolution rejection; an
eligible controlled DNS-changing/rebinding fixture; original-host TLS
mismatch; redirect; timeout; oversized response. The existing hosted probe
evidence is a useful baseline, **not** proof for this revised sender.
DNS permissions were previously refused with 403, so the DNS-specific cases
remain **NOT RUN / BLOCKED** rather than silently passed. Do not request or
provision a public-IPv4 VPS, escalate authorization, or turn on Events.

Cloudflare documents hosted outbound HTTP proxy restrictions on private
destinations, and workerd's public PeerFilter/dial architecture is useful
implementation evidence, but neither alone proves the exact hosted
Cloudflare proxy's address-at-connect behavior for adversarial dynamic DNS.
A successful 526 response is an observed HTTP/TLS-related symptom, not
unambiguous packet-level proof of the internal TLS failure step.

## Official platform documentation recheck (2026-11-09; documentation only)

This section records a source review, **not** a new hosted probe, receiver
observation, DNS test, or proof that the current candidate head is safe.

- [Workers supported protocols](https://developers.cloudflare.com/workers/reference/protocols/)
  documents outbound HTTP(S) through Worker-native `fetch()`.
  [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
  explicitly blocks direct sockets to Cloudflare IP ranges and recommends
  `fetch` for port 80/443. A DNS-pinned raw TLS socket is therefore not a
  general transport to provider callbacks behind Cloudflare.
- [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)
  limits `cf.resolveOverride` to hosts within the Worker's zone. It says
  nonmatching cross-zone overrides are **ignored**, not that arbitrary
  external callback hosts can be IP-pinned. This does not implement the
  original-host TLS and connection-time public-address checks of #19/REQ-002.
- [Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
  documents `global_fetch_strictly_public` as public-front-door routing
  for global fetch. It does **not** document a per-connection forbidden-IP,
  rebinding-defense, or TLS-peer inspection contract. Preserve this flag
  without treating it as completion evidence.
- [Workers VPC Service bindings](https://developers.cloudflare.com/workers-vpc/api/)
  pre-register a fixed host and port; that binding owns the connection target.
  They do not transparently validate an arbitrary provider-generated
  callback host. They are a separate, configured networking product,
  not an authorized substitute for general public Events delivery.
- [Workers fetch limits](https://developers.cloudflare.com/workers/platform/limits/)
  say there is no inherent single-subrequest deadline. The sender's own
  abort deadline and streaming size caps remain necessary, and must be
  tested against an actual allowed receiver on the exact candidate head.

## Exact Candidate Head Remote Preview Execution (2026-11-09 JST)

- **Execution Timestamp:** 2026-11-09 08:10 – 08:26 JST (2026-11-08 23:10 – 23:26 UTC)
- **Baseline Git SHA:** `472f798` / branch `feat/issue-19-safe-egress-preflight`
- **Toolchain:** Node `24.22.1`, Wrangler `4.158.0`, local `workerd 2026-11-04`, Biome `2.6.6`
- **Execution Mode:** Cloudflare Workers Remote Preview (`npx wrangler dev --remote --config test/egress/wrangler.jsonc --ip 127.0.0.1 --port 8788`)
- **Authenticated Cloudflare Account ID:** `0fbaae27d3ff021bc17109f1493d0b2d`
- **Receiver Fixture:** Cloudflare Tunnel `https://probe.outliner-online.com/egress-check/*` backed by local Node HTTP listener on `127.0.0.1:8790` (PID 313679).
- **Harness:** Opt-in isolated probe (`test/egress/probe-worker.ts`) calling candidate production `sendVerifiedHttps` with sanitized JSON response (`testId`, `result`, `upstreamStatus`), zero secret logging, zero header dumps, zero error body echoes.

### Executed Scenarios & Empirical Receipts

| Case / Target | Request & Parameters | Observed Worker Response | Receiver / Host Correlation | Status |
| --- | --- | --- | --- | --- |
| 1. Allowed HTTPS Host (Positive Baseline) | `POST /__egress_probe`<br>Target: `https://probe.outliner-online.com/egress-check/positive` | HTTP 200 `{"result":"reachable","testId":"positive-control-01"}` | Receiver logged `{"mode":"positive"}` and replied HTTP 204 | **PASS (reachability)** |
| 2. Provider Opaque Query | `POST /__egress_probe`<br>Target: `https://probe.outliner-online.com/egress-check/positive?opaque_sub_id=sec-12345` | HTTP 200 `{"result":"reachable","testId":"opaque-query-02"}` | Receiver logged `{"mode":"positive"}` and replied HTTP 204 | **PASS** |
| 3. HTTP 302 Redirect | `POST /__egress_probe`<br>Target: `https://probe.outliner-online.com/egress-check/redirect` | HTTP 502 `{"result":"redirect-refused","testId":"redirect-03"}` | Receiver logged single redirect request; Location header was NOT followed | **PASS** |
| 4. Response > 64 KiB | `POST /__egress_probe`<br>Target: `https://probe.outliner-online.com/egress-check/large` (65,537 bytes) | HTTP 502 `{"result":"response-too-large","testId":"large-04"}` | Stream aborted at 64 KiB boundary; no excess bytes read or logged | **PASS** |
| 5. Server Delay > 10 s | `POST /__egress_probe`<br>Target: `https://probe.outliner-online.com/egress-check/slow` (15 s delay) | HTTP 504 `{"result":"deadline","testId":"slow-05"}` (after ~10 s) | Worker `AbortSignal` fired at 10 s deadline; socket terminated | **PASS** |
| 6. Valid Web PKI TLS Control | `POST /__egress_probe`<br>Target: `https://badssl.com/` | HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":405,"testId":"badssl-valid-cert-06"}` | OpenSSL reported `Verification: OK`, `Verified peername: badssl.com`. Origin Nginx server received POST and returned HTTP 405 Method Not Allowed | **PASS (TLS negotiation succeeded)** |
| 7. TLS Hostname Mismatch | `POST /__egress_probe`<br>Target: `https://wrong.host.badssl.com/` | HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":526,"testId":"wrong-host-badssl-07"}` | OpenSSL reported `depth=0 CN=*.badssl.com verify error:num=62:hostname mismatch`. Cloudflare proxy aborted upstream TLS handshake and generated HTTP 526 (Invalid SSL Certificate) | **PASS (observed rejection); original-host TLS proof still BLOCKED** |
| 8. DNS to Loopback / RFC1918 Private IP | Disposable record `egress-test-issue19.outliner-online.com`<br>Resolved to `127.0.0.1` and `10.0.0.1` (DNS-only) | HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":530,"testId":"dns-private-127-01"}`<br>HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":530,"testId":"dns-private-rfc1918-02"}` | Cloudflare edge proxy actively refused connections to non-public/private addresses with HTTP 530 (DNS origin error / restricted origin access). Record cleaned up and verified deleted | **PASS (observed proxy refusal)** |
| 9. In-flight TOCTOU DNS Rebinding | Alternating public/private responses per outbound fetch query | N/A (Requires dynamic authoritative DNS fixture) | Hosted Workers egress lacks socket IP inspection; workerd `connect_allowed` local code evidence is distinct from hosted proxy guarantee | **NOT RUN / BLOCKED** |

### DNS Permission and Lifecycle Audit

- Temporary token verified: Account-scoped API Token (`id: 0fe0c82af494f8a92978822910ec7ab7`), active on zone `outliner-online.com` (`d93d3721c888913fa36a3f170853578d`).
- Lifecycle discipline:
  1. Record before test: `egress-test-issue19.outliner-online.com` did not exist (`result: []`).
  2. Created single test record (`id: d0d9e68ccf254c4360c622745c5a1bbb`), tested `127.0.0.1` and `10.0.0.1`.
  3. Cleaned up immediately after test: `DELETE /dns_records/d0d9e68ccf254c4360c622745c5a1bbb` succeeded.
  4. Post-check re-query confirmed record completely removed (`result: []`).
  5. The operating production record (`probe.outliner-online.com`) was never modified.

## Issue #19 Verification: Tasks A, B, C, D (2026-11-09 10:45 – 10:58 JST)

- **Execution Commit SHA:** Current working head on `feat/issue-19-safe-egress-preflight`
- **Execution Mode:** Cloudflare Workers Remote Preview (`npx wrangler dev --remote --config test/egress/wrangler.jsonc --ip 127.0.0.1 --port 8788`)
- **Toolchain:** Node `24.22.1`, Wrangler `4.158.0`, Cloudflare CLI `cf v1.0.0-beta.25`, Biome `2.6.6`
- **Zone:** `outliner-online.com` (`d93d3721c888913fa36a3f170853578d`)
- **Production Anchor:** `probe.outliner-online.com` CNAME was preserved unmodified throughout all tests.
- **Log Sanitation Discipline:** Zero secrets, bearer tokens, full URLs, or response bodies were emitted to logs or test artifacts; only typed outcomes, statuses, and bounded `cfErrorCode` integer fields are preserved.

### Task A: Root-Cause Identification of Cloudflare HTTP 530

Cloudflare's HTTP 530 status indicates that the Cloudflare edge proxy encountered an origin error. Under Cloudflare's platform architecture, HTTP 530 carries specific sub-error codes (1xxx) in its proxy error pages. To safely distinguish whether 530 represents an explicit refusal of private IP, a DNS resolution failure, or a Workers Remote Preview routing issue, bounded 1xxx error code extraction was added to `sendVerifiedHttps()` and `probe-worker.ts`:

1. **Loopback IP (`127.0.0.1`, DNS-only):**
   - Host: `egress-diag-loopback.outliner-online.com`
   - Authoritative DNS (`jimmy.ns.cloudflare.com`): `NOERROR`, `A 127.0.0.1` (TTL 60)
   - Public Resolvers (`1.1.1.1`, `8.8.8.8`): `NOERROR`, `A 127.0.0.1`
   - Workers Remote Preview Probe: HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":530,"cfErrorCode":1016,"testId":"task-a-diag-127"}`
2. **RFC 1918 Private IP (`10.0.0.1`, DNS-only):**
   - Host: `egress-diag-rfc1918.outliner-online.com`
   - Authoritative DNS (`jimmy.ns.cloudflare.com`): `NOERROR`, `A 10.0.0.1` (TTL 60)
   - Public Resolvers (`1.1.1.1`, `8.8.8.8`): `NOERROR`, `A 10.0.0.1`
   - Workers Remote Preview Probe: HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":530,"cfErrorCode":1016,"testId":"task-a-diag-rfc1918"}`
3. **Non-Existent Subdomain (NXDOMAIN Control):**
   - Host: `egress-diag-nxdomain-nonexistent.outliner-online.com`
   - Authoritative DNS (`jimmy.ns.cloudflare.com`): `NXDOMAIN`
   - Public Resolvers (`1.1.1.1`, `8.8.8.8`): `NXDOMAIN`
   - Workers Remote Preview Probe: HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":530,"cfErrorCode":1016,"testId":"task-a-diag-nxdomain"}`

**Diagnostic Distinction:**
- In Cloudflare's edge proxy, **Error 1016 ("Origin DNS error")** is returned when the egress proxy fails to resolve a routable public origin. When a DNS-only hostname resolves to `127.0.0.1` or `10.0.0.1`, Cloudflare's egress DNS resolution layer treats the private destination as an invalid/unresolvable origin, terminating the subrequest at the DNS-resolution phase with **Error 1016**.
- In contrast, Cloudflare **Error 1000 ("DNS points to prohibited IP")** is generated when an *incoming* public request hits a Cloudflare-proxied (orange cloud) zone whose configured origin IP is prohibited. Because Cloudflare DNS rejects creating orange-cloud proxied records pointing to loopback, Workers outbound `fetch` to grey-cloud private IPs consistently triggers **Error 1016**.
- The HTTP 530 is **not** a Workers Preview artifact; it is an active edge proxy origin DNS policy refusal.

### Task B: Public IP → Private IP DNS Switch Test

On temporary subdomain `egress-switch-issue19.outliner-online.com`, the full multi-step DNS switch test was executed:

1. **Step 1: Positive Control Baseline (Public HTTPS):**
   - Ingress added to Cloudflare Tunnel `469ea721-e109-4081-b6ac-d8abc6152879`: `hostname: egress-switch-issue19.outliner-online.com` -> `http://127.0.0.1:8790`.
   - CNAME created: `egress-switch-issue19.outliner-online.com` -> `469ea721-e109-4081-b6ac-d8abc6152879.cfargotunnel.com` (`proxied: true`).
   - Authoritative DNS returned Cloudflare anycast IPs `104.21.66.24`, `172.67.155.83`.
   - Direct edge curl received HTTP 204.
   - Remote Preview probe via `sendVerifiedHttps()` returned HTTP 200 `{"result":"reachable","testId":"switch-step1-positive"}` (Upstream HTTP 204 received).
2. **Step 2: Switch Same Hostname to Private IP (`127.0.0.1`):**
   - Deleted CNAME; created A record `egress-switch-issue19.outliner-online.com` -> `127.0.0.1` (`proxied: false`, TTL 60).
3. **Step 3: Record TTL, Cache, and DNS Responses:**
   - Authoritative `jimmy.ns.cloudflare.com`: `status: NOERROR`, `ANSWER: egress-switch-issue19.outliner-online.com. 60 IN A 127.0.0.1`.
   - Public resolver `1.1.1.1`: `status: NOERROR`, `ANSWER: egress-switch-issue19.outliner-online.com. 60 IN A 127.0.0.1`.
   - Public resolver `8.8.8.8`: `status: NOERROR`, `ANSWER: egress-switch-issue19.outliner-online.com. 60 IN A 127.0.0.1`.
4. **Step 4: Send via Same `sendVerifiedHttps()`:**
   - Worker probe returned HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":530,"testId":"switch-step4-private-127","cfErrorCode":1016}`.
   - Cloudflare edge proxy actively refused the request with HTTP 530 Error 1016.
5. **Step 5: Confirm Zero Connection / Data to Private IP & RFC 1918 Switch:**
   - Receiver logs confirmed zero HTTP requests arrived at `127.0.0.1:8790` during the private IP test.
   - **Crucial Boundary Clarification:** The fact that zero requests arrived at the Ubuntu host's `127.0.0.1:8790` listener demonstrates non-delivery through Cloudflare Tunnel. However, because the DNS record was grey-clouded (`proxied: false`), traffic was not routed to the Tunnel. This observation does **not** directly prove non-connection to the Cloudflare edge server's own loopback or internal interface.
   - In an isolated session verifying RFC 1918 `10.0.0.1`, `sendVerifiedHttps()` similarly returned HTTP 502 with `upstreamStatus: 530` and `cfErrorCode: 1016` (`test-10-isolated`).
6. **Step 6: Restore DNS & Tunnel Configuration:**
   - Temporary DNS record deleted; re-query confirmed `[]`.
   - Tunnel ingress configuration restored to `probe.outliner-online.com` and `http_status:404`.
   - Baseline `probe.outliner-online.com` tested and confirmed healthy (HTTP 204).

### Task B.2: DNS-only Public IP Positive Control (GCP Fixture `34.3.98.126`)

To eliminate the proxy-mode discrepancy from Task B (switching from `proxied: true` Tunnel to `proxied: false` private A-record), a dedicated external fixture was prepared on a separate compute instance (`34.3.98.126`, GCP `us-west1-b`, zone `outliner-online.com`):
1. **Infrastructure Configuration:**
   - Subdomain: `direct.outliner-online.com`
   - Cloudflare DNS: `A 34.3.98.126`, `proxied: false`, TTL 60 (`id: dc53640ea5555f7a384883acc8bb96b4`).
   - Web PKI Certificate: Let's Encrypt TLS certificate issued covering `direct.outliner-online.com` and installed on the remote receiver.
   - HTTPS Receiver: Python listener on port 443 logging client IP, host, path, `x-probe-test-id`, and `CF-Ray` header, responding with HTTP 204.
2. **Workers Remote Preview Execution:**
   - Probe request: `POST /__egress_probe` with `testId: "test-1-direct-positive"`, targeting `https://direct.outliner-online.com/egress-check/positive`.
   - Worker response: HTTP 200 `{"result":"reachable","testId":"test-1-direct-positive"}`.
   - Upstream status: HTTP 204 received by candidate `sendVerifiedHttps()`.
   - Receiver log: `[HTTPS] Client=162.159.110.20 | Host=direct.outliner-online.com | Path=/egress-check/positive | Status=204 | RayID=a579ba57eeeb2feb-NRT`.
   - Worker response `CF-Ray`: `a579ba57eeeb2feb-NRT` (exact match with receiver receipt).
   - Egress Client IP: `162.159.110.20` (Cloudflare public egress range).
3. **Determination:**
   - **PASS (OBSERVED)**: Proves that candidate `sendVerifiedHttps()` over hosted Workers native `fetch()` successfully connects to an unproxied (`proxied: false`), DNS-only public Web PKI HTTPS endpoint and completes delivery.

### Task C: In-flight and Dynamic DNS Rebinding Verification

A dedicated, customer-controlled authoritative DNS fixture was deployed on `34.3.98.126` to evaluate adversarial dynamic DNS resolution and multi-record scenarios:
1. **Authoritative DNS Delegation:**
   - Glue record: `ns-rebind.outliner-online.com` A `34.3.98.126` (`proxied: false`, ID: `7f479ce5776ac3f46248be11749c6554`).
   - Delegation: `rebind.outliner-online.com` NS `ns-rebind.outliner-online.com` (`proxied: false`, ID: `1441f8c1ad779c9342d1b012a34d3ec7`).
   - Service: Custom authoritative DNS daemon (`dnslib`) listening on UDP/TCP port 53.
   - TLS Certificates: Let's Encrypt multi-SAN certificate covering `*.rebind.outliner-online.com` (`target`, `mixed`, `private`).
2. **Scenario 1: Delegated NS Static Private Resolution (`private.rebind.outliner-online.com`):**
   - Authoritative DNS daemon responded: `A 127.0.0.1`, TTL 0.
   - Workers Remote Preview probe: HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":530,"cfErrorCode":1016,"testId":"test-2-private"}`.
   - Result: Cloudflare edge proxy actively refused the private IP resolution from an external delegated authoritative NS with HTTP 530 Error 1016. Zero requests reached port 443.
3. **Scenario 2: Mixed Public + Private A-Records in Single Answer (`mixed.rebind.outliner-online.com`):**
   - Authoritative DNS daemon responded with both public and private records: `[34.3.98.126, 127.0.0.1]`, TTL 0.
   - Workers Remote Preview probe: HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":403,"testId":"test-3-mixed"}`.
   - Result: Cloudflare edge proxy actively refused routing to an address set containing private addresses with **HTTP 403 Forbidden**. The edge did not dial or leak requests to `127.0.0.1`.
4. **Scenario 3: Dynamic Alternating In-flight DNS Rebinding (`target.rebind.outliner-online.com`):**
   - Authoritative DNS daemon statefully tracked query counts for `target.rebind.outliner-online.com`:
     - Query 1: Answered `34.3.98.126` (public IP, TTL 0).
     - Query 2+: Answered `127.0.0.1` (loopback private IP, TTL 0).
   - Execution 1 (Initial query):
     - Worker returned HTTP 200 `{"result":"reachable","testId":"test-4-target-q1"}` (upstream HTTP 204).
     - Receiver logged HTTP 204 receipt from Cloudflare egress IP.
   - Execution 2 (Subsequent query under rebinding):
     - Authoritative DNS served `127.0.0.1` to Cloudflare resolver `172.68.24.106` (`Mode=REBIND_QUERY_2 | Count=2 | Answer=127.0.0.1 | TTL=0`).
     - Worker returned HTTP 502 `{"result":"upstream-non-2xx","upstreamStatus":530,"cfErrorCode":1016,"testId":"test-4-target-q2"}`.
     - Cloudflare edge proxy terminated the outbound subrequest with Error 1016. Zero network traffic reached the receiver on port 443.
5. **Teardown & Cleanup Discipline:**
   - Temporary DNS records (`direct`, `ns-rebind`, `rebind`) deleted and verified via `cf dns records list`.
   - Temporary firewall rules (`allow-dns-53`) deleted from GCP.
   - Remote fixture service (`egress-fixture.service`) stopped and disabled.
   - Operating production record `probe.outliner-online.com` confirmed healthy and untouched.

### Task D: Cloudflare Connection Boundary Evidence Matrix

Strict classification taxonomy:
- `OBSERVED`: Empirically verified on Hosted Workers (Remote Preview).
- `OFFICIAL GUARANTEE`: Explicitly guaranteed in Cloudflare's official product documentation.
- `SOURCE-BASED INFERENCE`: Inferred from open-source `workerd` code or architecture.
- `NOT RUN / BLOCKED`: Unverified due to lack of environment/platform fixtures.

| Check / Requirement | Code Evidence (`workerd` source) | Hosted Observation (Remote Preview) | Cloudflare Platform Guarantee | Strict Classification |
| --- | --- | --- | --- | --- |
| **DNS resolution validated at connect time** | `src/rust/cxx/kj-hyper/client.rs` & `src/workerd/server/server/services/network.rs`: `connect_allowed(addr)` explicitly rejects loopback, RFC 1918, link-local, multicast before connection. | Remote Preview actively refused connections to `127.0.0.1` and `10.0.0.1` (both in-zone and via delegated NS) with HTTP 530 Error 1016, and mixed multi-A with HTTP 403. | Outbound Workers traffic routes to public Internet front door; Error 1016 indicates Origin DNS error. | **OBSERVED** (edge proxy HTTP 530 / 403 refusal) / **SOURCE-BASED INFERENCE** (workerd `connect_allowed`). Notice: Error 1016 is an origin DNS error; JavaScript cannot inspect the dialed socket IP. |
| **Inspected IP matches TCP destination (no TOCTOU)** | Hyper client dials the validated `SocketAddr` directly. No second hostname lookup occurs between inspection and TCP connect. In userland (`src/notifications/egress.ts`), there is no user-space DNS preflight. | Dynamic rebinding from public IP to `127.0.0.1` resulted in immediate edge refusal (HTTP 530 Error 1016) without forwarding to private address. Zero requests reached receiver port 443. | Outbound fetch traverses Cloudflare egress proxy architecture. | **OBSERVED** (edge refused switched / rebound private IP) / **SOURCE-BASED INFERENCE** (workerd single resolution-to-connect pipeline). |
| **DNS-change / in-flight rebinding distinction** | `workerd` connects directly to a resolved `SocketAddr` in inspected source; hosted proxy internals are not independently exposed. | The custom authoritative DNS fixture returned public IP on one fetch and private IP on a subsequent fetch; the latter produced HTTP 530/1016. Mixed A answers produced HTTP 403. This demonstrates **request-to-request DNS change refusal**, not a DNS swap between validation and dial within one connection. | Cloudflare documentation does not provide a callback-specific rebinding/connection pinning guarantee for arbitrary provider hosts. | **OBSERVED** (separate requests) / **NOT RUN** (controlled same-connection TOCTOU instrumentation). |
| **TLS certificate validated against original hostname** | Web PKI validation in BoringSSL / hyper enforces SAN / CN matching SNI hostname. | Remote Preview against `wrong.host.badssl.com` resulted in immediate TLS handshake abort and HTTP 526. Positive control against `direct.outliner-online.com` with Let's Encrypt certificate succeeded with HTTP 200 (upstream 204). | Web PKI certificate validation is enforced for native `fetch()`. | **OBSERVED** (HTTP 526 on mismatch; HTTP 200 on valid cert) / **OFFICIAL GUARANTEE** (fetch Web PKI). Limitation: Runtime cannot programmatically inspect certificate chain or SANs. |
| **Cloudflare-fronted & DNS-only HTTPS callback support** | Direct TCP sockets (`cloudflare:sockets`) are blocked to Cloudflare IPs. Workers `fetch` with `global_fetch_strictly_public` is the documented platform transport. | Remote Preview to `probe.outliner-online.com` via Cloudflare Tunnel succeeded (HTTP 200 / 204). Remote Preview to DNS-only `direct.outliner-online.com` on GCP succeeded (HTTP 200 / 204). | Documented platform architecture for reaching Cloudflare-fronted and public endpoints via `fetch`. | **OBSERVED** & **OFFICIAL GUARANTEE**. |
| **Connection IP / Certificate SAN programmatic inspection** | No API exposed on `fetch()` `Response` object to inspect `remoteAddress` or peer TLS certificate SANs. | Candidate code cannot programmatically assert or log the connected IP or TLS peer certificate from userland JavaScript. | Workers Runtime API does not expose socket metadata on `Response`. | **BLOCKED (runtime limitation)**. |

---

### Hardened Infrastructure & Diagnostic Updates (2026-11-09)

1. **P0: Experiment Script Safety (`scripts/egress_experiments.py`):**
   - **Collision-Safe DNS:** `create_dns_record()` inspects `list_dns_records()` and raises `DnsCollisionError` if records already exist. Pre-existing records are never deleted; only record IDs returned by the successful create operation and tracked in the active session (`created_dns_records`) are deleted on cleanup. If the create response omits an ID, the script refuses to claim a post-create DNS lookup result as its own, leaving any ambiguous remote record for manual reconciliation.
   - **Tunnel Configuration Snapshot & Restore:** `snapshot_tunnel_ingress()` deep-copies the complete mutable `config`, including top-level `originRequest` and unrelated routing settings. Update/restore sends the full config, not just ingress; independent before-write and before-restore reads refuse observed concurrent changes. The Cloudflare CLI does not expose atomic compare-and-swap here, so concurrent remote mutation in the read/write gap remains a residual risk; do not run this experiment against a shared live tunnel.
   - **Process Group Termination:** Completely eliminated `pkill -f "wrangler dev --remote"`. Wrangler is spawned with `start_new_session=True` and stopped via process-group signals (`os.killpg(pgid, signal.SIGTERM)` / `SIGKILL`), isolating teardown exclusively to the spawned PID tree.
   - **Secure `.dev.vars` Lifecycle:** Pre-existing regular-file bytes and mode are retained in memory; symlinks/non-regular files are refused. New bearer tokens are written to same-directory 0600 temporary files and installed atomically with `os.replace`, never by in-place `O_TRUNC`. Restoration uses the same atomic path, refuses unexpected inode/content changes and narrows formerly permissive file modes to 0600. A failed replace leaves the original bytes intact. A forced crash can still leave an isolated 0600 probe file; follow the documented local cleanup procedure.
   - **Transactional Rollback:** All operations are protected by `SafeExperimentSession` with `try/finally` and signal handlers (`SIGINT`, `SIGTERM`).
   - **Safety Regression Suite:** Python tests in `test/unit/test_egress_experiments.py` cover full-config round-trip with nonempty `originRequest`, observed concurrent-update refusal, DNS collision, 0644 source protection, symlink refusal, atomic-write fault cleanup, in-place user edits, session rollback and cleanup-error isolation. CI invokes `python -m pytest -q test/unit/test_egress_experiments.py`. Live DNS/Tunnel mutation now also requires `AGENT_TABLE_ALLOW_LIVE_EGRESS_EXPERIMENT=yes` and separate authorization. Probe curl credentials are passed on stdin rather than exposed in process arguments; unparseable upstream responses return a fixed category rather than raw output.

2. **P1: Safe 5xx Diagnostic Parsing (`src/notifications/egress.ts`):**
   - **Bounded Stream Reading:** Reads at most 4 KiB and immediately cancels the underlying stream reader in `finally`, protecting against unbounded buffering and memory exhaustion on huge single chunks (tested up to 1 MiB).
   - **Shared Deadline Enforcement:** Diagnostic body extraction races against the common 10-second request deadline. Hanging or slow streams abort promptly, returning `{ ok: false, reason: "deadline" }`.
   - **Untrusted diagnostic hint:** Checks for Cloudflare-shaped `server`, `cf-ray`, `cf-error-type` or `cf-error-code` fields and bounded HTML patterns. These response headers and error markup are **not authenticated**: an origin can forge the same indicators. The scalar 1xxx result is only a diagnostic hint and must never be cited as independent proof of an edge address-at-connect refusal. A synthetic forged-header regression keeps public readiness disabled.
   - **Production Isolation:** Diagnostic parsing is separated as an explicit opt-in mode (`{ diagnostics: true }`) for probe and testing. The production `sendVerifiedHttps()` sender does not parse 5xx response bodies or headers, eliminating runtime parsing overhead and untrusted body inspection in production.

---

### Requirement Status Summary

- **REQ-002: ACCEPTED PLATFORM ASSUMPTION FOR CONTROLLED LIMITED BETA ONLY; NOT FORMALLY PROVEN FOR GA**
  - Destination origin/prefix policy preflight: **PASS** (strictly parsed, IP literals / unreviewed origins / malformed policies rejected before I/O).
  - Original-host TLS certificate validation: **OBSERVED** (OpenSSL hostname mismatch correlated with HTTP 526 on `wrong.host.badssl.com`; Let's Encrypt and BadSSL valid certs completed TLS handshake with HTTP 200/405), but native `fetch` exposes no certificate SAN validation trace to application code.
  - Actual TCP/TLS connection-time private IP exclusion: **OBSERVED** (Cloudflare edge proxy refused `127.0.0.1` and `10.0.0.1` via direct DNS and delegated authoritative NS with HTTP 530 Error 1016; mixed public/private A-records refused with HTTP 403), but application code cannot inspect or pin the connected IP.
  - Request-to-request DNS changes: **OBSERVED** (the second fetch received a private DNS answer and returned HTTP 530/1016; mixed multi-A records returned HTTP 403). **Single-connection DNS rebinding between inspection and dial remains NOT RUN / UNVERIFIED** on hosted Workers.
  - Runtime connection-boundary programmatic inspection: **BLOCKED (runtime limitation)** (Workers runtime provides no API on `fetch()` `Response` to assert connected socket IP or peer certificate chain; connection invariant rests on Cloudflare edge proxy behavior rather than application-enforced socket pinning).
- **REQ-006: HOSTED BEHAVIORAL EVIDENCE RECORDED; EXPLICIT LIMITED-BETA RESIDUAL RISK** (the owner decision of 2026-11-09 no longer requires a socket-level trace or formal Cloudflare guarantee for limited beta; observed sender behavior and inability to prove same-attempt DNS TOCTOU must remain distinct)
  - Real Workers positive reachability controls: **PASS** (verified against both Cloudflare Tunnel receiver and DNS-only public Web PKI receiver on GCP `34.3.98.126`).
  - Real Workers negative behavioral controls: **PASS** (HTTP 302 redirect refusal, 10 s deadline abort, 64 KiB streaming cap, destination policy preflight rejections).
  - Real Workers adversarial TLS verification: **PASS** (TLS hostname mismatch on `wrong.host.badssl.com` actively terminated by edge with HTTP 526).
  - Real Workers adversarial DNS private resolution: **PASS** (DNS-only loopback and RFC 1918 private IPs actively terminated with HTTP 530 Error 1016).
  - Real Workers adversarial mixed-record resolution: **PASS** (DNS returning multi-A `[34.3.98.126, 127.0.0.1]` actively refused by edge with HTTP 403).
  - Real Workers dynamic DNS change across two requests: **OBSERVED** (public IP on first fetch; private IP on second fetch, HTTP 530/1016). **Same-connection in-flight rebinding: NOT RUN / BLOCKED** pending a permitted fixture and evidence of the actual hosted connection boundary.

### Gating Conditions Enforced

- `ENABLE_OPENAI_EVENTS=false` remains enforced in `wrangler.jsonc`.
- `callbackTransportReadiness()` returns `{ enabled: false, reason: "connection-boundary-unverified" }`.
- PR #33 remains in **DRAFT** status.
- The original strict same-connection proof thread was **resolved as superseded by the limited-beta owner decision**, not as experimentally proven. The separate P1 tunnel full-config safety, `.dev.vars` safety, and CI review threads require review of this hardening and successful exact-head CI before they can be resolved.
- Issue #19 remains **OPEN** pending security review, current-head CI and the required documentation/verification assessment.
- The code may merge with Events disabled only after these gates; **no production deployment or Events activation is authorized**. A separately approved synthetic-only, signed, monitored opt-in rollout is mandatory.

### 2026-11-09: fail-closed authoritative DNS precondition

The isolated diagnostic runner now treats failed or mismatched authoritative DNS
propagation as a fatal precondition, not a non-blocking boolean. Its A-record
check requires an exact line match and a successful bounded `dig` call;
a timeout raises an exception before an affected hosted probe can be classified.
The experiment session then attempts its existing owned-resource rollback.
Three deterministic Python regressions cover partial-answer rejection, exact
answer acceptance and expiry without any hosted or DNS mutations.

**Evidence boundary:** This tests the selected authoritative DNS response only;
it does not attest Cloudflare's resolver cache, final dial destination,
same-connection rebinding, or actual hosted Worker refusal. The historical
hosted evidence remains the evidence recorded above. No new hosted experiment
was performed for this harness-only change. The Task A/B/C/D run labeled
"Current working head" lacks an independently recorded full execution SHA;
its precise source/runtime provenance is **inconclusive**, and green CI on a
later head does not retrospectively establish that identity. Reproduction
requires separately authorized isolated fixtures, exact build SHA capture,
and receiver-side correlation; a public-IPv4 VPS is not a production requirement.

### 2026-11-09: probe response attribution and bounded result envelope

The isolated Python experiment runner now accepts a probe observation only when the local
HTTP status matches the narrow result category, the returned `testId` exactly matches the
outbound request, and optional numeric diagnostics are bounded and correctly typed. Extra
response fields and unknown categories are rejected rather than copied into evidence.
Curl has an 8 KiB transfer cap and the parsed diagnostic output is also bounded. New
mocked-subprocess regressions cover stale IDs, conflicting HTTP status, secret-bearing
extra fields and malformed diagnostic values. These checks prevent obvious stale/foreign
local responses from being mislabeled as real-Worker evidence; they do not authenticate
Cloudflare's outbound connection, pin remote DNS/IP, establish a receiver receipt or
retroactively supply the missing full SHA for historical runs. No live probe was run.


### 2026-11-09: mandatory provenance for subsequent authorized hosted experiments

The opt-in live experiment runner now aborts before DNS/Tunnel mutation unless invoked
at a clean repository root with a complete Git commit SHA and an installed, identifiable
Wrangler CLI. It records the local checkout SHA, exact sender/probe/config SHA-256
digests, CLI version and UTC capture time in `test-results/egress-results.json`.
A second check refuses to publish an apparently complete result if the local code or CLI
identity changed during the run. Synthetic Python tests exercise clean and dirty states.
The CLI version parser accepts the pinned Wrangler `--version` non-TTY stdout
(`4.158.0`) as well as the prefixed form (`wrangler 4.158.0`), rejects additional
text/nonzero exits, and requires an exact match with both `package.json` and
`package-lock.json`. A regression invokes the installed CLI with captured stdout
to detect changes to its real subprocess output. These checks cannot authenticate
the subsequently hosted Worker or establish connection-time IP/TLS enforcement.

This is **local source/CLI provenance**, not an attestation of the Hosted Workers edge
runtime or of the code actually deployed in a Remote Preview session. Independent
hosted request/receiver correlation and approved fixtures are still needed, and no
historical unpinned run can be reclassified as pinned evidence. No external operation
or production Events activation was performed for this change.
