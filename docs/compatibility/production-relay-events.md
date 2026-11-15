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
