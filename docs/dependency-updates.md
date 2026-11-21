# Dependency and runtime updates

The repository checks for updates, validates the complete candidate, and merges
eligible bot PRs automatically. Each successful current-main validation also
publishes a relay image to GitHub Container Registry (GHCR). Cloudflare deployment
and replacement of a running relay continue through the existing
[reviewed release runbook](release-runbook.md).

## Update groups and schedule

| Group | Contents | Schedule (Asia/Tokyo) |
| --- | --- | --- |
| `dependencies` | All npm production/development dependencies, Python CI dependencies, and GitHub Actions | Monday 06:15, one cross-ecosystem PR |
| `automation/runtime-updates` | Node, npm, matching Node Docker tag and image digest | Monday 06:45, one runtime PR |
| Security groups | npm security updates together; Python security updates together | GitHub's security-update processing, if enabled for this repository |

The dependency group deliberately includes major library releases. A breaking
upgrade remains in its failed PR for correction; it is not partially merged.
All npm packages, including the MCP client/server and Cloudflare/Vitest tooling,
are considered in the same update. `@types/node` stays on the supported Node major.
Security updates cannot share a PR across ecosystems or with ordinary version
updates, so they have separate per-ecosystem groups.

Normal npm/Python versions and Node/npm runtime releases wait three days after
publication. The runtime updater refreshes the Node base image digest even when
the Node version is unchanged, allowing Debian base-image security fixes to flow
through validation. The updater runs on changes to its workflow/script as well
as its schedule; **Run workflow** can request an immediate check.

## Runtime sources of truth

- `.node-version` contains the exact Node release. `package.json` and the root of
  `package-lock.json` must agree with it.
- `package.json.packageManager` pins npm. Validation and both reviewed deployment
  workflows install that exact npm before `npm ci`.
- `deploy/relay/node-image.txt` contains the exact Node Docker tag and SHA-256
  manifest digest. CI and image publication use this same value.
- `.python-version` selects the supported Python 3.12 line. `setup-python` selects
  its latest available patch on every CI run. `requirements-ci.txt` pins the
  Python libraries so Dependabot can update them.
- `ubuntu-latest` tracks the GitHub-hosted runner image. The Actions used by the
  workflows are included in the bulk dependency group.

Node and npm automatically move forward **within their currently pinned major
versions**. Moving to a new Node/npm major, changing the Python minor line, or
changing the Debian image family is a separate compatibility change. Update the
pins and validate that change normally. Exact Node enforcement in the relay
reads `.node-version`; it never falls back to a floating version or disables the
runtime check.

The runtime updater fetches the official Node release index, npm registry metadata,
and Docker's `library/node` manifest. It checks the manifest digest against the
actual response bytes and requires a Linux amd64 image. Failed metadata/image
requests, inconsistent pins, and concurrent local changes fail without publishing
a partial update. It does not execute downloaded packages or require registry
credentials.

Cloudflare upgrades its hosted Workers runtime. Its `compatibility_date` opts into
behavior changes; it is not a runtime binary version. The local `workerd`,
`miniflare`, Wrangler, and Workers packages are included in the dependency group.
Changing compatibility dates or live environment configuration remains a reviewed
compatibility/release change.

## Validation and automatic merging

`Validation` retains one job named `verify` and the existing release gate step
names. Every candidate runs the normal typecheck, lint, script/unit tests,
Workerd integration/recovery tests, isolated Docker relay restart, SDK/live-stream
probes, Wrangler dry runs, and browser E2E tests. The additional runtime check
rejects mismatched Node/npm/image manifests before installing project packages.

`Merge validated dependency updates` is triggered only after Validation completes.
Its privileged code is checked out from `main`. It reads candidate manifests via
the GitHub API; it never checks out or installs candidate code with its write token.
It verifies the repository, authentic bot identity, current PR head and base,
completed Validation steps, other checks, and review state. It permits only:

- Dependabot version changes in package manifests/locks, Python requirements, and
  GitHub Actions references. Application source, package scripts, workflow triggers,
  and workflow permissions are not permitted.
- The runtime bot's four synchronized runtime pin files, within the supported
  Node/npm majors.

`no-automerge` or `manual-review` labels opt a PR out. Drafts, unresolved review
threads, requested changes, stale validation, failed/pending checks, conflicts,
and unexpected edits block merging. Repository branch rules remain effective.

The merge request includes the expected head SHA. After merging, the workflow
explicitly dispatches Validation on `main`, because pushes made with
`GITHUB_TOKEN` do not start ordinary push workflows. The runtime updater likewise
dispatches Validation on its branch, so it does not depend on approval of a
workflow-created PR's automatic workflow run.

## Delivery and live rollout

`Publish validated relay image` accepts only successful Validation runs for the
current `main` commit. It builds the digest-pinned relay image, checks the Node
runtime in the resulting container, and publishes:

```text
ghcr.io/kitamura-tetsuo/agent-table-relay:sha-<40-character-main-commit>-<run-id>-<attempt>
```

The run summary records the source SHA and immutable image digest. Use the digest
as `RELAY_IMAGE` in the reviewed relay release process. Publication does not
restart the host's running container, change ingress, or alter release evidence.
No floating `latest` tag is published. Each workflow run/attempt has a unique
source tag, so a retry cannot overwrite a previous publication. The digest is
the immutable deployment identity.

Cloudflare release workflows still require their existing exact-main dispatched
CI evidence, provider/configuration checks, operations decision, and applicable
Environment approval. The new automation prepares tested dependency changes and
relay images; it does not replace that release authority.

## Repository settings and operations

No new personal access token or installed update service is required. Dependabot
runs when `.github/dependabot.yml` is present on the default branch. The runtime
workflow uses the repository's short-lived `GITHUB_TOKEN` with only the declared
permissions. GitHub **Settings → Actions → General → Workflow permissions →
Allow GitHub Actions to create and approve pull requests** must be enabled for
runtime PR creation. This automation does not submit approval reviews, change
branch protection, or require the repository's native **Allow auto-merge** option.
GHCR publication uses the workflow's `packages: write` permission.

Useful local commands:

```sh
node scripts/runtime-updates.mjs --check
node scripts/runtime-updates.mjs --check-runtime
node scripts/runtime-updates.mjs --update
node --test scripts/runtime-updates.test.mjs scripts/dependency-automerge.test.mjs
```

To pause checks, disable **Runtime updates** and set Dependabot's group schedule
or update configuration as appropriate. To stop merging while keeping update PRs,
disable **Merge validated dependency updates**. Failed groups stay available for
inspection; fix the incompatibility in that PR and rerun validation. If a manual
edit introduces source/configuration changes outside the allowlist, merge it
through normal review after validation.

## References

- [Dependabot multi-ecosystem groups](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configuring-multi-ecosystem-updates)
- [Dependabot configuration options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [Security grouping restrictions](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-errors#failed-to-group-dependencies-security-updates)
- [GITHUB_TOKEN workflow triggering](https://docs.github.com/en/actions/concepts/security/github_token)
- [Cloudflare compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
