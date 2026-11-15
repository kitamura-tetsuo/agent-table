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
    environment: "production",
    buildSha: "a".repeat(40),
    origin: "https://relay.example.org",
    callerId: "synthetic_caller_123",
    audience: "production:agent-table",
  }),
});
