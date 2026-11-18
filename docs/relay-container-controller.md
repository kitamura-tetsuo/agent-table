# Staging Docker controller and ingress

This is a deployment integration for the existing foreground launcher, not a new
relay protocol, signing authority or public administration API. The controller
runs as PID1, retains the launcher input/output in process and exposes only a
0600 Unix socket inside an owner-only0700 runtime directory. It does not create
keys, automatically enable, resequence/retry commands or reconcile unknown rows.
Every launcher restart starts paused with a fresh generation. Application/store
and signed ingress/egress semantics remain in the existing launcher.

## Assets and ownership

Use `deploy/relay/Dockerfile`, `compose.yml` and
`cloudflared.example.yml` at the exact reviewed commit. The example ingress is
intentionally unusable until its hostname and dedicated tunnel are selected.
The host owner controls Docker images, host directories, TLS, persistent store,
Tunnel/DNS and the exclusive controller session. The application owner manages
the separate staging Worker signing private key and protected release. Only the
public SPKI and fingerprint are needed by the relay. No production key, store,
TLS material, callback secret or existing tunnel is copied.

Build using an approved Node24.22.1 image by digest and inspect the built image
revision/digest. `NODE_IMAGE`, `RELAY_IMAGE` and `CLOUDFLARED_IMAGE` have no floating
default. Environment variable names alone do not verify image provenance: the
host owner must inspect/pin actual digest values before execution. The controller
CLI additionally refuses any Node version other than24.22.1. The root .dockerignore allowlists public source and excludes private configuration,
credentials, state, .git and node_modules from the build context. Keep live
materials outside the source checkout. The runtime source
closure uses Node built-ins and the checked-in erasable TypeScript; it does not
install dependencies or download code on container startup.

Mount only a staging configuration/TLS directory read-only at `/config`, and a
staging-only persistent local SQLite directory at `/state`. Set absolute paths
in relay.json, for example `/config/origin.key`, `/config/origin.crt` and
`/state/admission.sqlite`. Files/directories must be accessible to UID/GID10001;
the TLS key must be owned by that UID and mode0600. Keep host config/ingress
folders0700 with minimal individual file access. Never mount the Docker socket,
a production directory or a general secret store. The runtime control directory
is a private tmpfs, recreated on a new container. A stale socket during a process
restart is refused, never silently deleted or taken over; confirm old processes
and original unknown operations before host cleanup.

The relay listener remains127.0.0.1. Compose publishes NO host/LAN ports and uses
NO host network. The dedicated cloudflared container shares `service:relay`
network namespace, so it reaches the relay's loopback listener. It mounts only
its own dedicated tunnel credentials/config and origin CA. TLS uses the reviewed
origin hostname and explicit CA; no `noTLSVerify` exception. Public ingress
permits the exact challenge/message/status POST paths and ends in404. It adds no
WAF/BIC bypass. Docker's dedicated bridge/egress and the new public tunnel/DNS
are real setup changes requiring their actual applicable approval before use.
Fixed staging container names prevent ordinary Compose scale/second-project
copies; they do not prove that every outside Docker/host producer is stopped.

## Operation

Inspect (also used by Docker healthcheck):

```sh
docker compose -f deploy/relay/compose.yml exec -T relay \
  node scripts/relay-control.mjs --socket /run/agent-table-relay/control.sock --inspect
```

Inspection returns the latest controller-observed generation/hash/state/sequence;
it is not callback acceptance, independent producer inventory or a new launcher
status command. Paused is healthy. There is no public HTTP health endpoint.
For an actual status/enable/pause/recovery/stop, supply a complete existing
launcher command over stdin, with exact generation/config hash and a strictly
increasing sequence. The controller supplies none of these operator decisions:

```sh
docker compose -f deploy/relay/compose.yml exec -T relay \
  node scripts/relay-control.mjs --socket /run/agent-table-relay/control.sock --stdin \
  < /private/approved-command.json
```

The input must contain exactly the existing launcher envelope
`{version,generation,configurationSha256,sequence,action,payload}`. For enable,
status, pause, plan-recovery and stop, payload is null. Recovery payloads retain
the original operation/plan/owner record. A busy controller refuses rather than
queuing mutations. A missing/late reply is unknown: inspect/status or read the
original durable recovery ID before deciding any retry. No automatic enable,
recovery, new operation identity or sequence retry occurs. Socket clients are
bounded in size/time/count. Detectable loss of a pending operator response or
controller output stops intake and drains the launcher. A successful socket
write cannot prove that the human read the reply.

## Stop, restart and evidence

Use exact-generation pause, then stop; read `stopped,settled:true` from the
private response or controller termination metadata. SIGTERM/INT end launcher
input and await its existing bounded drain. Docker stop grace is30seconds;
a forced kill or missing receipt is unknown, never a successful transport stop.
Compose restart is deliberately `no`: no crash/stop silently restarts a process.
An explicit container restart starts paused and needs fresh operator enable.
No previous enable state is stored. Stop the dedicated ingress and relay
containers with the host owner when ending the deployment; an ingress left
running against a stopped listener can produce502 and is not host teardown.
Confirm container/process/listener absence and preserve the original SQLite,
unknown admission identities and recovery journal. Do not remove persistent
state as a restart shortcut. The controller cannot prove remote callback work
has ceased or that every old producer sharing a store is stopped.

Local tests use temporary synthetic keys/TLS/SQLite and an actual launcher/Unix
socket. They cover paused startup, explicit commands, duplicate/old-generation
refusal, graceful shutdown/restart, retained unresolved rows and private path
refusal. They are not Docker namespace, public TLS/tunnel or real-host acceptance.
The host owner must perform the actual Docker/ingress readback at the reviewed
image/config before the application owner enables the bounded Work trial.
