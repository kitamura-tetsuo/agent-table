import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  PinnedAgent,
  publicV4,
  preparePinnedRequest,
  checkedHeaders,
} from "./egress-relay-prototype.mjs";
const targets = [
  { origin: "https://callback.example.org", pathPrefix: "/events" },
];
test("reject forbidden, noncanonical and unsupported IPv6 addresses", () => {
  for (const ip of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.2",
    "203.0.113.2",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::ffff:8.8.8.8",
    "2001:4860:4860::8888",
    "0127.0.0.1",
    "127.1",
  ])
    assert.equal(publicV4(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "104.16.0.1"])
    assert.equal(publicV4(ip), true);
});
test("unreviewed destination refused before DNS; mixed A answer refused", async () => {
  let lookups = 0;
  const resolve = async () => {
    lookups++;
    return ["8.8.8.8", "127.0.0.1"];
  };
  await assert.rejects(
    preparePinnedRequest("https://evil.example.org/events", targets, resolve),
  );
  assert.equal(lookups, 0);
  await assert.rejects(
    preparePinnedRequest(
      "https://callback.example.org/events",
      targets,
      resolve,
    ),
    /address-rejected/,
  );
  for (const answer of [[], ["::1"], ["garbage"], Array(65).fill("8.8.8.8")])
    await assert.rejects(
      preparePinnedRequest(
        "https://callback.example.org/events",
        targets,
        async () => answer,
      ),
    );
});
test("resolve once, immutable literal pin, original TLS/HTTP hostname retained", async () => {
  let count = 0;
  const plan = await preparePinnedRequest(
    "https://callback.example.org/events/opaque?q=1",
    targets,
    async () => {
      count++;
      return ["8.8.8.8"];
    },
  );
  assert.equal(count, 1);
  assert.deepEqual(plan, {
    hostname: "callback.example.org",
    address: "8.8.8.8",
    path: "/events/opaque?q=1",
  });
  assert.ok(Object.isFrozen(plan));
  let options;
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.authorized = true;
  socket.remoteAddress = "8.8.8.8";
  socket.remotePort = 443;
  const agent = new PinnedAgent(plan, (opts) => {
    options = opts;
    return socket;
  });
  let delivered = 0;
  assert.equal(
    agent.createConnection({}, (error, actual) => {
      assert.equal(error, null);
      assert.equal(actual, socket);
      delivered++;
    }),
    undefined,
  );
  assert.equal(delivered, 0);
  assert.equal(options.host, "8.8.8.8");
  assert.equal(options.servername, "callback.example.org");
  assert.equal(options.rejectUnauthorized, true);
  assert.ok(
    options.checkServerIdentity("8.8.8.8", {
      subjectaltname: "DNS:wrong.example.org",
    }),
  );
  assert.equal(
    options.checkServerIdentity("ignored", {
      subjectaltname: "DNS:callback.example.org",
    }),
    undefined,
  );
  socket.emit("secureConnect");
  assert.equal(delivered, 1);
  socket.emit("error", new Error("synthetic"));
  assert.equal(delivered, 1);
});
test("peer mismatch, private peer and unauthorized TLS never release socket", () => {
  for (const [address, authorized, port] of [
    ["8.8.4.4", true, 443],
    ["127.0.0.1", true, 443],
    ["8.8.8.8", false, 443],
    ["8.8.8.8", true, 80],
  ]) {
    let destroyed = false;
    let result;
    const socket = new EventEmitter();
    Object.assign(socket, {
      remoteAddress: address,
      authorized,
      remotePort: port,
      destroy: () => {
        destroyed = true;
      },
    });
    const agent = new PinnedAgent(
      { hostname: "callback.example.org", address: "8.8.8.8" },
      () => socket,
    );
    agent.createConnection({}, (...args) => {
      result = args;
    });
    socket.emit("secureConnect");
    assert.equal(result[0].message, "connection-boundary-rejected");
    assert.equal(result[1], undefined);
    assert.equal(destroyed, true);
  }
});
test("reject caller Host, auth, hop-by-hop and CRLF header overrides", () => {
  for (const key of [
    "host",
    "authorization",
    "connection",
    "transfer-encoding",
    "content-length",
  ])
    assert.throws(() => checkedHeaders({ [key]: "x" }), /invalid-headers/);
  assert.throws(() => checkedHeaders({ "webhook-id": "x\r\ninjected:y" }));
  assert.equal(
    checkedHeaders({ "webhook-id": "synthetic" })["webhook-id"],
    "synthetic",
  );
  assert.equal(
    checkedHeaders({
      "x-mcp-signature": "synthetic",
      "x-mcp-subscription-id": "synthetic",
    })["x-mcp-signature"],
    "synthetic",
  );
});

test("agent destruction cancels TLS-pending socket exactly once", () => {
  const socket = new EventEmitter();
  let destroyed = 0,
    callbacks = 0;
  socket.destroy = () => {
    destroyed++;
    socket.emit("close");
  };
  const agent = new PinnedAgent(
    { hostname: "callback.example.org", address: "8.8.8.8" },
    () => socket,
  );
  agent.createConnection({}, (error, actual) => {
    assert.equal(error.message, "transport-error");
    assert.equal(actual, undefined);
    callbacks++;
  });
  agent.destroy();
  agent.destroy();
  socket.emit("secureConnect");
  assert.equal(callbacks, 1);
  assert.equal(destroyed, 1);
});
test("bounded sender: success, redirects, size, stream errors and deadline", async () => {
  const { createPrototypeSender } = await import(
    "./egress-relay-prototype.mjs"
  );
  for (const scenario of [
    "success",
    "challenge",
    "redirect",
    "large",
    "aborted",
    "deadline",
  ]) {
    let sent = 0,
      destroyed = 0;
    const sender = createPrototypeSender({
      resolve: async () => ["8.8.8.8"],
      schedule: (fn) => setTimeout(fn, 20),
      requestHttps: (options, onResponse) => {
        assert.equal(options.hostname, "callback.example.org");
        assert.equal(options.method, "POST");
        assert.equal(options.headers["content-length"], 2);
        const request = new EventEmitter();
        request.destroy = () => {
          destroyed++;
          options.agent.destroy();
        };
        request.end = (body) => {
          sent++;
          assert.deepEqual([...body], [1, 2]);
          queueMicrotask(() => {
            if (scenario === "deadline") return;
            const response = new EventEmitter();
            response.statusCode = scenario === "redirect" ? 302 : 204;
            response.destroy = () => {};
            onResponse(response);
            if (scenario === "challenge")
              response.emit("data", Buffer.from("synthetic-challenge"));
            if (scenario === "large")
              response.emit("data", Buffer.alloc(65537));
            if (scenario === "aborted") response.emit("aborted");
            response.emit("end");
          });
        };
        return request;
      },
    });
    const run = sender(
      "https://callback.example.org/events",
      targets,
      new Uint8Array([1, 2]),
    );
    if (scenario === "success")
      assert.deepEqual(await run, { status: 204, body: new Uint8Array() });
    else if (scenario === "challenge") {
      const result = await run;
      assert.equal(Buffer.from(result.body).toString(), "synthetic-challenge");
    } else
      await assert.rejects(
        run,
        scenario === "deadline" ? /deadline/ : /delivery-failed/,
      );
    assert.equal(sent, 1); // no redirect following or retries
    assert.ok(destroyed >= 1);
  }
});
test("DNS deadline cannot create a late request", async () => {
  const { createPrototypeSender } = await import(
    "./egress-relay-prototype.mjs"
  );
  let complete,
    requests = 0;
  const sender = createPrototypeSender({
    resolve: () =>
      new Promise((r) => {
        complete = r;
      }),
    schedule: (fn) => setTimeout(fn, 1),
    requestHttps: () => {
      requests++;
      throw new Error("unexpected network");
    },
  });
  await assert.rejects(
    sender("https://callback.example.org/events", targets, new Uint8Array()),
    /deadline/,
  );
  complete(["8.8.8.8"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 0);
});
