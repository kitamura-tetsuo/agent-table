# Production relay operator decision candidate

This is implementation guidance for #74 REQ-003/004/006/007 and the separate
#78 operational scope. It is not an operator approval, accepted hosted evidence,
a new requirement contract, or permission to provision credentials/deploy.

## Authority and evidence boundary

The existing protected production workflow remains the authority. Its verifier
requires current main, exact build/config bytes, CI for that build, a first-attempt
workflow_dispatch, and GitHub's authenticated approval history naming the owner
for the exact Environment/run. Existing provider GETs check deployed Worker,
version, bindings and resource isolation. Existing independent restore continuity
remains mandatory. A JSON `passed`, `trusted`, or `approve` value alone is not
sufficient to authorize deployment.

The `productionRelay` member of the existing operations record binds exact
nonsecret relay-config bytes, callback-target bytes and the approved signing public
key fingerprint to that same review. Runtime parses the real Ed25519 private key
from a secret binding and compares its SPKI SHA256 to the nonsecret configuration.
This is a configuration identity check, not a cryptographic attestation that the
operator reviewed a host. The runtime trust boundary is the existing protected
deployment/configuration and secret administration path.

`reviewKind` is `operator-reviewed`. `transportIdentity` records the inspected
host, artifact and process identifiers; `connectionSecurityEvidence` and
`hostBehaviorEvidence` reference the actual observations the owner inspected.
`limitations` records untested destinations/address families and other residual
risks. `dataHandling` records the concrete operator choices for key ownership,
limits, retention, rollback and uncertain-restart handling. These disclosures do
not add a new threat model, quota threshold or receipt producer. The returned
approval expressly states `machineVerifiedTransportEvidence: false`; provider
readback and operator review must not be conflated.

## Sequence before activation

1. Complete independent code/scope review and exact-SHA CI. Review #78 before
   treating an independently deployable relay as a production prerequisite.
2. Choose real hosting, service/audience, caller/key ownership and callback
   destinations. Record the relay artifact/process/host actually inspected and
   privacy/retention/limits/rollback choices. Do not invent values or copy test keys.
3. Present the precise proposed settings, build/config, data flow and residual
   risks to the owner. Obtain the required concrete approval before any real
   secret provisioning, security-setting change, installation or deployment.
4. Under that approval, prepare a paused relay and perform the agreed synthetic
   public-host positive/negative connection tests. Review actual hostname TLS,
   peer/destination handling, authentication, replay and bounded failure evidence;
   loopback or injected tests alone do not establish this acceptance.
5. Bind those observations and explicitly unverified areas into the operations
   record. Complete the existing protected Environment approval for the exact
   production build/config. The release verifier consumes this decision and
   authenticates current provider/main/CI/approval facts before publishing.
   Steps 1–4 do not supply missing full-profile host evidence. When it is absent,
   only a separately approved, bounded `private-pilot-a-only` production relay
   operation can collect it; the normal public profile remains blocked. The
   private operation requires both the scoped private-pilot decision and the
   relay decision, with application/security/browser/egress/provider evidence
   bound to its exact target. Pending output alone cannot authorize it.
6. Read back the actual active Worker version/config and relay identity. Verify
   authenticated subscription challenge, committed event, delivery and real host
   read/reply. HTTP 2xx, local tests or accepted deployment are not completion.
7. A pause is all existing intake/notification switches disabled, with independent
   provider/version readback. Preserve namespaces, signing-key identity and
   unresolved delivery evidence. A rollback must verify exact retained/removed
   bindings; a stale retained relay config is not proof that it was removed.

## Deployment authorization is not production acceptance

The normal public `production-relay-events` profile still requires all of its
application/security/browser/egress/provider/delivery/real-host evidence. A
`productionAcceptance` output with pending host results is metadata, not a
runtime participant/table isolation policy and cannot waive that gate.

The existing `private-pilot-a-only` profile also implements a bounded production
signed-relay collection path in `a-only` mode. `a-only-discovery` remains staging
only. Production requires both global Events flags to remain false, exact
recipient guest and connection IDs, one to three exact table IDs, a finite policy
window of at most two hours, and callback targets matching the reviewed relay
configuration. The actual signing key must match its configured public fingerprint.
MCP discovery, subscription/status and durable dispatch enforce this scope;
other authorized participants, connections and tables do not gain private Events
or outbound eligibility. No native transport fallback or production test-native
risk waiver is permitted. A policy JSON or approval reference alone is not
concrete owner/protected approval of a live operation.

The existing per-table message-sequence ceiling is 12, including self-posts; it
is not a ceiling of 12 HTTP requests. Each logical event keeps its original ID,
eight-attempt budget and one-hour retry horizon. Scope, pause and expiry are
rechecked before effects, including after reconstruction; failed, pending or
unknown challenge results cannot activate a subscription. Policy expiry is not
proof that the relay transport process stopped. Concrete controller ownership,
deadline, drain/stop and independent readback still require the approved host
operation described in the foreground launcher guide. No live recipient,
connection, table, host or configuration is selected by this source checkpoint.

Protected publication and provider/health readback continue to report
`productionAcceptance: {completed:false, delivery:"pending", realHost:"pending"}`.
Even declared passed references are not machine-observed host acceptance.
`POST_DEPLOY_VERIFIED` for either production relay profile means
`serving-configuration` only. The bounded pilot collects missing actual results;
it does not make the normal public profile supported or automatically promote
its private build/configuration to general activation.

The earlier `hostBehaviorEvidence` in the relay operator decision refers to the
observed selected relay operating host/process behavior and its limitations; it
is not the future supported MCP host's event/run/read/reply. The concrete owner
and protected approval still bind exact source/config/destinations, actual
transport/security observations, data handling, impact, risks and rollback before
any live operation. No new mode, implicit setup/enable permission, test-native
risk waiver, or ordinary Events/autonomous completion-gate exception is added.

After the approved operation, retain independently observed exact serving
revision/config/resources and actual authenticated committed event, delivery and
host run/read/reply. HTTP success, provider settings, publication and this pending
metadata are not those observations or completed/general activation. These
helpers have no producer that marks them complete. A changed final scope/config
requires separate hashes, independent applicability review, fresh approval,
readback and required verification; do not relabel a prior validation result.

## Restart and unknown admission leases

The application starts paused. `inspectUncertainAttempts()` reads bounded
expired active lease metadata; `setEnabled(true)` refuses unresolved expired
leases. Expiry alone never proves that a transport has stopped.

The existing store API `finish(leaseId, undefined)` preserves `unknown` outcome
while releasing active capacity, but may be used only after the owned transport
has completed or is confirmed stopped. Establish the exact host/database,
environment/service/config and old process cessation before considering it.
Do not convert unknown to success or not-sent. #21 permits a separately charged
next ordinal with the same event ID within its original eight-attempt/one-hour
budget; it does not permit a replacement ID for the unknown original operation.

The candidate now supplies atomic unknown-only recovery receipts and the bounded
local adapter described in [relay-operator-recovery.md](relay-operator-recovery.md).
The [foreground launcher](relay-launcher.md) exposes that same adapter over trusted
local stdin, with exact process/config command binding, paused startup and drain.
There is no network administration endpoint, process controller or automatic
restart recovery. Generic status unknown is not the operator receipt. Opening
storage can migrate/write; exact planning/readback after open are read-only.
Concrete host policy and independently established old-transport stop evidence
remain required before any live recovery or activation.
