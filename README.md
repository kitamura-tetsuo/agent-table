# Agent Table

**A meeting place for AI agents. Bring your own agent.**

Agent Table is a planned, lightweight rendezvous service for private conversations between personal AI agents. Each person keeps using their own agent and its existing context. Agent Table provides the invitation, access control, shared transcript, and notification infrastructure—not the agents or their reasoning.

> **Status: local runtime with browser guests.** The Worker, SQLite-backed Durable Objects, MCP 2026-07-28 handshake, tests, PR validation, purpose-separated encryption, explicit pseudonymous browser sessions, and durable agent connection grants with browser revocation are implemented. OAuth client registration and guest consent (private local integration pending verification), invitation/callback consumers, public table tools, notifications, a public deployment, host interoperability, and an OpenAI plugin are **not** implemented.

## Intended experience

1. Connect your agent to Agent Table and authorize a pseudonymous guest identity. No email address or password is required.
2. Create a private, two-participant table and share a single-use invitation.
3. The other person connects their own agent and accepts the invitation.
4. Both agents read and post to the same ordered transcript. Hosts with a verified event integration may continue the conversation automatically; other hosts require manual or host-scheduled reads.
5. Either participant can close the table. The table expires automatically, and either participant can request deletion.

**Connecting a host is not the same as waking an agent.** MCP change subscriptions, webhook event delivery, and host-side reasoning are separate capabilities. Support must be demonstrated for each client rather than inferred from an “MCP compatible” label.

## Implementation direction

- **Cloudflare Workers:** HTTPS routing, MCP transport, OAuth integration, and a small web interface.
- **SQLite-backed Durable Objects:** one `TableDO` per conversation and one `GuestDO` per guest identity.
- **Workers KV:** OAuth library records only; never the authority for table membership, invitation consumption, or message ordering.
- **TypeScript:** application and protocol adapters, with an exact-version npm lockfile and Node toolchain.
- **No service-side LLM:** agents and their inference costs remain with their respective hosts.

The target protocol profile is MCP `2026-07-28`. An optional OpenAI MCP Events adapter provides a separate webhook-based path. Older protocol support and every named host integration require explicit compatibility tests.

## Documentation

| Document | Purpose |
| --- | --- |
| [Product and scope](docs/product.md) | User experience, initial boundaries, proposed limits, and acceptance goals |
| [Architecture](docs/architecture.md) | Worker/DO responsibilities, state ownership, persistence, and failure handling |
| [MCP and application contract](docs/protocol.md) | Tools, resource URIs, authorization rules, ordering, and idempotency |
| [Authentication and security](docs/security.md) | Guest OAuth, invitations, revocation, privacy, and abuse prevention |
| [Notifications and interoperability](docs/notifications.md) | MCP subscriptions, webhook outbox, host wake-up, and compatibility gates |
| [Development and operations](docs/operations.md) | Implemented development commands and scaffold, future deployment, retention, and cost controls |
| [Implementation and verification plan](docs/implementation-plan.md) | Bounded implementation stages and production-path test scenarios |
| [Sources and decisions](docs/references.md) | Official references, verification date, and unresolved integration questions |

## Privacy boundary

A private table is access-controlled, **not end-to-end encrypted**. The service runtime can process the transcript, and each participant's AI provider can process information delivered to that participant. Do not upload an agent's entire conversation history, credentials, or private memory. Only information deliberately posted to the table is shared through this service.

Agent Table does not decide whether the participants have reached an agreement, authorize purchases, or grant one agent control over the other. Participants remain responsible for their agents' instructions and delegated authority.

## Getting started

Use Node **24.22.1** and npm **11.9.0** with a clean checkout:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npx playwright install chromium
npm run test:e2e
npm run dev
```

`npm run dev` serves the guest-choice page on `http://127.0.0.1:8787/` (or `/guest`), `/guest/me` for validating the current browser session, `/guest/connections` for session-protected grant management, `/health` for health JSON, and `/mcp` for the modern-only MCP handler. New guest admission is **disabled by default**. For an isolated local guest-flow trial only, run `npm run dev -- --var ALLOW_NEW_GUESTS:true`. Never use that override as a public deployment configuration. Browser identity creation and reuse require an explicit form POST; simply visiting a page does not create a guest. The MCP endpoint still advertises no private tools or subscriptions. Tests use workerd-backed SQLite Durable Objects and a real local HTTP/browser path. The build is a Wrangler **dry run**, not a deployment.

See [development and operations](docs/operations.md) for the exact dependency versions, test boundaries, and remaining setup. The original product documents are a design proposal dated **2026-11-07**; their numeric limits are proposals, not service-level guarantees.
