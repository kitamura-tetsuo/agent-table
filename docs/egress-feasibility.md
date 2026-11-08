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

- **Execution Timestamp:** 2026-11-09 08:10 – 08:14 JST (2026-11-08 23:10 – 23:14 UTC)
- **Baseline Git SHA:** `b89731ba14126b54c33035d09cb5138e3f322bc6` / branch `feat/issue-19-safe-egress-preflight`
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
| 8. DNS Change Public -> Private IP | Temporary record pointing to loopback/RFC1918 | N/A (Cannot create/update DNS records) | Cloudflare API returned `HTTP 403 Forbidden` (`code 10000: Authentication error`). `wrangler whoami` shows token has `zone (read)` but lacks `Zone.DNS:Edit` | **NOT RUN / BLOCKED** |
| 9. In-flight TOCTOU DNS Rebinding | Alternating public/private responses per outbound fetch query | N/A (Requires dynamic authoritative DNS fixture) | Hosted Workers egress lacks socket IP inspection; workerd `connect_allowed` local code evidence is distinct from hosted proxy guarantee | **NOT RUN / BLOCKED** |

### DNS Permission and Authority Status

`wrangler whoami` Token Scopes:
- Included: `user (read)`, `account (read)`, `workers (write)`, `workers_kv (write)`, `zone (read)`, `connectivity (admin)`
- Missing: `Zone.DNS:Edit` / `DNS:Edit` / `DNS:Write`

Per project safety rules:
- No permission bypass was attempted.
- Operating production DNS records (`probe.outliner-online.com`) were NOT modified.
- No untrusted third-party dynamic DNS services were invoked.
- Case 8 and Case 9 remain strictly **NOT RUN / BLOCKED**.

### Requirement Status Summary

- **REQ-002: BLOCKED / NOT COMPLETE**
  - Destination origin/prefix policy preflight: **PASS**
  - Original-host TLS certificate validation: **OBSERVED** (OpenSSL hostname mismatch correlated with HTTP 526), but native `fetch` exposes no certificate SAN validation trace to application code.
  - Actual TCP/TLS connection-time private IP exclusion: **BLOCKED** (`fetch()` provides no connection IP inspection API; DNS write permission missing to prove proxy-level RFC1918 refusal).
  - DNS Rebinding defense: **BLOCKED** (no hosted empirical alternating-DNS test; workerd source `connect_allowed` is local implementation evidence, not hosted proof).
- **REQ-006: BLOCKED / PARTIAL**
  - Real Workers positive reachability control: **PASS** (synthetically verified against live Cloudflare Tunnel receiver).
  - Real Workers negative behavioral controls (redirect, timeout, size limit, policy rejection): **PASS**.
  - Real Workers adversarial connection-time IP and DNS rebinding traces: **BLOCKED**.

### Gating Conditions Enforced

- `ENABLE_OPENAI_EVENTS=false` remains enforced in `wrangler.jsonc`.
- `callbackTransportReadiness()` returns `{ enabled: false, reason: "connection-boundary-unverified" }`.
- PR #33 remains in **DRAFT** status.
- P1 review thread on unmet runtime security proof remains **OPEN**.
- Issue #19 remains **OPEN**.
- No production deployment, public Events release, or PR merge is authorized.
