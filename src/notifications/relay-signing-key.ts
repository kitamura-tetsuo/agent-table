import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
/** Canonical operator-provisioned Ed25519 PKCS8. No key generation or logging. */
export function relaySigningPublicKeySha256(encoded: unknown): string | null {
  if (
    typeof encoded !== "string" ||
    encoded.length > 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    return null;
  try {
    const der = Buffer.from(encoded, "base64");
    if (der.toString("base64") !== encoded) return null;
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !Buffer.from(key.export({ format: "der", type: "pkcs8" })).equals(der)
    )
      return null;
    return createHash("sha256")
      .update(createPublicKey(key).export({ format: "der", type: "spki" }))
      .digest("hex");
  } catch {
    return null;
  }
}
