import { describe, expect, it } from "vitest";
import { parseCanonicalInboxFilter } from "../../src/mcp/subscriptions";

const tableId = "00000000-0000-4000-8000-000000000001";
const membershipId = "00000000-0000-4000-8000-000000000002";
const uri = `agent-table://tables/${tableId}/inbox/${membershipId}`;

describe("single canonical live subscription filter", () => {
  it("accepts only the pinned single private inbox shape", () => {
    expect(parseCanonicalInboxFilter({ resourceSubscriptions: [uri] })).toEqual(
      {
        uri,
        tableId,
        membershipId,
      },
    );
  });

  it.each([
    undefined,
    null,
    false,
    [],
    {},
    { resourceSubscriptions: [] },
    { resourceSubscriptions: [uri, uri] },
    { resourceSubscriptions: [uri, "agent-table://other"] },
    { resourceSubscriptions: ["https://example.com/inbox"] },
    { resourceSubscriptions: [`${uri}?x=1`] },
    { resourceSubscriptions: [`${uri}#fragment`] },
    { resourceSubscriptions: [`${uri}/`] },
    { resourceSubscriptions: [uri.toUpperCase()] },
    {
      resourceSubscriptions: [
        uri.replace("000000000001", "00000000000a").replace("a", "A"),
      ],
    },
    { resourceSubscriptions: [uri], toolsListChanged: true },
    { resourceSubscriptions: [uri], resourcesListChanged: false },
    { resourceSubscriptions: [uri], promptsListChanged: true },
    { toolsListChanged: true },
    { resourceSubscriptions: uri },
    { resourceSubscriptions: [null] },
    { resourceSubscriptions: [1] },
  ])("rejects unsupported or aliased filters: %j", (filter) => {
    expect(parseCanonicalInboxFilter(filter)).toBeNull();
  });

  it("never treats a parsed resource URI as authorization", () => {
    const otherMember = "00000000-0000-4000-8000-000000000003";
    const parsed = parseCanonicalInboxFilter({
      resourceSubscriptions: [
        `agent-table://tables/${tableId}/inbox/${otherMember}`,
      ],
    });
    // This parser only checks canonical syntax. The fresh actor/membership
    // authorization must happen in TableDO, not in edge-only filter parsing.
    expect(parsed?.membershipId).toBe(otherMember);
  });
});

describe("validated OAuth token deadline", () => {
  it("accepts only future safe integer seconds and converts once to milliseconds", async () => {
    const { validatedTokenDeadline } = await import(
      "../../src/mcp/subscriptions"
    );
    const seconds = Math.floor(Date.now() / 1000) + 60;
    expect(validatedTokenDeadline(seconds)).toBe(seconds * 1000);
    for (const value of [
      undefined,
      null,
      `${seconds}`,
      NaN,
      Infinity,
      0,
      seconds + 0.1,
      Math.floor(Date.now() / 1000),
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(validatedTokenDeadline(value)).toBeNull();
    }
  });
});
