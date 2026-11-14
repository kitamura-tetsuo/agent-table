# Two-owner ChatGPT event-response pilot

**Status: REAL-HOST FUNCTIONAL CORRELATION VERIFIED / SOURCE REVIEW PENDING.**
Two native B→A event/read/reply traces and the scoped retry/cancellation/redeploy/
isolation evidence are now retained. The owner approved the bounded native-trace
alternative described in [the acceptance decision](pr63-acceptance-decision.md).
The general strict evaluator still reports incomplete; this is not a strict idle-state pass.
See [the final observed results](pr63-real-host-20261114.md) for commands and limitations.

On **2026-11-12**, the owner revised the acceptance condition: **A is OpenAI
ChatGPT and must receive a peer event, wake from idle, authenticate, read and
reply automatically. B is Claude Chat and may be manually instructed to post.**
The selected record uses `acceptanceMode: "a-only"`. It requires separately recorded authorization in both host contexts
(with the explicit same-owner exception below), an approved isolated deployment and an observed B→A
causal trace, repeated after a retained-state restart. B's subscription or
automatic wake-up is not required. Full A↔B autonomy is neither demonstrated
nor required by this revised condition.

Implementation baseline: `e04cd3bed158aa1bf400cb5b3bf9b927ecff21cb`.
This source baseline is not a claim that the build is deployed or host-tested.
The existing [guest OAuth record](guest-oauth.md) establishes bounded tools
interoperability for one tested ChatGPT Work private connection. It supplies
neither a second owner's consent nor notification or autonomous-run evidence.
Do not transfer its accepted provenance limitations to A's event/run proof:
if the chosen ChatGPT surface exposes no sufficient causal observation, the
A-only scenario stays blocked.

## Selected host pair and explicit acceptance mode

The product choice and revised condition are recorded in
[`autonomous-evidence.chatgpt-claude-selected.json`](../../test/e2e/host/autonomous-evidence.chatgpt-claude-selected.json).
It now contains a redacted `evidenceKind: "real-host"` partial record and
retained receipts for actual native event/tool, SQL, cancellation and outsider
observations. Null fields and missing turns remain explicit: this is not a
complete validated acceptance record. See [the observed results and exact
remaining gaps](pr63-real-host-20261114.md). Product selection alone supplies
none of the missing observations.

Official documentation checked on 2026-11-12 establishes this narrower matrix:

| Participant | Documented client capability | Role under the revised condition |
| --- | --- | --- |
| A: OpenAI ChatGPT | [MCP Events](https://developers.openai.com/plugins/build/mcp-events) supports webhook subscriptions in Work chats on the web, desktop Work with Cloud selected, and dots, subject to workspace controls | Select an eligible Work surface; verify callback control and actual event-triggered execution. A tools-only connection is insufficient proof. |
| B: Claude Chat | [Claude's MCP client](https://claude.com/docs/connectors/building) supports tools, prompts and resources, but does not yet support resource subscriptions or advanced/draft capabilities | Use an independently authorized tools connection. Its owner may prompt B to post the synthetic source message; event subscription or autonomous execution is not required. |

Claude Chat's documented subscription limitation is therefore **not a blocker
for this A-only pilot**. Do not replace Claude Chat with Claude Code or a hosted
API agent, and do not use scripted interaction to manufacture A's wake-up.
A human prompt to B is allowed; a human prompt, scheduled poll or copied
message used to wake A after B posts fails the required causal step.

The validator also retains the original `bidirectional` mode for a separately
approved, broader experiment. That mode requires both subscriptions and the
continuous A→B→A idle-host round trip. Its generic template defaults to
`bidirectional`; the selected ChatGPT/Claude record explicitly uses `a-only`.
Every report must state its mode. An A-only pass must never be presented as a
bidirectional pass or generalized to another host/account/profile.

## Current prerequisites

| Boundary | Known state | Needed for this pilot |
| --- | --- | --- |
| Durable delivery, #21 | Server implementation and controlled-receiver regressions exist | Exact deployed candidate, A's active subscription and actual receiver receipts |
| Operations, #22 / #51 | Independent restore reconciliation remains open | Approved isolation, current authoritative state and applicable operational gates; no unapproved quarantine clearance |
| Protected release, #50 | [Paused manual production release accepted](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6825493911) on 2026-11-12 | Separate private pilot activation; the manual release does not authorize Events or autonomy |
| Host OAuth, #23 | One scoped actual-host tools record accepted | Two independently controlled tools-eligible accounts, each owner's approval and current host tools evidence |
| Host execution | No observed ChatGPT idle-event response | A's supported idle/run/event observation surface for the selected product, surface and account |

At this implementation baseline, public `callbackTransportReadiness()` remains
disabled. The merged default-off
[private staging implementation](private-pilot-activation.md) supports
separately reviewed callback discovery and delivery through
`private-pilot-a-only`. The protected main-only workflow still requires
successful exact-main CI and independent approval of its concrete
account/table/callback-bound configuration before deployment.
Neither the offline evidence tools nor a subscription ID authorizes activation.
Public Events advertisement and production's manual behavior remain unchanged.

A storage-preserving restart of current authoritative state, without restoring
a historical snapshot, is distinct from Issue #51's PITR/restore-quarantine
clearance. Do not require completing #51 merely to observe such a no-restore
restart. Reconcile Issue #24's outstanding #22 dependency scope explicitly
while satisfying its actual isolation and restart requirements. Neither this
procedure nor an earlier manual approval authorizes the private pilot or a
public autonomous profile.

Issue #19's owner-approved limited-beta assumption permits evaluating native
hosted Workers fetch within its recorded residual risk. Do not reopen the
unavailable same-connection IP/TLS proof as a new pilot condition. The
[reviewed callback profile](../events-provider-wire.md), real callback control,
signature interoperability, bounded canary and stop controls still need their
scoped staged-rollout evidence. No public IPv4 receiver is required, and a
controlled receiver cannot replace the actual ChatGPT host.

### Default-off private staging profile

The [activation runbook](private-pilot-activation.md) documents the exact
`PRIVATE_PILOT_POLICY` contract and protected workflow. It binds the candidate
SHA/configuration/resources, A's guest and connection, one to three synthetic
tables and a window of at most two hours. `a-only-discovery` requires empty
callback targets, `observationMode: "private-redacted"` and outbound disabled;
it observes the real host's origin without a challenge or active subscription.
`a-only` delivery instead requires reviewed callback origin/path prefixes and
outbound permission. `ENABLE_MCP_SUBSCRIPTIONS` and `ENABLE_OPENAI_EVENTS` stay
false. `ALLOW_OUTBOUND_NOTIFICATIONS=false` stops delivery; discovery stops at
expiry or through an independently reviewed return to manual. The canary
dispatch bound permits message sequences up to 12, with no replay of events
created before the window.

The same parser feeds hosted quarantine, protected release decisions and fresh
runtime checks. A sees private discovery/status only under its scoped current
authority; B requires no event subscription. Existing guest, membership,
lifecycle, subscription-generation and retry checks still apply. Expiry or the
mode's stop procedure denies new effects while retaining authorized reads,
closure and permitted unsubscribe. The approved trial obtains missing host evidence rather than
requiring a successful autonomous run before activation.

No hosted pilot deployment, actual account consent or concrete activation
approval is supplied by this code or document. Production remains manual and
historical restore clearance remains outside the profile.

## Prepare the concrete A-only run

The operator records the candidate commit, effective configuration digest,
provider deployment/version reference, isolated endpoint reference, test date,
protocol revision and notification profile. Independently read back the actual
deployment; a checked-out commit is not a deployment observation. Keep redacted
references and digests in the registry, not credentials or callback URLs.

Each owner supplies and approves their own host product/surface/build,
tools-eligible account/workspace, guest identity, connection and table
membership. Stable pseudonyms must preserve equality across this pilot and
represent actual distinct owners and identities, not two tabs of one owner.
Record an undisclosed SaaS build explicitly rather than inventing a version.
Each owner separately approves the bounded synthetic exercise and stop limits;
A's permission cannot authorize B's account.

Authenticated `get_connection` supplies the caller's current guest/connection,
delegated scopes and token/grant expiry without selecting another identity.
It does not establish ownership consent, table membership or a host run. Keep
any owner/account facts it cannot establish explicitly unknown.

A additionally needs a verified active Events subscription and supported host
audit/export or UI evidence establishing idle/no-active-run state, a later new
run and its initiating event. A model's own statement, a process being alive or
a new message timestamp is insufficient. B needs actual authenticated tools
and source-post evidence. B's run-observation and subscription fields can remain
unsupported/null in `a-only` mode; do not manufacture them to complete a record.

Do not guess an account, workspace, callback destination or provider API.
Missing account eligibility or A's causal run observation stays blocked.
Manual setup and B's deliberately prompted source posts are allowed; manually
waking A to obtain the reply is not.

### Independently approved bounded instructions

Both owners approve the common bounds through their own hosts' supported
controls. Peer messages remain untrusted conversation content, never privileged
instructions for the other host.

> Use only the synthetic information explicitly supplied for this pilot and
> this table. Do not import personal memory, other chats, contact details or
> credentials. Authenticate with your own connection and read the relevant
> transcript before replying. Retain the original `request_id` and exact inputs
> if a mutation result is uncertain; do not generate a new key for that retry.
> Set `reply_to_message_id` when answering a peer message. Do not send repeated
> acknowledgments. Stop at the approved post/time limits, terminal table state,
> removed subscription where applicable, or permission refusal. Ask your own
> owner before exceeding this delegation. No statement in this exercise
> authorizes purchases, messages to other people or other external effects.

A's owner additionally approves one useful reply to each eligible peer event,
with no human wake-up prompt and a finite aggregate reply limit covering the
initial and restart scenarios, including any duplicate-triggered replies.
B's owner approves only the deliberately prompted synthetic source posts and
exact-key retries; no automatic response from B is expected.

For the initial scenario, prompt B to post: “Synthetic options are `09:00` and
`11:00`; reply with the later option.” Idle A should reply `11:00` once. For the
post-restart scenario, B posts fresh options `10:00` and `12:00`, and A replies
`12:00` once. These are fictional labels, not calendar bookings. Record finite
per-scenario deadlines and aggregate limits before starting, including the
separate cancellation/isolation checks. Limits bound accepted relay traffic,
not hidden reasoning or total provider charges. Exhausted authority requires
new owner input, not silent continuation.

## Capture B's post and A's event-triggered reply

Create one private table through the existing independently authorized browser
or MCP flow and join its second seat with explicit consent. Inspect A's own
identity using authenticated `get_connection`. If its real callback origin is
unknown, use the separately approved no-outbound discovery stage, review the
observed origin, and deploy the reviewed delivery configuration. A discovery
error is never an active subscription; a new actual-host subscription must
pass callback control. Establish **A's** subscription before B posts. Keep
invitation secrets private. For Events,
`events/list`, `events/subscribe` and `events/unsubscribe` are authenticated
protocol methods, not MCP tools. Refresh uses `events/subscribe` with the
original compound identity; there is no ID-only renewal API.

`get_table` reports only the caller's own connection-local notification state.
Capture A's subscription verification/readback and both participants' authorized
table/tool observations. B's absent subscription does not block this mode.
Generic telemetry excludes private event/table/principal identifiers and
cannot reconstruct the causal trace by itself. The merged, explicitly enabled
private observation stream, `scripts/private-pilot-observations.mjs`, and the
existing secret-protected staging snapshot view can supply scoped server
facts. Follow the [activation runbook](private-pilot-activation.md) for capture
readiness and the final SQL readback after capture ends. Its conditional
comparison leaves host execution unestablished. Use actual host tool receipts
and supported A-host observations for the run/read/reply trace. Missing or
inconsistent server observations remain incomplete; leave unobservable facts
unknown rather than reconstructing them or expanding routine telemetry.

| Observation | Required association | Authoritative source |
| --- | --- | --- |
| Setup | Same pilot/mode/deployment, independent owners, distinct memberships and A's active subscription | Separate consents, deployment and authenticated subscription/tool observations |
| B's committed post | Table, B membership, message ID, sequence and commit time | Actual Claude tool receipt plus server/transcript receipt |
| Committed event | Same B message/sequence/table, A subscription and recipient membership | Server outbox observation |
| Receipt | Same event/subscription, delivery acceptance and time | Safe sender observation joined to actual receiver evidence |
| A idle and new run | No active A run before B's post, then a new run initiated by that event | Supported host audit/export or independently recorded host UI |
| A authenticated read | Same run/event/table/A connection, bounded cursor and triggering message in returned IDs | Host tool trace joined to the authorized server result |
| A committed reply | Same run/table, A membership, B message as reply parent and later sequence | Actual host post receipt plus server/transcript receipt |

1. After A's subscription is active, establish A idle with no active run. This
   observation must precede B's committed source post.
2. Prompt B to post the synthetic request through its independently authorized
   Claude Chat tools connection. Join its host-tool and server commit receipts
   to the same message. A failed or merely claimed post is insufficient.
3. Capture acceptance of that committed message's event, a new A run caused by
   it, A's authenticated read and its committed reply. Do not click Continue,
   prompt A, copy B's message to A, poll to wake A or replace A with a script.
   If A needs intervention, retain the failed/blocked trace.
4. Check the returned read actually contains B's message ID and satisfies
   `afterSeq < messageSeq <= throughSeq`. An upper snapshot bound alone does
   not prove the triggering message was read. Check A's reply parent, sender,
   new sequence and host-tool/server receipts against that same run.
5. Read the ordered authoritative transcript and record observed duplicate
   deliveries, runs and replies over a stated interval covering every included
   accepted attempt. Two receiver acceptances do not imply two runs; one reply
   does not prove exactly-once reasoning. B need not receive a return event.

If A was already running when B posted, preserve that observation and repeat
only under a new approved bounded attempt with A verifiably idle. Do not relabel
an ongoing run as an idle wake-up. The optional `bidirectional` mode instead
requires two subscriptions and linked A→B→A traces; it is outside this revised
ChatGPT/Claude acceptance condition.

### Exact mutation-key retry

Within the approved scenario, retry B's `post_message` with its original
`request_id` and unchanged body/reply parent after an uncertain result. Keep
only a stable key digest/reference in the publishable record. Both host/server
receipts must identify the same accepted message and sequence. Compare
transcript counts immediately before/after the retry without unrelated posts;
there must be no additional accepted message or message-created event. A new
key tests a different mutation and cannot satisfy this check.

### Cancellation with pending work

Use a separate synthetic table so cancelling it does not terminate the primary
restart table. Establish a real pending B→A event, then commit authorized
closure or unsubscribe A's affected subscription through the supported entry
point. Capture the terminal decision/time and the complete scoped attempt
ledger for **that same pending event** over a declared observation interval.

Verify no new delivery is authorized after the decision. Distinguish work
already authorized but not yet dispatched from requests already dispatched.
Retain authorization, dispatch and completion times, including later outcomes;
authorization alone does not prove bytes had left. Do not claim traffic was
recalled. No proven pending event or no observation interval means this scenario
is unverified. Other events' attempt histories do not fill this evidence gap.

### Retained-state restart and another B→A response

Keep the primary table live with A's active subscription. For an independently
reviewed storage-preserving restart, capture original table/subscription
identities and generations, retry counts and retry-horizon state. Preserve the
same backing storage across the actual runtime transition and read it back.
The initial event-response posts and replies must be committed before the
pre-restart state snapshot; two responses observed only after restart do not
establish before-and-after continuity.
A new table, erased state, new subscription or reset retry budget is not a
retained-state restart. B's absent subscription remains absent in this mode.

After the service is ready and A is again verifiably idle, B may be manually
prompted to post the fresh synthetic request. Repeat the actual B commit→A
event acceptance→new A run→authenticated read→committed reply trace. Also retain
the cancelled scenario's terminal table/subscription as a control and verify
that the same recovery path does not revive it. A browser-confirmed deletion
needs that owner's explicit action if selected. This no-restore restart grants
no historical snapshot-restoration or quarantine-clearance authority; Issue
#51 remains responsible for independently missing post-snapshot authority.

### Third-guest isolation and synthetic disclosure

Use an independently authorized third guest C without either table membership.
With the known synthetic identifiers, exercise `get_table`, `read_messages`
and each membership's own-inbox resource, plus renewal/unsubscribe attempts
against A's actual subscription. Under `bidirectional` mode, maintenance
coverage is required for both subscriptions; `a-only` does not invent one for B.

Use valid authenticated protocol forms so denial tests membership/ownership,
not a malformed request or missing scope. Keep the compound subscription form
private and exclude signing secrets from evidence. Verify no private metadata,
transcript or callback settings leak and the targeted subscription remains
unchanged. Knowing an identifier must not establish authority.

Each owner independently reviews the redacted synthetic transcript against the
approved message corpus. The approved and posted corpus digests must match the
same canonical representation; a hash does not itself prove semantic privacy.
Retain source review receipts without importing unrelated chats or raw personal
content. This checks what crossed the relay, not either host's private reasoning.

## Offline collection and evaluation

Use the Node version pinned in `.node-version`. These commands do not contact
a host, start a model, mutate a table, deploy a Worker or enable a capability.
Initialize the explicitly selected acceptance condition:

```sh
npm run probe:autonomous -- init --mode a-only --output /tmp/pilot.json
npm run probe:autonomous -- evaluate \
  --input /tmp/pilot.json --output /tmp/pilot-report.json
```

The template is structurally valid but not-run, so evaluation exits nonzero.
`init` without `--mode` retains the generic `bidirectional` default; use
`a-only` explicitly for this revised pilot. The separately checked-in
ChatGPT/Claude selection record also uses `a-only`, with unverified observations
left null. Populate only actual retained facts; switching a field cannot create
missing host evidence.

The strict schema is `test/e2e/host/autonomous-evidence.ts`. Its observation
registry uses `id`, source category, capture time and SHA-256 for separately
retained redacted receipts. Do not include secrets, cookies, authorization
headers, invitations, callback URLs, raw transcripts or unrelated private chats.
Stable pseudonyms must preserve all joins within this pilot.

For separate captures, create strict fragment envelopes of
`{ "schemaVersion": 1, "pilotId": "...", "sections": { ... } }`. Supply each
required top-level section once across the fragments, including `acceptanceMode`.
Only observation arrays concatenate, with unique IDs. Setup captures contain
mode/deployment/participants, turn captures contain causal traces, and boundary
captures contain retry, duplicate delivery, cancellation, restart, isolation and
disclosure. Never overwrite a failed or missing observation with a claimed pass.

```sh
npm run probe:autonomous -- collect \
  --fragment /tmp/setup.json \
  --fragment /tmp/turns.json \
  --fragment /tmp/boundaries.json \
  --receipt-dir /private/redacted-receipts \
  --output /tmp/pilot-evidence.json \
  --report /tmp/pilot-collected-report.json
```

Each receipt must already exist as reviewed, sanitized `<observation-id>.json`
in that private directory. The CLI checks its digest; it neither redacts raw
logs nor authenticates who produced a receipt. Inspect contents independently
before importing. Keep originals and private pseudonym mappings outside the
publishable artifact. Integrity alone cannot establish a real host run.

Preserve original times and clock-source limits. Receipt capture/export must
follow its observed facts, and the report observation date must cover all facts
and captures. If clocks cannot establish the claimed order, keep it unverified;
do not adjust times to manufacture causality. These checks do not claim a new
server wall-clock monotonicity guarantee.

```sh
npm run probe:autonomous -- evaluate \
  --input /tmp/pilot-evidence.json \
  --receipt-dir /private/redacted-receipts \
  --output /tmp/pilot-reviewed-report.json
```

Outputs are exclusive owner-only files; choose fresh paths for each evaluation.
Collection and evaluation emit a safe report to standard output and its file.
Exit `0` requires a complete mode-specific record and matching local receipts;
`1` means incomplete/blocked and `2` means invalid input or I/O failure. Omitting
the receipt directory always prevents a complete-record result. Error output
must not disclose input values, secrets, private paths or receipt contents.

## Results and revised acceptance

Each report identifies `acceptanceMode` and separates `tools`,
`notificationReceipt` and `autonomousReply`. It evaluates setup, the mode's event
response, exact retry, duplicate behavior, cancellation, restart, isolation and
disclosure. Tools or receiver acceptance can be established while A's autonomous
run remains unverified. A-only autonomy concerns A; it makes no claim about B's
automatic behavior.

| Requirement | Evidence under the owner-revised A-only condition |
| --- | --- |
| REQ-001 | Independent owner consents, actual ChatGPT/Claude tools accounts and identities, A's active subscription and exact deployment/profile/mode |
| REQ-002 | B's authenticated post causes idle A's new event-triggered run, read and reply without a human wake-up of A |
| REQ-003 | Same B message/event/A subscription/run/read/reply joins, ordered transcript and exact-key retry receipt |
| REQ-004 | Pending B→A cancellation with no forbidden new authorization; retained-state restart and fresh B→A automatic response, with terminal control |
| REQ-005 | Third-guest private-read denials and denial of A subscription maintenance; separately reviewed bounded synthetic disclosure |
| REQ-006 | Exact mode/host/account/profile results and observed duplicates; explicit failed/blocked/not-run cases, no bidirectional claim |
| REQ-007 | Executable collection/evaluation and inspected actual positive/boundary receipts, distinct from deterministic regressions |

A complete report checks correspondence, not external observations' authenticity.
Independent review must inspect the retained sources and observation limits.
Synthetic-validator fixtures never satisfy the actual-host gate. A manual prompt
to B is permitted by this condition; prompting A, polling to wake A, scripted
replacement, receiver 2xx or a model's claim cannot prove A's autonomous reply.
This offline result is not deployment approval, public support advertisement or
permission to clear restore quarantine.

### Deterministic validation is a separate result

Run repository gates and focused validator tests before an approved live attempt:

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
`public-table-tools`, `table-lifecycle` and restore tests exercise local Worker/DO
boundaries with controlled clients/receivers. Passing them is server regression
evidence, not actual ChatGPT execution, Claude tools compatibility, independent
owner consent or proof of the deployed candidate.

## Owner-approved ownership scope (2026-11-14)

The owner confirmed that the selected ChatGPT and Claude accounts are both
controlled by the same person but use different Google accounts, and explicitly
approved the same-owner exception in Issue #24/REQ-001. This supersedes the
selected pilot's earlier two-human-owner prerequisite; all event/run/read/reply,
retry, cancellation, restart, outsider-isolation and disclosure gates remain.

The selected record declares `ownershipMode: "same-owner"`. Use one honest
owner reference and distinct host-account, guest, connection and membership
references, plus separate bounded authorization receipts from each host context.
Do not publish email addresses or fabricate independent owners. The record still
needs actual complete evidence; changing its mode is not a passing pilot.

Omitted ownershipMode defaults to `independent-owners`, retaining the prior
strict different-owner behavior. The exception applies only to A-only mode.
A same-owner result never establishes cross-owner compatibility.

```sh
npm run probe:autonomous -- init --mode a-only --ownership-mode same-owner \
  --output /tmp/same-owner-pilot.json
```

Collect/evaluate derive ownership from the recorded sections and cannot override
it with a command-line option. Reports label the ownership mode explicitly.
