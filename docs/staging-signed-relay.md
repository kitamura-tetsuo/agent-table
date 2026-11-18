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

The private profile permits only `table.message.created`, an exact recipient
connection and reviewed table IDs, at most two hours and message sequence 12.
This first relay trial is intended to verify challenge and message delivery,
host wake, authenticated read and one reply; acceptance requires actual observed
host outcomes. It does not claim resume-event delivery;
resume APIs and native Work resume acceptance already have separate evidence.

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
