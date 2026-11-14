import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  RECOVERY_AUTHORIZATION_DOMAIN,
  validateRecoveryClaims,
  validateRecoveryNamespaceIdentity,
  verifyRecoveryAuthorization,
} from "../src/shared/recovery.ts";

export const RECOVERY_BINDINGS = [
  "RECOVERY_AUTHORIZATION",
  "RECOVERY_VERIFICATION_KEY",
  "RECOVERY_CONFIG_SHA256",
  "RECOVERY_NAMESPACE_IDENTITY",
];
const FLAGS = [
  "ENABLE_MCP_SUBSCRIPTIONS",
  "ENABLE_OPENAI_EVENTS",
  "ALLOW_OUTBOUND_NOTIFICATIONS",
  "ALLOW_NEW_GUESTS",
  "ALLOW_NEW_TABLES",
];

export class RecoveryVerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "RecoveryVerificationError";
  }
}
export function requireRecovery(condition, code) {
  if (!condition) throw new RecoveryVerificationError(code);
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  requireRecovery(
    value &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype,
    "noncanonical-recovery-value",
  );
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
export function recoveryDigest(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

/**
 * Commit every parsed Wrangler field except the authorization envelope and its
 * own digest. The complete final bytes are hashed separately in deployment
 * receipts. No other field, whitespace inside a string, or array order is lost.
 */
export function recoveryConfigurationDigest(config) {
  const candidate = structuredClone(config);
  requireRecovery(
    candidate?.vars && typeof candidate.vars === "object",
    "recovery-config-vars-missing",
  );
  delete candidate.vars.RECOVERY_AUTHORIZATION;
  delete candidate.vars.RECOVERY_CONFIG_SHA256;
  return recoveryDigest(candidate);
}

export function signRecoveryAuthorization(claims, privateKey) {
  requireRecovery(validateRecoveryClaims(claims), "invalid-recovery-claims");
  let key;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw new RecoveryVerificationError("recovery-signing-key-invalid");
  }
  requireRecovery(
    key.asymmetricKeyType === "ed25519",
    "recovery-signing-key-invalid",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(null, Buffer.from(RECOVERY_AUTHORIZATION_DOMAIN + payload), key).toString("base64url")}`;
}

export function signedRecoveryConfiguration(config, claims, privateKey) {
  const result = structuredClone(config);
  requireRecovery(
    result?.vars?.RECOVERY_VERIFICATION_KEY ===
      createPublicKey(createPrivateKey(privateKey))
        .export({ type: "spki", format: "pem" })
        .toString(),
    "recovery-signing-key-not-pinned",
  );
  result.vars.RECOVERY_NAMESPACE_IDENTITY = canonicalJson(
    claims.namespaceIdentity,
  );
  result.vars.RECOVERY_CONFIG_SHA256 = recoveryConfigurationDigest(result);
  const bound = { ...claims, configSha256: result.vars.RECOVERY_CONFIG_SHA256 };
  result.vars.RECOVERY_AUTHORIZATION = signRecoveryAuthorization(
    bound,
    privateKey,
  );
  verifyRecoveryConfiguration(result);
  return result;
}

export function verifyRecoveryConfiguration(config, now = Date.now()) {
  const vars = config?.vars;
  requireRecovery(
    vars && typeof vars === "object",
    "recovery-config-vars-missing",
  );
  if (RECOVERY_BINDINGS.every((name) => vars[name] === undefined)) return null;
  requireRecovery(
    RECOVERY_BINDINGS.every(
      (name) => typeof vars[name] === "string" && vars[name].length > 0,
    ),
    "partial-recovery-bindings",
  );
  const claims = verifyRecoveryAuthorization(
    vars.RECOVERY_AUTHORIZATION,
    vars.RECOVERY_VERIFICATION_KEY,
    now,
  );
  requireRecovery(claims, "recovery-authorization-invalid");
  let identity;
  try {
    identity = validateRecoveryNamespaceIdentity(
      JSON.parse(vars.RECOVERY_NAMESPACE_IDENTITY),
    );
  } catch {
    /* Reject malformed identity below. */
  }
  requireRecovery(
    identity &&
      canonicalJson(identity) === canonicalJson(claims.namespaceIdentity),
    "recovery-namespace-identity-mismatch",
  );
  requireRecovery(
    claims.environment === vars.RELEASE_ENVIRONMENT &&
      claims.buildSha === vars.RELEASE_BUILD_SHA &&
      claims.configSha256 === vars.RECOVERY_CONFIG_SHA256 &&
      claims.configSha256 === recoveryConfigurationDigest(config) &&
      identity.accountId === config.account_id &&
      identity.workerName === config.name &&
      config.kv_namespaces?.length === 1 &&
      config.kv_namespaces[0].binding === "OAUTH_KV" &&
      config.kv_namespaces[0].id === identity.namespaces.OAUTH_KV,
    "recovery-config-substitution",
  );
  const expected = {
    TABLES: "TableDO",
    GUESTS: "GuestDO",
    OAUTH_SERIALIZER: "OAuthTokenDO",
    ADMISSION: "AdmissionDO",
  };
  requireRecovery(
    config.durable_objects?.bindings?.length === 4 &&
      Object.entries(expected).every(
        ([name, className]) =>
          config.durable_objects.bindings.filter(
            (binding) =>
              binding.name === name &&
              binding.class_name === className &&
              Object.keys(binding).sort().join(",") === "class_name,name",
          ).length === 1,
      ),
    "recovery-do-binding-substitution",
  );
  if (claims.phase === "reset") {
    requireRecovery(
      vars.RESTORE_QUARANTINE === "true" &&
        FLAGS.every((name) => vars[name] === "false") &&
        config.durable_objects.code_update_strategy?.mode === "immediate",
      "recovery-reset-not-frozen",
    );
  } else {
    requireRecovery(
      vars.RESTORE_QUARANTINE === "false",
      "recovery-serve-not-cleared",
    );
  }
  return claims;
}

export function verifyRecoveryProviderIdentity(identity, observed) {
  requireRecovery(
    identity &&
      observed &&
      identity.accountId === observed.accountId &&
      identity.workerName === observed.workerName &&
      identity.namespaces.OAUTH_KV === observed.kvId &&
      Object.keys(identity.commitments).every(
        (name) => identity.namespaces[name] === observed.doNamespaces?.[name],
      ),
    "recovery-provider-identity-changed",
  );
}

/** Current generation comes from the independent journal and live deployment. */
export function verifyRecoveryContinuity({
  config,
  observed,
  journal,
  now = Date.now(),
}) {
  requireRecovery(
    journal &&
      Object.hasOwn(journal, "record") &&
      Object.hasOwn(journal, "headSha"),
    "recovery-journal-unavailable",
  );
  const candidate = verifyRecoveryConfiguration(config, now);
  const active = observed.textBindings;
  const hasActive = RECOVERY_BINDINGS.some(
    (name) => active[name] !== undefined,
  );
  if (journal.record === null) {
    requireRecovery(
      candidate === null && !hasActive,
      "recovery-history-missing",
    );
    return;
  }
  const record = journal.record;
  requireRecovery(record.state === "cleared", "recovery-in-progress");
  requireRecovery(
    candidate?.phase === "serve" && hasActive,
    "recovery-fence-removal-refused",
  );
  const previous = verifyRecoveryAuthorization(
    active.RECOVERY_AUTHORIZATION,
    active.RECOVERY_VERIFICATION_KEY,
    now,
  );
  requireRecovery(
    previous?.phase === "serve" &&
      previous.buildSha === active.RELEASE_BUILD_SHA &&
      previous.configSha256 === active.RECOVERY_CONFIG_SHA256 &&
      active.RESTORE_QUARANTINE === "false" &&
      active.RECOVERY_VERIFICATION_KEY ===
        config.vars.RECOVERY_VERIFICATION_KEY,
    "recovery-live-authority-unverified",
  );
  for (const claims of [candidate, previous]) {
    requireRecovery(
      claims.generation === record.generation &&
        claims.operationId === record.operationId &&
        claims.environment === record.environment &&
        claims.schemaVersion === record.schemaVersion &&
        claims.planSha256 === record.planSha256 &&
        claims.evidenceSha256 === record.evidenceSha256 &&
        canonicalJson(claims.namespaceIdentity) ===
          canonicalJson(record.namespaceIdentity),
      "recovery-generation-replay",
    );
  }
  verifyRecoveryProviderIdentity(record.namespaceIdentity, observed);
}
