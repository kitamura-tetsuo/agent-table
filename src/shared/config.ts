/** The only two application-secret domains supported by this service. */
export type SecretPurpose = "invitation-response" | "callback-credential";

/** These bindings must be provisioned as Wrangler secrets, never as vars. */
export type SecretEncryptionBindings = Pick<
  Env,
  "INVITATION_RESPONSE_KEYRING" | "CALLBACK_CREDENTIAL_KEYRING"
>;

export type SecretEnvelopeFailure =
  | "invalid-input"
  | "invalid-envelope"
  | "unsupported-version"
  | "wrong-purpose"
  | "keyring-unavailable"
  | "invalid-keyring"
  | "key-unavailable"
  | "key-expired"
  | "authentication-failed";

/** Error text and properties must never include secret material or inputs. */
export class SecretEnvelopeError extends Error {
  constructor(readonly code: SecretEnvelopeFailure) {
    super(`Secret envelope failure: ${code}`);
    this.name = "SecretEnvelopeError";
  }
}

export interface VersionedSecretKey {
  id: string;
  key: string;
}

export interface PreviousSecretKey extends VersionedSecretKey {
  retiredAt: string;
  acceptUntil: string;
}

export interface SecretKeyring {
  current: VersionedSecretKey;
  previous: PreviousSecretKey[];
}

// A retired key cannot be retained as a decryption key indefinitely.
export const MAX_ROTATION_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_KEYRING_LENGTH = 8_192;
const MAX_PREVIOUS_KEYS = 2;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

function parseKey(value: unknown, previous: boolean): VersionedSecretKey {
  if (
    !isRecord(value) ||
    !hasExactly(
      value,
      previous ? ["id", "key", "retiredAt", "acceptUntil"] : ["id", "key"],
    ) ||
    typeof value.id !== "string" ||
    !KEY_ID.test(value.id) ||
    typeof value.key !== "string" ||
    value.key.length !== 43 ||
    !/^[A-Za-z0-9_-]+$/.test(value.key)
  ) {
    throw new SecretEnvelopeError("invalid-keyring");
  }
  return { id: value.id, key: value.key };
}

function parseInstant(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new SecretEnvelopeError("invalid-keyring");
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new SecretEnvelopeError("invalid-keyring");
  }
  return milliseconds;
}

export function readSecretKeyring(
  purpose: SecretPurpose,
  bindings: SecretEncryptionBindings,
): SecretKeyring {
  if (!bindings || typeof bindings !== "object") {
    throw new SecretEnvelopeError("keyring-unavailable");
  }
  let encoded: string | undefined;
  switch (purpose) {
    case "invitation-response":
      encoded = bindings.INVITATION_RESPONSE_KEYRING;
      break;
    case "callback-credential":
      encoded = bindings.CALLBACK_CREDENTIAL_KEYRING;
      break;
    default:
      throw new SecretEnvelopeError("invalid-input");
  }
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new SecretEnvelopeError("keyring-unavailable");
  }
  if (encoded.length > MAX_KEYRING_LENGTH) {
    throw new SecretEnvelopeError("invalid-keyring");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new SecretEnvelopeError("invalid-keyring");
  }
  if (
    !isRecord(parsed) ||
    !hasExactly(parsed, ["current", "previous"]) ||
    !Array.isArray(parsed.previous) ||
    parsed.previous.length > MAX_PREVIOUS_KEYS
  ) {
    throw new SecretEnvelopeError("invalid-keyring");
  }

  const current = parseKey(parsed.current, false);
  const previous: PreviousSecretKey[] = [];
  const ids = new Set([current.id]);
  for (const candidate of parsed.previous) {
    const key = parseKey(candidate, true);
    if (!isRecord(candidate) || ids.has(key.id)) {
      throw new SecretEnvelopeError("invalid-keyring");
    }
    ids.add(key.id);
    const retiredAt = parseInstant(candidate.retiredAt);
    const acceptUntil = parseInstant(candidate.acceptUntil);
    if (
      acceptUntil <= retiredAt ||
      acceptUntil - retiredAt > MAX_ROTATION_OVERLAP_MS
    ) {
      throw new SecretEnvelopeError("invalid-keyring");
    }
    previous.push({
      ...key,
      retiredAt: candidate.retiredAt as string,
      acceptUntil: candidate.acceptUntil as string,
    });
  }
  return { current, previous };
}
