# Private A-only staging activation

**Implementation candidate; no hosted pilot deployment or activation approval
is recorded by this document.** The `private-pilot-a-only` profile provides a
bounded staging trial in which one selected ChatGPT connection can subscribe
and receive peer events. A second independently authorized agent may be
manually prompted to post. This can gather the missing event-to-host-run proof
for [Issue #24](https://github.com/kitamura-tetsuo/agent-table/issues/24); it does
not require that proof before permitting a specifically approved trial.
It makes no public Events or autonomous-compatibility claim.

Production remains `manual`. The existing protected manual release behavior,
OAuth/GuestDO authority, TableDO membership/lifecycle checks, encrypted
subscription credentials, delivery generations and durable retry accounting
remain authoritative. A policy reference alone cannot authorize a deployment,
create a guest grant or grant table membership.

## Runtime policy

The shared parser and eligibility predicates live in
[`src/shared/private-pilot.ts`](../../src/shared/private-pilot.ts). Configure
these bindings only in a separately reviewed staging candidate:

| Binding | Required value or role |
| --- | --- |
| `RELEASE_ENVIRONMENT` | `staging` |
| `RELEASE_PROFILE` | `private-pilot-a-only` |
| `RELEASE_BUILD_SHA` | Exact reviewed 40-character lowercase Git SHA |
| `RESTORE_QUARANTINE` | `false` only for independently reviewed current state, with no historical restore |
| `ENABLE_MCP_SUBSCRIPTIONS` | `false` |
| `ENABLE_OPENAI_EVENTS` | `false`; no global/public advertisement |
| `ALLOW_OUTBOUND_NOTIFICATIONS` | Delivery mode: `true` only for the approved active trial; `false` stops delivery. Discovery mode: must be `false` |
| `PRIVATE_PILOT_POLICY` | Exact serialized JSON string described below |

`PRIVATE_PILOT_POLICY` has the following required fields and one optional
`observationMode` field. Unknown fields are rejected:

| Field | Constraint |
| --- | --- |
| `schemaVersion`, `mode` | `1`; `a-only` for delivery or `a-only-discovery` for callback discovery without delivery |
| `buildSha` | Matches `RELEASE_BUILD_SHA` |
| `approvedAt`, `notBefore`, `expiresAt` | UTC ISO timestamps; approval no later than start; positive window of at most two hours |
| `approvalRef` | Bounded reference to the separately retained operator decision; not a credential or self-issued permission |
| `recipientGuestId`, `recipientConnectionId` | The exact independently authorized receiving guest and application connection |
| `tableIds` | One to three distinct UUIDs for the approved synthetic primary/cancellation/control tables |
| `callbackTargets` | Delivery: nonempty strict reviewed HTTPS `origin` plus canonical `pathPrefix` entries. Discovery: exactly an empty array |
| `observationMode` (optional) | Exactly `private-redacted` enables separately reviewed private observations. Required in discovery mode; omitted means no private diagnostic stream |

The following is **synthetic schema illustration only**, not an approved or
currently usable deployment policy:

```json
{
  "schemaVersion": 1,
  "mode": "a-only",
  "buildSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "approvedAt": "2026-11-12T11:59:00.000Z",
  "notBefore": "2026-11-12T12:00:00.000Z",
  "expiresAt": "2026-11-12T14:00:00.000Z",
  "approvalRef": "example-owner-approval",
  "recipientGuestId": "11111111-1111-4111-8111-111111111111",
  "recipientConnectionId": "22222222-2222-4222-8222-222222222222",
  "tableIds": ["33333333-3333-4333-8333-333333333333"],
  "callbackTargets": [
    { "origin": "https://receiver.example.com", "pathPrefix": "/mcp-events" }
  ]
}
```

Store the serialized policy as a string in the candidate's `vars`. Keep its
exact bytes: the policy digest and full configuration digest bind the approved
candidate, and post-deploy checks compare the actual policy bytes rather than
JSON semantic equivalence. The policy contains private routing/identity
metadata even though it contains no bearer or signing secret. Retain it in the
protected operator/configuration channel; do not copy it into public receipts.

An eligible trial requires the active window and outbound switch, exact
recipient/connection, listed table and reviewed callback. Only that
freshly authorized recipient sees private Events discovery and its own
availability. Registration and dispatch independently recheck current policy,
guest/connection scope and table/subscription authority. Another connection
of the same guest, B's connection or an unrelated guest gets no new privilege.
The current canary dispatch bound permits only message sequences up to 12 and
work created no earlier than the policy window; it does not reset table limits
or permit replay of older queued events. Ordinary authorized tools remain
subject to their existing scopes and membership checks.

The global `callbackTransportReadiness()` result and public feature flags
remain disabled. The private branch reuses the reviewed native sender and
callback challenge/signature path under the finite policy. It does not claim
stronger same-connection IP/TLS evidence than the owner-approved limited-beta
native-fetch premise already recorded for Issue #19.

## Discover an actual host callback without outbound requests

The receiving host supplies its callback URL in `events/subscribe`. An OAuth
redirect origin, documentation example, guessed hostname or synthetic receiver
does not establish that callback destination. When its actual origin is not yet
known, prepare a separate `a-only-discovery` policy under the same staging-only
`private-pilot-a-only` release profile. It requires the exact A guest/connection
and selected tables, the finite approved window, `observationMode:
"private-redacted"`, an empty `callbackTargets` array and
`ALLOW_OUTBOUND_NOTIFICATIONS="false"`. Enabling outbound in this mode makes
the configuration invalid.

Only A's freshly authorized connection sees the private Events capability.
An actual subscription request crosses a fresh grant and current TableDO
membership/lifecycle check before producing a sanitized HTTPS origin
observation. Discovery sends no callback challenge or event, persists no
callback URL or signing secret, and does not create or commit a subscription.
It returns an operator-review-required failure. The recorded origin remains
unreviewed routing evidence; it is not an allowlist entry or proof of provider
control. Its observation is limited by a separate persisted rolling admission
bucket to one per 60 seconds for the policy/recipient, at most 120 within the
half-open two-hour window. Ordinary ingress limits also apply.

Review the observed origin and the provider's path-scope requirements before
proposing an `a-only` delivery policy. Use a root path prefix only when the
provider actually requires unrelated opaque paths and that scope is explicitly
reviewed. A subsequent protected deployment binds the reviewed targets. A
new real host subscription must then pass the existing signed callback-control
challenge before delivery becomes eligible. A failed discovery request is
never reclassified as a successful subscription.

Discovery has effects even while outbound is false. Its protected authorization
and immediate prewrite gate therefore require its window to be active. An
expired discovery policy cannot be deployed as a supposed stopped delivery
configuration. Expiry stops discovery eligibility; an operator stop uses the
separately reviewed return-to-manual configuration. The ordinary outbound
switch is a delivery stop and is not a discovery stop.

## Explicit private observations and their limits

`observationMode: "private-redacted"` is an opt-in private diagnostic stream,
separate from routine categorical telemetry. It requires an additional
operator review of the exact policy and observation handling. A prior policy
that omits the field emits no such stream. The new instrumentation introduces
no SQL schema migration and does not alter retry counts, subscription identity
or transport authority.

The fixed observation schema admits only the scoped synthetic identifiers,
policy/build association, event and attempt timing, and categorical transport
outcomes needed to compare the actual trial. Callback discovery records only
the sanitized origin. It excludes full callback URLs, signing or bearer
credentials, headers, invitations and message bodies. Keep the collected
observations private; publish only reviewed references and digests. Review
account-specific provider log handling and the collector's retention with the
existing operational disclosures.

The operator captures the stream for a declared interval and compares it with
the policy-scoped SQLite projection through the existing secret-protected
staging evidence route. That projection reads actual subscription/outbox,
message-identity and terminal-state facts. It is not an agent tool and does not
give an outside guest access to private tables. Start capture before the
source event, retain the actual capture boundaries, and finish after every
included attempt has its final outcome and the cancellation observation
interval has ended.

Live log delivery can be missing, sampled, truncated or interrupted. The SQL
attempt count is a conservation check, not a source for invented authorization
or dispatch timestamps: a reservation can survive a crash before final
authorization. Any missing, ambiguous or unmatched observation makes the
attempt ledger incomplete. Do not infer that no request occurred from an empty
stream, reconstruct timestamps from counters, or silently retry a scenario as
if the first one had passed. A transport invocation is an observation of the
sender calling its actual HTTPS transport, not proof that bytes reached the
receiver. Response headers and later completion remain distinct observations;
even a genuine 2xx response does not establish a new A-host run.

### Collect and compare the actual observations

Use `get_connection` through the receiving host to obtain its own authenticated
guest and connection IDs before creating a policy. Rescan the host's MCP app
when needed to discover the new tool and the subsequently enabled Events
capability. Do not substitute a provider link ID for the server connection ID.

The collector runs on the authorized operator machine with its existing
Cloudflare credentials. Supply the reviewed configuration, an actual bounded
UTC end time with milliseconds, and a new private output path:

```sh
node scripts/private-pilot-observations.mjs collect \
  --worker agent-table-staging \
  --until "$PILOT_OBSERVATION_END_UTC" \
  --config "$PILOT_STAGING_CONFIG_PATH" \
  --output "$PILOT_CAPTURE_PATH"
```

It launches the installed pinned Wrangler directly with no filter flags
(`filters: []`) and disk logs disabled. Wrangler 4.158.0 rejects
`--sampling-rate 1`; omitting it requests no sampling filter. Provider-side
sampling may still drop events. Raw tail output, request metadata, exception
text and stderr never reach the output file or terminal. Any stderr warning,
including sampling or a reconnect, invalidates continuity. Bounds are 1 MiB
per buffered object, 32 MiB total input, 2,000 retained observations and two
hours plus one minute of collection. Output is exclusively created with mode 0600 and no symlink
following. The first actual tail frame emits a safe `capture: ready` marker;
an ordinary authorized read can produce that initial frame. Wait for readiness
before the source event. Process startup alone is insufficient.

After stopping capture, request the existing `POST /__staging/evidence` with
its operator secret and JSON fields `guestId`, `connectionId`, `tableId` and
`view: "private-pilot"`. Keep the returned snapshot private. This view requires
the exact policy scope and observation opt-in. It intentionally remains
available after outbound pause, policy expiry or grant revocation so retained
terminal state can be inspected. It exports bounded random identifiers and
state, never transcript content, destinations or credentials. Missing retained
rows, mismatched recipient connections or unknown error categories cannot
satisfy complete evidence.

Finish after all included attempts complete. SIGINT is an explicit requested
stop; unexpected EOF or source failure is incomplete. Capture the final SQL
snapshot at or after collection ends, within 60 seconds. A snapshot taken
before the end cannot cover a later retry whose log was lost. Any additional
charged attempt appearing in the final readback without its complete observed
stages makes the result incomplete. Then compare the private files:

```sh
node scripts/private-pilot-observations.mjs verify \
  --capture "$PILOT_CAPTURE_PATH" \
  --snapshot "$PILOT_SNAPSHOT_PATH" \
  --output "$PILOT_OBSERVATION_REPORT_PATH"
```

The comparison covers every retained outbox row for that table, with exact
event/message/subscription joins, charged attempt counts, stage flags and
timestamps. A successful report is `conditionally-complete` and still says
`hostExecution: "not-established"`. Keep one continuous collector across a
same-build, same-policy storage-preserving restart if it is to cover both
phases. A new collector cannot supply the earlier events' missing history;
preserve a reconnect or capture gap as incomplete. Actual host idle/run/read/
reply receipts remain independently required by the pilot acceptance record.

## Prepare a concrete, reviewable candidate

1. Confirm two independently controlled owners/accounts and their separate
   synthetic-only instructions. Select the actual receiving ChatGPT Work
   surface, its supported event/run observation and Claude's tools connection.
   Product names alone establish none of those permissions or capabilities.
2. Establish the synthetic memberships and receiving connection through the
   independently approved manual setup. Identify the exact primary and
   cancellation/control tables before proposing their policy. Do not replace
   missing identities with guessed IDs or enable unrestricted new admission.
3. Review the actual provider callback origin/prefix and callback-control
   procedure, bounded canary, stop plan and retained native-fetch risk. If the
   actual destination is unavailable, use the separately approved no-outbound
   discovery stage above before proposing delivery. Actual
   callback verification and host execution still need to be observed during
   the trial; an operator checklist is not their passing test result.
4. Build exact staging/peer configuration files and current inventories using
   the existing [release runbook](../release-runbook.md). Preserve namespace,
   migration, origin and secret separation. Keep the production peer manual.
   Use `tee` with a quoted heredoc when creating operator text files, and store
   credential values through the approved secret mechanism rather than chat.
5. Bind the owner-reviewed operations record and structural evidence to the
   same candidate SHA/config bytes, then request the concrete protected staging
   approval. Do not activate merely because local tests or this document pass.

All ordinary retention, cost, schema, resource-ownership and independently
reviewed **no-restore** fields from the release process still apply. Add an
`operations.privatePilot` record containing:

| Field | Meaning |
| --- | --- |
| `mode` | Exactly matches policy mode: `a-only` or `a-only-discovery` |
| `policySha256` | SHA-256 of the exact serialized policy string |
| `approvalRef` | The same policy decision reference |
| `independentOwnerConsentsReviewed` | Both owners' bounded authorities actually reviewed |
| `callbackControlReviewed` | Delivery mode: actual callback scope/control procedure reviewed |
| `nativeFetchRiskAccepted` | Delivery mode: recorded limited-beta transport premise accepted for this scope |
| `callbackDiscoveryReviewed` | Discovery mode: genuine host callback capture and subsequent separate scope review understood |
| `noOutboundReviewed` | Discovery mode: no challenge, delivery or active subscription is permitted |
| `privateObservationReviewed` | Required whenever `observationMode` is present: private diagnostic fields, capture, incompleteness and retention handling reviewed |
| `boundedCanaryReviewed` | Exact table/recipient/window and traffic bounds reviewed |
| `stopPlanReviewed` | Outbound stop, terminal action and readback plan reviewed |

Every applicable review field must be `true` based on actual review. They are
not filled automatically from this example. Structural private-profile evidence
requires the existing `application`, `security` and `browser` checks. Completed
real-host autonomy evidence is deliberately not an activation prerequisite:
the purpose of the approved trial is to obtain or fail that evidence.

## Protected deployment path

Only after the prerequisite implementation is on exact `main` with successful
required CI, use the protected **Staging deployment** workflow
([`deploy-staging.yml`](../../.github/workflows/deploy-staging.yml)). Select
`release_profile=private-pilot-a-only`, the reviewed `expected_sha`, and
`bootstrap_staging=false`. This is not a first-time namespace bootstrap and
must not be combined with the legacy staging-identity exception.

The reusable [reviewed workflow](../../.github/workflows/_deploy-reviewed.yml)
retains the Environment approval and stages:

1. Independently verify the requested `main` SHA and run local gates.
2. Validate exact candidate/peer configuration bytes and dry-run the build
   before exposing deployment credentials.
3. [`release-authorization.mjs`](../../scripts/release-authorization.mjs)
   independently reads main CI, protected Environment approval and live
   Cloudflare resource ownership. It uses the shared policy parser, binds the
   operations decision to its exact policy digest and mode. It requires an
   active window for enabled delivery and for every discovery deployment.
4. [`require-release-approval.mjs`](../../scripts/require-release-approval.mjs)
   checks the profile-bound manifest and private window again immediately
   before the write, alongside a fresh main-head check. An expired enabled
   manifest cannot be reused to start the trial.
5. [`release-postverify.mjs`](../../scripts/release-postverify.mjs) hashes the
   actual configuration bytes, verifies the approved build/environment/profile
   and private policy/window/stop metadata, reads live service settings and the
   active version, and checks the no-store `/health` build response. The
   manifest's mode and observation setting must exactly match the candidate.

Both service settings and active-version bindings must contain the same exact
policy as the candidate. Missing, duplicated, secret-typed or divergent policy
bindings fail verification. A previous manual deployment may omit the policy
during the pre-deploy readback; the resulting private deployment must contain
it. If the reviewed return-to-manual candidate removes the policy, retaining
it on either provider surface is an error. Redacted receipts contain no raw
recipient/table IDs or callback targets.

A post-verification success means the reviewed configuration and resource
identity were observed. It does not prove a callback was received or a model
ran. The actual B-post→A-event→A-run→authenticated-read→committed-reply trace
remains a separate acceptance exercise.

## Stop, expiry and storage-preserving restart

For `a-only` delivery, policy expiry or `ALLOW_OUTBOUND_NOTIFICATIONS=false`
stops new private registration/delivery eligibility while valid configuration preserves ordinary
authorized reads, closure and the owner's permitted unsubscribe. Do not remove
or corrupt the policy while retaining the private profile; an invalid hosted
configuration fails closed and can also prevent read/close operations.

For an operator stop, prepare a new exact candidate with outbound disabled,
retain the valid policy and identity bindings, and obtain the required
protected configuration-change approval. The authorization path permits this
stopped configuration even after its old window expires; it does not restart
its effects. For table-local termination, use the existing authorized closure
or unsubscribe path and record the actual terminal decision. Requests already
dispatched cannot be recalled; distinguish them from work newly authorized
after the decision.

A subsequent return to `manual` must disable all notification flags and remove
the private policy in the exact reviewed configuration and both provider
readbacks. Never broaden the policy or extend its window as an uncertain retry.
New authority requires a new concrete owner decision and bound release record.

A no-restore service restart retains the same current TableDO/GuestDO/KV state,
subscriptions, retry budgets and terminal records. It is not historical PITR
or a stale snapshot restoration. Issue #51's independent post-snapshot
reconciliation remains separate; this profile neither implements nor clears
restore quarantine. New tables, replacement grants, reset retry state or
recreated subscriptions cannot prove retained-state recovery.

## Verification boundaries

Focused deterministic checks cover the shared policy, scoped runtime entry
points and protected release/readback path:

```sh
npx vitest run test/unit/private-pilot.test.ts
node --test scripts/release-preflight.test.mjs \
  scripts/release-authorization.test.mjs \
  scripts/require-release-approval.test.mjs \
  scripts/release-provider.test.mjs scripts/release-postverify.test.mjs
```

Run the repository's typecheck, lint, Worker integration and browser gates for
the candidate as well. Passing these tests is implementation evidence. No
account consent, callback-control success, hosted deployment or autonomous
ChatGPT response is supplied by a synthetic fixture or a passing release test.

### Stopped captures around a version transition

For two disjoint captures of the same table/policy/subscription, retain the
first capture and its own fresh post-shutdown SQL snapshot. The later full
snapshot retains historical rows; do not remove them manually or concatenate
tails into a claimed continuous stream. Verify with:

```sh
node scripts/private-pilot-observations.mjs verify \
  --capture "$LATER_CAPTURE" --snapshot "$LATER_SNAPSHOT" \
  --prior-capture "$PRIOR_CAPTURE" --prior-snapshot "$PRIOR_SNAPSHOT" \
  --output "$REPORT"
```

The prior capture must pass the original verifier. Only identical previously
accepted events may be carried forward; pending work, changed retry counts,
changed messages/subscription identity, missing stages and new events in the
gap fail closed. The report lists both intervals and an explicitly unobserved
gap, with continuousCoverage false and hostExecution not-established. It is
conditional per-event sender evidence, not lossless coverage, a host wake-up
receipt, or a complete autonomous acceptance result.
