# Staging native Events exception (implementation draft)

This is a test-only exception requested by the owner on 2026-11-15. It is not
acceptance of the production transport requirement or proof against DNS
rebinding. Native Workers fetch may send to an internal destination after DNS
changes; the connected-peer boundary remains unverified. Production readiness
continues to return false.

## Explicit runtime prerequisites

All must match simultaneously:
- RELEASE_ENVIRONMENT=staging
- RELEASE_PROFILE=test-native-events
- RELEASE_BUILD_SHA: exact tested 40-character lower-case Git SHA
- RESTORE_QUARANTINE=false
- ENABLE_MCP_SUBSCRIPTIONS=true
- ENABLE_OPENAI_EVENTS=true
- ALLOW_OUTBOUND_NOTIFICATIONS=true
- TEST_NATIVE_EVENTS_RISK_ACCEPTANCE=accept-unverified-dns-peer-boundary
- EVENTS_REVIEWED_CALLBACK_TARGETS: nonempty validated exact HTTPS origin/path list.

No existing Worker vars were changed. These strings alone are not authorization
to deploy. Obtain concrete owner approval for the actual staging Worker, target
SHA, bindings and risk immediately before changing security configuration.

## What changes and what does not

The profile has no pilot UUID/table allowlist or two-hour ceiling. Every table
still requires real guest/connection scopes and durable membership. Callback
control challenge, exact callback allowlist, credential encryption, signed
delivery, cancellation/generation fences, replay/idempotency, limits, HTTPS,
redirect refusal and recovery quarantine are preserved. New guest/table
admission remains controlled by its independent existing switches.

MCP subscriptions, Events advertisement, alarm dispatch and notification
availability use the explicit profile. Diagnostic context identifies this profile;
private-pilot-specific detailed trace records are not enabled by it.

## Release gates and rollback

The standard protected-main release flow now accepts this profile only for staging.
This staging-only profile collects hosted evidence; initial activation must not
require successful delivery from the configuration that has not yet been deployed.
Preflight requires application, security and browser evidence for the exact
build/config. Authenticated provider ownership/readback remains a separate
mandatory predeployment gate. Hosted live_runtime, provider delivery and actual
host receipt/read/reply are postdeployment acceptance outcomes, initially pending;
activation or HTTP acceptance is not proof of those outcomes. Production profiles
retain their existing evidence requirements. Authorization also requires the independent
protected Environment reviewer and a fresh operator record containing
`testNativeEvents.risk`, the SHA256 of exact callback-target JSON, and true
`allAuthorizedTablesReviewed`, `callbackDataDisclosureReviewed` and
`monitoringAndStopPlanReviewed`. This is an explicit native-risk exception, not
a DNS-boundary acceptance claim. Postverify reads exact risk/target bindings from
settings and the active version, checks health and preserves resource identity.

Emergency outbound pause can set ALLOW_OUTBOUND_NOTIFICATIONS=false; this also
fails closed at quarantine ingress until a coherent manual profile is applied.
For normal pause/rollback use the protected manual release with all five admission/
notification flags false, remove TEST_NATIVE_EVENTS_RISK_ACCEPTANCE and the native
callback target binding, retain data resources and keys, and run release-pause-readback
against the exact resulting version. Do not delete tables or subscriptions as a
rollback shortcut. A later re-enable requires a fresh approved release.

Hosted acceptance remains outstanding; this draft is NOT deployment-approved. Verify a supported MCP initialize ->
events/subscribe -> challenge -> actual peer post -> signed callback -> host
acceptance -> unsubscribe path in staging before claiming functionality. Test
production with the same exception vars and require denial. Repeat revocation,
expiry, outsider, duplicate, redirect and credential-nondisclosure checks.

## Redacted execution record (2026-11-15 08:40 UTC)

Issue contract: #74, body updated 2026-11-15T07:59:25Z. This record implements
REQ-007 without introducing a new application diagnostic storage feature.
A missing private-pilot trace, recent.scopeMatches=false, or an unknown record
does not prove that no request occurred. Existing context and own subscription
state are partial observations, not proof of host behavior.

| Stage | Test environment | Production environment |
| --- | --- | --- |
| Investigation | Inspected committed base c53b2b0e5fa8d3e1ca9e3fb789b9d295a2585b65 and its profile/release paths | Same base inspected; native test exception explicitly denied |
| Code | Uncommitted dot/test-native-events changes; runtime/profile/release integration implemented | No production activation implemented or performed by this work |
| Local tests | Full application suite 55 files / 588 tests passed before final rollback/readback refinements; final focused release suite 84 tests passed, affected MCP integration passed; typecheck passed | Runtime production MCP rejection and preflight cross-environment refusal covered synthetically; no production network test |
| Independent review | Concrete rollback blocker and script lint corrected; closure-only and production-entry regression added; re-review found no remaining blocker in reviewed test-profile scope | Production transport readiness remains false; no production acceptance inferred |
| Exact-SHA CI/review | PENDING: changes are not committed/published; local working-tree success is not exact-commit CI evidence | PENDING / outside this test-profile change |
| Transport acceptance | Owner's test-only residual-risk direction recorded in #74; hosted peer/TLS/DNS safety not proved | BLOCKED pending separate transport decision/evidence and concrete approval |
| Operator decision | No concrete build/config/destination deployment approval obtained in this work | No production decision obtained |
| Deployment | NOT ATTEMPTED; no operation ID or retry ID exists | NOT ATTEMPTED |
| Serving readback | PENDING: no new version applied, no matching deployed config/resources verified | PENDING |
| Provider/host behavior | PENDING: no actual provider delivery/host receipt/read/reply/cancellation test performed by this change | PENDING |

The reviewed code diff (src, scripts, workflow and test files, against the base
above) had SHA256
f7736036e7d736a70e0f18f1da07fa6635e858b1d3cd0affc79efe8b63addf4d.
This is a local snapshot identifier, not a Git commit or deployed build.

When a live operation is approved, append its exact tested commit/config digest,
approval reference, original operation/idempotency identifier, receipt/readback,
actual serving version/resources, committed-event reference, signed-delivery
outcome and actual host receipt/read/reply/cancellation outcome. Preserve an
unknown operation result without assigning a replacement ID or repeating it.
Do not copy callback URLs, secrets, tokens, private message bodies or unrelated
conversation content into this record. Provider HTTP success and host receipt
must remain separate stages.
