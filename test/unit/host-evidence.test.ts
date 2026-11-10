import { describe, expect, it } from "vitest";
import { evaluateHostEvidence, HOST_CASES } from "../e2e/host/evidence";
import partialHostRecord from "../e2e/host/evidence.chatgpt-work-2026-11-09.json";
import deniedHostRecord from "../e2e/host/evidence.chatgpt-work-2026-11-10-deny.json";
import pinnedHostRecord from "../e2e/host/evidence.chatgpt-work-2026-11-10-pinned.json";
import refreshedHostRecord from "../e2e/host/evidence.chatgpt-work-2026-11-10-refresh.json";
import revokedHostRecord from "../e2e/host/evidence.chatgpt-work-2026-11-10-revocation.json";
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

  it("keeps the redacted actual-host snapshot incomplete", () => {
    const result = evaluateHostEvidence(partialHostRecord);
    expect(result.structurallyValid).toBe(true);
    expect(result.completeRecord).toBe(false);
    expect(result.missing).toContain("isolated deployed Agent Table build SHA");
    expect(result.missing).toContain(
      "actual client and server evidence for deniedConsent",
    );
    expect(result.missing).toContain(
      "actual client and server evidence for createdTable",
    );
    expect(result.missing).toContain(
      "actual client and server evidence for readTable",
    );
  });

  it("does not certify a pinned Worker without exposed host build or denial", () => {
    const result = evaluateHostEvidence(pinnedHostRecord);
    expect(result.structurallyValid).toBe(true);
    expect(result.completeRecord).toBe(false);
    expect(result.missing).toContain("exact host product/build identity");
    expect(result.missing).toContain(
      "actual client and server evidence for deniedConsent",
    );
    expect(result.missing).toContain(
      "actual client and server evidence for createdTable",
    );
  });

  it("accepts a documented host Deny case without certifying the whole suite", () => {
    const result = evaluateHostEvidence(deniedHostRecord);
    expect(result.structurallyValid).toBe(true);
    expect(result.completeRecord).toBe(false);
    expect(deniedHostRecord.cases.deniedConsent.status).toBe("passed");
    expect(result.missing).not.toContain(
      "actual client and server evidence for deniedConsent",
    );
    expect(result.missing).toContain("exact host product/build identity");
    expect(result.missing).toContain(
      "actual client and server evidence for refreshedToken",
    );
  });

  it("accepts an independently bound host refresh/read but not the full run", () => {
    const result = evaluateHostEvidence(refreshedHostRecord);
    expect(result.structurallyValid).toBe(true);
    expect(result.completeRecord).toBe(false);
    expect(refreshedHostRecord.cases.refreshedToken.status).toBe("passed");
    expect(refreshedHostRecord.cases.readAfterRefresh.status).toBe("passed");
    expect(result.missing).not.toContain(
      "actual client and server evidence for refreshedToken",
    );
    expect(result.missing).not.toContain(
      "actual client and server evidence for readAfterRefresh",
    );
    expect(result.missing).toContain("exact host product/build identity");
    expect(result.missing).toContain(
      "actual client and server evidence for revokedInBrowser",
    );
  });

  it("records host broker refusal without claiming a protected MCP 401", () => {
    const result = evaluateHostEvidence(revokedHostRecord);
    expect(result.structurallyValid).toBe(true);
    expect(result.completeRecord).toBe(false);
    expect(revokedHostRecord.cases.revokedInBrowser.status).toBe("passed");
    expect(revokedHostRecord.cases.rejectedAfterRevocation.status).toBe(
      "passed",
    );
    // The host denied its protected operation at token refresh; this is not an MCP 401.
    expect(
      revokedHostRecord.cases.rejectedAfterRevocation.serverObservationRef,
    ).toBe("pr41_6756230954_oauth_token_400");
    expect(result.missing).not.toContain(
      "actual client and server evidence for revokedInBrowser",
    );
    expect(result.missing).not.toContain(
      "actual client and server evidence for rejectedAfterRevocation",
    );
    expect(result.missing).toContain("exact host product/build identity");
    expect(result.missing).toContain(
      "actual client and server evidence for createdTable",
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
