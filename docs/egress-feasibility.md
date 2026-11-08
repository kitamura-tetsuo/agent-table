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

## Evidence classification for the current branch

Toolchain pinned in `package.json`/lockfile: Node 24.22.1, Wrangler 4.158.0,
Cloudflare Vitest plugin 1.6.0; local `workerd 2026-11-04`. Local unit and
integration tests execute through the Cloudflare Vitest workerd bridge.

| Scenario | Current evidence | Classification |
| --- | --- | --- |
| Reviewed origin, opaque path/query, unreviewed origin/path, malformed review policy and forbidden URL forms | Workerd Vitest policy assertions | Local checks only; passing |
| Oversized outgoing buffer and disabled production capability | Workerd Vitest | Local checks only; passing |
| Probe missing auth/config, no fetch before policy, manual redirect and streaming-size guards | Workerd Vitest with mocked upstream `fetch` | Simulated checks only; passing |
| Isolated probe Worker bundle | `npx wrangler deploy --dry-run --config test/egress/wrangler.jsonc --outdir ../../dist/egress-probe` on Wrangler 4.158.0 | Builds; **not deployed** |
| Local probe HTTP listener | `wrangler dev --local` attempted in current managed executor | **Blocked** (`uv_interface_addresses` system error); no HTTP receipt claimed |
| Permitted HTTPS POST to approved provider/Cloudflare/Tunnel receiver in hosted Workers | No authenticated Cloudflare runtime or configured receiver in current execution | **Not run / blocked** |
| Final-address private/local/link-local refusal and DNS change/rebinding | No authorized adversarial DNS/address fixture or hosted address-policy observation | **Not run / blocked** |
| Original-host TLS-name mismatch refusal | No controlled wrong-certificate fixture in hosted Workers | **Not run / blocked** |
| Hosted redirect, timeout, and oversized response refusal | No controlled hosted behavior fixtures | **Not run / blocked** |

These passing simulated checks cannot be counted as a positive transport or
real-runtime adversarial test. REQ-002 and REQ-006 remain unverified.

Local verification on the merged main/#19 tree (2026-11-08 JST): typecheck,
Biome lint, production dry-run and isolated-probe dry-run passed; Vitest had
one initial OAuth concurrency-probe failure (`providerEntries` 2 rather than
1), then the isolated OAuth suite (14/14) and full suite (81/81) passed when
rerun without concurrent build/mutant processes. The first failure remains a
possible scheduling flake, not a security result or a waived check. The OAuth
replay mutant oracle also passed. GitHub Actions on the **new published head**
is the merge-time CI oracle; old-head successes must not be reused.

## Required acceptance evidence before enabling any sender

The remaining proof requires an authorized hosted Workers test environment;
an approved provider, Cloudflare Worker/Pages or existing Cloudflare Tunnel
HTTPS receiver; controlled private-address/rebinding/TLS/redirect/timeout/size
fixtures; and a supported documented way to establish public-IP-at-connect
and intended-host TLS guarantees on the actual request path. None of these
requires a separately owned public-IPv4 server. Record the exact deployment
SHA, runtime versions, security mechanism and redacted positive and negative
traces. Do not use localhost exemptions, mocked connections, unconditional
refusal or an unverified proxy as production proof.

Until that proof exists, public Events and webhook delivery remain unavailable.
The existence of the preflight module, a passing unit suite or an allowlist
must not be interpreted as completion of Issue #19.
