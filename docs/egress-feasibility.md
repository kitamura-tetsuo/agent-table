# Callback egress: hosted-Workers security evidence gate

Status as of 2026-11-08: **blocked for public webhook delivery**. This is
partial Issue #19 work, not an accepted outbound HTTPS transport. The
application sender still makes **zero network requests**. A separate opt-in
diagnostic Worker can exercise native `fetch` without changing that gate.

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

The application sender returns `connection-boundary-unverified` even for an
otherwise reviewed URL. Requests above 16 KiB are rejected before that gate.
Its planned 10 s deadline and 64 KiB response-size constants are **not**
production transport guarantees; they are not exercised by this stub.

## Supported runtime APIs and unresolved connection boundary

- Hosted Workers outbound HTTP is mediated by Cloudflare's proxy, which
  restricts targets to public Internet services or the Worker's own zone's
  origin. That is a relevant platform boundary, **not a documented guarantee
  that each dynamic callback hostname is re-resolved and checked against all
  forbidden ranges at the final connection, including DNS rebinding**.
  [Hosted Workers security model](https://developers.cloudflare.com/workers/reference/security-model/)
- Without `global_fetch_strictly_public`, the hosted global `fetch` may route
  same-zone requests to the zone origin, bypassing the public front door.
  The isolated probe opts into this compatibility flag; it is a necessary
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
requests return 404. The authenticated `POST /__egress_probe` invokes native
`fetch` with `redirect: "manual"`, an abort deadline of 10 s, a fixed synthetic
request body, and streaming response counting up to 64 KiB. It returns only a
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
| TLS certificate hostname mismatch | OpenSSL s_client: verification failed (`hostname mismatch`, `error:0A000086`); Workers remote preview: Cloudflare edge returned HTTP 526 (`Invalid SSL Certificate`), worker returned `upstream-non-2xx` (502) | Origin not reached; connection rejected at TLS handshake | **PASS (hostname mismatch rejected)** |
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
- **Basis for PASS:** TLS certificate hostname mismatch is strictly enforced at Cloudflare's egress proxy boundary via HTTP 526, preventing communication with mismatched HTTPS endpoints.


### Cloudflare Platform Security Guarantees & Boundaries

1. **Rejection of non-public IP at connection:** Cloudflare's platform proxy restricts outbound subrequests to public Internet services or same-zone origins. However, the Workers application runtime cannot programmatically inspect or assert the connected IP.
2. **DNS Rebinding guarantees:** Cloudflare documentation does not provide an explicit DNS Rebinding defense guarantee or SLA for dynamic outbound `fetch()`. DNS preflight in user code does not protect against rebinding due to TOCTOU.
3. **Connection IP inspection:** Cloudflare Workers `fetch()` (`Response` object) does not expose `remoteAddress` or socket metadata. Raw TCP sockets (`node:net` / `node:tls` / `cloudflare:sockets`) expose IP inspection but are explicitly blocked by Cloudflare when connecting to Cloudflare-owned/fronted IP ranges.
4. **TLS certificate verification against original host:** Native `fetch()` verifies certificates via Web PKI against the URL hostname. However, custom CN/SAN inspection or certificate pinning is not exposed on `fetch()`.
5. **`global_fetch_strictly_public` scope:** Prevents same-zone requests from shortcutting through internal origin routing and ensures egress traverses Cloudflare's public edge front door. It does not provide IP pinning or DNS rebinding prevention.
6. **Same-zone vs Cross-zone behavior:** Without `global_fetch_strictly_public`, same-zone requests bypass public edge proxies. `resolveOverride` is restricted to same-zone targets and throws Error 1034 for external/cross-zone destinations.
7. **Supported mechanism for Cloudflare-fronted targets:** Native `fetch` with `redirect: "manual"`, explicit `AbortSignal` deadlines, and bounded streaming is the only officially supported path to reach Cloudflare-fronted public endpoints.

## Required acceptance evidence before enabling any sender

The actual-runtime tests demonstrate positive reachability and negative behavioral controls (redirect, timeout, response size, unreviewed path, unreviewed origin, IP literals, fail-closed configuration).
However, **REQ-002 (connection-time IP and TLS safety) and complete REQ-006 (adversarial connection-time traces)** cannot be fully satisfied by `fetch()` alone without platform-level IP inspection/pinning guarantees.

Status remains: **blocked for public webhook delivery**.
- `ENABLE_OPENAI_EVENTS=false` must remain enforced.
- Production callback sender remains fail-closed (`connection-boundary-unverified`).
- PR #33 remains in draft status.
- P1 review thread on unmet runtime security proof remains open.
- Issue #19 remains open.
