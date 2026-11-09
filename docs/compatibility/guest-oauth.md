# Guest OAuth interoperability — actual host evidence gate

Status: **PARTIAL REAL-HOST EVIDENCE — ACCEPTANCE OPEN** as of 2026-11-10.
An owner-authorized ChatGPT Work private MCP app (`Agent Table Test2`) was
connected to an isolated staging Worker. Real host-origin create/read operations,
a `refresh_token` exchange and post-browser-revocation HTTP 401 have been
reported with redacted server receipts. This is **not** a completed nine-case
host acceptance result: an actual-host Deny test, independent per-case receipt
review and a trustworthy deployed Git-SHA mapping remain outstanding. See
Issue [#23](https://github.com/kitamura-tetsuo/agent-table/issues/23) and
[PR #41](https://github.com/kitamura-tetsuo/agent-table/pull/41).
The local MCP SDK/OAuth regression tests cannot replace real-host evidence.

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

## Observed 2026-11-09 UTC — partial, redacted

- **Actual host:** ChatGPT Work owner-authorized **private MCP app**
  `Agent Table Test2`. The account could register and use the private app.
  The host SaaS build/version was **not exposed** in the captured host UI or
  connector responses. This is an eligibility observation for **this** account
  and surface, not all ChatGPT accounts, dots, or other hosts.
- **Endpoint/transport:** `https://agent-table-test.outliner-online.com/mcp`
  over HTTPS MCP, on `agent-table-staging` with separate staging Durable
  Object and OAuth bindings. The owner selected/reused the same synthetic guest.
  No production origin or personal conversation was used.
- **Deployment provenance limitation:** Cloudflare identifies distinct
  deployed versions, not the Git SHA of the uploaded bundle. Revocation
  occurred under version `6296bab9-d3cf-45b5-a9b5-f2a408938556` at
  13:54:04Z; refresh-token audit under
  `0bf4b7b6-6221-43dc-9e49-c26a1b67a8fe` at 15:59:42Z; audit-off
  cleanup under `aede0218-480c-46e3-b3a8-dd39a44a6bc7` at 16:12:26Z.
  The audit deployment was reported as built from
  `8c92fec397b22c15cbff4a87c01bfe965357e333`, **not independently
  attested by Cloudflare**. These observations must not be represented as a
  single exact-head run.
- **Correlation limit:** Cloudflare Zone HTTP Analytics supplied redacted
  time/method/path/status. The metadata-only live tail supplied
  `grant_type=refresh_token`, HTTP 200, a validated binding digest and
  identical approved/issued four-scope arrays. The tail lacked a shared
  request ID and per-event timestamps: correlation is by the narrow test
  window. Retained private traces were not replayed by an independent reviewer.

| Required host case | Observed result | Evidence and remaining limitation |
| --- | --- | --- |
| Denied consent without grant | **NOT RUN** | Must Deny on a separate actual-host test connection, then confirm absent usable grant/protected-call refusal |
| Deliberate guest choice/reuse | **OWNER OBSERVED** | Same guest shown across old revoked and fresh active grants; [browser report](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6743908128) |
| Approved consent | **OBSERVED** | Actual reconnect Allow and `/authorize` 200/302 followed by token 200; [client report](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6743908128), [server status](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6744413982) |
| Host `create_table` | **HOST TOOL OBSERVED** | Actual private-app tool result; direct independent DO table persistence audit still needed ([client report](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6743636141)) |
| Host `get_table` | **HOST TOOL OBSERVED** | Host read after creation and after reauthorization; exact protected operation to persisted table needs independent join ([client report](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6743908128)) |
| Actual host refresh token | **SERVER OBSERVED** | Live redacted `refresh_token`/200; active connection digest and equal four-scope arrays ([audit receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6744941273)) |
| Authenticated read after refresh | **HOST/SERVER OBSERVED** | Host `get_table` succeeded; matching-window `/mcp` 200, no shared request ID ([audit receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6744941273)) |
| Same-guest browser revocation | **BROWSER/SERVER OBSERVED** | Old grant Revoked, fresh grant Active; `POST /guest/connections/revoke` 303 ([browser report](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6743908128), [edge receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6744413982)) |
| First host call refused after revocation | **HOST/SERVER OBSERVED** | Host showed reconnect without protected table; `POST /mcp` HTTP **401** at 15:22:55Z, before new Allow ([edge receipt](https://github.com/kitamura-tetsuo/agent-table/pull/41#issuecomment-6744413982)) |
| Host-side Disconnect | **NOT RUN** | Service-side Revoke and host-side Disconnect are distinct |
| Notification receipt / idle autonomy | **UNTESTED** | Not part of #23 OAuth gate; separate #18–#24 |

The default `evidence.template.json` intentionally remains entirely blocked
for **new** test runs. A separate redacted, **incomplete** actual-host snapshot
(`evidence.chatgpt-work-2026-11-09.json`) tracks observed facts without
pretending the missing Deny, exact build attestation or independent causal
correlation passed. Its validation cannot authenticate the external receipts.

Before closing #23, run actual-host Deny on another connection without touching
the existing active connection; independently compare the paired receipts,
establish a source-SHA-attested staging deployment for any new head-specific
run, then review/merge the evidence and compatibility documentation. Host
disconnect behavior remains separately identified, not silently presumed.
No public-IPv4 receiver or production deployment is needed for this OAuth gate.
