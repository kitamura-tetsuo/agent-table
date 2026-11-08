import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { APPLICATION_SCHEMA_VERSION } from "../../schema/migrations";
import {
  MAX_ROTATION_OVERLAP_MS,
  type SecretEncryptionBindings,
  SecretEnvelopeError,
  type SecretKeyring,
} from "../../src/shared/config";
import {
  openSecret,
  SECRET_ENVELOPE_VERSION,
  sealSecret,
} from "../../src/shared/secret-envelope";

const context = { recordId: "table:4bd3d8c4-6e31-48b2-a516-217a1d782f2b" };
const formerKeyId = "2026-10";
const currentKeyId = "2026-11";
const retiredAt = "2026-11-08T00:00:00.000Z";
const acceptUntil = "2026-11-10T00:00:00.000Z";
const duringOverlap = Date.parse("2026-11-09T00:00:00.000Z");
const afterOverlap = Date.parse(acceptUntil);

// Synthetic test-only material. The actual keyrings are Workers secret bindings.
function syntheticKey(seed: number): string {
  const bytes = Array.from({ length: 32 }, (_, index) => (index + seed) % 256);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function ring(
  currentId: string,
  currentKey: string,
  previous: SecretKeyring["previous"] = [],
): string {
  return JSON.stringify({
    current: { id: currentId, key: currentKey },
    previous,
  });
}

function bindings(
  invitation = ring(currentKeyId, syntheticKey(1)),
  callback = ring(currentKeyId, syntheticKey(97)),
): SecretEncryptionBindings {
  return {
    INVITATION_RESPONSE_KEYRING: invitation,
    CALLBACK_CREDENTIAL_KEYRING: callback,
  };
}

async function failure(
  operation: () => Promise<unknown>,
  code: SecretEnvelopeError["code"],
): Promise<SecretEnvelopeError> {
  let rejected: unknown;
  try {
    await operation();
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(SecretEnvelopeError);
  expect((rejected as SecretEnvelopeError).code).toBe(code);
  return rejected as SecretEnvelopeError;
}

function alter(envelope: string, field: string, value: unknown): string {
  return JSON.stringify({ ...JSON.parse(envelope), [field]: value });
}

function tamperTag(ciphertext: string): string {
  const binary = atob(
    ciphertext
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(ciphertext.length / 4) * 4, "="),
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  bytes[bytes.length - 1] ^= 1;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("production Workers AES-GCM secret envelopes", () => {
  it("round-trips both domains using purpose-specific current keys and fresh nonces", async () => {
    const config = bindings();
    const invitation = "synthetic-invite-secret-keep-private";
    const callback = "synthetic-callback-credential-keep-private";
    const inviteEnvelope = await sealSecret(
      "invitation-response",
      invitation,
      context,
      config,
    );
    const callbackEnvelope = await sealSecret(
      "callback-credential",
      callback,
      context,
      config,
    );
    const repeatedEnvelope = await sealSecret(
      "invitation-response",
      invitation,
      context,
      config,
    );

    expect(
      await openSecret("invitation-response", inviteEnvelope, context, config),
    ).toBe(invitation);
    expect(
      await openSecret(
        "callback-credential",
        callbackEnvelope,
        context,
        config,
      ),
    ).toBe(callback);
    expect(inviteEnvelope).not.toBe(repeatedEnvelope);
    const parsed = JSON.parse(inviteEnvelope);
    expect(parsed.version).toBe(SECRET_ENVELOPE_VERSION);
    expect(parsed.keyId).toBe(currentKeyId);
    expect(parsed.purpose).toBe("invitation-response");
    expect(parsed.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(inviteEnvelope.includes(invitation)).toBe(false);
    expect(inviteEnvelope.includes(syntheticKey(1))).toBe(false);
    expect(callbackEnvelope.includes(callback)).toBe(false);
    expect(callbackEnvelope.includes(syntheticKey(97))).toBe(false);
  });

  it("stores ciphertext in a SQLite-backed TableDO and opens it after object reconstruction", async () => {
    const config = bindings();
    const secret = "ephemeral-invitation-response";
    const stub = env.TABLES.get(env.TABLES.idFromName(crypto.randomUUID()));
    const serialized = await sealSecret(
      "invitation-response",
      secret,
      context,
      config,
    );
    expect(await stub.schemaVersion()).toBe(APPLICATION_SCHEMA_VERSION);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TABLE secret_envelope_fixture (record_id TEXT PRIMARY KEY, envelope TEXT NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO secret_envelope_fixture (record_id, envelope) VALUES (?, ?)",
        context.recordId,
        serialized,
      );
    });
    await evictDurableObject(stub);

    const opened = await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ record_id: string; envelope: string }>(
          "SELECT record_id, envelope FROM secret_envelope_fixture",
        )
        .one();
      expect(row.envelope).toBe(serialized);
      expect(row.envelope.includes(secret)).toBe(false);
      return openSecret(
        "invitation-response",
        row.envelope,
        { recordId: row.record_id },
        bindings(),
      );
    });
    expect(opened).toBe(secret);
  });

  it("rejects malformed data, altered metadata/tag, wrong context and purpose", async () => {
    const config = bindings();
    const serialized = await sealSecret(
      "invitation-response",
      "sensitive-value",
      context,
      config,
    );
    const parsed = JSON.parse(serialized);

    await failure(
      () => openSecret("callback-credential", serialized, context, config),
      "wrong-purpose",
    );
    await failure(
      () =>
        openSecret(
          "invitation-response",
          serialized,
          { recordId: "table:another" },
          config,
        ),
      "authentication-failed",
    );
    await failure(
      () =>
        openSecret(
          "invitation-response",
          alter(serialized, "version", 2),
          context,
          config,
        ),
      "unsupported-version",
    );
    await failure(
      () =>
        openSecret(
          "invitation-response",
          alter(serialized, "keyId", "unknown"),
          context,
          config,
        ),
      "key-unavailable",
    );
    await failure(
      () =>
        openSecret(
          "invitation-response",
          alter(serialized, "purpose", "callback-credential"),
          context,
          config,
        ),
      "wrong-purpose",
    );
    await failure(
      () =>
        openSecret(
          "invitation-response",
          alter(serialized, "nonce", "AAAAAAAAAAAAAAAA"),
          context,
          config,
        ),
      "authentication-failed",
    );
    const alteredTag = tamperTag(parsed.ciphertext);
    await failure(
      () =>
        openSecret(
          "invitation-response",
          alter(serialized, "ciphertext", alteredTag),
          context,
          config,
        ),
      "authentication-failed",
    );
    await failure(
      () =>
        openSecret(
          "invitation-response",
          alter(serialized, "extra", "field"),
          context,
          config,
        ),
      "invalid-envelope",
    );
    await failure(
      () =>
        openSecret("invitation-response", `${serialized} `, context, config),
      "invalid-envelope",
    );
    await failure(
      () =>
        openSecret("invitation-response", "{".repeat(24_001), context, config),
      "invalid-envelope",
    );
  });

  it("authenticates a configured key ID even when another version has identical bytes", async () => {
    const key = syntheticKey(44);
    const config = bindings(
      ring(currentKeyId, key, [
        { id: formerKeyId, key, retiredAt, acceptUntil },
      ]),
    );
    const envelope = await sealSecret(
      "invitation-response",
      "version-bound",
      context,
      config,
    );
    await failure(
      () =>
        openSecret(
          "invitation-response",
          alter(envelope, "keyId", formerKeyId),
          context,
          config,
          duringOverlap,
        ),
      "authentication-failed",
    );
  });

  it("bounds input and refuses empty secret values", async () => {
    const config = bindings();
    const maximum = "x".repeat(16_384);
    const envelope = await sealSecret(
      "invitation-response",
      maximum,
      context,
      config,
    );
    expect(
      (await openSecret("invitation-response", envelope, context, config)) ===
        maximum,
    ).toBe(true);
    await failure(
      () => sealSecret("invitation-response", "", context, config),
      "invalid-input",
    );
    await failure(
      () =>
        sealSecret("invitation-response", "x".repeat(16_385), context, config),
      "invalid-input",
    );
  });

  it("uses only the current key for new writes and expires explicitly configured old reads", async () => {
    const old = syntheticKey(9);
    const newer = syntheticKey(10);
    const oldBindings = bindings(ring(formerKeyId, old));
    const oldEnvelope = await sealSecret(
      "invitation-response",
      "old-record",
      context,
      oldBindings,
    );
    const rotated = bindings(
      ring(currentKeyId, newer, [
        { id: formerKeyId, key: old, retiredAt, acceptUntil },
      ]),
    );
    const newEnvelope = await sealSecret(
      "invitation-response",
      "new-record",
      context,
      rotated,
    );
    expect(JSON.parse(newEnvelope).keyId).toBe(currentKeyId);
    expect(
      await openSecret(
        "invitation-response",
        oldEnvelope,
        context,
        rotated,
        duringOverlap,
      ),
    ).toBe("old-record");
    expect(
      await openSecret(
        "invitation-response",
        newEnvelope,
        context,
        rotated,
        duringOverlap,
      ),
    ).toBe("new-record");
    await failure(
      () =>
        openSecret(
          "invitation-response",
          oldEnvelope,
          context,
          rotated,
          afterOverlap,
        ),
      "key-expired",
    );
    await failure(
      () =>
        openSecret(
          "invitation-response",
          oldEnvelope,
          context,
          bindings(ring(currentKeyId, newer)),
          duringOverlap,
        ),
      "key-unavailable",
    );
    await failure(
      () =>
        openSecret(
          "invitation-response",
          oldEnvelope,
          context,
          rotated,
          Date.parse(retiredAt) - 1,
        ),
      "key-unavailable",
    );
    expect(
      await openSecret(
        "invitation-response",
        newEnvelope,
        context,
        rotated,
        afterOverlap,
      ),
    ).toBe("new-record");
    expect(MAX_ROTATION_OVERLAP_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("fails closed on absent, corrupt, duplicate or unbounded key configuration", async () => {
    const config = bindings();
    const envelope = await sealSecret(
      "invitation-response",
      "private",
      context,
      config,
    );
    const absent = {
      INVITATION_RESPONSE_KEYRING: undefined,
      CALLBACK_CREDENTIAL_KEYRING: undefined,
    };
    await failure(
      () => sealSecret("invitation-response", "private", context, absent),
      "keyring-unavailable",
    );
    await failure(
      () => openSecret("invitation-response", envelope, context, absent),
      "keyring-unavailable",
    );
    await failure(
      () =>
        sealSecret(
          "invitation-response",
          "private",
          context,
          bindings("not-json"),
        ),
      "invalid-keyring",
    );
    await failure(
      () =>
        sealSecret(
          "invitation-response",
          "private",
          context,
          bindings(ring("id", "bad")),
        ),
      "invalid-keyring",
    );
    const duplicate = bindings(
      ring(currentKeyId, syntheticKey(3), [
        { id: currentKeyId, key: syntheticKey(4), retiredAt, acceptUntil },
      ]),
    );
    await failure(
      () => sealSecret("invitation-response", "private", context, duplicate),
      "invalid-keyring",
    );
    const unbounded = bindings(
      ring(currentKeyId, syntheticKey(3), [
        {
          id: formerKeyId,
          key: syntheticKey(4),
          retiredAt,
          acceptUntil: "2026-12-01T00:00:00.000Z",
        },
      ]),
    );
    await failure(
      () => openSecret("invitation-response", envelope, context, unbounded),
      "invalid-keyring",
    );
  });

  it("does not log or disclose secret-bearing invalid input or cryptographic failure details", async () => {
    const secretSentinel = "no-disclosure-test-invitation-secret";
    const keySentinel = "no-disclosure-test-key-material";
    const observed: string[] = [];
    const capture = (...args: unknown[]) => {
      observed.push(args.map((argument) => String(argument)).join(" "));
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
    ];
    try {
      const malformed = `{"payload":"${secretSentinel}"}`;
      const error = await failure(
        () => openSecret("invitation-response", malformed, context, bindings()),
        "invalid-envelope",
      );
      const config = bindings(
        `{"current":{"id":"v1","key":"${keySentinel}"},"previous":[]}`,
      );
      const configError = await failure(
        () =>
          sealSecret("invitation-response", secretSentinel, context, config),
        "invalid-keyring",
      );
      const sealed = await sealSecret(
        "invitation-response",
        secretSentinel,
        context,
        bindings(),
      );
      const authenticationError = await failure(
        () =>
          openSecret(
            "invitation-response",
            sealed,
            { recordId: "table:wrong" },
            bindings(),
          ),
        "authentication-failed",
      );
      const output = [
        String(error.stack),
        String(configError.stack),
        String(authenticationError.stack),
        ...observed,
      ].join("\n");
      expect(output.includes(secretSentinel)).toBe(false);
      expect(output.includes(keySentinel)).toBe(false);
      expect(observed.length).toBe(0);
      expect("cause" in error).toBe(false);
      expect("cause" in authenticationError).toBe(false);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
