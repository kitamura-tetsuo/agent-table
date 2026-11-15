# Provisioning and purpose-specific secrets

This is an operator procedure for Issue #22 / REQ-007. It does not authorize a
provider mutation. Each live operation requires its exact target, configuration,
source, retained-state implications and owner approval to be recorded first.
Use the repository's pinned Node/npm and Wrangler after `npm ci`.
[Cloudflare documents](https://developers.cloudflare.com/workers/configuration/secrets/)
that **`wrangler secret put` creates a version and deploys it immediately**.
A dry-run afterward cannot undo that deployment. Secret values must never enter
Git, shell history, command arguments, ordinary files, logs or public receipts.

## Shared operator preparation

Use a clean, reviewed checkout and a trusted interactive Bash terminal. The
Cloudflare write token is already supplied through the approved secret channel;
do not paste it into these commands. A separate read token is required for the
provider checks. The approved tooling commit can differ from an existing
Worker's deployed build; a secret-only update must preserve that deployed build.

```bash
set -euo pipefail
set +x
umask 077
cd "$(git rev-parse --show-toplevel)"
read -r -p 'Approved checkout commit: ' AGENT_TABLE_CHECKOUT_SHA
read -r -p 'Target environment (staging/production): ' AGENT_TABLE_ENVIRONMENT
read -r -p 'Approved Cloudflare account ID: ' AGENT_TABLE_ACCOUNT_ID
[[ "$AGENT_TABLE_CHECKOUT_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$AGENT_TABLE_ENVIRONMENT" =~ ^(staging|production)$ ]]
[[ "$AGENT_TABLE_ACCOUNT_ID" =~ ^[a-f0-9]{32}$ ]]
test "$(git rev-parse HEAD)" = "$AGENT_TABLE_CHECKOUT_SHA"
git diff --quiet
git diff --cached --quiet
test "$(node -p 'process.versions.node')" = "$(cat .node-version)"
npm ci
AGENT_TABLE_WORKER="agent-table-$AGENT_TABLE_ENVIRONMENT"
AGENT_TABLE_CONFIG="$PWD/.operator-$AGENT_TABLE_ENVIRONMENT-reviewed.json"
AGENT_TABLE_IDENTITY_CONFIG="$PWD/.operator-$AGENT_TABLE_ENVIRONMENT-identity.json"
readonly AGENT_TABLE_CHECKOUT_SHA AGENT_TABLE_ENVIRONMENT AGENT_TABLE_ACCOUNT_ID
readonly AGENT_TABLE_WORKER AGENT_TABLE_CONFIG AGENT_TABLE_IDENTITY_CONFIG
printf '/.operator-%s-*.json\n' "$AGENT_TABLE_ENVIRONMENT" |
  tee -a "$(git rev-parse --git-path info/exclude)" >/dev/null
export CLOUDFLARE_ACCOUNT_ID="$AGENT_TABLE_ACCOUNT_ID"
: "${CLOUDFLARE_API_TOKEN:?Supply the approved write token securely}"
: "${CLOUDFLARE_READ_TOKEN:?Supply the approved read token securely}"
```

The final strict JSON must contain only reviewed configuration and resource
metadata, including the real `account_id`, Worker name and environment marker.
Keep `main: "src/index.ts"`; stage the file in the checkout root so Wrangler
resolves the approved source correctly. The peer configuration may remain in
protected external storage. No nested `env`, custom build hook, `unsafe` binding,
foreign DO delegation or command-line environment override is supported.
Stage the approved private file without changing its bytes:

```bash
stage_reviewed_config() {
  read -r -p 'Absolute path to approved private JSON: ' AGENT_TABLE_PRIVATE_CONFIG
  [[ "$AGENT_TABLE_PRIVATE_CONFIG" = /* ]]
  test ! -e "$AGENT_TABLE_CONFIG"
  tee "$AGENT_TABLE_CONFIG" < "$AGENT_TABLE_PRIVATE_CONFIG" >/dev/null
  chmod 600 "$AGENT_TABLE_CONFIG"
  cmp -- "$AGENT_TABLE_PRIVATE_CONFIG" "$AGENT_TABLE_CONFIG"
  node --input-type=module - "$AGENT_TABLE_CONFIG" "$AGENT_TABLE_ACCOUNT_ID" \
    "$AGENT_TABLE_WORKER" "$AGENT_TABLE_ENVIRONMENT" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
try {
  const [path, account, worker, environment] = process.argv.slice(2);
  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(config.account_id, account);
  assert.equal(config.name, worker);
  assert.equal(config.vars.RELEASE_ENVIRONMENT, environment);
  assert.equal(config.main, "src/index.ts");
  assert.equal(config.env, undefined);
  assert.equal(config.build, undefined);
  assert.equal(config.unsafe, undefined);
} catch {
  process.stderr.write("OPERATOR_CONFIG_IDENTITY_BLOCKED\n");
  process.exitCode = 1;
}
NODE
  AGENT_TABLE_CONFIG_SHA256="$(sha256sum "$AGENT_TABLE_CONFIG" | cut -d ' ' -f 1)"
  readonly AGENT_TABLE_CONFIG_SHA256
  printf 'Reviewed config SHA-256: %s\n' "$AGENT_TABLE_CONFIG_SHA256"
}
require_reviewed_config() {
  test "${CLOUDFLARE_ACCOUNT_ID:-}" = "$AGENT_TABLE_ACCOUNT_ID"
  test "$(git rev-parse HEAD)" = "$AGENT_TABLE_CHECKOUT_SHA"
  git diff --quiet
  git diff --cached --quiet
  printf '%s  %s\n' "$AGENT_TABLE_CONFIG_SHA256" "$AGENT_TABLE_CONFIG" |
    sha256sum --check --status
}
```

This identity check is not the full release gate or an approval. Do not overwrite
an existing staged file; reconcile its owner, bytes and previous operation first.

## New quarantined environment

This branch is only for an explicitly approved **new** Worker and new KV/DO
resources. Existing staging/production resources must not be recreated, adopted,
renamed, emptied or rebound. The ordinary release workflow deliberately rejects
unknown Workers; bootstrap is a separately reviewed direct operator deployment.

1. Record authenticated account ownership and successful metadata reads. Confirm
   target Worker settings explicitly report absence, and completely paginate the
   DO/KV inventories to establish no namespaces owned by the target Worker and
   no matching proposed KV title. A 401/403, timeout, incomplete list or ambiguous
   response is a blocker, never evidence of absence. Confirm peer resource IDs.
2. Approve the exact new account/Worker/KV-title allocation. Recheck absence just
   before creation. Create an identity-only private config for this allocation:

```bash
test ! -e "$AGENT_TABLE_IDENTITY_CONFIG"
node - "$AGENT_TABLE_ACCOUNT_ID" "$AGENT_TABLE_WORKER" <<'NODE' | tee "$AGENT_TABLE_IDENTITY_CONFIG" >/dev/null
const [account_id, name] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ account_id, name }, null, 2)}\n`);
NODE
npx --no-install wrangler kv namespace create "$AGENT_TABLE_WORKER-OAUTH_KV" \
  --config "$AGENT_TABLE_IDENTITY_CONFIG" --binding OAUTH_KV --update-config false
```

3. Capture the actual new KV ID and authenticated ownership readback. If the
   creation response is lost, stop and inspect; do not retry creation or adopt a
   similarly named namespace. Prepare the complete private JSON using this ID,
   the immutable SQLite migrations and four local class bindings. Set the
   selected HTTPS `PUBLIC_ORIGIN`, `RELEASE_PROFILE: "manual"`, the approved
   application build SHA, `RESTORE_QUARANTINE: "true"`, all five intake/capability
   switches to `"false"`, `workers_dev: false` and `preview_urls: false`.
   Omit both `route` and `routes` entirely: even `routes: []` is rejected by the
   preflight. Include no custom domain or scheduled trigger.
4. Stage those final bytes and validate the quarantined shape against the peer:

```bash
stage_reviewed_config
read -r -p 'Absolute path to reviewed peer JSON: ' AGENT_TABLE_PEER_CONFIG
node --input-type=module - "$AGENT_TABLE_CONFIG" "$AGENT_TABLE_PEER_CONFIG" \
  "$AGENT_TABLE_CHECKOUT_SHA" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareQuarantinedRestoreConfig } from "./scripts/release-preflight.mjs";
try {
  const [path, peerPath, sha] = process.argv.slice(2);
  const text = readFileSync(path, "utf8");
  const config = JSON.parse(text);
  const derived = JSON.parse(prepareQuarantinedRestoreConfig(text, readFileSync(peerPath, "utf8")));
  assert.deepEqual(config, derived);
  assert.equal(config.vars.RELEASE_BUILD_SHA, sha);
  assert.equal(config.vars.RELEASE_PROFILE, "manual");
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.triggers, undefined);
} catch {
  process.stderr.write("BOOTSTRAP_CONFIG_BLOCKED\n");
  process.exitCode = 1;
}
NODE
AGENT_TABLE_BUILD_OUTPUT="$(mktemp -d)"
npx --no-install wrangler deploy --dry-run --config "$AGENT_TABLE_CONFIG" \
  --outdir "$AGENT_TABLE_BUILD_OUTPUT"
sha256sum "$AGENT_TABLE_CONFIG"
```

The generator checks configuration isolation; it does not verify live ownership
or supply recovery authority. Review the exact resulting SHA-256, source and
absence receipts. Only after the separate bootstrap deployment approval and an
immediately fresh absence check may the operator run:

```bash
require_reviewed_config
npx --no-install wrangler deploy --config "$AGENT_TABLE_CONFIG"
```

5. Capture the **actual** metadata checks below before injecting secrets. Require
   the new active version, class-owned SQLite namespaces and KV ID to match the
   reviewed allocation, and all exposure surfaces to remain disabled. Secrets
   may initially be absent; the ordinary release/pause verifier is unsuitable.
6. Approve each required purpose-specific secret independently, then use the
   secret-write command below against this already verified Worker. Compare live
   settings, version and namespace identity after **each** change. Record only
   secret names, nonsecret key IDs, operation time and version/config references.
7. Record actual private-binding quarantine probes, including private ingress
   refusal with HTTP 503/no-store, through an already reviewed probe. Metadata
   alone is not a runtime denial receipt. An unavailable probe remains pending;
   do not add a public route or mark it passed to finish provisioning.

**Bootstrap ends quarantined.** Do not set `RESTORE_QUARANTINE=false` manually.
Ordinary release authorization refuses a quarantined target or peer. Use the
separately approved [recovery/clearance procedure](fresh-start-recovery.md) for
its exact resources and independent authority; otherwise retain quarantine.
Provisioning, functional validation, clearance and public release are separate
receipts. The historical [production bootstrap](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6793656610)
is evidence for its recorded operation, not approval to repeat it.

### Required provider readback

Use authenticated Cloudflare metadata GETs and inspect the results privately.
The following paths are relative to `/client/v4/accounts/{account_id}`. Save
only compared nonsecret fields and outcomes; never dump raw bindings or tokens.

| GET | Required observation |
| --- | --- |
| `/workers/scripts/{worker}/settings` | Unique binding names; exact reviewed text vars and DO/KV bindings. |
| `/workers/scripts/{worker}/deployments`, then `/versions/{version_id}` under the same Worker path | One 100%-traffic active version; expected migration tag, class exports, namespace IDs and text vars matching service settings. Record the actual new version. |
| `/workers/scripts/{worker}/subdomain` | Both `enabled` and `previews_enabled` false. |
| `/workers/domains` (all pages) | No custom domain for a new quarantined bootstrap; exactly the reviewed domain for an existing normal release. |
| `/workers/services/{worker}`, then `/workers/services/{worker}/environments/production/routes?show_zonename=true` | Verify the service default environment and actual route list; bootstrap requires no routes. Here `production` is Cloudflare's service environment, also for an application Worker named `*-staging`. |
| `/workers/durable_objects/namespaces` (all pages) | Four distinct SQLite namespaces owned by this Worker and its expected classes, disjoint from the peer. |
| `/storage/kv/namespaces/{id}` | Exact reviewed OAuth namespace; distinct from the peer. Use the complete namespace list for initial absence checks. |
| `/workers/scripts/{worker}/secrets` | Names/types only; required secret names after injection. Presence does not prove valid key material. |

For subsequent writes, compare the original namespace IDs, application build,
text vars and source/version lineage; only the approved secret and resulting
version may change. Any unexplained drift stops the operation. Do not repair a
mismatch by silently deploying another config or wiping/replacing resources.

## Existing paused Worker secret change

This path requires an existing `manual` Worker with normal intake/outbound pause,
`RESTORE_QUARANTINE=false`, both keyring names, a verified HTTPS domain and a valid
peer. Record the active version/build and exact config bytes before approval.
For a missing-secret or domainless quarantined Worker use the manual metadata
checks above; do not forge a successful normal-pause result.

```bash
stage_reviewed_config
read -r -p 'Absolute path to reviewed peer JSON: ' AGENT_TABLE_PEER_CONFIG
read -r -p 'Independently observed active version ID: ' AGENT_TABLE_BEFORE_VERSION
node scripts/release-pause-readback.mjs --config "$AGENT_TABLE_CONFIG" \
  --peer-config "$AGENT_TABLE_PEER_CONFIG" --expected-version-id "$AGENT_TABLE_BEFORE_VERSION"
```

Obtain the exact secret-change approval after this baseline. Recheck the same
version immediately before writing; concurrent deployment or unknown version
state requires a fresh review. Preserve all recovery bindings and generation
journal continuity. This command does not replace protected release/clearance
workflows, and it never applies a safe config's text vars to an unsafe active
Worker. The deployed configuration must already match the approved baseline.

### Secret write command

Run **one approved secret** at a time in an interactive terminal. Validate the
keyring shape using trusted tooling without outputting its values. Enter the
value only into Wrangler's hidden prompt; use the approved key-handling policy.

```bash
test -t 0
require_reviewed_config
read -r -p 'Approved secret name: ' AGENT_TABLE_SECRET_NAME
case "$AGENT_TABLE_SECRET_NAME" in
  INVITATION_RESPONSE_KEYRING|CALLBACK_CREDENTIAL_KEYRING) ;;
  *) exit 1 ;;
esac
npx --no-install wrangler secret put "$AGENT_TABLE_SECRET_NAME" \
  --config "$AGENT_TABLE_CONFIG" --name "$AGENT_TABLE_WORKER"
```

Stop and decline any prompt to create a missing Worker. Wrangler's noninteractive
fallback can create a draft Worker; unreviewed piping/CI injection is not this
procedure. If the latest version is not deployed, stop: do not deploy it or
switch to `versions secret put` merely to bypass the refusal. Version-only
secret updates target the latest uploaded version and need a separately reviewed
deployment path; pending DO migrations and traffic splits require further review.

After the command, perform the provider comparison above and capture the new
active version. For the existing normal-paused path, also run:

```bash
read -r -p 'Independently observed new active version ID: ' AGENT_TABLE_AFTER_VERSION
node scripts/release-pause-readback.mjs --config "$AGENT_TABLE_CONFIG" \
  --peer-config "$AGENT_TABLE_PEER_CONFIG" --expected-version-id "$AGENT_TABLE_AFTER_VERSION"
```

Require the expected new version and unchanged namespace IDs, application build,
source lineage, safety vars and peer. Name-only checks cannot validate ciphertext
readability. Perform the approved staging old-read/new-write checks before a
separate production rotation decision. A secret-change failure does not authorize
an automatic rollback: an older version/key may no longer read new ciphertext.

## Bounded key rotation

Generate independent random 32-byte AES keys per purpose/environment in a trusted
operator process; encode unpadded base64url and choose unique nonsecret key IDs.
Only use an already approved protected retention or no-backup policy. The runtime
accepts at most **two previous keys** and at most **seven days** per overlap.

When the former key is actually available through an authorized protected source:

1. Build the replacement keyring with a new `current` key and the former key in
   `previous`, with exact UTC `.sssZ` `retiredAt` and `acceptUntil` timestamps.
   `acceptUntil` must be later than retirement and no more than seven days later.
2. Review dependent invitation/callback ciphertext and the retirement plan. Use
   the existing-Worker sequence to deploy the approved keyring, verify metadata,
   and exercise authorized staging old reads and new writes. Ciphertext retains
   its original `keyId`; changing the keyring does not re-encrypt old records.
3. Complete approved retirement/reissue before the deadline. Remove the old key
   through another approved secret deployment; `key-expired` or `key-unavailable`
   failures permit no plaintext fallback, silent resealing or restored authority.

**K3 / unavailable former key:** production's [approved K3 injection](https://github.com/kitamura-tetsuo/agent-table/issues/50#issuecomment-6794647999)
retained no recoverable local/offline key copy. Name-only API readback cannot
recover it. Stop ordinary overlap rotation and leave the current secret unchanged
if the former key is unavailable. Replacing it with `previous: []` can make old
envelopes unreadable and needs a separate exact-scope decision: independently
verified absence of dependent live ciphertext, or authorized retirement/reissue
with its loss implications. There is no automatic inventory/re-encryption tool
or guaranteed ciphertext drain here. Pausing new guests/tables/outbound does not
stop every existing user's invitation write. Do not infer readiness from a timer,
require new escrow retrospectively, or claim production rotation was rehearsed
because synthetic envelope tests passed. Preserve quarantine or fail-closed
errors when authority/key material is unavailable.
