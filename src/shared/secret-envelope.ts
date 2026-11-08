import {
  readSecretKeyring,
  type SecretEncryptionBindings,
  SecretEnvelopeError,
  type SecretPurpose,
  type VersionedSecretKey,
} from "./config";

export { SecretEnvelopeError } from "./config";

export const SECRET_ENVELOPE_VERSION = 1;
const MAX_SECRET_BYTES = 16_384;
const MAX_ENVELOPE_CHARACTERS = 24_000;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface SecretRecordContext {
  /** Stable owning record ID; not serialized into the envelope. */
  recordId: string;
}

interface SecretEnvelopeV1 {
  version: 1;
  keyId: string;
  purpose: SecretPurpose;
  nonce: string;
  ciphertext: string;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(
  value: unknown,
  maxBytes: number,
): Uint8Array<ArrayBuffer> | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 2 ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  ) {
    return null;
  }
  try {
    const binary = atob(
      value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
    if (binary.length > maxBytes) {
      return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function validateContext(context: SecretRecordContext): string {
  if (
    !context ||
    typeof context.recordId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(context.recordId)
  ) {
    throw new SecretEnvelopeError("invalid-input");
  }
  return context.recordId;
}

function additionalData(
  envelope: SecretEnvelopeV1,
  recordId: string,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify({
      version: envelope.version,
      keyId: envelope.keyId,
      purpose: envelope.purpose,
      recordId,
    }),
  );
}

async function importEncryptionKey(material: string): Promise<CryptoKey> {
  const bytes = decodeBase64Url(material, 32);
  if (!bytes) {
    throw new SecretEnvelopeError("invalid-keyring");
  }
  try {
    if (bytes.length !== 32) {
      throw new SecretEnvelopeError("invalid-keyring");
    }
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    throw new SecretEnvelopeError("invalid-keyring");
  } finally {
    bytes.fill(0);
  }
}

function parseEnvelope(value: string): SecretEnvelopeV1 {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ENVELOPE_CHARACTERS
  ) {
    throw new SecretEnvelopeError("invalid-envelope");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SecretEnvelopeError("invalid-envelope");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretEnvelopeError("invalid-envelope");
  }
  const fields = parsed as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 5 ||
    !["version", "keyId", "purpose", "nonce", "ciphertext"].every(
      (key) => key in fields,
    )
  ) {
    throw new SecretEnvelopeError("invalid-envelope");
  }
  if (fields.version !== SECRET_ENVELOPE_VERSION) {
    throw new SecretEnvelopeError("unsupported-version");
  }
  if (
    typeof fields.keyId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fields.keyId) ||
    (fields.purpose !== "invitation-response" &&
      fields.purpose !== "callback-credential")
  ) {
    throw new SecretEnvelopeError("invalid-envelope");
  }
  const nonce = decodeBase64Url(fields.nonce, NONCE_BYTES);
  const ciphertext = decodeBase64Url(
    fields.ciphertext,
    MAX_SECRET_BYTES + TAG_BYTES,
  );
  if (
    !nonce ||
    nonce.length !== NONCE_BYTES ||
    !ciphertext ||
    ciphertext.length < TAG_BYTES
  ) {
    throw new SecretEnvelopeError("invalid-envelope");
  }
  const envelope = fields as unknown as SecretEnvelopeV1;
  // Seal writes this canonical representation; reject ambiguous extra JSON syntax.
  if (JSON.stringify(envelope) !== value) {
    throw new SecretEnvelopeError("invalid-envelope");
  }
  return envelope;
}

function selectDecryptionKey(
  envelope: SecretEnvelopeV1,
  keyring: ReturnType<typeof readSecretKeyring>,
  now: number,
): VersionedSecretKey {
  if (envelope.keyId === keyring.current.id) {
    return keyring.current;
  }
  const previous = keyring.previous.find(
    (candidate) => candidate.id === envelope.keyId,
  );
  if (!previous) {
    throw new SecretEnvelopeError("key-unavailable");
  }
  if (now >= Date.parse(previous.acceptUntil)) {
    throw new SecretEnvelopeError("key-expired");
  }
  if (now < Date.parse(previous.retiredAt)) {
    throw new SecretEnvelopeError("key-unavailable");
  }
  return previous;
}

/** Seals only through the current Workers-secret key for the chosen domain. */
export async function sealSecret(
  purpose: SecretPurpose,
  plaintext: string,
  context: SecretRecordContext,
  bindings: SecretEncryptionBindings,
): Promise<string> {
  const recordId = validateContext(context);
  if (typeof plaintext !== "string") {
    throw new SecretEnvelopeError("invalid-input");
  }
  const bytes = encoder.encode(plaintext);
  try {
    if (bytes.length === 0 || bytes.length > MAX_SECRET_BYTES) {
      throw new SecretEnvelopeError("invalid-input");
    }
    const keyring = readSecretKeyring(purpose, bindings);
    const key = await importEncryptionKey(keyring.current.key);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const envelope: SecretEnvelopeV1 = {
      version: SECRET_ENVELOPE_VERSION,
      keyId: keyring.current.id,
      purpose,
      nonce: encodeBase64Url(nonce),
      ciphertext: "",
    };
    try {
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: additionalData(envelope, recordId),
          tagLength: 128,
        },
        key,
        bytes,
      );
      envelope.ciphertext = encodeBase64Url(new Uint8Array(ciphertext));
      return JSON.stringify(envelope);
    } catch {
      throw new SecretEnvelopeError("authentication-failed");
    }
  } finally {
    bytes.fill(0);
  }
}

/** Opening a stored envelope conveys no invitation or callback authorization. */
export async function openSecret(
  purpose: SecretPurpose,
  serialized: string,
  context: SecretRecordContext,
  bindings: SecretEncryptionBindings,
  now = Date.now(),
): Promise<string> {
  const recordId = validateContext(context);
  if (!Number.isFinite(now)) {
    throw new SecretEnvelopeError("invalid-input");
  }
  const envelope = parseEnvelope(serialized);
  if (envelope.purpose !== purpose) {
    throw new SecretEnvelopeError("wrong-purpose");
  }
  const keyring = readSecretKeyring(purpose, bindings);
  const material = selectDecryptionKey(envelope, keyring, now);
  const key = await importEncryptionKey(material.key);
  const nonce = decodeBase64Url(envelope.nonce, NONCE_BYTES);
  const ciphertext = decodeBase64Url(
    envelope.ciphertext,
    MAX_SECRET_BYTES + TAG_BYTES,
  );
  if (!nonce || !ciphertext) {
    throw new SecretEnvelopeError("invalid-envelope");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: additionalData(envelope, recordId),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    try {
      return decoder.decode(plaintext);
    } finally {
      new Uint8Array(plaintext).fill(0);
    }
  } catch {
    throw new SecretEnvelopeError("authentication-failed");
  }
}
