# Guest OAuth interoperability — actual host evidence gate

Status: **BLOCKED / NOT RUN** as of 2026-11-09. This is a procedure and a
metadata-only fixture, **not** evidence that a real host supports Agent Table.
Issue [#23](https://github.com/kitamura-tetsuo/agent-table/issues/23)
requires an eligible owner-authorized agent host and an isolated reachable
deployment; neither is available to this connector-only validation run.
The successful local MCP SDK/OAuth tests for #6/#9 are server regressions only.

## Scope and inputs

Use one explicitly authorized private connector surface of a candidate
personal-agent host. Record its exact product/surface/version or exposed build,
account/workspace eligibility, test UTC date, protocol/transport, canonical
resource, and the deployed Agent Table git SHA. A product landing page,
connection badge or SDK compatibility assertion does not count as host origin.
Do not purchase accounts, publish a connector, deploy to production or alter
permission/identity recovery rules merely to perform this test.

Use a separate staging Worker and isolated SQLite Durable Objects with a
synthetic owner guest, synthetic table title and no real conversation. Confirm
the Worker build SHA out-of-band; `https://<isolated-host>/mcp` must be the
canonical OAuth resource/audience for that exact deployment. Capture the
host product/version and whether this account can actually add a private MCP
connection. A candidate described in provider docs is not automatically
eligible for an individual account.

## Reproducible execution procedure

1. Create a synthetic run tag and copy
   `test/e2e/host/evidence.template.json` into an **uncommitted**
   local record. The template is deliberately all blocked; update only from
   observations. Retain real host/server traces only in authorized private
   evidence storage, redacted before review. Do not put secrets in Git.
2. From the **actual host UI**, try a private MCP connection with the
   canonical staging resource and observe discovery, dynamic client
   registration (if supported) and explicit browser guest selection/reuse.
   Record exact client-visible actions separately from Worker's safe request
   and grant observations.
3. Deny the OAuth consent once. Verify that no usable grant was issued and
   protected host-origin calls are denied. Repeat with deliberate consent
   for the selected guest and only the requested bounded scopes.
4. In the **real host session**, call `create_table` and `get_table`;
   correlate the returned ID with the stored table and verified guest and
   connection grant. A successful HTTP response or interface badge alone
   is not a protected-operation oracle. Do not log the raw table content.
5. Observe the **host's** actual refresh-token exchange and its next
   authenticated protected read. Correlate it with the same original guest,
   connection, canonical audience and scopes. A local token refresh fixture
   does not count.
6. Revoke the grant using that guest's browser connection-management page.
   Observe the host's next protected request being refused and confirm the
   persisted grant state. Record the host's own disconnect behavior
   separately; service revocation does not imply host-side disconnect.
7. Review redacted client- and server-origin evidence references for every
   required case. Run the evidence-schema regression in CI. Mark tools
   verified **only after a human reviewer validates the actual host/server
   receipts**. Keep notifications and autonomous idle-host execution
   *untested*; those are separate Issues #18–#24.

## Evidence format and fail-closed interpretation

`test/e2e/host/evidence.ts` exports the strict, metadata-only Zod schema
and `evaluateHostEvidence`. It requires both client-side (host or browser)
and server-side redacted observation references for each of nine test cases:
consent denial, guest choice, consent approval, create, get, real host refresh,
post-refresh read, browser revocation and host's post-revocation refusal.
Each case is `not-run`, `blocked`, `failed` or `passed`; no missing case
is silently interpreted as passed. Only an actually eligible host, actual
host-origin path and pinned isolated SHA/resource can yield a structurally
complete record. The validator deliberately does **not** authenticate or
replay external observations: completeness is not proof they occurred.

Keep evidence references to opaque, redacted IDs only, not URLs with tokens,
auth codes, cookies, unredacted headers or personal identifiers. Reject extra
JSON fields instead of accidentally retaining secret material. Store private
source traces outside Git under explicit access controls. If a wire-level
incompatibility is observed, add a separate synthetic/reduced OAuth regression
case; do not loosen PKCE, redirect, scope, audience, guest identity or
revocation rules. Use exact product/build and endpoint in any compatibility
claim, not a blanket provider label.

Current results:

| Check | Status | Missing independent evidence |
| --- | --- | --- |
| Eligible real host and isolated deployed SHA | BLOCKED | Authorized host surface/account, test deployment |
| Host denial, guest choice and consent | NOT RUN | Host UI + server grant traces |
| Host create/get and storage correlation | NOT RUN | Host-origin requests + committed table |
| Host refresh and subsequent protected operation | NOT RUN | Host-origin refresh + unchanged grant |
| Browser revoke and host next-request denial | NOT RUN | Same-guest browser and host/server refusal |
| Notification receipt / autonomous execution | UNTESTED | Separate #18–#24 evidence gates |

No account credential, callback URL, production deployment or public-IPv4
server is required by this documentation update alone.
