import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  RECOVERY_AUTHORIZATION_DOMAIN,
  RECOVERY_DO_BINDINGS,
  RECOVERY_NAMESPACE_COMMITMENT_NAME,
  type RecoveryClaims,
} from "../../src/shared/recovery";

export function recoveryFixture(
  baseEnv: Env,
  overrides: Partial<RecoveryClaims> = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims: RecoveryClaims = {
    format: "agent-table.fresh-start.v1",
    phase: "serve",
    operationId: crypto.randomUUID(),
    generation: randomBytes(32).toString("hex"),
    environment: "local",
    buildSha: "a".repeat(40),
    configSha256: "b".repeat(64),
    schemaVersion: 12,
    namespaceIdentity: {
      accountId: "f".repeat(32),
      workerName: "agent-table-local",
      namespaces: {
        TABLES: "1".repeat(32),
        GUESTS: "2".repeat(32),
        OAUTH_SERIALIZER: "3".repeat(32),
        ADMISSION: "4".repeat(32),
        OAUTH_KV: "5".repeat(32),
      },
      commitments: Object.fromEntries(
        RECOVERY_DO_BINDINGS.map((name) => [
          name,
          baseEnv[name]
            .idFromName(RECOVERY_NAMESPACE_COMMITMENT_NAME)
            .toString(),
        ]),
      ) as RecoveryClaims["namespaceIdentity"]["commitments"],
    },
    planSha256: "c".repeat(64),
    evidenceSha256: "d".repeat(64),
    previousRecordSha256: "0".repeat(64),
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: null,
    approvalRef: "fixture-recovery-review",
    ...overrides,
  };
  const authorize = (
    patch: Partial<RecoveryClaims> = {},
    bindingOverrides: Partial<Env> = {},
  ): Env => {
    const current = { ...claims, ...patch };
    const encoded = Buffer.from(JSON.stringify(current)).toString("base64url");
    return {
      ...baseEnv,
      RELEASE_ENVIRONMENT: current.environment,
      RELEASE_BUILD_SHA: current.buildSha,
      RECOVERY_AUTHORIZATION: `${encoded}.${sign(null, Buffer.from(RECOVERY_AUTHORIZATION_DOMAIN + encoded), privateKey).toString("base64url")}`,
      RECOVERY_VERIFICATION_KEY: publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
      RECOVERY_CONFIG_SHA256: current.configSha256,
      RECOVERY_NAMESPACE_IDENTITY: JSON.stringify(current.namespaceIdentity),
      ...bindingOverrides,
    };
  };
  return { claims, authorize, env: authorize() };
}
