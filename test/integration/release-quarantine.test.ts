import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { rejectRestoredAccess } from "../../src/shared/release-quarantine";

const origin = "http://localhost:8787";

describe("restore quarantine ingress (actual Worker handler)", () => {
  it("denies all ordinary and protocol access in a quarantined release", async () => {
    for (const [path, method] of [
      ["/health", "GET"],
      ["/guest/me", "GET"],
      ["/mcp", "POST"],
      ["/oauth/token", "POST"],
      ["/guest/connections/revoke", "POST"],
      ["/join", "POST"],
    ] as const) {
      const response = await worker.fetch(
        new Request(`${origin}${path}`, { method }) as unknown as Parameters<
          typeof worker.fetch
        >[0],
        { ...env, RELEASE_ENVIRONMENT: "staging", RESTORE_QUARANTINE: "true" },
        createExecutionContext(),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("Service unavailable during recovery");
    }
  });

  it("denies staging or production access if the independent gate is missing or malformed", () => {
    for (const name of ["staging", "production"] as const) {
      expect(
        rejectRestoredAccess({ RELEASE_ENVIRONMENT: name }),
      ).not.toBeNull();
      expect(
        rejectRestoredAccess({
          RELEASE_ENVIRONMENT: name,
          RESTORE_QUARANTINE: "unknown",
        }),
      ).not.toBeNull();
    }
  });

  it("preserves ordinary local development defaults and explicit authorized release mode", () => {
    expect(rejectRestoredAccess({})).not.toBeNull();
    expect(
      rejectRestoredAccess({
        RELEASE_ENVIRONMENT: "local",
        RESTORE_QUARANTINE: "false",
      }),
    ).toBeNull();
    expect(
      rejectRestoredAccess({
        RELEASE_ENVIRONMENT: "staging",
        RESTORE_QUARANTINE: "false",
      }),
    ).toBeNull();
    expect(
      rejectRestoredAccess({
        RELEASE_ENVIRONMENT: "staging",
        RESTORE_QUARANTINE: "true",
      }),
    ).not.toBeNull();
  });
});
