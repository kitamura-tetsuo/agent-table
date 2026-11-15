import assert from "node:assert/strict";
import test from "node:test";
import { acceptedChallenge } from "../src/notifications/challenge.ts";
import { createResultOnlyChallengeVerifier } from "./egress-relay-challenge.mjs";
import { relayOperationDigest } from "./egress-relay-ingress-prototype.mjs";

const challenge = "123e4567-e89b-42d3-a456-426614174000";
const bytes = (value) => new TextEncoder().encode(value);
const envelope = () => ({
  version: 1,
  kind: "challenge",
  audience: "test:synthetic-relay",
  requestId: "synthetic-request-1",
  timestamp: 100000,
  destination: "https://callback.example.org/events",
  headers: { "content-type": "application/json" },
  payload: Buffer.from(
    JSON.stringify({ type: "verification", challenge }),
  ).toString("base64"),
});
const caller = "synthetic-worker-1";
const targets = [
  { origin: "https://callback.example.org", pathPrefix: "/events" },
];
test("oracle requires exact challenge string, not status/name/reflection shortcut", () => {
  assert.equal(
    acceptedChallenge(bytes(JSON.stringify({ challenge })), challenge),
    true,
  );
  for (const body of [
    "",
    "{}",
    "null",
    "[]",
    JSON.stringify({ challenge: "other" }),
    JSON.stringify({ challenge, extra: 1 }),
    JSON.stringify({ challenge: challenge + "\0" }),
    JSON.stringify({ challenge: 1 }),
  ])
    assert.equal(acceptedChallenge(bytes(body), challenge), false);
  assert.equal(acceptedChallenge(new Uint8Array([0xff]), challenge), false);
});
test("result-only candidate binds actual challenge response to exact operation without retaining response", async () => {
  let calls = 0;
  const input = envelope();
  const verify = createResultOnlyChallengeVerifier(
    async (url, policy, body, headers) => {
      calls++;
      assert.equal(url, input.destination);
      assert.deepEqual(policy, targets);
      assert.equal(
        JSON.parse(Buffer.from(body).toString()).challenge,
        challenge,
      );
      assert.equal(headers["content-type"], "application/json");
      return { status: 200, body: bytes(JSON.stringify({ challenge })) };
    },
  );
  const receipt = await verify(input, caller, targets);
  assert.deepEqual(receipt, {
    kind: "challenge",
    verification: "verified",
    operationDigest: relayOperationDigest(input, caller, "challenge"),
  });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(receipt).includes(challenge), false);
  const different = { ...input, requestId: "synthetic-request-2" };
  assert.notEqual(
    (await verify(different, caller, targets)).operationDigest,
    receipt.operationDigest,
  );
});
test("wrong/extra/illformed responses fail; exceptions/status-only/oversize never prove verified", async () => {
  for (const body of [
    bytes("{}"),
    bytes(JSON.stringify({ challenge: "other" })),
    bytes(JSON.stringify({ challenge, secret: "x" })),
    new Uint8Array([0xff]),
  ]) {
    const receipt = await createResultOnlyChallengeVerifier(async () => ({
      status: 200,
      body,
    }))(envelope(), caller, targets);
    assert.equal(receipt.verification, "failed");
    assert.equal("body" in receipt, false);
  }
  for (const send of [
    async () => {
      throw Error("secret exception");
    },
    async () => ({ status: 503, body: bytes(JSON.stringify({ challenge })) }),
    async () => ({ kind: "http", status: 204 }),
    async () => ({ status: 200, body: new Uint8Array(65537) }),
  ]) {
    const receipt = await createResultOnlyChallengeVerifier(send)(
      envelope(),
      caller,
      targets,
    );
    assert.equal(receipt.kind, "unknown");
    assert.equal("verification" in receipt, false);
    assert.equal(JSON.stringify(receipt).includes("secret"), false);
  }
});
test("message/extra-field/malformed challenge request never invokes transport", async () => {
  let calls = 0;
  const verify = createResultOnlyChallengeVerifier(async () => {
    calls++;
    throw Error("unexpected");
  });
  for (const payload of [
    { type: "table.message.created", challenge },
    { type: "verification", challenge, extra: 1 },
    { type: "verification", challenge: "not-uuid" },
  ]) {
    assert.deepEqual(
      await verify(
        {
          ...envelope(),
          payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
        },
        caller,
        targets,
      ),
      { kind: "unknown" },
    );
  }
  assert.equal(calls, 0);
});
