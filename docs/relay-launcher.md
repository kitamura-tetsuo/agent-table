# Foreground local relay launcher (#74 / #78)

This portable Node 24 entry composes the existing application and local recovery
adapter. It installs no service, creates no credentials, changes no provider or
network settings, and supplies no public administration endpoint. Host selection,
TLS material, policies, concrete owner approval and #50 protected release remain
separate. It is not hosted transport or actual host acceptance.

## Ownership and startup

Run one foreground controller over a trusted private stdin/stdout channel:

```sh
node scripts/relay-launcher.mjs --config /approved/operator/relay.json \
  --expected-config-sha256 "$REVIEWED_CONFIG_SHA256"
```

The paths/hash are operator inputs, not selected production values. The artifact
and Node version must separately match the reviewed release manifest. The config
hash covers exact file bytes, not the truth of owner statements or artifact
provenance. No config, credential or operator input is echoed.

Required strict JSON keys:
- `version:1`, `startup:"paused"`, `environment:"test"|"production"`, `serviceId`;
- absolute `databasePath`, `tlsKeyPath`, `tlsCertPath`, and integer `port`;
- `callers:[{callerId,publicKeySpki,targets:[{origin,pathPrefix}]}]`, where
  publicKeySpki is canonical base64 Ed25519 SPKI DER (public verification key only);
- `admission:{perMinute,globalPerMinute,concurrency,leaseMs,maxReplayMs,maxRecords,
  busyTimeoutMs,operatorRecoveryPolicy:{planFreshnessMs,receiptRetentionMs,maxReceipts}}`.

All numerical policies must be explicit within the existing store bounds. No
live operating choices or default production settings are selected by this
launcher. TLS keys/certs must already exist as bounded regular nonsymlink files;
on Unix the key must be owned by the current process user with no group/other
permissions. Keep config, code, credentials and database directory protected
against untrusted replacement; pathname checks do not defeat a hostile directory
owner. Ordinary opening may migrate/write SQLite. Never point a test at a live DB.

The listener binds only 127.0.0.1. Port zero chooses an ephemeral local port;
a real published target needs its separately reviewed fixed port/HTTPS ingress.
The first metadata line contains a fresh generation UUID, configurationSha256,
actual port and state `paused`. The persisted config always says paused and is
never rewritten on enable. No remembered enabled state or automatic restart-time
enable is supported. Losing the previous controller or restarting always needs a
fresh exact-generation decision.

## Local commands

Each newline-delimited JSON command has exactly:
`{version:1,generation,configurationSha256,sequence,action,payload}`.
Use the current startup generation/hash and a strictly increasing positive safe
integer sequence. Actions with null payload: `status`, `enable`, `pause`,
`plan-recovery`, `stop`. `apply-recovery` takes the unchanged existing
`{operationId,plan,ownerRecord}`; `read-recovery` takes the original operation ID.
Recovery planning/application requires paused intake and no in-flight local
handler. A running generation cannot attest that it itself has stopped.

Read the response's state, ok and result; `ok:false` is refusal, not approval.
An enable with a stale generation/hash/sequence, duplicate enable, malformed
command or failed authority check pauses intake. A lost response never authorizes
blind repetition: query status first, or read the original durable recovery
operation ID. An identical recovery can be retried with a new control sequence
and the SAME recovery operation/request after the required readback. Unknown
readback is not success, no-send or permission to replace its ID.

Control input/output are bounded to 64 KiB; oversized input or unavailable/blocked
output drains the process. Keep the output consumer alive; this is an operator
protocol, not a general log stream. EOF/truncated input, SIGINT and SIGTERM stop
intake immediately and await the existing bounded listener/transport drain.
Only successful application close emits `stopped,settled:true`; an ambiguous
close emits `unknown,settled:false`. Missing output is unknown to the operator.
SIGKILL emits no stop proof. Original admission/attempt evidence is not reset.

The launcher itself has no detached service/FIFO/socket management scheme. The
reviewed [Docker controller integration](relay-container-controller.md) retains
its input/output and provides a private, owner-only Unix control socket without
automatic enable. A supervisor must retain exclusive ownership of the channel;
stdin=/dev/null immediately drains. Detached systemd activation and unattended
re-enable are not provided. If those are needed, review that specific deployment
integration instead of opening an administrative TCP port.

## Recovery and rollback

Follow [the existing exact-plan recovery procedure](relay-operator-recovery.md).
The launcher checks its own process context, not whether every other old
producer/transport is stopped. The concrete owner's retained evidence must cover
ALL producers sharing the store, exact old generations and configuration.
Neither expiry, a PID, this launcher output nor a JSON passed flag proves remote
cessation. machineVerifiedTransportStop remains false. Missing stop evidence,
stale full-set plans, known receipts and foreign stores/configs retain existing
refusal behavior. No automatic unknown-lease clearing occurs.

Pause the Worker producer and local launcher, drain/verify all old transports,
retain the same SQLite/journal, operation IDs and key identity, then use only a
reviewed schema-compatible artifact. A rollback also starts paused. Never delete
the ledger, restore an old snapshot, rename the namespace or generate new request
IDs to regain availability. Historical snapshot authority is a separate decision.

## Isolated validation and live gate

The subprocess tests use temporary SQLite and ephemeral loopback TLS certificates,
the published RFC8032 test signing key and synthetic destinations. A test-only
Node preload delays/fails DNS before any callback dial; it is not a production
transport override. Independent SQL observes actual signed admission, drain,
crash, paused restart, immutable unknown recovery/receipt and duplicate refusal.
The existing real-MCP producer recovery harness separately checks original event,
attempt identity, eight attempts/no ninth and the original one-hour deadline.

These checks do not prove public DNS/TLS/peer behavior, real host shutdown,
filesystem power-loss durability, owner approval or actual hosted read/reply.
Before live setup, freeze the launcher artifact/build/config hashes and selected
host/TLS/identity/storage/retention/limits/rollback; obtain target-bound approval.
After separately approved deployment, collect active Worker/relay/provider
readback and authenticated committed event → delivery → actual host read/reply.
