import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRelayIngress,
  relaySigningBytes,
} from "./egress-relay-ingress-prototype.mjs";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";

test("real SQLite admission composes with signed intake across independent handles and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-intake-store-"));
  const options = {
    environment: "test",
    serviceId: "synthetic-relay",
    concurrency: 2,
  };
  let a, b;
  try {
    a = openRelayAdmissionStore(join(dir, "admission.sqlite"), options);
    b = openRelayAdmissionStore(join(dir, "admission.sqlite"), options);
    const callerId = "synthetic-worker-1";
    const privateKey = createPrivateKey({
      format: "der",
      type: "pkcs8",
      key: Buffer.from(
        "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "hex",
      ),
    });
    const publicKey = {
      format: "der",
      type: "spki",
      key: Buffer.from(
        "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "hex",
      ),
    };
    const callers = new Map([
      [
        callerId,
        {
          publicKey,
          targets: [
            { origin: "https://callback.example.org", pathPrefix: "/events" },
          ],
        },
      ],
    ]);
    let attempts = 0;
    const send = async () => {
      attempts++;
      return { status: 204, body: new Uint8Array() };
    };
    const make = (admissionStore) =>
      createRelayIngress({
        audience: "test:synthetic-relay",
        callers,
        admissionStore,
        send,
      });
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        audience: "test:synthetic-relay",
        requestId: "synthetic-request-1",
        timestamp: Date.now(),
        destination: "https://callback.example.org/events",
        headers: {},
        payload: "",
      }),
    );
    const request = {
      method: "POST",
      path: "/relay/v1",
      callerId,
      bytes,
      signature: sign(
        null,
        relaySigningBytes(bytes, callerId),
        privateKey,
      ).toString("base64"),
    };
    const results = await Promise.all([make(a)(request), make(b)(request)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(attempts, 1);
    a.close();
    b.close();
    a = openRelayAdmissionStore(join(dir, "admission.sqlite"), options);
    assert.equal((await make(a)(request)).status, 409);
    assert.equal(attempts, 1);
  } finally {
    a?.close();
    b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
