/** Semantic commitment for an already validated, snapshotted relay operation.
 * Original forwarding timestamp/expiry are persisted separately and never renewed.
 * Caller-provided hashes are not trusted as proof of actual delivered bytes.
 */
export interface RelaySemanticOperation {
  kind?: "forward" | "message" | "challenge";
  audience: string;
  callerId: string;
  requestId: string;
  destination: string;
  headers: Record<string, string>;
  payload: string;
}
export async function relayOperationDigest(
  operation: RelaySemanticOperation,
): Promise<string> {
  const snapshot = structuredClone(operation);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      kind: snapshot.kind ?? "forward",
      audience: snapshot.audience,
      callerId: snapshot.callerId,
      requestId: snapshot.requestId,
      destination: snapshot.destination,
      headers: Object.fromEntries(
        Object.entries(canonicalRelayHeaders(snapshot.headers)).sort(
          ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
        ),
      ),
      payload: snapshot.payload,
    }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** HTTP field names are case-insensitive; duplicate aliases fail closed. */
export function canonicalRelayHeaders(
  input: Record<string, string>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error("invalid relay header");
    const key = name.toLowerCase();
    if (Object.hasOwn(output, key)) throw new Error("duplicate relay header");
    output[key] = value;
  }
  return output;
}
