# Callback egress feasibility probe (Issue #19)

Status (2026-11-08): **candidate implementation, NOT production-verified**. The application does not call this transport and `ENABLE_OPENAI_EVENTS` remains `false`. No real provider callback or controlled external receiver was invoked while preparing this probe. Do not merge or advertise public webhook support until the actual-runtime gate below passes.

## Pinned environment and candidate mechanism

- Wrangler `4.158.0`, Workers types `5.20261108.1`, compatibility date `2026-11-07`, `nodejs_compat`.
- `src/notifications/egress-policy.ts`: reviewed exact-host JSON allowlist, HTTPS-only URL parsing, conservative public IPv4 validation (IPv6 is rejected), mixed-resolution refusal, bounded target/path.
- `src/notifications/egress.ts`: Workers-supported `node:dns/promises.resolve4` followed by a **literal checked IP** in `node:tls.connect({ host: ip, port: 443, servername: allowedHost, rejectUnauthorized: true })`. Before sending HTTP bytes it requires `authorized`, a matching `remoteAddress`, an available peer certificate, `checkServerIdentity(allowedHost, cert)`, and HTTP/1.1 negotiation or fallback. It never delegates the hostname to a second unreviewed resolver, follows redirects, or retries.
- Bounded request headers/body, response headers/body, connection and request deadlines, explicit safe failure categories. The narrow HTTP/1.1 parser rejects unexpected transfer codings, ambiguous framing, redirects and malformed responses. It does not support HTTP/2 or IPv6-only providers.
- The Workers runtime documentation advertises these Node compatibility APIs, but **does not promise** that `remoteAddress`, the certificate inspection API, or literal-IP TLS routing behaves as needed in deployed Workers. Until verified, the transport is merely a candidate and remains disconnected from the main Worker.

Sources: [Workers TLS API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/), [Workers DNS API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/), [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), [Workers outbound fetch limitations](https://developers.cloudflare.com/workers/platform/known-issues/).

## Controlled external prerequisites

1. An operator-approved **isolated staging** Cloudflare account and preview Worker, not the production Agent Table Worker. Production publication, paid plan choice and credentials are outside this Issue.
2. A controlled public HTTPS receiver on an operator-owned DNS name, with CA-valid certificate, port 443 and a request counter. Do not send a probe to a third-party provider's live callback endpoint.
3. Additional operator-controlled DNS/TLS fixtures: a name resolving to forbidden/private addresses; an A-record transition from public to private before and after resolution; a public address with the wrong TLS certificate hostname; an HTTP 302 destination; a stalled server; an oversized/streaming receiver. Record the observed remote endpoint on the fixture side where possible.
4. A short-lived private probe authorization token with at least 32 characters. Keep all hostnames, callback paths, token values, DNS configuration and response bodies outside committed traces. Never use real subscriptions or personal data.

`test/egress/probe-worker.ts` is a **separate Worker entry**, not a route in `src/index.ts`. It accepts only an authenticated POST with a case key already configured by the operator. It sends the same fixed synthetic body and returns only status/size or a safe error code. It cannot fetch a caller-supplied URL. The case JSON and allowlist are deployment-time, operator-controlled values, not request fields.

Example local-only configuration file creation; substitute approved, independently controlled staging names and a random secret before executing. The values below are intentionally unusable reserved-domain placeholders:

```sh
tee test/egress/.dev.vars > /dev/null <<'EOF'
EGRESS_PROBE_AUTH_TOKEN=REPLACE_WITH_RANDOM_TOKEN_AT_LEAST_32_CHARACTERS
EGRESS_PROBE_ALLOWED_HOSTS=["receiver.example"]
EGRESS_PROBE_CASES=[{"name":"positive","url":"https://receiver.example/accept"},{"name":"redirect","url":"https://receiver.example/redirect"}]
EOF

# Start only after provisioning controlled fixtures and isolated staging access.
npx wrangler dev --remote --config test/egress/wrangler.jsonc

# In a different shell, use the preview URL and the token from the local secret file.
# Do not print the token or a private callback URL to a committed report.
curl -X POST -H 'Authorization: Bearer <operator-secret>' \
  'https://<isolated-preview-worker>/__egress_probe?case=positive'
```

Never commit `.dev.vars`, use an operator-approved secret-management process for real staging deployments, and destroy the short-lived probe after capture. The current repository has no verified Cloudflare account, controlled endpoint, or external probe observations; no commands above were executed against Cloudflare.

## Evidence to collect before enabling delivery

| Case | Expected actual-runtime evidence | Status |
| --- | --- | --- |
| Allowed public destination | Real receiver recorded one synthetic request; Worker returned its bounded status; pinned remote IP, certificate and SNI hostname were checked | **Not run** |
| Private/local/link-local or mixed A records | No TCP connection to the forbidden address; safe DNS failure | **Not run** |
| DNS rebind after checked resolution | Connection remains on pinned originally permitted public address, or fails before sending; no connection to changed forbidden address | **Not run** |
| Wrong-host certificate / TLS failure | No HTTP bytes to a peer without matching identity | **Not run** |
| 30x response | Safe redirect failure; no request to Location | **Not run** |
| Timeout and unbounded stream | Finite deadline and bounded resource use, no implicit retry | **Not run** |
| Oversized response/request | Explicit size failure before buffering beyond bounds | **Only local parser tests** |
| URL credentials, IP literal, non-HTTPS, unexpected port | Policy failure before DNS/socket use | **Workerd unit tests pass** |

For each actual fixture record UTC time, Wrangler/runtime version, deployed probe code SHA, redacted case ID, DNS answer and change sequence, receiver-side connection count, expected vs observed safe category, duration, redacted TLS identity and whether HTTP application bytes arrived. Missing a case remains `not-run`, not implicitly passed. The outside service must independently confirm that prohibited connections were not made.

## Release decision

Current decision: **blocked/unverified**. A green unit/CI job or `wrangler --dry-run` is not a substitute for the positive controlled HTTPS connection and adversarial deployed-runtime traces. If the runtime cannot expose a pin-verifiable remote address and certificate identity, this candidate fails closed. Do not fall back to host-only `fetch`, preflight-only DNS checks, a mock connector, or a hidden proxy to make a test pass. An independently reviewed changed mechanism or explicit threat-model decision is required before any public Events enablement. #20 and #21 must consume only a positively proven transport and must retain their independent authorization/retry responsibilities.
