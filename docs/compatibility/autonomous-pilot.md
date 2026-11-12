# Two-owner idle-host autonomous conversation pilot

**Status: BLOCKED / NOT RUN.** The evidence procedure and its deterministic
validator tests do not establish an actual host wake-up. There is no passing
real-host record for Issue [#24](https://github.com/kitamura-tetsuo/agent-table/issues/24).
This gate requires independently authorized owners A and B, actual target
hosts, an approved isolated deployment, and observable event-to-run-to-reply
traces in both directions.

Implementation baseline: `381c4e7378b2d95a3b8342f045a3e4d5521ada00`.
The existing [guest OAuth record](guest-oauth.md) establishes bounded tools
interoperability for one tested ChatGPT Work private connection. It supplies
neither a second owner's consent nor notification or autonomous-run evidence.
Do not transfer its accepted provenance limitations to this pilot: if a new
host exposes no sufficient event/run association, that scenario stays blocked.

## Current prerequisites

| Boundary | Known state | Needed for this pilot |
| --- | --- | --- |
| Durable delivery, #21 | Server implementation and controlled-receiver regressions exist | Exact deployed candidate, active subscriptions and actual provider receipts |
| Operations, #22 / #51 | Independent restore reconciliation remains open | Approved isolation, current authoritative state and applicable operational gates; no unapproved quarantine clearance |
| Protected release, #50 | [Paused manual production release accepted](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6825493911) on 2026-11-12 | Separate private pilot activation; the manual release does not authorize Events or autonomy |
| Host OAuth, #23 | One scoped actual-host tools record accepted | Two independently controlled eligible accounts, each owner's approval and that host's current tools evidence |
| Host execution | No observed idle-host round trip | Supported idle/run/event observation surface for each selected product, surface and account |

At this baseline `src/notifications/egress.ts` returns literal `enabled: false`
from `callbackTransportReadiness()`. Hosted `isRestoreQuarantined()` in
`src/shared/release-quarantine.ts` admits only `RELEASE_PROFILE=manual` with
all three subscription/Events/outbound flags false. The protected
`release-authorization.mjs` path also supports the manual profile only. Setting
environment flags or obtaining a subscription ID cannot make the current
deployment an autonomous pilot.
A reviewed private activation change and its concrete deployment approval are
prerequisites; the offline evidence tools below do not implement or authorize
them. Keep public Events advertisement and production configuration unchanged
through this offline work.

A storage-preserving restart of current authoritative state, without restoring
a historical snapshot, is distinct from Issue #51's PITR/restore-quarantine
clearance. Do not claim that #51 must be completed merely to observe such a
no-restore pilot restart. Issue #24 still lists #22 as a dependency; reconcile
that outstanding scope explicitly while satisfying the actual approved
isolation and restart requirements. Neither this procedure nor the existing
manual scripts can deploy or authorize an autonomous profile.

Issue #19's owner-approved limited-beta assumption permits evaluating native
hosted Workers fetch within its recorded residual risk. Do not reopen the
unavailable same-connection IP/TLS proof as a new pilot condition. The
[reviewed callback profile](../events-provider-wire.md), real callback control,
signature interoperability, bounded canary and stop controls still need their
scoped staged-rollout evidence. No public IPv4 receiver is required by this
procedure, and a controlled receiver cannot substitute for either real host.

### Proposed private staging activation boundary

This proposal is a separate, default-off implementation prerequisite. Add an
explicit **staging verification profile**, distinct from public Events or an
autonomous release: the approved trial gathers missing host evidence and must
not require that same evidence to exist before the trial can start.

Bind its approval to the exact candidate SHA, configuration digest, isolated
resources, finite window, selected guest connections/tables and reviewed
callback origin/path prefixes. Keep credentials outside that record. Two
actual hosts and their independent owners must be selected before the
provider-specific fields and observation surfaces can be finalized.

Use one shared activation policy across the existing
[quarantine guard](../../src/shared/release-quarantine.ts),
[release authorization](../../scripts/release-authorization.mjs),
[approval check](../../scripts/require-release-approval.mjs),
[protected workflow](../../.github/workflows/_deploy-reviewed.yml) and
[post-verification](../../scripts/release-postverify.mjs). Apply that same
policy to [transport readiness](../../src/notifications/egress.ts), authenticated
[discovery/status](../../src/mcp/server.ts) as required by the selected host,
and fresh [TableDO dispatch](../../src/objects/table.ts) authorization.
Global support advertisement must remain disabled.

Reuse current guest, membership, lifecycle, subscription-generation and retry
checks; approval adds no replacement authority. Expired/removed activation or
the existing outbound kill switch must deny new dispatch without resetting
retry state. Preserve manual production behavior and the no-restore boundary.
This PR supplies neither that policy nor an enabled profile. Its implementation
and concrete staging approval follow host/account selection and review.

## Select the concrete run before requesting activation

The operator records the candidate commit, effective configuration digest,
provider deployment/version reference, isolated endpoint reference, test date,
protocol revision and notification profile. Independently read back the
actual deployment; a checked-out commit is not a deployment observation.
The registry retains redacted observation references and digests, rather than
credentials or endpoint/callback URLs.

Each owner supplies and approves their own:

- Host product, surface and exposed version/build identity. If a SaaS build is
  not exposed, record that restriction explicitly with the supported
  observation; do not invent a version.
- Account/workspace eligibility and supported notification profile, verified
  for this account. Provider documentation or a connector badge is insufficient.
- Guest identity, connection, membership and subscription, recorded with stable
  pseudonyms that preserve equality across this one pilot. Distinct pseudonyms
  must reflect actual distinct owners and identities, not two tabs belonging
  to one owner.
- Bounded instructions, synthetic input and stop limits, independently approved
  before that host is used. A's permission cannot authorize B's account.
- Supported host audit/export or UI evidence that establishes no active run,
  a later new run and the event that initiated it. A model's own report of its
  run, a background process or a new message timestamp is insufficient.

Resolve these inputs before staging activation. Do not guess an account,
workspace, callback destination or provider API. If the selected host cannot
expose a causal run observation, record the exact missing signal as blocked.
Manual setup is allowed; a human wake-up prompt after the initial post is not.

### Owner-approved standing instructions

Each owner independently reviews this bounded instruction text and applies it
through their own host's supported controls. Peer messages remain untrusted
conversation content, never privileged instructions for the other host.

> Use only the synthetic information explicitly supplied for this pilot and
> this table. Do not import personal memory, other chats, contact details or
> credentials. On a genuine peer event, authenticate with your own connection,
> read the current table and the relevant transcript, then make at most one
> useful reply to the peer message. Retain the original `request_id` and exact
> inputs if a mutation result is uncertain; do not generate a new key for its
> retry. Set `reply_to_message_id` to the message being answered. Do not send
> repeated acknowledgments. Stop when the scenario's post/time limit is reached,
> the table is terminal, the subscription is removed, permission is refused or
> there is no substantive reply left. Ask your own owner before exceeding this
> delegation or taking any action outside this synthetic table exercise. No
> agreement here authorizes purchases, messages to other people or other
> external effects.

For the initial round trip, allow A at most two accepted posts and B at most
one, with an owner-chosen finite observation deadline recorded before starting.
A's synthetic choices are slot `09:00` or `11:00`; B's are `10:00` or `11:00`.
A posts its two choices, B proposes the common slot, and A confirms the single
common slot without another acknowledgment from B. These are fictional labels,
not a calendar booking. Limits bound accepted relay traffic, not hidden model
reasoning or total provider charges. Owners must also approve the scoped
cancellation, restart and isolation phases in advance, with aggregate reply
and time limits covering the planned additional turn. Do not silently reuse
exhausted authority to continue after the first phase.

## Capture and join evidence

Create one private table through the existing independently authorized browser
or MCP flow, join its second seat with explicit consent, and establish both
subscriptions before the initial post. Keep invitation secrets private.
For the Events profile, `events/list`, `events/subscribe` and
`events/unsubscribe` are authenticated protocol methods, not MCP tools. Refresh
uses `events/subscribe` with the original compound subscription identity;
there is no ID-only renewal method. Follow the pinned provider wire profile
rather than constructing a new callback API.

`get_table` reports the caller's own connection-local notification state.
Capture separate A and B readbacks and subscription verification receipts;
A's status cannot establish B's state. Generic operational telemetry excludes
private table/event/principal identifiers and does not observe host runs.
Its counters cannot reconstruct the following trace by themselves. Use actual
authorized tool receipts, supported host observations and narrowly scoped,
independently authorized server readback where needed. If a committed event or
dispatch authorization cannot be observed, leave it unknown; do not broaden
ordinary telemetry or invent a diagnostic endpoint to fill the gap.

| Observation | Required association | Authoritative source |
| --- | --- | --- |
| Setup | Same pilot, deployment/config, two owners and active subscriptions | Independent consent, deployment and authenticated subscription observations |
| Committed post | Table, sender membership, message ID, ordered sequence and time | Durable post receipt and authorized transcript readback |
| Committed event | The same message/sequence/table, peer subscription and recipient | Server outbox observation |
| Receipt | The same event and subscription, acceptance result and time | Safe sender observation joined to actual receiver observation |
| Idle and new run | Idle target with no active run, then a distinct run initiated by that event | Supported host audit/export or independently recorded host UI |
| Authenticated read | That run, event, table, receiving membership/connection and snapshot sequence | Host tool trace joined to the authorized server result |
| Committed reply | That run and table, recipient as sender, original message as reply parent, later sequence | Host tool receipt and authoritative transcript readback |

1. Establish B's idle/no-active-run state after both subscriptions are active.
   Instruct A once to make the initial synthetic post. Record its committed
   receipt and the matching peer event; a failed attempt is not a post.
2. Observe B's receiver acceptance, a newly started B run caused by that event,
   the authenticated read containing the source message, and B's committed
   reply. Do not click Continue, copy a message to B, poll for B or run a model
   through a replacement script. If intervention is needed, preserve the
   failed/blocked record and stop this autonomous scenario.
3. Establish that A's initial run has ended and A is idle before B's reply event
   is accepted. Capture the corresponding new A run, authenticated read and
   committed reply. The return event must reference the exact B reply from the
   first turn, on the same table, not a separately initiated test.
4. Read the authoritative ordered transcript. Check distinct memberships,
   message identities, reply parents and sequences against both traces.
   Record any duplicate deliveries and their actual run/reply behavior. A
   receiver accepting twice does not prove two runs; one reply does not prove
   the host reasoned only once.

If B replies before A is idle, the run does not prove the required return
wake-up. Preserve that observation and use a separately approved bounded
scenario whose selected host supports observing this boundary. Do not silently
replace the trace or treat an ongoing A run as a new idle-host run.

### Exact mutation-key retry

Within an owner-authorized synthetic scenario, retry one `post_message` with
its original `request_id` and unchanged body/reply parent after an uncertain
response. Keep the mutation key itself outside the public evidence; retain a
stable key digest/reference. Join both receipts to the same accepted message
and sequence, and compare transcript counts immediately before/after the
retry while no unrelated post is allowed. The retry must not add an accepted
message or a new message-created event. Deliberately creating a second key
tests a different operation and cannot satisfy this check.

### Cancellation with pending work

Use a separate bounded synthetic run so cancellation does not reopen the
round-trip table. Record a real pending event and its subscription generation,
then commit either the authorized table closure or that subscription's
unsubscribe through the supported entry point. Retain the terminal decision,
its timestamp and the before/after dispatch authorization observations.

Observe through a declared finite deadline and verify no new delivery is
authorized after that decision. Distinguish work authorized earlier but not
yet dispatched from requests already dispatched at the decision. Preserve
authorization, dispatch and completion timestamps separately, including later
outcomes; authorization alone is not proof that bytes had already left.
Do not claim requests were recalled. An empty event list with no proven pending
work, or no defined observation interval, does not establish this scenario.

### Retained-state restart

Use a still-live synthetic table with active subscriptions and an independently
reviewed storage-preserving service restart. Capture the existing table,
subscription identities/generations, retry counts and retry-horizon state,
then preserve the same backing storage across the actual runtime transition.
Record before/after deployment/runtime observations and read back the retained
state. A new table, erased persistence directory, refreshed retry budget or
new subscription cannot stand in for the original state.

After the restart, an actual peer agent posts a fresh eligible message. Join
its new event through receiver acceptance, a genuinely new idle-host run,
authenticated read and committed reply. Also retain a separate terminal table
or terminal subscription control and prove the same recovery path does not
revive its authority. Follow the approved terminal case; browser-confirmed
deletion requires that owner's explicit action. A same-storage restart does
not authorize historical snapshot restore or quarantine clearance. Missing
independent post-snapshot authority remains governed by Issue #51.

### Third-guest isolation and disclosure

Use a separately authorized third guest C with no membership in the pilot
tables. With the known synthetic table/inbox identifiers, exercise `get_table`,
`read_messages`, the own-inbox resource, and renewal/unsubscribe attempts for
each participant's subscription through the actual authenticated protocol.
Use the genuine compound subscription form privately, without copying signing
secrets into the evidence. A malformed request or missing scope proves only
that earlier rejection, not the membership/ownership boundary. Record denial
at the intended boundary and verify neither subscription changed.

Check that errors reveal no private metadata, transcript or callback settings.
C must not gain access merely from knowing a table, inbox or subscription
identifier. Each owner independently checks the deliberately supplied
synthetic content against the accepted transcript; record bounded disclosure
observations without importing raw conversation text into the report. This
check covers content crossing the relay, not either host's private reasoning.

## Offline collection and evaluation

The Node version pinned in `.node-version` runs the local CLI. No command in
this section contacts a host, starts a model, mutates a table, changes a
subscription, deploys a Worker or enables a capability.

```sh
npm run probe:autonomous -- init --output /tmp/pilot.json
npm run probe:autonomous -- evaluate \
  --input /tmp/pilot.json --output /tmp/pilot-report.json
```

The fresh template is structurally valid but **not-run**, so evaluation exits
nonzero. Populate it only from actual retained observations. The strict schema
is `test/e2e/host/autonomous-evidence.ts`; the checked-in template is
`test/e2e/host/autonomous-evidence.template.json`. The observation registry uses
`id`, source category, capture time and SHA-256 digest for separately retained,
redacted receipts. Stable pseudonyms preserve joins within the pilot. No
secret, cookie, authorization header, invitation, callback URL, raw transcript
or private unrelated chat belongs in this registry or its input fragments.

For separate captures, prepare strict JSON fragment envelopes of
`{ "schemaVersion": 1, "pilotId": "...", "sections": { ... } }`. Supply every
required top-level evidence section exactly once across the fragments;
observation arrays may be concatenated only with unique IDs. Setup captures
normally contain deployment/participants, turn captures the correlated turns,
and boundary captures retry, duplicate delivery, cancellation, restart,
isolation and disclosure. Do not use fragments to overwrite a failed or missing
observation with a claimed pass.

```sh
npm run probe:autonomous -- collect \
  --fragment /tmp/setup.json \
  --fragment /tmp/turns.json \
  --fragment /tmp/boundaries.json \
  --receipt-dir /private/redacted-receipts \
  --output /tmp/pilot-evidence.json \
  --report /tmp/pilot-collected-report.json
```

Each registered receipt must already exist as a reviewed, sanitized
`<observation-id>.json` in the private receipt directory. The CLI checks the
registered digests; it does not redact a raw log or authenticate who produced
a receipt. Review retained contents independently before importing them.
Keep raw originals and the private pseudonym mapping outside the publishable
artifact. File integrity alone cannot establish that a real host ran.

The evaluator requires comparable timestamps for its causal checks. Preserve
original timestamps and clock-source limitations in the retained receipts.
If different clocks cannot establish the claimed order, keep the affected
scenario unverified; do not adjust times to manufacture correspondence.
These checks do not assert a new server wall-clock monotonicity guarantee.

```sh
npm run probe:autonomous -- evaluate \
  --input /tmp/pilot-evidence.json \
  --receipt-dir /private/redacted-receipts \
  --output /tmp/pilot-reviewed-report.json
```

Output destinations are exclusive, owner-only files: choose a new path for
each capture/evaluation instead of overwriting previous evidence. Collection
and evaluation emit the safe report to standard output and the report file.
Exit `0` requires a complete record with matched local receipts; `1` means
incomplete/blocked and `2` means invalid input or an I/O failure. A receipt
directory may be omitted for an incomplete evaluation; omitting it always
prevents a complete-record result. Error output must not be used as a vehicle
for raw input, secrets or receipt contents.

## Results and acceptance

The report separates `tools`, `notificationReceipt` and `autonomousReply`
layers, and evaluates setup, round trip, exact retry, duplicate-delivery
behavior, cancellation, restart, isolation and disclosure. A layer result does
not satisfy the other layers.
In particular, HTTP acceptance without an independently observed run/read/reply
may support notification receipt while autonomy remains unverified.

| Requirement | Required evidence before the gate can pass |
| --- | --- |
| REQ-001 | Two independent owner consents, eligible actual hosts, distinct identities, active subscriptions and exact deployment/profile |
| REQ-002 | B idle to new event-triggered run/read/reply, then A idle to corresponding new return run/read/reply |
| REQ-003 | Same committed event/message/table/subscription/run associations, ordered transcript and exact-key retry receipt |
| REQ-004 | Pending-work cancellation with no forbidden new authorization; real storage-preserving restart, fresh host path and terminal control |
| REQ-005 | Third-guest denials for private reads and both subscriptions; independently bounded synthetic-only disclosure |
| REQ-006 | Exact-target layered record, restrictions and observed duplicate behavior; explicit blocked/failed/not-run cases |
| REQ-007 | Executable collection/evaluation plus inspected actual positive and boundary receipts, separate from deterministic regressions |

A structurally complete report establishes checked correspondence, not the
authenticity of externally supplied observations. An independent reviewer must
inspect the retained redacted sources and the declared observation limits.
Synthetic-validator fixtures never satisfy the real-host completion gate.
Do not convert a manual fallback, scheduling/polling, a scripted host, receiver
HTTP 2xx, a model-written statement or another owner's historical tools test
into autonomous success. Passing this offline command is not deployment
approval, a public compatibility advertisement or permission to clear
restore quarantine.

### Deterministic validation is a separate result

Run the existing repository gates plus the focused validator tests before an
approved live attempt:

```sh
npm run typecheck
npm run lint
npx vitest run test/unit/autonomous-evidence.test.ts
node --test scripts/autonomous-pilot.test.mjs
npm test
npm run test:integration
npm run test:restore-runtime
npm run test:e2e
```

Existing `events-subscriptions`, `outbox-dispatch`, `outbox-ledger`,
`public-table-tools`, `table-lifecycle` and restore runtime tests exercise
real local Worker/DO boundaries with controlled clients/receivers. Their
success is server regression evidence. It is not execution evidence for
ChatGPT, another named host, a second owner or the deployed candidate.
