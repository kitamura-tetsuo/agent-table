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
6. Read back the actual active Worker version/config and relay identity. Verify
   authenticated subscription challenge, committed event, delivery and real host
   read/reply. HTTP 2xx, local tests or accepted deployment are not completion.
7. A pause is all existing intake/notification switches disabled, with independent
   provider/version readback. Preserve namespaces, signing-key identity and
   unresolved delivery evidence. A rollback must verify exact retained/removed
   bindings; a stale retained relay config is not proof that it was removed.

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

There is currently no dedicated operator mutation CLI with a durable operation
receipt. `finish` is row-idempotent, but does not persist an operator operation ID;
status readback merges expired-active and finished-unknown into `unknown`.
An uncertain helper result therefore cannot be declared resolved by that status.
The store's open/read paths can migrate/update its clock and are not strict
read-only plans. Do not advertise automatic restart recovery as complete or ask
operators to bypass this limitation with SQL edits. A separately reviewed minimal
operation receipt/administrative recovery boundary is still needed before an
idempotent automated operator tool can claim completion; no such control plane
is activated by this candidate.
