import { exports } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

const endpoint = new URL("http://localhost:8787/mcp");

describe("official MCP SDK against the real Worker entry", () => {
  it("negotiates the 2026-07-28 transport without publishing private tools", async () => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set("host", endpoint.host);
        return exports.default.fetch(request);
      },
    });
    const client = new Client(
      { name: "runtime-integration-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getServerCapabilities()?.tools).toBeUndefined();
      expect(await client.listTools()).toEqual({ tools: [] });
      await expect(
        client.callTool({ name: "create_table", arguments: {} }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("explicitly rejects an unsupported legacy protocol", async () => {
    const request = new Request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "unsupported-client", version: "1.0.0" },
        },
      }),
    });
    request.headers.set("host", endpoint.host);
    const response = await exports.default.fetch(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: number; data: { supported: string[] } };
    };
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toEqual(["2026-07-28"]);
  });
});
