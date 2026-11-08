import { describe, expect, it } from "vitest";
import { evaluateHostEvidence, HOST_CASES } from "../e2e/host/evidence";
import template from "../e2e/host/evidence.template.json";

describe("actual host interoperability evidence gate", () => {
  it("keeps the default untested host explicitly blocked", () => {
    const result = evaluateHostEvidence(template);
    expect(result.structurallyValid).toBe(true);
    expect(result.completeRecord).toBe(false);
    expect(result.missing).toContain(
      "actual host-origin traffic (not SDK-only)",
    );
    expect(result.missing).toContain(
      "actual client and server evidence for refreshedToken",
    );
  });

  it("cannot certify SDK-only observations or one missing denial", () => {
    const caseRecords = Object.fromEntries(
      HOST_CASES.map((name) => [
        name,
        {
          status: "passed",
          clientObservationRef: `client_${name}`,
          serverObservationRef: `server_${name}`,
        },
      ]),
    );
    const synthetic = {
      ...template,
      host: {
        product: "Synthetic Test Host",
        surface: "private MCP connector",
        exposedBuild: "synthetic-1",
        eligibility: "eligible",
        origin: "sdk-only",
      },
      deployment: {
        endpoint: "https://example.test/mcp",
        buildSha: "a".repeat(40),
        isolated: true,
      },
      observedAt: "2026-11-09T00:00:00Z",
      cases: caseRecords,
    };
    expect(evaluateHostEvidence(synthetic).completeRecord).toBe(false);
    const withHost = {
      ...synthetic,
      host: { ...synthetic.host, origin: "actual-host" },
    };
    // A structurally complete synthetic record tests the validator only.
    // It is NOT evidence that any external host test has run.
    expect(evaluateHostEvidence(withHost).completeRecord).toBe(true);
    const missingDenied = {
      ...withHost,
      cases: {
        ...withHost.cases,
        deniedConsent: {
          status: "blocked",
          clientObservationRef: null,
          serverObservationRef: null,
        },
      },
    };
    expect(evaluateHostEvidence(missingDenied).missing).toContain(
      "actual client and server evidence for deniedConsent",
    );
  });

  it("refuses unknown secret-bearing fields and incomplete observation IDs", () => {
    const invalid = {
      ...template,
      accessToken: "not-a-real-token",
    };
    expect(evaluateHostEvidence(invalid).structurallyValid).toBe(false);
    const malformed = {
      ...template,
      cases: {
        ...template.cases,
        createdTable: {
          status: "passed",
          clientObservationRef: "bad",
          serverObservationRef: null,
        },
      },
    };
    expect(evaluateHostEvidence(malformed).structurallyValid).toBe(false);
  });
});
