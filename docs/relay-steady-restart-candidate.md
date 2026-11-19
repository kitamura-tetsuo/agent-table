# Opt-in steady restart candidate (#78)

Not a deployment instruction or approval. Normal Compose retains restart:no
and paused startup. The optional overlay enables durable controller inhibit.
A local deployment supervisor may invoke the local adapter after an independently
authorized paired startup; the container never receives the Docker socket.

The controller persists pause/quarantine before forwarding private pause/stop.
It rechecks inhibit immediately before forwarding enable. It does not clear an
inhibit. Direct launcher stdin bypasses this protection and is unsupported in
opt-in mode. Only the host owner tools need Linux /usr/bin/flock (util-linux);
the container controller uses filesystem primitives only. The owner directory
must exist on the dedicated store mount, be owner-only, and be local.

The host can fail closed without removing any admission row. #21 is unchanged.

## Host runner and isolated verification

An explicitly enrolled Linux host may invoke
`node scripts/relay-steady-host-supervisor.mjs --enrollment <owner-only JSON>`.
It uses only the pinned pair. A fully live exact pair is observed without
mutation. A one-sided crash permits a single stop of the surviving enrolled
incarnation only after proving the failed incarnation retired. Both must be
stopped and retired and the ledger validated again before the same IDs start
relay first and ingress second. Unexpected replacement, ambiguity, failed
retirement or outstanding work requires owner attention. Docker stop by ID
is not a kernel process compare-and-swap; initial enrollment must confer
exclusive pair lifecycle ownership, with no independent Docker auto-restart,
Compose reconcilers, or host processes changing these IDs concurrently.

The `--watch --enrollment <owner-only JSON>` mode observes the pair every two
seconds and invokes that bounded owner path. The opt-in systemd unit example
`deploy/relay/agent-table-steady-owner.service.example` is not installed. Its
paths, local authority, UID and initial enrolled inventory require owner
approval; the example must use the existing production host definition and
must not create another pair. The watcher exits on ambiguous state instead of
retrying enable. It does not clear pause, quarantine or uncertain enable,
install itself, change restart policy, or recreate containers.

Enrollment binds version 1, steady production mode, exact relay/ingress names
and Docker image IDs, config SHA-256, environment/service/store identities,
exact host config/state/ingress bind sources, owner directory, database path,
programmatically observed prior relay/ingress incarnations, and a fixed HTTPS
route origin and status URL. The owner directory must be accessible to both
processes under the same mapped numeric owner; there is no permission widening.
The host entrypoint requires local Docker and util-linux flock only on the host.
The control socket stays inside its container and is accessed through exact-ID
Docker exec. The fixed TLS route is tested with normal trust and redirect
refusal; the 404 sentinel alone is not evidence of callback egress or host
execution.

After paired startup the supervisor checks Linux boot ID, process PID/start,
Docker cgroup and kernel network namespace. Duplicate or ambiguous source
identity fails closed; a retained old PID on the same boot is disqualifying
unless its independently read start time proves PID reuse. Any incarnation
records are machine-observed and atomically persisted before enable. Pending
output delivery still blocks rather than being released or replayed.

`node --test scripts/relay-steady-restart.test.mjs` runs offline identity,
persistent state, claim, and SQLite checks. The real Docker oracle runs via the provisioner below. It tests automatic
retirement of a verified surviving ingress after an isolated relay crash,
same-ID startup and persistent pause. It does not use production names,
URLs or data. An approved production enrollment and service installation
remain separate acceptance requirements.

### Clean-checkout Docker fixture

Use a dedicated Linux runner with the local, rootful Docker daemon, Node 24,
OpenSSL, util-linux flock, and host permissions to read the fixture PIDs'
cgroups and network namespaces. The runner must have direct access to its
internal Docker bridge. Docker is not installed or started by these commands.

Supply an already downloaded and independently pinned Node **24.22.1** base
image. Build the checkout's relay image without pulling or network access:

```sh
docker image inspect "${PINNED_NODE_IMAGE:?pinned local image required}" >/dev/null
docker build --network=none --pull=false \
  --build-arg "NODE_IMAGE=$PINNED_NODE_IMAGE" \
  -f deploy/relay/Dockerfile -t agent-table-restart78-ci .
IMAGE_ID="$(docker image inspect --format '{{.Id}}' agent-table-restart78-ci)"
node scripts/relay-steady-docker-fixture.mjs "$IMAGE_ID"
```

The fixture provisions an internal bridge, a synthetic CA/leaf, a fresh SQLite
store, an exact opt-in relay plus a synthetic raw TCP ingress in its namespace,
and an owner-only enrollment. It captures original kernel-backed process
identities, crashes only the labeled synthetic relay and leaves its old
ingress running, then runs the watcher/restart oracle through a trusted
local TLS passthrough, exercises durable pause, and removes only the resources
it created and can verify by immutable ID and fixture label. There are no
public endpoints, registry operations, or real recipients. A fixture
precondition, recovery failure, or incomplete cleanup returns nonzero.

The controller checks the fixed relay entrypoint/CMD/working directory and
read-only rootfs with no runtime-replacement mounts before startup. It checks
the separately approved ingress program against the inspected process definition.
Config bytes, service identity and the state mount mapping are checked before
start, in addition to the new controller's exact readback after start.

The bridge fixture is an actual Docker/controller/HTTPS startup oracle, not
a production callback-delivery oracle. Separately, the controller integration
test sends a real Ed25519-signed fresh request after restart through the signed
listener and persistent store to a controlled local HTTPS receiver, proving one
204 receipt and no delivery of a paused event. The test uses a trusted
module-only sender seam; the Docker CLI cannot opt into it. Neither fixture
validates production DNS, pinned external dialing, an actual live production
recipient, or a Worker transaction. No destination restrictions are weakened.

### Owner crash and fixture cleanup evidence

The durable successor inventory is bound to the fresh controller generation
and config digest. A returning owner only continues an exact paused sequence-0
controller if no pending or spent attempt exists. It revalidates the running
pair, TLS sentinel and store before claiming one enable. A pending enable is
never resent: only exact enabled sequence-1 readback with the matching
persistent attempt record resolves it. Otherwise the watcher stops. The Docker
oracle includes two separate owner-process exits at these checkpoints.

The Validation fixture checkpoints a token and three immutable Docker IDs in
an owner-only journal under the runner's job/attempt-specific temporary path.
Each create is recorded as pending before it is issued. An interrupted create
without a known ID remains explicitly unknown; cleanup never guesses an ID or
prunes. A local cleanup attempt and an independent `always()` cleanup step
each allow at most one inspect/remove/readback cycle for each known ID. Scope
label, fixture-token label, role, name and immutable ID must all match before
removal. The per-command limit is three seconds and each cleanup attempt has
a 32-second overall Docker budget. The independent step preserves the primary
GitHub step result and separately fails on incomplete or missing evidence.
A force-canceled or lost runner can interrupt both attempts; ephemeral runner
isolation is the last boundary, not a guarantee of cleanup completion. The
locally built test image is confined to the ephemeral job runner.
