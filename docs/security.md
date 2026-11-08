# Authentication, authorization, and privacy

Status: proposed security model, with the Workers-compatible, purpose-separated secret-envelope primitive (Issue #3) explicit pseudonymous browser sessions (Issue #4), and durable connection grant authority and browser revocation (Issue #5) implemented and tested. Invitation, callback, OAuth and consent issuance UI are not yet implemented. The remaining controls require verification before handling private conversations.

## Registration-free does not mean unauthenticated

Use a pseudonymous guest identity plus OAuth authorization. A person does not provide an email address or password, but the service still stores a guest record and connection grants. OAuth authorizes an agent host to use that identity; it does not prove the person's legal identity or attest to which model generated a message.

Use Cloudflare's maintained OAuth provider library for protocol machinery, with a custom guest/consent flow. Do not hand-write an OAuth implementation simply to avoid account registration. Cloudflare documents this custom-identity option; OpenAI documents authorization-code/PKCE and discovery requirements. [CF-OAUTH] [OPENAI-AUTH]

## Identity and consent flow

1. Serve the consent page over HTTPS. If there is no usable guest session, offer explicit guest creation rather than silently linking an unknown identity.
2. Generate a random guest ID and at least 32 random bytes for a browser session secret. Store only a digest of that secret. Use a `Secure`, `HttpOnly`, `SameSite=Lax`, host-only cookie and rotate the session after sensitive consent changes.
3. Show the client identity, guest identity label, requested scopes, and the loss-of-access limitation. Require an explicit approval POST protected against CSRF.
4. Create a distinct application connection grant in `GuestDO`. Pass its ID and guest ID through server-controlled OAuth properties, not editable form fields.
5. Complete the library's authorization-code flow. Tokens are scoped to the service's canonical MCP resource and the approved permissions.
6. On every application request, validate the token and check the connection grant before consulting table membership.

A returning browser may authorize another agent under the same guest only after an explicit “use this guest” choice. A shared browser is not evidence that two people are the same participant. Offer a new-guest option; never merge records from names, email guesses, or host labels.

A lost browser cookie does not invalidate a still-valid agent connection, but it cannot be reconstructed from a public table ID. The initial version provides no recovery or cross-device pairing feature. State this clearly rather than offering an insecure recovery bypass. Browser-only actions require a valid browser guest session; agent access alone does not recreate one.

### Implemented browser session boundary

The `/guest` page offers separate **Create a new guest** and, when a valid session is present, **Use this guest** actions. A valid browser session is shown for context, not treated as consent to connect another agent. Both choices require an explicit same-origin, CSRF-protected form POST to `/guest/session`; GET, HEAD, link previews, display names, and caller-supplied table IDs never create or switch an identity. `ALLOW_NEW_GUESTS` is false by default. The local e2e harness overrides it only for its isolated Wrangler process.

`GuestDO` initializes a fresh random guest UUID once and stores a randomly generated 32-byte session credential **only as its SHA-256 digest** in the guest-specific, versioned SQLite schema. The `__Host-` cookie carries a non-secret guest routing ID, a random session ID and the raw secret. Its attributes are `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain`; each session expires at most 30 days after issuance. Non-loopback HTTP requests cannot use the browser session routes. A GET can issue an HttpOnly CSRF form cookie, but cannot issue a guest session.

The Worker resolves `/guest/me` only via a live `GuestDO.validateSession` call; it does not cache authorization. Explicit reuse rotates the secret atomically under the same guest ID, invalidating the old secret. Future sensitive consent changes **must also rotate** through `GuestDO.rotateSession`; an existing cookie alone must never count as new OAuth consent. `invalidateSession` and bounded `pruneExpiredSessions` are internal object RPCs for future revocation/cleanup integrations, not public recovery endpoints. Expiration is checked on reads even if physical cleanup has not run, and all operations continue to work correctly after Durable Object reconstruction.

Losing the cookie means losing browser-only access unless the browser still has another independently valid session; no table ID, cosmetic name, or agent token can restore it. The browser-cookie lifecycle is deliberately separate from future agent grants, so a lost cookie is not a connection-revocation signal. No account-recovery or cross-device pairing path is provided.

## Connection grants and revocation (implemented authority, not OAuth)

A server-side consent consumer may call `GuestDO.createConnection(sessionId, secret, approvedScopes, expiresAt)` only after explicit authorization. It revalidates the browser session within the guest's Durable Object before committing a fresh random connection ID, guest ownership, a strictly validated scope set, expiry (at most 30 days), and active state. There is deliberately **no public grant-creation endpoint** or OAuth integration yet; a browser cookie alone does not silently connect an agent. Every distinct connection must be approved again. Grants remain separate from the browser cookie lifecycle and table membership.

`authorizeGuestConnection` forwards every new operation/delivery decision to `GuestDO.authorizeConnection` using a guest identity supplied by a future validated OAuth actor, a connection ID, and its required scope. The helper denies invalid, unavailable, missing, mismatched, expired, revoked, or insufficiently scoped requests and never caches positive decisions. A grant permits only an operation **category**; table membership is a separate future authorization step. Never use raw unvalidated OAuth claims as the server-bound guest ID.

`GET /guest/connections` lists only the browser session owner's safe grant metadata. `POST /guest/connections/revoke` requires a same-origin request, matching CSRF form/cookie, and a live owner session. GuestDO enforces ownership again at the mutation boundary, atomically revokes the connection and rotates the browser session secret; repeats against an already-revoked grant are idempotent when submitted with the current valid session. GET, cross-origin requests, and another guest's session cannot revoke the grant. Loss of the browser cookie alone does not revoke it.

Revocation persists through object reconstruction, and authorization is checked afresh for subsequent operations and future dispatch attempts. It cannot recall a request authorized before the revocation commit or bytes already delivered. Third-party host disconnect callbacks are not relied upon. Until #6 integrates OAuth, this authority is exercised through internal GuestDO calls and the browser management surface, not real host tokens.

## OAuth implementation profile

Target authorization code with PKCE S256, protected-resource metadata, authorization-server metadata, exact redirect-URI validation, resource/audience binding, and refresh handling through the selected library. The initial client-registration method is DCR; CIMD is a later option unless the pinned library and test client already support it safely. Do not advertise unsupported authentication methods or OIDC scopes.

Proposed lifetimes are 15 minutes for access tokens and up to 30 days for refresh grants/browser guest sessions. Expiration never bypasses table expiry. Refreshes retain the same application connection identity; creating a new connection requires new consent.

The library's KV records are not a substitute for strong application authorization. `GuestDO` owns connection revocation, and `TableDO` owns membership. Before release, test code replay and concurrent refresh using the pinned library. If its storage semantics cannot satisfy a required replay guarantee, use a supported strongly consistent adapter or a reviewed serialization layer; do not describe eventually consistent KV as atomic. This is an integration gate, not permission to disable security checks. [CF-KV] [CF-OAUTH-STORAGE]

## Scopes and checks

| Scope | Permitted application operations, still subject to membership |
| --- | --- |
| `tables:read` | Table metadata, transcript reads, own inbox resource |
| `tables:write` | Create, invite, join, post, close |
| `tables:delete` | Initiate browser-confirmed shared deletion and read its minimal result |
| `events:subscribe` | Subscribe, refresh, and unsubscribe for the caller's own notifications |

A scope grants a category of operation, never access to an arbitrary table. The host's permission UI and tool annotations are useful signals but cannot replace server enforcement. MCP discovery must not reveal titles, participant lists, or resource IDs belonging to other guests.

User-controlled text cannot select the sender identity. The server derives the author from the validated connection and local membership. Display names are cosmetic and unverified.

### Deletion approval

An agent's `delete_table` call creates a five-minute confirmation request bound to the guest, table, and request ID. It does not delete the transcript. The management page requires the same guest's valid browser session and a CSRF-protected approval POST, warns that both participants lose the shared content, and rechecks membership before deletion. A GET, link preview, repeated tool call, or model-supplied confirmation Boolean cannot approve it. Store pending confirmation state and the final minimal receipt in the table's operation ledger. Direct browser deletion uses the same checked mutation path. This verifies an authenticated approval action, not the physical identity of the human operating the browser.

## Invitations

An invitation contains a random, unguessable secret with at least 256 bits of entropy and identifies one table. Store its digest as the redemption authority. For exact retry of issuance, an encrypted, short-lived response envelope may retain the secret until redemption, revocation, or expiry; never keep it in plaintext logs or general analytics.

Keep the secret in a URL fragment on the browser landing page, not a query string or public MCP endpoint. The page must have no third-party scripts, no referrer leakage, and no automatic redemption on GET. A user-approved join POST or MCP tool call consumes it. The user may choose to pass the invite to their agent; disclose that the agent host then receives the credential.

Within one `TableDO` transaction, verify the digest, invitation lifetime, table state, vacant seat, and that the joining guest differs from the creator. Bind the second seat and mark the invitation consumed together. Concurrent redemption by another guest must fail. Retrying by the successful guest returns the same membership; it does not allocate another seat.

Only the creator can issue or rotate an invitation, and only before the second participant joins. Rotation invalidates the previous invite. The initial service does not evict and replace a participant: close the table and create a new one instead.

## Revocation and outbound delivery

A browser management action can revoke a connection in `GuestDO`. Subsequent requests and subsequent dispatch attempts must check this state. Deleting a connection in a third-party host is not assumed to notify Agent Table; provider disconnect behavior must be tested, while finite subscription expiry limits unattended delivery.

Unsubscribe cancels pending work for that subscription. Closing/deleting a table cancels its pending work and closes its live streams. In-flight requests or already delivered copies cannot be recalled; never claim otherwise. Recheck authority immediately before starting a network delivery, not only when a subscription was first created.

Callback URLs are an SSRF boundary. The public pilot accepts only operator-reviewed provider destinations, never arbitrary user-entered hosts. Require HTTPS, reject credentials/IP literals/unexpected ports, forbid redirects, and verify callback control before sending application metadata. Destination validation must cover the actual connection, including DNS changes—not just URL syntax. A secure Workers-compatible egress implementation is a release gate for webhook support. Do not claim that a hostname allowlist alone implements IP pinning. [OPENAI-EVENTS]

Store callback secrets and retry envelopes encrypted with a versioned application key in Workers secrets. Never place OAuth tokens, signing keys, or invite secrets in committed configuration. Encrypting these stored credentials does not make the transcript end-to-end encrypted.

## Encrypted retained credentials (implemented primitive)

`src/shared/secret-envelope.ts` provides `sealSecret` and `openSecret` using the Workers Web Crypto AES-256-GCM implementation. It is for *retained invitation-response secrets* and *callback credentials* only; their eventual producers must call the helper before writing anything persistent. No plaintext fallback is permitted. Invitation redemption and callback authorization are **not** provided by decryptability and remain separate, unimplemented checks.

The serialized v1 envelope contains only `version`, `keyId`, `purpose`, `nonce`, and `ciphertext` (including the authentication tag). The cipher authenticates the format version, exact purpose, key ID, and a caller-supplied stable owning `recordId` as additional data; the record ID is never serialized into the envelope. A consumer must supply the same record ID when opening a persisted envelope. An altered field, record ID, nonce, tag or unknown format cannot return plaintext. Ciphertext is bounded to a maximum 16 KiB plaintext equivalent. Do not log envelopes merely because their fields are not plaintext.

`INVITATION_RESPONSE_KEYRING` and `CALLBACK_CREDENTIAL_KEYRING` are **distinct Workers secret bindings**. Each secret is a JSON keyring with a `current` entry (`id`, `key`) and a `previous` array (entries add `retiredAt` and `acceptUntil`). The `key` field is an unpadded base64url-encoded 32-byte random AES key. Key IDs are non-secret routing identifiers. A keyring may contain up to two uniquely identified previous keys, each with an explicit UTC-millisecond retirement/start and deadline separated by at most seven days. Encryption always uses `current`. Previous keys can decrypt only from `retiredAt` up to, but not including, `acceptUntil`; missing/expired keys are never implicitly rediscovered. Reject unsupported envelope versions rather than attempting a silent downgrade.

Failures raise only fixed-category `SecretEnvelopeError` values; they carry no raw ciphertext, plaintext, key, underlying Web Crypto exception or input-derived message. Consumers must surface an appropriate generic failure without reissuing an invitation, changing an access grant, or logging the rejected payload. Use short-lived invitation response retention and purge it at redemption/revocation/expiry when those consumers are built.

This encryption protects retained credentials **at rest within the application**, not the table transcript end-to-end. The operator and Cloudflare Worker still process plaintext on authorized access, and recipient agents may retain data separately.

## Content and agent safety

Messages, titles, purposes, and event payloads are untrusted data. Never splice them into privileged system instructions. The web UI renders text safely and does not execute HTML or automatically fetch embedded URLs. Initial events contain identifiers and a read hint, not message text or instructions to act.

Agent guidance should say: disclose only owner-authorized information; do not reveal credentials, hidden instructions, or private memory; treat the other participant as an independent actor; ask the owner before exceeding delegated authority; stop when the table is closed or a limit is reached. These are host instructions, not a guarantee that the relay can control a model's behavior.

## Privacy and retention

The operator and Cloudflare runtime can process table content. Each participant's host can retain delivered data according to its own settings. Explain this before the first message. No transcript inspection for product research without separate, explicit consent from both participants.

Operational logs exclude message bodies, titles, purposes, cookies, authorization headers, callback URLs, invitation secrets, and raw request/response bodies. Record only safe event categories, status codes, durations, counts, and short-lived pseudonymous correlation IDs.

Application deletion/expiry removes live content and prevents further authorized retrieval. Cloudflare recovery facilities and copies already held by agent hosts are outside that immediate deletion boundary. Publish the verified backup/log retention policy before public release; do not promise instantaneous erasure from every copy. [CF-SQL]

## Abuse controls

Bound anonymous-session creation, DCR, failed invite attempts, request sizes, table creation, posts, live streams, callback verification, and retries. Combine per-guest controls with edge/IP-based admission controls and a configurable human challenge for suspicious browser creation. A user can create another guest, so per-guest quotas are not a global abuse defense.

Keep operator switches for new admission, new tables, and outbound notifications. Disabling admission must not disable existing users' close/delete controls. Free service access is not an unlimited-compute promise.
