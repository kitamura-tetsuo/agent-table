import { z } from "zod";

/**
 * Metadata-only record for actual host-origin OAuth interoperability.
 * References identify separately retained, redacted observations; never store
 * tokens, raw HTTP headers, cookies, authorization codes or private messages.
 */
export const HOST_CASES = [
  "deniedConsent",
  "guestChoice",
  "approvedConsent",
  "createdTable",
  "readTable",
  "refreshedToken",
  "readAfterRefresh",
  "revokedInBrowser",
  "rejectedAfterRevocation",
] as const;

const observationRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/);
const caseObservation = z.strictObject({
  status: z.enum(["not-run", "blocked", "failed", "passed"]),
  clientObservationRef: observationRef.nullable(),
  serverObservationRef: observationRef.nullable(),
});

export const hostEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  host: z.strictObject({
    product: z.string().min(1).max(80),
    surface: z.string().min(1).max(80),
    exposedBuild: z.string().min(1).max(100),
    eligibility: z.enum(["unknown", "eligible", "ineligible"]),
    origin: z.enum(["not-tested", "sdk-only", "actual-host"]),
  }),
  deployment: z.strictObject({
    endpoint: z.string().max(256).nullable(),
    buildSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
    isolated: z.boolean().nullable(),
  }),
  observedAt: z.string().datetime({ offset: true }).nullable(),
  syntheticRunTag: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  cases: z.record(z.enum(HOST_CASES), caseObservation),
  disconnect: z.enum(["not-run", "observed", "unsupported"]),
});

/**
 * Shape validation prevents accidentally reporting partial/SDK-only evidence
 * as a complete record. It does not attest that observations are genuine:
 * an independent reviewer must inspect the actual redacted host/server traces.
 */
export function evaluateHostEvidence(input: unknown): {
  structurallyValid: boolean;
  completeRecord: boolean;
  missing: string[];
} {
  const parsed = hostEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      structurallyValid: false,
      completeRecord: false,
      missing: parsed.error.issues.map(
        (issue) => `Invalid evidence field: ${issue.path.join(".") || "root"}`,
      ),
    };
  }

  const record = parsed.data;
  const missing: string[] = [];
  if (record.host.eligibility !== "eligible") {
    missing.push("eligible real host account");
  }
  if (record.host.origin !== "actual-host") {
    missing.push("actual host-origin traffic (not SDK-only)");
  }
  if (
    !record.host.exposedBuild.trim() ||
    record.host.exposedBuild.toLowerCase() === "unknown"
  ) {
    missing.push("exact host product/build identity");
  }
  if (!record.observedAt) missing.push("observation date");
  if (!record.deployment.isolated || !record.deployment.buildSha) {
    missing.push("isolated deployed Agent Table build SHA");
  }

  let canonicalResource = false;
  if (record.deployment.endpoint) {
    try {
      const endpoint = new URL(record.deployment.endpoint);
      canonicalResource =
        endpoint.protocol === "https:" &&
        endpoint.pathname === "/mcp" &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash &&
        endpoint.port === "";
    } catch {
      // Invalid or absent URLs never count as a verified deployed resource.
    }
  }
  if (!canonicalResource) missing.push("canonical isolated HTTPS /mcp endpoint");

  for (const name of HOST_CASES) {
    const observation = record.cases[name];
    if (
      observation.status !== "passed" ||
      !observation.clientObservationRef ||
      !observation.serverObservationRef
    ) {
      missing.push(`actual client and server evidence for ${name}`);
    }
  }

  return {
    structurallyValid: true,
    completeRecord: missing.length === 0,
    missing,
  };
}
