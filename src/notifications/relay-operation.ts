/** Semantic commitment for an already validated, snapshotted relay operation.
 * Original forwarding timestamp/expiry are persisted separately and never renewed.
 * Caller-provided hashes are not trusted as proof of actual delivered bytes.
 */
export interface RelaySemanticOperation {
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
      kind: "forward",
      audience: snapshot.audience,
      callerId: snapshot.callerId,
      requestId: snapshot.requestId,
      destination: snapshot.destination,
      headers: Object.fromEntries(
        Object.entries(snapshot.headers).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      ),
      payload: snapshot.payload,
    }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
