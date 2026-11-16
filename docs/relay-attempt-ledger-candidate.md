# Immutable relay-attempt ledger integration

The earlier isolated candidate has been integrated into the disabled TableDO relay
path. See [relay-table-integration.md](relay-table-integration.md) for current state,
retry/receipt semantics, schema-13 recovery and evidence limits.

The active migration is `schema/013_relay_attempt_ledger.ts`, registered by
`schema/migrations.ts`. The older `schema/candidates/013_relay_attempt_ledger.ts`
is an unregistered historical prototype, not a second migration to apply.

Important correction to the earlier candidate: #21 explicitly requires bounded
at-least-once recovery. Unknown original operations are retained unchanged, but
they do not permanently block every future ordinal. After the recovery deadline,
a fresh authorized attempt can retry the stable event ID within the original
maximum-eight/one-hour budget. This may repeat receiver delivery and does not
claim exactly-once host execution. Same-operation identity/timestamp/expiry are
never renewed, and known local receipts remain authoritative during readback loss.

Acceptance expiry must equal issuedAt + 60,000 ms, matching the currently signed
wire. A shorter remote deadline requires a separate signed-wire change; no such
shortening is implicitly authenticated by this ledger.

All live profile selection, credentials, configuration, transport acceptance and
deployment remain unperformed. The private runtime relay adapter still returns
null; positive tests inject synthetic transport in Workerd rather than enabling
production or establishing actual hosted receiver acceptance.
