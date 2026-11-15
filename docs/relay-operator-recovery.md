# Candidate local operator recovery (#78)

Local JavaScript/store adapter only: no network management API, process
controller, deployment authority or new service. No live database or credentials.

## Authority and procedure

Keep ALL producers sharing this one-host database paused. A concrete owner must
independently identify every old process/transport generation and verify that
every transport represented by the plan completed or stopped. Deadline expiry,
missing heartbeat, HTTP timeout, changed PID or JSON flags do not prove stopping.
The adapter validates the exact owner's statement and stores its commitment,
not its real-world truth. machineVerifiedTransportStop is explicitly false.

Open the store with its exact environment/service/configuration. Opening CAN
migrate and write: it is not a read-only operation. Once open,
planUncertainRecovery performs a read-only transaction returning exact store UUID,
configuration digest, full active lease set including original hashes/digests/
timestamps, and plan creation/expiry. No arbitrary subset selection.
Nonexpired active leases cannot be released.

Provide operationId = opr_<plan.createdAt>_<32 lowercase hex> and ownerRecord
with exact planSha256, concrete ownerId/processGeneration, evidenceSha256,
observedAt, admissionsPaused:true, transportState:stopped|completed.
The retained evidence must cover ALL old transports and leases. No raw owner
record, evidence URL, message, callback, key or body is persisted. Hashes are
pseudonymous commitments, not anonymization.

applyUncertainRecovery rechecks the full active set and configuration inside
BEGIN IMMEDIATE. Changed set, foreign store/configuration, stale plan, absent
stop evidence and nonexpired leases refuse admission changes. Unknown-only
finish and immutable operation receipt commit together. Original IDs, digests,
rate/replay timestamps remain; known completions cannot be overwritten.
No forwarding or runtime enablement is performed.

After result loss, readUncertainRecovery using the ORIGINAL operation ID first.
Committed means the atomic receipt exists; missing/unavailable means UNKNOWN,
not success or proof of nonexecution. Retry only the identical request/ID after
readback. Do not invent a replacement operation to bypass uncertainty.
An identical committed request is idempotent after plan expiry; conflicts refuse.

## Explicit candidate policy, not production settings

Mutation requires operatorRecoveryPolicy:
planFreshnessMs 1000..300000; receiptRetentionMs 86400000..2592000000;
maxReceipts 1..1000. These are defensive candidate bounds, NOT selected production
settings. Tests use 5 minutes / 7 days / 1000. The concrete owner must approve
actual host retention/freshness/capacity. First committed recovery binds the
exact policy; later changes refuse pending a separately reviewed migration.

Receipt cleanup occurs only inside an authorized recovery transaction after
retention. Capacity exhaustion never evicts unexpired receipts. A pruned receipt
is unknown; the creation timestamp embedded in operation ID prevents rebinding
that ID to a fresh plan. Operator evidence retention remains independently
required. Old database snapshot restoration is a separate replay reconciliation
problem, not resolved here.

## Schema and evidence

Schema5 adds store UUID and immutable recovery receipts in existing SQLite.
Historical1..4 migrations preserve admission rows and original IDs. No network
API, distributed store or external control plane. Existing transport-owned finish
remains; operator recovery couples updates and receipt in one transaction.

Synthetic temporary-DB tests cover independent SQL state, lost response/reopen,
known204/410 preservation, full-set/stop-evidence refusals, atomic rollback,
two-connection idempotency, schema migration, policy binding, bounded retention
and capacity. They are not live host shutdown, process-to-lease mapping,
filesystem durability certification or actual owner approval. Keep runtime
paused until those independently established facts and production gates hold.

## Integrated local recovery regression

`relay-operator-flow.test.mjs` uses a real localhost TLS listener, signed message
and status envelopes, the actual SQLite admission store, actual application
restart/enable gating, and the Worker's unchanged SQL outbox/attempt-ledger
functions. A SQLite trigger injects failure at durable message completion.
Previously the listener returned HTTP200/completed despite that failed commit;
message intake now requires one successful atomic finish before acknowledging a
completed receipt. An ambiguous finish is not implicitly repeated in `finally`.

The test closes the old listener after its controlled sender settled, verifies
restart remains blocked, applies a synthetic owner-approved full-set plan, loses
and reads back the operator result, and then resumes the actual application.
Authenticated original-ID readback stays unknown and replay of that ID stays409.
The Worker's original budget permits a distinct second ordinal; its signed intake
reaches a controlled localhost TLS callback, receives204 and records acceptance.
Original admission/attempt IDs, digests, replay clocks and first-attempt budget
are checked independently in SQLite. No payload is retained by operator recovery.

This combines actual production modules but is not a hosted Workerd-to-public
relay deployment. The callback transport boundary is deliberately controlled to
localhost, not evidence of production public DNS/pinned-peer behavior or real
owner/process-generation mapping. Existing Workerd routing/lifecycle tests remain
separate. No live policy, credential, target or deployment is changed.
