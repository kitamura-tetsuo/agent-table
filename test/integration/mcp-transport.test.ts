import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("MCP OAuth authorization boundary", () => {
  it("challenges anonymous requests with the canonical resource and scope", async () => {
    const response = await exports.default.fetch("http://localhost:8787/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=",
    );
    const meta = await exports.default.fetch(
      "http://localhost:8787/.well-known/oauth-protected-resource/mcp",
    );
    expect(meta.status).toBe(200);
    const data = (await meta.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(data).toMatchObject({
      resource: "http://localhost:8787/mcp",
      authorization_servers: ["http://localhost:8787"],
    });
  });

  it("does not accept a forged actor header or unverified bearer token", async () => {
    const response = await exports.default.fetch("http://localhost:8787/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer not-a-valid-token",
        "x-agent-table-guest": crypto.randomUUID(),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(401);
  });
});
