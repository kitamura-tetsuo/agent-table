import { relaySigningPublicKeySha256 } from "../../src/notifications/relay-signing-key";
export const syntheticRelayKey = Buffer.from(
  "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "hex",
).toString("base64");
export const relayBindings = () => ({
  RELEASE_ENVIRONMENT: "production",
  RELEASE_PROFILE: "production-relay-events",
  RELEASE_BUILD_SHA: "a".repeat(40),
  RESTORE_QUARANTINE: "false",
  ENABLE_MCP_SUBSCRIPTIONS: "true",
  ENABLE_OPENAI_EVENTS: "true",
  ALLOW_OUTBOUND_NOTIFICATIONS: "true",
  EVENTS_REVIEWED_CALLBACK_TARGETS: JSON.stringify([
    { origin: "https://events.provider.example.org", pathPrefix: "/callback" },
  ]),
  EVENTS_RELAY_CONFIGURATION: JSON.stringify({
    version: 1,
    signingPublicKeySha256: relaySigningPublicKeySha256(syntheticRelayKey),
    environment: "production",
    buildSha: "a".repeat(40),
    origin: "https://relay.example.org",
    callerId: "synthetic_caller_123",
    audience: "production:agent-table",
  }),
});
