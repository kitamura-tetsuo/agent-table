# Read-only relay readiness observations

This library adds no startup, enable, callback-send, provider-write, or release
operation. It is a candidate for the next separately approved trial harness. It
does not modify the stopped trials or authorize another trial.

`observeReadiness` records separately bounded DNS, GET `/` HTTPS/TLS, authenticated
Tunnel-status readback, and categorized Tunnel-log observations. All evidence is
labelled with its collection mode and UTC interval. `productionAcceptance` is
always false. A fixture success is only a fixture success.

`ready:true` means the expected endpoint was observed, the exact Tunnel ID was
reported healthy, and bounded log capture was obtained. Empty capture and
unclassified events can still be observed capture. This predicate does not
require a positive connection log and does not assert error-free logs, callback
egress, delivery, supported-host execution, or production acceptance.

The production-mode boundary accepts a bare DNS hostname on port 443 with normal
platform trust. It rejects private/mixed/non-IPv4 answers before dialing, resolves
once, and checks actual TLS peer address/port. It sends no authentication header,
body, or callback. It follows no redirects. Each adapter has a finite timeout;
response bytes, DNS answers, and logs have limits. Failed or missing evidence
cannot yield `ready:true`. The specific endpoint predicate is HTTP 404 and the
exact fixed `{"code":"unavailable"}` body, not an arbitrary HTTP success.

Fixture mode permits loopback only and an ephemeral test CA. It cannot be used
as a live observation. Tests use a real loopback HTTPS server and generated
short-lived local test certificate; no public target or provider is contacted.

Before a future authorized harness uses this library:

1. Pass only its approved public ingress hostname and exact created Tunnel ID.
   Supply a read-only provider adapter using the existing formal authenticated
   API connection. Return the actual `{id,status}` from that GET; do not fabricate
   healthy state. Keep its credential out of runtime processes and arguments.
2. Pipe the new dedicated cloudflared child's stdout and stderr into
   `createTunnelLogCapture().write`. Keep both streams private, without a raw log
   file or terminal echo. Pass the capture's `read` method as `logRead`. Existing
   management/probe processes are not reconfigured or stopped.
3. Run `observeReadiness` and immediately retain **every** result using
   `retainObservation` at a unique private path. Do not retain only the last
   successful attempt. The writer uses exclusive creation, mode 0600 and fsync;
   it refuses overwrites and arbitrary/modified observations.
4. Keep attempts inside the separately approved setup deadline and verified
   process-tree stop mechanism. Readiness alone never enables the relay or
   sends a callback. An unknown operation result must be read back with its
   original identity; readiness retry must never become message retry.

Only DNS IPs, safe error categories, HTTP status/body length/digest/exact-match,
TLS protocol/public certificate fingerprint/actual peer, exact Tunnel ID/status,
and fixed log categories are persisted. No raw exception messages, request or
response headers, response bodies, callback URL, authorization value, certificate
key, provider token, arbitrary log message or command line is recorded. Unknown
log events retain only level and `unclassified`; incomplete/overflow capture is
unknown. This favors privacy over detailed root-cause text. Adapters are trusted
observation inputs, not independent cryptographic attestation of a provider.

Run the isolated verification with:

```sh
node --test scripts/relay-readiness-diagnostics.test.mjs
```

The tests cover positive real TLS/HTTP, issuer/name failures before HTTP, DNS
failure/mixed/private/late answers, redirects, wrong/oversize/incomplete responses,
timeouts, foreign/failed/unknown Tunnel state, bounded split-stream log capture,
secret-injection privacy, immutable private persistence and overwrite refusal.
