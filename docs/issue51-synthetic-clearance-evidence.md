# Issue #51: controlled synthetic clearance

**Current recorded outcome: the first clearance attempt failed its private
verification and automatically returned the target to quarantine. A corrected
verification transport and retry are pending under the same approved v2 scope.
This record does not yet establish completed clearance.**

The [first-attempt metadata](issue51-synthetic-clearance-attempt1.json) ends in
`rolled-back`, with nine private ingress paths returning 503 and
`Cache-Control: no-store` at **2026-11-15 00:41:52.685 UTC / 09:41:52.685 JST**.
The evidence and execution helpers are being retained in
[PR #72](https://github.com/kitamura-tetsuo/agent-table/pull/72). Earlier attempts
and their evidence are retained separately from any subsequent retry.

## Approval and exact subject

The owner replied `#51 SYNTHETIC_CLEARANCE` to the concrete corrected-proposal
request. The [approval record](https://github.com/kitamura-tetsuo/agent-table/issues/51#issuecomment-6886616675)
binds the [v2 proposal](issue51-synthetic-clearance-proposal-v2.json), including
its manual release profile, configuration commitment, same-generation
inspection renewal, private verification and quarantine-only compensation.
The [correction record](issue51-synthetic-clearance-correction.md) explains why
the superseded proposal was stopped before activation.

| Approved subject | Value |
| --- | --- |
| Scope | Manual, isolated synthetic staging only |
| Worker | `agent-table-pr51-recovery-staging` |
| Application source | `3d65b9ace98720afd2ef48275a3bb76a8638f76e` |
| Reviewed provider/operator source | `5f41a40f22fa1fe6dcc28c0238100ed944d18107` |
| Application schema | `12` |
| Operation | `4603a356-06f8-408c-bc13-f94f26484328` |
| Generation | `bbdca17200eeca1428bedb579c3461730ded3bb5155d763f8feaf9a514078ce4` |
| Original reset-plan commitment | `8a917fe2c076578a98d7f7b6ae5db27183b859148bcd890885be83e6e73db398` |
| Corrected proposal, canonical SHA-256 | `020534bdd708a01c501d27829ff80d01f8ebb2b48336ac49d29196f9959046c9` |
| Approved serving-configuration commitment | `58aaf16f7cacf06c3b0b568b4e3858c9c399d86b826348630c99a99f0a2330fa` |
| Quarantine/rollback commitment | `56be00421e272f3415e9ee8a694998cfb95243c25462c4ac0b123f0bfdfceb07` |

All five namespace IDs and the four runtime DO commitments are retained in the
proposal and each evidence subject. No namespace is replaced, renamed or
deleted. The five flags remain false: `ALLOW_NEW_GUESTS`, `ALLOW_NEW_TABLES`,
`ENABLE_MCP_SUBSCRIPTIONS`, `ENABLE_OPENAI_EVENTS` and
`ALLOW_OUTBOUND_NOTIFICATIONS`. Workers.dev, preview URLs, actual service routes
and custom domains remain disabled or absent. Verification uses authenticated
private Service bindings.

The schema-13 Worker, `agent-table-pr51-schema-staging`, existing staging and
production resources are excluded. Its preflight deployment remained
`847f5f75-1679-4fb9-880f-b479d832710f`, with matching configuration and disabled
public exposure. This metadata observation is not a new canonical SQL
inspection of that Worker. Cloudflare's `serviceEnvironment: "production"` in
provider receipts names the default internal service slot of these synthetic
Workers; the application environment is `staging`.

This manual approval is separate from a protected GitHub Environment approval
and the production `recovery-records` journal. It authorizes no new destructive
reset, PITR, public release, new guest/table intake or Events activation.

## Retained recovery proof and current inspection

The [original hosted recovery report](issue51-cloudflare-recovery-evidence.md),
[metadata](issue51-cloudflare-recovery-evidence.json) and
[canonical inspection supplement](issue51-cloudflare-recovery-inspection.json)
establish the preceding real Cloudflare snapshot, separately observed later
revocation/deletion/expiry, PITR, continued quarantine, actual canonical discard
and preserved newer-schema refusal. Those artifacts and the original private
checkpoint remain unchanged.

The continuation first reverified the exact original deployed configuration and
version, namespace ownership/inventory, runtime identity and nine denied private
paths. It then renewed only the same-operation, same-generation quarantined
inspection authorization. Fresh challenged `RecoveryControl.inspect` receipts
covered the original one TableDO and one GuestDO, including full schema
manifests, per-table counts and zero DO KV entries. Reviewed private rows remained
absent; the required zero-byte `table_transcript_usage` singleton remained.
OAuth serializer and Admission inventories were empty, and the OAuth KV listing
contained no keys. Inspection was repeated immediately before serving
certificate issuance. No reset or deletion RPC was invoked during this
continuation.

The serve certificate retained the original reset-plan commitment and bound the
approved v2 configuration, original recovery evidence, current continuation
predecessor and approval reference. Runtime/operator source and resource
identities were unchanged.

## First attempt and verified rollback

The first attempt used the immutable
[execution helper](https://github.com/kitamura-tetsuo/agent-table/blob/c9f04e4bcd573edafc8a4a46759b01af347818d1/scripts/recovery-hosted-clearance.mjs)
and [private-check helper](https://github.com/kitamura-tetsuo/agent-table/blob/c9f04e4bcd573edafc8a4a46759b01af347818d1/scripts/recovery-hosted-clearance-checks.mjs).
Their byte hashes are in the first continuation record. The original helper
files and first-attempt checkpoint are retained for reproducing that record.

| Observation on 2026-11-15 | UTC / JST | Active version or result |
| --- | --- | --- |
| Same-generation quarantine renewal verified | 00:40:40.209 / 09:40:40.209 | `20ec8926-7377-46ac-bcc3-85412431dd41` |
| Exact approved serving configuration verified | 00:41:40.525 / 09:41:40.525 | `ffe95a9c-518e-444d-9051-f38bf7a56622` |
| Private verification failed | 00:41:43.465 / 09:41:43.465 | `new-guest-admission-remains-disabled:status` |
| Quarantine compensation verified by provider | 00:41:50.086 / 09:41:50.086 | `c419489a-a11d-4486-bd8d-7d60cf02ae31` |
| Quarantine private ingress verified | 00:41:52.685 / 09:41:52.685 | Nine paths: 503, no-store |

The verifier did not accept the admission-response mismatch. The operator
confirmed that the active serving deployment belonged to this operation, then
restored the approved quarantine configuration in the same generation and
namespaces. The final complete signed-configuration hash was
`0b886ef1c82a54292096961cf38ab90dcb2b62fc5c61094090ce70cff6456ca2`.
Provider readback confirmed zero public service routes and custom domains,
with Workers.dev and previews disabled. The rollback did not call reset, delete
storage, restore a snapshot or change namespace identities.

The live failure record intentionally contains only the sanitized mismatch
code; it does not retain the numeric HTTP status or response body. A subsequent
local reproduction identified the installed Miniflare platform proxy's Origin
check: `getPlatformProxy` forwarded the remote Origin to its localhost transport,
where the check could reject the request before the target Worker received it.
That reproduction diagnoses a verification-transport problem; its numeric
response is not retrospectively attributed to the recorded live failure.

The pending fix constructs the same-origin form request inside a local Worker
before forwarding through the private Service binding. It changes the local
verification transport, preserving the target application's CSRF check, runtime
source, exact v2 configuration, namespaces, operation and generation. Successful
retry must be recorded separately and cannot erase the first failed attempt.

## Required private verification after retry

All six checks must pass through the corrected private transport, with bounded
request/body processing, `no-store`, no new session cookie and no credential
reflection. They are requirements for a retry, not completed results in this
first-attempt record.

| Check | Required result |
| --- | --- |
| `GET /health` | 200; exact source, staging environment and manual profile |
| Old session at `GET /guest/me` | 401; `no-valid-guest-session` |
| Old session at `GET /guest/table` | 401; `Valid guest browser session required` |
| `GET /guest` | 200; ordinary AgentTable HTML |
| Same-origin `POST /guest/session`, choice `new` | 503; `New guest admission is disabled` |
| Same-origin `POST /guest/session`, choice `reuse`, old session | 401; `No valid guest session` |

A retry must also repeat fresh canonical inspection under quarantine and final
exact provider/configuration readback. The excluded schema Worker's metadata
must remain unchanged. A conflicting later deployment must be preserved rather
than overwritten by compensation.

## Audit links and limits

| Retained commitment | SHA-256 |
| --- | --- |
| Original recovery evidence, canonical JSON | `3cd59ec2fa2f69d44f9c471332e1e0eb5343a4df6c6ce5601cba185bef2ec0f7` |
| Original synthetic record head | `2567285e3fca23fdb7371cbd0644c3cfe57fffc6230d3050448a9f2faffa5d6b` |
| First attempt, canonical JSON | `16d15e1ccacb2f7786787fa81b8d6d54d4d3ba9ae05d3bd59180ceda92f2be1f` |
| First attempt, file bytes | `6165aecf0d71d7e5b632e67279922a74652634a608f61941b73f2bca5e662540` |
| First attempt, final continuation record | `7a142579d74b589b7abf611116ec9701b457b1221642ed66767669aa1fd60fe0` |

The continuation is independently retained outside restored application DO/KV.
Its public metadata contains manifests, counts, claims, timestamps and hashes,
without private keys, synthetic session secrets, snapshot bookmarks, row bodies
or authorization signatures. `verifyObjectResetReceipts` can reproduce the
canonical-inspection summaries from the published receipts and expected claims.

The old hosted session was originally time-limited and is now expired as well.
An HTTP 401 alone cannot distinguish expiry, earlier revocation and canonical
discard. The private table route rejects at Guest authentication and does not
establish a direct TableDO read attempt. No issued hosted OAuth-token replay is
claimed. Normal HTTP checks may create Admission rate-limit metadata; an empty
pre-clearance inventory does not imply all post-check inventories stay empty.

Observed empty OAuth KV listings do not prove erasure of every edge cache,
provider backup or retained copy. Generation fencing remains necessary after
cleanup. Every supported restore must start a new generation before PITR;
out-of-band same-generation restoration and replay of an entire old deployment
remain outside the supported safety claim. This continuation does not recover
old conversations or confer authority to operate on existing users' data.
