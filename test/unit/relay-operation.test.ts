import { expect, it } from "vitest";
import { relayOperationDigest } from "../../src/notifications/relay-operation";

it("matches the Node ingress semantic commitment and ignores header insertion order", async () => {
  const value = {
    audience: "test:synthetic-relay",
    callerId: "synthetic-worker-1",
    requestId: "synthetic-request-1",
    destination: "https://callback.example.org/events",
    headers: { "webhook-timestamp": "123", "content-type": "application/json" },
    payload: "AQI=",
  };
  const expected =
    "7e3f462c3664e018a2248d2e4962fff252aca67f0ec60997720ae19901199695";
  expect(await relayOperationDigest(value)).toBe(expected);
  expect(
    await relayOperationDigest({
      ...value,
      headers: {
        "content-type": "application/json",
        "webhook-timestamp": "123",
      },
    }),
  ).toBe(expected);
  for (const changed of [
    { ...value, requestId: "synthetic-request-2" },
    { ...value, payload: "Aw==" },
    { ...value, audience: "production:synthetic-relay" },
  ])
    expect(await relayOperationDigest(changed)).not.toBe(expected);
});
