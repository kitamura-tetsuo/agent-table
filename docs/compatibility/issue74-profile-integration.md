# Issue #74 profile integration execution record

Inspected main: `91cdae9eb1a5c626b47792c9b8782efdee65c069` (2026-11-16).
No AGENTS.md or applicable `.agents/skills` exists in that tree. This record
supplements the historical test-native and production-relay checkpoints; it does
not replace their evidence scopes or assert live activation.

| Requirement | Reused implementation and current bounded work | Outstanding acceptance |
| --- | --- | --- |
| REQ-001 | #76/#77 staging all-authorized-table native profile; #75 production relay profile; current regression exercises MCP discovery/subscription and persisted ownership for two tables/four real GuestDO grants in each profile | Environment-specific actual hosted acceptance |
| REQ-002 | Shared native-profile predicate now rejects retained pilot policy, relay configuration and relay key bindings, even empty/malformed values. Preflight checks redacted secret inventory; provider verification checks settings, active version and secret-list presence. Production cannot use the test waiver | Native connected-peer DNS boundary remains unproved; the waiver is test-only |
| REQ-003 | #75 reviewed relay candidate and fail-closed production release gates remain in force | Selected live hosting/identity/security/data-handling decision and independent actual connection evidence; no new service is implicitly mandatory |
| REQ-004 | Existing MCP/service/TableDO/diagnostic/release consumers share the predicate; current Worker/service/TableDO refusal regression and release tests prevent mixed-profile false readiness | #82 separately owns schema-15 release evidence and full-stop regression/runbook; no duplicated implementation here |
| REQ-005 | Existing OAuth/MCP producer, authorization/lifecycle/generation/retry/eviction suites retained. Current tests add explicit two-table/four-connection positive controls and mixed-profile refusal with zero external fetch/candidate/subscription rows | Controlled transport is not actual network, relay deployment or host evidence |
| REQ-006 | Manual protected deployment workflows only; merging source triggers Validation, not deployment | Concrete per-environment build/config/settings/destination/data/impact/risk/stop approval before any live change; then serving-resource readback and committed-event/delivery/host read/reply/cancellation observations |
| REQ-007 | This redacted record and the implementing PR separate source checks/review from transport, operator, deployment and host stages | Each approved live operation must retain its original operation/retry identities and unknown outcomes |

The new MCP regression injects an already authenticated identity at `handleMcp`
and independently rechecks actual GuestDO grants through the service/DO boundary.
It does not claim a new OAuth-provider exchange. Existing OAuth-entry regression
coverage remains in `events-subscriptions.test.ts`. External callback/relay
responses in the new test are controlled; production relay success is not an
independent transport acceptance oracle.

Independent review initially found a runtime/release inconsistency for retained
relay secrets. The correction requires absence in redacted candidate inventory
and every observed provider surface, including deployed configuration checks;
secret values are neither fetched by tests nor included in evidence.

Exact source SHA, measured check counts, independent re-review and CI/merge
receipts belong to the implementing PR. No live settings, credentials, endpoint,
deployment or real send was changed by this source work. Test and production
operator decisions, serving readback and real host outcomes remain pending.
Do not close #74 through a PR closing keyword on this bounded source change.
The owner's pre-launch direction adds no old-data restoration/retention goal;
current authorization, stop and unknown-result boundaries continue to apply.
