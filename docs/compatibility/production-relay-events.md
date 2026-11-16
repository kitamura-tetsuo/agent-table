# Production relay runtime and protected release boundary (#74)

This source checkpoint wires the actual MCP → subscription service → TableDO
challenge and durable outbox to the shared relay adapters. It does not provision
an endpoint/key, apply configuration, deploy, or prove hosted receiver acceptance.

## Runtime configuration and trust

`EVENTS_RELAY_CONFIGURATION` is exact nonsecret JSON: `version:1`,
`environment:"production"`, release-matching `buildSha`, canonical HTTPS `origin`,
`callerId`, `audience:"production:<service-id>"`, and `signingPublicKeySha256`.
The fingerprint is SHA256 of the Ed25519 public key's SPKI DER. The separate secret
binding `EVENTS_RELAY_SIGNING_KEY_PKCS8` must be canonical base64 PKCS8 Ed25519 and
its actual public fingerprint must match. Missing, malformed, mismatched or
cross-environment inputs fail closed; test-native risk consent cannot enable it.
Existing callback target policy and all restore authorization remain mandatory.

The synchronous Node crypto key validator is shared by readiness, diagnostics,
restore quarantine, subscription selection, own-table availability and dispatcher.
There is no config-shape-only green status when the real key is unavailable.
Factories snapshot config/key/targets together, freeze exposed configuration,
ignore replacement caller config, and recheck current bindings before and after
fresh authority checks immediately before external fetch. Operational outbound
pause forbids sends; metadata reads can retain current grant/key authority.
No production failure falls back to the native callback transport.

These bindings are trusted only as configuration installed by the existing
protected release workflow. Runtime parsing is not independent transport evidence.
Release preflight/authorization must bind exact build/config/callback targets/key
fingerprint, concrete operator-reviewed transport identity/security/host evidence
and data handling to the existing authenticated GitHub owner/environment approval.
Provider readback proves deployed config and secret presence, not secret material
or host behavior. Operator review and machine-observed facts remain distinct.
No `trusted:true`, invented receipt, or recovery authorization reused as transport
approval is introduced. Concrete live changes still need owner approval.

## Durable behavior and evidence limits

Challenge/result-only candidate records and message logical-attempt records keep
original identity/digest/timestamps and lifecycle/grant/generation fences. Same
attempt readback does not recompute or overwrite an old digest. Canonical HTTP
header names are lowercased before new semantic commitments and relay envelopes;
duplicate case aliases are rejected, not silently merged. Existing #21 bounded
at-least-once retry charges a distinct ordinal and may redeliver the stable event.
Unknown results are not success or proof of non-delivery.

Actual OAuth/MCP/service/TableDO tests select the production factory without
injecting a relay adapter. Controlled external fetch verifies relay signatures,
receives the real signed challenge/message, returns typed receipts and checks
activation, reconstruction, own-table status, pause and invalid-key refusal.
Additional tests cover key format/fingerprint, immutable shared configuration,
current grant/binding changes, domain-separated message/challenge/status paths and
header canonicalization. They are not evidence of live DNS/TLS peer binding,
public relay ownership, remote process operations or hosted ChatGPT behavior.

## Deployment versus actual acceptance

The normal public `production-relay-events` profile retains its full evidence
prerequisites, including actual delivery and real-host evidence. Pending metadata
cannot grant runtime isolation or enable an all-table candidate.

The existing `private-pilot-a-only` profile now also implements production
signed-relay collection in `a-only` mode; `a-only-discovery` remains staging-only.
Both global Events flags must remain false. Exact recipient guest/connection,
one to three selected tables, matching reviewed callback targets, a window of
at most two hours, and the existing per-table message-sequence ceiling of 12
bound discovery, subscription/status and dispatch. The ceiling includes
self-posts and is not a total HTTP-request count. The normal public readiness
signal remains false for the private profile. Production still requires valid
relay config and the actual matching signing key; no native fallback is allowed.

Predeployment application/security/browser/egress/provider checks, both scoped
private-pilot and relay operator decisions, and the existing exact-main CI,
provider/resource/restore and protected owner approval gates remain mandatory.
No source-only approval chooses live participants, tables, destinations or host,
or authorizes setup, enablement, keys, deployment or traffic. Runtime scope
checks are not process-stop evidence; a live operation needs its own bounded
controller/drain/stop plan and independent readback.

Actual OAuth/MCP and TableDO regressions retain previously authorized
participants and old subscriptions outside the selected scope, reconstruct the
objects, and verify that only the selected scope can dispatch. They also cover
expiry, outbound pause, sequence limits, bad keys and failed/pending/unknown
challenges. Controlled relay responses and local tests do not establish a real
supported host's receipt, run, read or reply.

Protected publication and provider/health readback still retain
`productionAcceptance.completed:false`, with `delivery` and `realHost` pending:
these helpers have no machine oracle for a supported-host run/read/reply. HTTP
2xx, old Test2 traces, declaration fields or different-config observations do not
satisfy that acceptance. See the existing
[operator sequence](../production-relay-operator-decision.md). A private trial
cannot automatically promote the normal public profile: a changed final
scope/config needs separate hashes, independent applicability review, fresh
approval/readback and required full-profile verification. Original event IDs,
attempt ordinals, the eight-attempt budget and one-hour retry horizon remain
unchanged; unknown results remain unknown.
