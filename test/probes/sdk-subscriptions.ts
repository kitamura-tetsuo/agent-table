import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  InMemoryServerEventBus,
  McpServer,
} from "@modelcontextprotocol/server";

const URI = "agent-table://sdk-probe/own-inbox";
const FOREIGN_URI = "agent-table://sdk-probe/other-inbox";

/** SDK-only compatibility fixture: no application authorization or TableDO. */
async function fixture(
  options: { disabled?: boolean; capacity?: number } = {},
) {
  const bus = new InMemoryServerEventBus();
  const frames: Array<Record<string, unknown>> = [];
  const handler = createMcpHandler(
    () =>
      new McpServer(
        { name: "subscription-sdk-probe", version: "1" },
        {
          capabilities: {
            resources: { subscribe: !options.disabled, listChanged: false },
            tools: { listChanged: false },
          },
        },
      ),
    {
      legacy: "reject",
      keepAliveMs: 0,
      bus,
      maxSubscriptions: options.capacity ?? 1,
    },
  );
  const client = new Client(
    { name: "subscription-sdk-probe", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  let onUpdate: (() => void) | undefined;
  client.setNotificationHandler("notifications/resources/updated", () => {
    onUpdate?.();
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (url, init) => {
        const response = await handler.fetch(new Request(url, init));
        if (
          !response.body ||
          !response.headers.get("Content-Type")?.startsWith("text/event-stream")
        ) {
          return response;
        }
        const decoder = new TextDecoder();
        let pending = "";
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              pending += decoder.decode(chunk, { stream: true });
              const parts = pending.split("\n\n");
              pending = parts.pop() ?? "";
              for (const frame of parts) {
                const data = frame
                  .split("\n")
                  .find((line) => line.startsWith("data: "));
                if (data) frames.push(JSON.parse(data.slice(6)));
              }
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      },
    }),
  );
  return {
    bus,
    handler,
    client,
    frames,
    nextUpdate: () =>
      new Promise<void>((resolve) => {
        onUpdate = resolve;
      }),
    async dispose() {
      await handler.close();
      await client.close();
    },
  };
}

export async function probeAckUpdateCompletion() {
  const f = await fixture();
  try {
    const stream = await f.client.listen({
      resourceSubscriptions: [URI],
      toolsListChanged: true,
    });
    assert.deepEqual(stream.honoredFilter, { resourceSubscriptions: [URI] });
    assert.equal(
      f.frames[0]?.method,
      "notifications/subscriptions/acknowledged",
    );
    assert.equal(f.bus.listenerCount, 1);
    f.handler.notify.resourceUpdated(FOREIGN_URI);
    const update = f.nextUpdate();
    f.handler.notify.resourceUpdated(URI);
    await update;
    await f.handler.close();
    assert.equal(await stream.closed, "graceful");
    assert.equal(f.bus.listenerCount, 0);
    assert.equal(f.frames.length, 3);
    assert.equal(f.frames[1]?.method, "notifications/resources/updated");
    const ack = f.frames[0]?.params as { _meta: Record<string, unknown> };
    const note = f.frames[1]?.params as {
      uri: string;
      _meta: Record<string, unknown>;
    };
    assert.equal(note.uri, URI);
    assert.equal(
      note._meta["io.modelcontextprotocol/subscriptionId"],
      ack._meta["io.modelcontextprotocol/subscriptionId"],
    );
    assert.equal(
      f.frames[2]?.id,
      ack._meta["io.modelcontextprotocol/subscriptionId"],
    );
  } finally {
    await f.dispose();
  }
}

export async function probeCancellationAndReconnect() {
  const f = await fixture();
  try {
    const first = await f.client.listen({ resourceSubscriptions: [URI] });
    await first.close();
    assert.equal(await first.closed, "local");
    // The transport's aborted body must release the server listener, not just
    // settle the client's local handle. Reopen only after that cleanup runs.
    for (
      let attempt = 0;
      f.bus.listenerCount !== 0 && attempt < 20;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(f.bus.listenerCount, 0);
    const second = await f.client.listen({ resourceSubscriptions: [URI] });
    assert.equal(f.bus.listenerCount, 1);
    await f.handler.close();
    assert.equal(await second.closed, "graceful");
  } finally {
    await f.dispose();
  }
}

export async function probeDisabledCapabilities() {
  const f = await fixture({ disabled: true });
  try {
    const stream = await f.client.listen({
      resourceSubscriptions: [URI],
      toolsListChanged: true,
    });
    assert.deepEqual(stream.honoredFilter, {});
    assert.equal(await stream.closed, "graceful");
    assert.equal(f.bus.listenerCount, 0);
  } finally {
    await f.dispose();
  }
}

export async function probeZeroCapacityRefusal() {
  const f = await fixture({ disabled: true, capacity: 0 });
  try {
    await assert.rejects(f.client.listen({ resourceSubscriptions: [URI] }), {
      code: -32603,
      message: /Subscription limit reached/,
    });
    assert.equal(f.frames.length, 0);
    assert.equal(f.bus.listenerCount, 0);
  } finally {
    await f.dispose();
  }
}
