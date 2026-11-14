import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";

export const RECOVERY_AUTHORIZATION_DOMAIN =
  "agent-table/recovery-authorization/v1\n";
export const RECOVERY_NAMESPACE_COMMITMENT_NAME =
  "agent-table/recovery-namespace/v1";
export const RECOVERY_DO_BINDINGS = [
  "TABLES",
  "GUESTS",
  "OAUTH_SERIALIZER",
  "ADMISSION",
] as const;
export type RecoveryDoBinding = (typeof RECOVERY_DO_BINDINGS)[number];

export interface RecoveryNamespaceIdentity {
  accountId: string;
  workerName: string;
  namespaces: Record<RecoveryDoBinding | "OAUTH_KV", string>;
  commitments: Record<RecoveryDoBinding, string>;
}

export interface RecoveryClaims {
  format: "agent-table.fresh-start.v1";
  phase: "reset" | "serve";
  operationId: string;
  generation: string;
  environment: "local" | "staging" | "production";
  buildSha: string;
  configSha256: string;
  schemaVersion: 12;
  namespaceIdentity: RecoveryNamespaceIdentity;
  planSha256: string;
  evidenceSha256: string | null;
  previousRecordSha256: string;
  issuedAt: string;
  expiresAt: string | null;
  approvalRef: string;
}

export type RecoveryContext =
  | { kind: "legacy" }
  | { kind: "denied" }
  | { kind: "authorized"; claims: RecoveryClaims };

export type RecoveryBindings = Partial<
  Pick<
    Env,
    | "RECOVERY_AUTHORIZATION"
    | "RECOVERY_VERIFICATION_KEY"
    | "RECOVERY_CONFIG_SHA256"
    | "RECOVERY_NAMESPACE_IDENTITY"
    | "RELEASE_ENVIRONMENT"
    | "RELEASE_BUILD_SHA"
    | RecoveryDoBinding
  >
>;

const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const RESOURCE_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RECOVERY_FIELDS = [
  "RECOVERY_AUTHORIZATION",
  "RECOVERY_VERIFICATION_KEY",
  "RECOVERY_CONFIG_SHA256",
  "RECOVERY_NAMESPACE_IDENTITY",
] as const;
const CLAIM_FIELDS = [
  "format",
  "phase",
  "operationId",
  "generation",
  "environment",
  "buildSha",
  "configSha256",
  "schemaVersion",
  "namespaceIdentity",
  "planSha256",
  "evidenceSha256",
  "previousRecordSha256",
  "issuedAt",
  "expiresAt",
  "approvalRef",
] as const;

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function instant(value: unknown): number | null {
  if (typeof value !== "string" || value.length !== 24) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

export function validateRecoveryNamespaceIdentity(
  value: unknown,
): RecoveryNamespaceIdentity | null {
  if (
    !exactObject(value, [
      "accountId",
      "workerName",
      "namespaces",
      "commitments",
    ]) ||
    typeof value.accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.accountId) ||
    typeof value.workerName !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.workerName) ||
    !exactObject(value.namespaces, [...RECOVERY_DO_BINDINGS, "OAUTH_KV"]) ||
    !exactObject(value.commitments, RECOVERY_DO_BINDINGS)
  )
    return null;
  for (const name of [...RECOVERY_DO_BINDINGS, "OAUTH_KV"] as const) {
    if (
      typeof value.namespaces[name] !== "string" ||
      !RESOURCE_ID.test(value.namespaces[name])
    )
      return null;
  }
  for (const name of RECOVERY_DO_BINDINGS) {
    if (
      typeof value.commitments[name] !== "string" ||
      !SHA256.test(value.commitments[name])
    )
      return null;
  }
  if (new Set(Object.values(value.namespaces)).size !== 5) return null;
  return value as unknown as RecoveryNamespaceIdentity;
}

/** Pure structural validation, also consumed by the protected operator tooling. */
export function validateRecoveryClaims(value: unknown): RecoveryClaims | null {
  if (
    !exactObject(value, CLAIM_FIELDS) ||
    value.format !== "agent-table.fresh-start.v1" ||
    (value.phase !== "reset" && value.phase !== "serve") ||
    typeof value.operationId !== "string" ||
    !UUID.test(value.operationId) ||
    typeof value.generation !== "string" ||
    !SHA256.test(value.generation) ||
    !["local", "staging", "production"].includes(String(value.environment)) ||
    typeof value.buildSha !== "string" ||
    !SHA1.test(value.buildSha) ||
    typeof value.configSha256 !== "string" ||
    !SHA256.test(value.configSha256) ||
    value.schemaVersion !== 12 ||
    !validateRecoveryNamespaceIdentity(value.namespaceIdentity) ||
    typeof value.planSha256 !== "string" ||
    !SHA256.test(value.planSha256) ||
    (value.evidenceSha256 !== null &&
      (typeof value.evidenceSha256 !== "string" ||
        !SHA256.test(value.evidenceSha256))) ||
    typeof value.previousRecordSha256 !== "string" ||
    !SHA256.test(value.previousRecordSha256) ||
    typeof value.approvalRef !== "string" ||
    value.approvalRef.length < 1 ||
    value.approvalRef.length > 512 ||
    !/^[!-~]+$/.test(value.approvalRef)
  )
    return null;
  const issuedAt = instant(value.issuedAt);
  if (issuedAt === null) return null;
  if (value.phase === "serve") {
    if (value.expiresAt !== null || value.evidenceSha256 === null) return null;
  } else {
    const expiresAt = instant(value.expiresAt);
    if (
      expiresAt === null ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 60 * 60_000
    )
      return null;
  }
  return value as unknown as RecoveryClaims;
}

function identityBytes(value: RecoveryNamespaceIdentity): string {
  return JSON.stringify({
    accountId: value.accountId,
    workerName: value.workerName,
    namespaces: Object.fromEntries(
      [...RECOVERY_DO_BINDINGS, "OAUTH_KV"].map((name) => [
        name,
        value.namespaces[name as keyof typeof value.namespaces],
      ]),
    ),
    commitments: Object.fromEntries(
      RECOVERY_DO_BINDINGS.map((name) => [name, value.commitments[name]]),
    ),
  });
}

// Cache only immutable signature work. Current time, bindings and object state
// are checked again by every decision; a cached signature is never an allow cache.
const signatures = new Map<string, RecoveryClaims | null>();

function verifiedClaims(encoded: string, pem: string): RecoveryClaims | null {
  const cacheKey = `${pem}\n${encoded}`;
  if (signatures.has(cacheKey)) return signatures.get(cacheKey) ?? null;
  let claims: RecoveryClaims | null = null;
  try {
    const parts = encoded.split(".");
    if (
      parts.length !== 2 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw new Error("Invalid envelope");
    const payload = Buffer.from(parts[0], "base64url");
    const signature = Buffer.from(parts[1], "base64url");
    if (
      payload.toString("base64url") !== parts[0] ||
      signature.toString("base64url") !== parts[1] ||
      signature.length !== 64
    )
      throw new Error("Invalid encoding");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    const parsed: unknown = JSON.parse(decoded);
    if (JSON.stringify(parsed) !== decoded)
      throw new Error("Noncanonical payload");
    const candidate = validateRecoveryClaims(parsed);
    const key = createPublicKey(pem);
    if (
      !candidate ||
      key.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.from(RECOVERY_AUTHORIZATION_DOMAIN + parts[0]),
        key,
        signature,
      )
    )
      throw new Error("Invalid authorization");
    Object.freeze(candidate.namespaceIdentity.namespaces);
    Object.freeze(candidate.namespaceIdentity.commitments);
    Object.freeze(candidate.namespaceIdentity);
    claims = Object.freeze(candidate);
  } catch {
    claims = null;
  }
  if (signatures.size >= 32) {
    const first = signatures.keys().next().value;
    if (first !== undefined) signatures.delete(first);
  }
  signatures.set(cacheKey, claims);
  return claims;
}

export function verifyRecoveryAuthorization(
  authorization: string,
  verificationKey: string,
  now = Date.now(),
): RecoveryClaims | null {
  if (
    typeof authorization !== "string" ||
    authorization.length === 0 ||
    authorization.length > 32_768 ||
    typeof verificationKey !== "string" ||
    verificationKey.length === 0 ||
    verificationKey.length > 4_096 ||
    !Number.isSafeInteger(now)
  )
    return null;
  const claims = verifiedClaims(authorization, verificationKey);
  if (
    !claims ||
    Date.parse(claims.issuedAt) > now ||
    (claims.expiresAt !== null && now >= Date.parse(claims.expiresAt))
  )
    return null;
  return claims;
}

export function recoveryContext(env: RecoveryBindings): RecoveryContext {
  if (RECOVERY_FIELDS.every((name) => env[name] === undefined))
    return { kind: "legacy" };
  const denied = { kind: "denied" } as const;
  if (
    RECOVERY_FIELDS.some(
      (name) => typeof env[name] !== "string" || env[name]?.length === 0,
    ) ||
    (env.RECOVERY_AUTHORIZATION?.length ?? 0) > 32_768 ||
    (env.RECOVERY_VERIFICATION_KEY?.length ?? 0) > 4_096 ||
    (env.RECOVERY_NAMESPACE_IDENTITY?.length ?? 0) > 8_192 ||
    !SHA256.test(env.RECOVERY_CONFIG_SHA256 ?? "")
  )
    return denied;
  const claims = verifyRecoveryAuthorization(
    env.RECOVERY_AUTHORIZATION ?? "",
    env.RECOVERY_VERIFICATION_KEY ?? "",
  );
  if (
    !claims ||
    claims.environment !== env.RELEASE_ENVIRONMENT ||
    claims.buildSha !== env.RELEASE_BUILD_SHA ||
    claims.configSha256 !== env.RECOVERY_CONFIG_SHA256 ||
    Date.parse(claims.issuedAt) > Date.now() ||
    (claims.expiresAt !== null && Date.now() >= Date.parse(claims.expiresAt))
  )
    return denied;
  try {
    const identity = validateRecoveryNamespaceIdentity(
      JSON.parse(env.RECOVERY_NAMESPACE_IDENTITY ?? ""),
    );
    if (
      !identity ||
      identityBytes(identity) !== identityBytes(claims.namespaceIdentity)
    )
      return denied;
    for (const name of RECOVERY_DO_BINDINGS) {
      if (
        env[name]?.idFromName(RECOVERY_NAMESPACE_COMMITMENT_NAME).toString() !==
        identity.commitments[name]
      )
        return denied;
    }
  } catch {
    return denied;
  }
  return { kind: "authorized", claims };
}

export function recoveryEnvironmentDenied(env: RecoveryBindings): boolean {
  const context = recoveryContext(env);
  return (
    context.kind === "denied" ||
    (context.kind === "authorized" && context.claims.phase !== "serve")
  );
}

export function recoveryServingGeneration(
  env: RecoveryBindings,
): string | null {
  const context = recoveryContext(env);
  if (context.kind === "legacy") return null;
  if (context.kind === "authorized" && context.claims.phase === "serve")
    return context.claims.generation;
  throw new Error("Recovery authorization unavailable");
}
