/** A temporary, staging-only, read-only Durable Objects SQLite diagnostic. */
const STAGING_ORIGIN = "https://agent-table-test.outliner-online.com";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type InspectionRequest = {
  guestId: string;
  tableId?: string;
  connectionId?: string;
};

export function stagingEvidenceEnabled(env: Env): boolean {
  return (
    env.PUBLIC_ORIGIN === STAGING_ORIGIN &&
    env.STAGING_EVIDENCE_MODE === "read-only"
  );
}

/** Fingerprint an independently random operation ID, never a personal field. */
export async function requestFingerprint(requestId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requestId),
  );
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function equalSecret(
  candidate: string | null,
  expected: string | undefined,
): boolean {
  if (
    !candidate ||
    !expected ||
    !/^[0-9a-f]{64}$/.test(candidate) ||
    !/^[0-9a-f]{64}$/.test(expected)
  )
    return false;
  let difference = 0;
  for (let i = 0; i < 64; i++)
    difference |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function inspectionRequest(value: unknown): InspectionRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["guestId", "tableId", "connectionId"].includes(key),
    ) ||
    typeof input.guestId !== "string" ||
    !UUID_V4.test(input.guestId) ||
    (input.tableId !== undefined &&
      (typeof input.tableId !== "string" || !UUID_V4.test(input.tableId))) ||
    (input.connectionId !== undefined &&
      (typeof input.connectionId !== "string" ||
        !UUID_V4.test(input.connectionId)))
  ) {
    return null;
  }
  return input as InspectionRequest;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Disabled by default and locked to the exact staging origin. Response contains
 * no raw identifiers, messages, guest identity, table title, or bearer credentials.
 */
export async function handleStagingEvidence(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!stagingEvidenceEnabled(env))
    return jsonResponse({ error: "not_found" }, 404);
  if (request.method !== "POST")
    return jsonResponse({ error: "method_not_allowed" }, 405);
  if (
    !equalSecret(
      request.headers.get("X-Agent-Table-Staging-Evidence"),
      env.STAGING_EVIDENCE_KEY,
    )
  )
    return jsonResponse({ error: "unauthorized" }, 401);
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    return jsonResponse({ error: "bad_request" }, 400);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 512)
    return jsonResponse({ error: "too_large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "bad_request" }, 400);
  }
  const parameters = inspectionRequest(parsed);
  if (!parameters) return jsonResponse({ error: "bad_request" }, 400);
  const guestId = parameters.guestId.toLowerCase();
  const tableId = parameters.tableId?.toLowerCase();
  const connectionId = parameters.connectionId?.toLowerCase();
  const guest = env.GUESTS.get(env.GUESTS.idFromName(guestId));
  const [guestSqlite, tableSqlite] = await Promise.all([
    guest.readStagingEvidence(guestId, tableId, connectionId),
    tableId
      ? env.TABLES.get(env.TABLES.idFromName(tableId)).readStagingEvidence(
          tableId,
          guestId,
        )
      : Promise.resolve(null),
  ]);
  return jsonResponse({
    evidence: "staging-durable-object-sqlite",
    capturedAt: Date.now(),
    guestSqlite,
    tableSqlite,
  });
}
