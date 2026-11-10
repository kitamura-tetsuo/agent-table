import { describe, expect, it } from "vitest";
import notificationsMarkdown from "../../docs/notifications.md?raw";
import referencesMarkdown from "../../docs/references.md?raw";
import denied from "../e2e/host/evidence.chatgpt-work-2026-11-10-deny.json";
import revoked from "../e2e/host/evidence.chatgpt-work-2026-11-10-revocation.json";

const summaries = [referencesMarkdown, notificationsMarkdown].map((markdown) =>
  markdown.replaceAll("**", "").replace(/\s+/g, " "),
);

describe("published host compatibility summaries", () => {
  it("reports passed Deny and broker OAuth 400 without inventing a host /mcp 401", () => {
    expect(denied.cases.deniedConsent.status).toBe("passed");
    expect(revoked.cases.rejectedAfterRevocation.serverObservationRef).toBe(
      "pr41_6756230954_oauth_token_400",
    );
    for (const summary of summaries) {
      expect(summary).toContain("Deny-without-grant passed");
      expect(summary).toMatch(
        /(?:broker's `\/oauth\/token`|token exchange) HTTP 400/,
      );
      expect(summary).toMatch(
        /(?:standalone|separately scripted) synthetic client, not ChatGPT/,
      );
      expect(summary).toContain("SQLite");
      expect(summary).toContain("revoked");
      expect(summary).not.toContain("browser-revocation-to-HTTP-401");
      expect(summary).not.toContain("Deny-without-grant, independent");
    }
  });

  it("keeps the candidate matrix unverified for autonomous/notification layers", () => {
    const candidate = notificationsMarkdown
      .split("\n")
      .find((line) => line.startsWith("| ChatGPT Work private MCP app"));
    expect(candidate).toBeDefined();
    expect(candidate).toContain("Deny passed");
    expect(candidate).toContain("synthetic-only `/mcp` 401");
    expect(candidate).toContain("latest grant independently confirmed revoked");
    expect(candidate).toContain("#23 partial");
    expect(candidate).toContain("**untested**");
  });
});
