import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  boundedRetryAfterSeconds,
  createStatusOnlyPrototypeSender,
} from "./egress-relay-prototype.mjs";

const destination = "https://callback.example.org/events";
const targets = [
  { origin: "https://callback.example.org", pathPrefix: "/events" },
];
test("message-only HTTP results preserve non-2xx without following redirects or retaining body", async () => {
  for (const status of [
    200, 204, 299, 301, 302, 307, 308, 400, 410, 413, 429, 500, 503, 599,
  ]) {
    let sent = 0,
      destroyed = 0,
      responseDestroyed = 0;
    const sender = createStatusOnlyPrototypeSender({
      clock: () => 100000,
      resolve: async () => ["8.8.8.8"],
      requestHttps: (options, receive) => {
        assert.equal(options.hostname, "callback.example.org");
        assert.equal(options.port, 443);
        assert.equal(options.path, "/events");
        const request = new EventEmitter();
        request.destroy = () => {
          destroyed++;
          options.agent.destroy();
        };
        request.end = () => {
          sent++;
          queueMicrotask(() => {
            const response = new EventEmitter();
            response.statusCode = status;
            response.headers = {
              location: "http://127.0.0.1/SECRET_SENTINEL",
              "retry-after": "9999",
            };
            response.destroy = () => {
              responseDestroyed++;
            };
            receive(response);
            assert.equal(response.listenerCount("data"), 0);
          });
        };
        return request;
      },
    });
    assert.deepEqual(
      await sender(destination, targets, new Uint8Array([1, 2])),
      {
        kind: "http",
        status,
        retryAfterState: "known",
        retryAfterSeconds: 900,
        retryAfterObservedAt: 100000,
      },
    );
    assert.equal(sent, 1);
    assert.equal(responseDestroyed, 1);
    assert.ok(destroyed >= 1);
  }
});
test("typed sender bounds Retry-After and validates exact HTTP-date without returning raw headers", () => {
  const now = Date.parse("Sun, 15 Nov 2026 12:00:00 GMT");
  for (const [value, expected] of [
    ["0", 0],
    ["15", 15],
    ["9999999999", 900],
    ["Sun, 15 Nov 2026 12:00:10 GMT", 10],
    ["Sun, 15 Nov 2026 11:00:00 GMT", 0],
    ["Sun, 15 Nov 2026 13:00:00 GMT", 900],
  ])
    assert.equal(boundedRetryAfterSeconds(value, now), expected);
  for (const value of [
    undefined,
    ["1", "2"],
    "1,2",
    "-1",
    "1.5",
    " 3 ",
    "99999999999",
    "bad",
    "Sun, 32 Nov 2026 12:00:10 GMT",
    "Mon, 15 Nov 2026 12:00:10 GMT",
    "1\r\nsecret",
  ])
    assert.equal(boundedRetryAfterSeconds(value, now), undefined);
});
test("DNS/TLS/network/deadline failures remain unknown, never fabricated HTTP or no-send", async () => {
  for (const scenario of ["dns", "network", "deadline", "invalid-status"]) {
    let sent = 0;
    const sender = createStatusOnlyPrototypeSender({
      clock: () => 100000,
      resolve: async () => {
        if (scenario === "dns") throw new Error("PRIVATE_DNS_SENTINEL");
        return ["8.8.8.8"];
      },
      schedule: (fn) => setTimeout(fn, 5),
      requestHttps: (options, receive) => {
        const request = new EventEmitter();
        request.destroy = () => options.agent.destroy();
        request.end = () => {
          sent++;
          queueMicrotask(() => {
            if (scenario === "network")
              request.emit("error", new Error("PRIVATE_TLS_SENTINEL"));
            if (scenario === "invalid-status")
              receive({ statusCode: 0, headers: {}, destroy() {} });
          });
        };
        return request;
      },
    });
    const outcome = await sender(destination, targets, new Uint8Array());
    assert.deepEqual(outcome, {
      kind: "unknown",
      reason: scenario === "deadline" ? "deadline" : "transport-error",
    });
    assert.equal(sent, scenario === "dns" ? 0 : 1);
  }
});
test("typed sender deadline across DNS cannot start a late request", async () => {
  let resolveDns,
    sent = 0;
  const sender = createStatusOnlyPrototypeSender({
    clock: () => 100000,
    resolve: () =>
      new Promise((r) => {
        resolveDns = r;
      }),
    schedule: (fn) => setTimeout(fn, 1),
    requestHttps: () => {
      sent++;
      throw new Error("unexpected");
    },
  });
  assert.deepEqual(await sender(destination, targets, new Uint8Array()), {
    kind: "unknown",
    reason: "deadline",
  });
  resolveDns(["8.8.8.8"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent, 0);
});
