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

/** Synthetic bounded scope only; never a live host/account/table selection. */
export function privateRelayBindings(options: {
  guestId: string;
  connectionId: string;
  tableIds: string[];
  now?: number;
}) {
  const base = relayBindings(),
    now = options.now ?? Date.now();
  return {
    ...base,
    RELEASE_PROFILE: "private-pilot-a-only",
    ENABLE_MCP_SUBSCRIPTIONS: "false",
    ENABLE_OPENAI_EVENTS: "false",
    EVENTS_RELAY_SIGNING_KEY_PKCS8: syntheticRelayKey,
    PRIVATE_PILOT_POLICY: JSON.stringify({
      schemaVersion: 1,
      mode: "a-only",
      buildSha: base.RELEASE_BUILD_SHA,
      approvedAt: new Date(now - 2000).toISOString(),
      notBefore: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 120000).toISOString(),
      approvalRef: "synthetic-relay-scope-review",
      recipientGuestId: options.guestId,
      recipientConnectionId: options.connectionId,
      tableIds: options.tableIds,
      callbackTargets: JSON.parse(base.EVENTS_REVIEWED_CALLBACK_TARGETS),
    }),
  };
}
