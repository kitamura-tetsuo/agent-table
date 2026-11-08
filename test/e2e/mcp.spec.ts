import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, test } from "@playwright/test";

test("official SDK negotiates against the live Wrangler HTTP server", async () => {
  const client = new Client(
    { name: "live-http-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp")),
    );
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
  } finally {
    await client.close();
  }
});
