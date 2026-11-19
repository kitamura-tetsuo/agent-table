# Staging signed-relay verification

Use the existing `private-pilot-a-only` profile with an explicit
`EVENTS_RELAY_CONFIGURATION` to select the shared signed relay in staging.
Configuration environment must be `staging`, with a `test:<serviceId>` audience;
production uses `production:<serviceId>`. The global production profile is still
production-only. A selected malformed/unavailable relay never falls back to
native fetch. Native staging profiles retain their separate risk decision and
cannot contain the relay signing secret.

Use a separate staging key, caller, process, admission/recovery database and
public route; compare the public fingerprint against production before writing
any secret. Key separation is an operational requirement: a matching config/key
fingerprint alone does not prove that a production key was not reused.
The shared relay launcher already supports the `test` environment. Do not
change the existing production installation or copy its credentials/database.

Release preflight verifies staging configuration and secret inventory, then
release authorization binds the operational decision, relay configuration,
callback policy, key fingerprint and private scope. `nativeFetchRiskAccepted`
is false for signed relay. The existing staging protected workflow and provider
readback remain required. The compatibility output field
`productionAcceptance` remains pending even for staging: it never attests an
observed callback or host outcome, and its name does not change the environment.

The private profile defaults to `table.message.created`, an exact recipient
connection and reviewed table IDs, at most two hours and message sequence 12.
An optional `eventNames` array selects one or both of `table.message.created` and
`table.resume.requested`; omission keeps existing message-only approvals unchanged.
Resume opt-in requires the signed-relay configuration in `a-only` delivery mode,
not the native or callback-observation path. The exact policy hash remains bound
to the operator record. Events discovery advertises only that explicit scope;
registration, challenge authorization and durable dispatch recheck it. Resume
requests retain the existing dormant generation, recipient consent, expiry,
original outbox event and per-attempt operation identities.
The relay trial is intended to verify challenge and selected event delivery,
host wake, authenticated read and one reply; acceptance requires actual observed
host outcomes. A local signed resume producer/delivery/acceptance test is not evidence of live
Work host delivery. Native Work resume acceptance already has separate evidence;
the signed-relay live resume acceptance remains pending until observed.

Keep guest/table admission available as required for preparation. Do not add a
routine manual-restore deadline. Policy expiry stops new eligible delivery;
process stop and unresolved in-flight outcomes require their own readback.
Stop only this trial's watch/table, pause the dedicated relay for new sends and
retain original operation identities for uncertain outcomes. Existing work may
already be remote and cannot be declared cancelled by a local stop.

Staging relay acceptance can support applicability of the shared signed
challenge/message/status clients, ingress, pinned egress and durable store.
Production origin/audience/key, selected process/store, current host callback,
exact final config and real production host behavior remain separate evidence.

For the live resume trial, the fixture and Work owners coordinate one reusable
dormant table, one formal `table.resume.requested` subscription/challenge, one
UUID request, and one recipient acceptance after matching the actual event to
the pending request and generation. Read back both guests, disable the watch and
close that dedicated fixture. An unknown callback outcome is inspected under
its original operation identity; do not recreate the request or subscription to
make an uncertain send look successful. Staging may retain its approved test
configuration; relay pause and the protected notification-stop candidate remain
available. Production is unchanged until staging acceptance is complete; its
requested operational failure policy is the non-destructive all-five-false stop,
without credential, key, membership or data deletion. A restart stays paused and
requires exact generation/configuration and unknown-outcome reconciliation.
