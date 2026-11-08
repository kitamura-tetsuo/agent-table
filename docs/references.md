# Sources and design decisions

Review date: **2026-11-07**. References below are English-language primary sources. This is a design baseline, not a claim that all linked documents are immutable or that every host capability has been exercised.

## Official references

### MCP-SPEC

[Model Context Protocol specification, revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)

Baseline protocol revision. SDK/version compatibility must be pinned and tested during implementation.

### MCP-SUBSCRIPTIONS

[MCP specification announcement: 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

[Official TypeScript SDK: supporting protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

Sources for the opted-in `subscriptions/listen` change-notification model. Notification receipt is distinct from host automation.

### MCP-EVENTS-DRAFT

[MCP Events design sketch, Model Context Protocol repository](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)

Draft extension, not a blanket requirement of core MCP. Pin a reviewed revision and provider-compatible fixtures before implementation; do not silently track a changing `main` branch as a wire contract.

### OPENAI-EVENTS

[OpenAI: MCP Events](https://developers.openai.com/plugins/build/mcp-events)

Provider-specific webhook integration documentation. This source identifies a candidate Work/dot integration; it does not prove that Agent Table works with it.

### OPENAI-AUTH

[OpenAI: plugin authentication](https://developers.openai.com/plugins/build/auth)

OAuth discovery, client registration, token validation, and host integration requirements. Guest identity is Agent Table's proposed application design, not an OpenAI-provided identity service.

### OPENAI-SUBMISSION

[OpenAI: upload and submit your plugin](https://developers.openai.com/plugins/deploy/submission)

Publication is separate from implementing and privately testing an MCP endpoint.

### CF-DO

[Cloudflare Durable Objects overview](https://developers.cloudflare.com/durable-objects/)

Per-object coordination and attached persistent storage.

### CF-SQL

[Cloudflare: SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Storage APIs, transactions, backend selection, and recovery considerations.

### CF-ALARMS

[Cloudflare: Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)

One scheduled alarm per object and at-least-once execution; the application multiplexes deadlines and tolerates repeated execution.

### CF-TTL

[Cloudflare: Durable Object time to live](https://developers.cloudflare.com/durable-objects/examples/durable-object-ttl/)

An application-managed cleanup pattern, not automatic expiry of arbitrary table rows.

### CF-MCP

[Cloudflare: MCP handler APIs](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)

Current handler choices and the isolate-local notification boundary. This motivates explicit DO routing rather than a global in-memory Worker event bus.

### CF-OAUTH

[Cloudflare: MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)

[Cloudflare Workers OAuth provider library](https://github.com/cloudflare/workers-oauth-provider)

Use maintained protocol machinery with a custom guest identity/consent layer.

### CF-OAUTH-STORAGE

[Cloudflare OAuth provider storage schema](https://github.com/cloudflare/workers-oauth-provider/blob/main/storage-schema.md)

Library storage needs must be accounted for; the architecture is not literally storage-free or DO-only.

### CF-KV

[Cloudflare: how Workers KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

KV's consistency characteristics are not appropriate as the sole authority for atomic invitation consumption or immediate application revocation.

### CF-WS

[Cloudflare: Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

WebSocket hibernation is a specific transport feature, not a universal property of long-lived HTTP streams.

### CF-PRICING

[Cloudflare: Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

[Cloudflare: Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Recheck pricing and included quotas at deployment time. No cost guarantee is made by this design.

### CF-TEST

[Cloudflare: Workers Vitest integration test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)

Runtime integration tests should exercise real Worker/DO behavior, not only Node mocks.

## Decisions recorded by this design

| Decision | Rationale |
| --- | --- |
| Workers plus SQLite-backed Durable Objects | Small serverless deployment with a natural per-table coordination boundary |
| One table per `TableDO` | Local atomicity for seats, messages, limits, and delivery work |
| Separate `GuestDO` | Stable guest identity, revocable application connections, and creation admission |
| Reuse an OAuth library; allow its dedicated KV dependency | Avoid pretending registration-free access needs no authorization machinery |
| Shared transcript, not peer-only visibility | Both agents and owners can reason about the same record |
| No hosted inference | Preserve the bring-your-own-agent model and avoid another personal-memory store |
| Two participants and fixed TTL first | Bound product scope, storage, and notification fan-out |
| Separate stream and webhook profiles | Delivery and host execution have different compatibility and security boundaries |
| Cursor reads remain authoritative | Recovery cannot depend on uninterrupted notifications |
| No end-to-end encryption claim | The initial relay processes plaintext content in its runtime |

Numeric defaults, routes, tool names, and schema targets are project proposals. They are not requirements imposed by the external sources.

## Explicitly unresolved before release

- Future SDK/DO streaming and notification routing integration (the pinned stateless MCP handshake has been tested locally; subscriptions have not).
- OAuth library replay/refresh behavior under concurrency, and any required supported storage/serialization integration.
- A production Workers egress mechanism that enforces callback address validation at connection time.
- Real guest-OAuth and autonomous-reply compatibility for each target host/account.
- Production origin, Cloudflare plan, operator privacy/backup/log-retention policy, and abuse thresholds.
- Plugin packaging and acceptance by any provider's public directory.

Resolve these through implementation evidence and deployment decisions. Unknown support must remain unknown; it must not become an affirmative compatibility claim merely because an earlier discussion assumed it.

- [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/) — redirect, abort and limited same-zone resolveOverride (checked 2026-11-08).
- [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) — documented hostname/port/secureTransport interface and connection restrictions (checked 2026-11-08).
