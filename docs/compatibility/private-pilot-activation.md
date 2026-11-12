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
| `ALLOW_OUTBOUND_NOTIFICATIONS` | `true` only for the approved active trial; `false` is the independent stop switch |
| `PRIVATE_PILOT_POLICY` | Exact serialized JSON string described below |

`PRIVATE_PILOT_POLICY` has exactly these fields:

| Field | Constraint |
| --- | --- |
| `schemaVersion`, `mode` | `1`, `a-only` |
| `buildSha` | Matches `RELEASE_BUILD_SHA` |
| `approvedAt`, `notBefore`, `expiresAt` | UTC ISO timestamps; approval no later than start; positive window of at most two hours |
| `approvalRef` | Bounded reference to the separately retained operator decision; not a credential or self-issued permission |
| `recipientGuestId`, `recipientConnectionId` | The exact independently authorized receiving guest and application connection |
| `tableIds` | One to three distinct UUIDs for the approved synthetic primary/cancellation/control tables |
| `callbackTargets` | Strict reviewed HTTPS `origin` plus canonical `pathPrefix` entries; no arbitrary caller-selected destination |

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
   procedure, bounded canary, stop plan and retained native-fetch risk. Actual
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
| `mode` | `a-only` |
| `policySha256` | SHA-256 of the exact serialized policy string |
| `approvalRef` | The same policy decision reference |
| `independentOwnerConsentsReviewed` | Both owners' bounded authorities actually reviewed |
| `callbackControlReviewed` | Actual callback scope/control procedure reviewed |
| `nativeFetchRiskAccepted` | Recorded limited-beta transport premise accepted for this scope |
| `boundedCanaryReviewed` | Exact table/recipient/window and traffic bounds reviewed |
| `stopPlanReviewed` | Outbound stop, terminal action and readback plan reviewed |

The five review fields must be `true` based on actual review. They are not
filled automatically from this example. Structural private-profile evidence
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
   operations decision to its exact policy digest and requires an active
   window for an enabled trial.
4. [`require-release-approval.mjs`](../../scripts/require-release-approval.mjs)
   checks the profile-bound manifest and private window again immediately
   before the write, alongside a fresh main-head check. An expired enabled
   manifest cannot be reused to start the trial.
5. [`release-postverify.mjs`](../../scripts/release-postverify.mjs) hashes the
   actual configuration bytes, verifies the approved build/environment/profile
   and private policy/window/stop metadata, reads live service settings and the
   active version, and checks the no-store `/health` build response.

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

Policy expiry or `ALLOW_OUTBOUND_NOTIFICATIONS=false` stops new private
registration/delivery eligibility while valid configuration preserves ordinary
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
