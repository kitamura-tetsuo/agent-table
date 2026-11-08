# Callback egress preflight: unverified Workers feasibility

Status as of 2026-11-08: **blocked for public webhook delivery**. This is
partial Issue #19 work, not an implementation of a positive safe HTTPS
transport. No callback is sent by the application.

## Threat boundary

The intended transport must enforce an operator-reviewed HTTPS destination,
a public address **at the connection actually used**, and TLS peer identity
for the original allowed hostname. DNS preflight followed by a separate
`fetch` is susceptible to rebinding; a URL allowlist does not enforce an
address policy. Disabling redirects alone does not repair this gap.

The new `src/notifications/egress.ts` preflight rejects URL credentials,
IP-literal endpoints, local/reserved names, unexpected ports, fragments,
unreviewed origin/path pairs, and oversized request bodies. The sender
intentionally returns `connection-boundary-unverified` even for an otherwise
reviewed URL. Its planned deadline and response-size constants are **not**
implemented transport guarantees.

## Runtime inventory and missing proof

- Cloudflare Workers `fetch` supports `redirect: "manual"` and abort
  signals, but the published `cf.resolveOverride` option is limited to
  same-zone names; it is not a general verified per-request IP pin with
  original-host TLS validation. [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)
- The published `cloudflare:sockets` `connect` API accepts a hostname/port
  and a `secureTransport` choice, but exposes no documented option in its
  `SocketOptions` for separate public-IP validation with original-host TLS
  identity. Cloudflare also recommends `fetch` for ports 80/443. This
  documentation inventory is not an executable negative proof of every
  platform configuration. [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- `test/unit/egress-policy.test.ts` checks parser policy and the closed
  capability gate. It **does not** exercise DNS, sockets, TLS, timeouts or
  production routing, so REQ-002, REQ-003, and REQ-006 remain open.

## Required acceptance evidence before enabling any sender

An authorized operator must provide a controlled HTTPS receiver, a real
Cloudflare Workers test environment and a supported way to enforce the public
address policy at the connection boundary while validating TLS for the
reviewed hostname. Record the actual deployment SHA, Wrangler/workerd
version, API/transport, receiver configuration, and redacted traces. Exercise
positive delivery alongside private/local resolution, DNS rebinding, redirect,
TLS-name mismatch, timeout, bounded request and oversized response refusals.
Do not use localhost exceptions, mock `connect`, or an unverified egress
proxy as positive production evidence.

Until that proof exists, public Events and webhook delivery remain unavailable.
The existence of the preflight module, a passing unit suite or an allowlist
must not be interpreted as completion of Issue #19.
