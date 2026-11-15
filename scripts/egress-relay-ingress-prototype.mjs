/**
 * Offline authenticated intake prototype; no listener or production wiring.
 * Public keys/policy and atomic replay store are operator-injected, never
 * supplied by the HTTP caller. No key generation or credential persistence.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { validateReviewedCallbackDestination } from "../src/notifications/egress.ts";
import { checkedHeaders } from "./egress-relay-prototype.mjs";

const WINDOW = 60000;
const MAX_SKEW = 60000;
const MAX_ENVELOPE = 32768;
const ID = /^[A-Za-z0-9_-]{16,128}$/;
const exact = (object, fields) =>
  object &&
  typeof object === "object" &&
  !Array.isArray(object) &&
  Object.keys(object).length === fields.length &&
  fields.every((field) => Object.hasOwn(object, field));
const canonicalBase64 = (s) =>
  typeof s === "string" &&
  s.length <= 21848 &&
  Buffer.from(s, "base64").toString("base64") === s;
export const relaySigningBytes = (bytes, callerId) =>
  Buffer.concat([
    Buffer.from(`POST\n/relay/v1\n${callerId}\n`),
    Buffer.from(bytes),
  ]);

export const relayStatusSigningBytes = (bytes, callerId) =>
  Buffer.concat([
    Buffer.from(`POST\n/relay/v1/status\n${callerId}\n`),
    Buffer.from(bytes),
  ]);
/** Call only on a fully validated semantic envelope; no payload is stored. */
export function relayOperationDigest(envelope, callerId) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        kind: "forward",
        audience: envelope.audience,
        callerId,
        requestId: envelope.requestId,
        destination: envelope.destination,
        headers: Object.fromEntries(
          Object.entries(envelope.headers).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        ),
        payload: envelope.payload,
      }),
    )
    .digest("hex");
}

/**
 * Only single-process offline tests may use this store. A deployment needs
 * atomic, shared, persistent insert-if-absent through the full replay horizon.
 * Capacity exhaustion denies new requests rather than evicting live entries.
 */
export function memoryReplayStoreForTests(capacity = 1000) {
  const entries = new Map();
  return {
    async reserve(key, expiresAt, now) {
      for (const [id, expiry] of entries) if (expiry < now) entries.delete(id);
      if (entries.has(key) || entries.size >= capacity) return false;
      entries.set(key, expiresAt);
      return true;
    },
  };
}

export function createRelayIngress({
  callers,
  audience,
  replayStore,
  admissionStore,
  enabled = () => true,
  readEnabled = () => true,
  send,
  clock = Date.now,
  perMinute = 10,
  readPerMinute = 30,
  readGlobalPerMinute = 100,
  globalPerMinute = 100,
  concurrency = 2,
  reserveTimeoutMs = 2000,
}) {
  if (
    !(callers instanceof Map) ||
    typeof audience !== "string" ||
    !/^(production|test):[a-z][a-z0-9-]{2,63}$/.test(audience) ||
    !!replayStore === !!admissionStore ||
    (replayStore && typeof replayStore.reserve !== "function") ||
    (admissionStore &&
      (typeof admissionStore.acquire !== "function" ||
        typeof admissionStore.finish !== "function")) ||
    typeof enabled !== "function" ||
    typeof readEnabled !== "function" ||
    typeof send !== "function"
  )
    throw new Error("invalid-configuration");
  for (const n of [
    perMinute,
    globalPerMinute,
    concurrency,
    readPerMinute,
    readGlobalPerMinute,
  ])
    if (!Number.isSafeInteger(n) || n < 1 || n > 1000)
      throw new Error("invalid-configuration");
  if (
    !Number.isSafeInteger(reserveTimeoutMs) ||
    reserveTimeoutMs < 1 ||
    reserveTimeoutMs > 2000
  )
    throw new Error("invalid-configuration");
  const loadIdentity = (id) => {
    const value = callers.get(id);
    if (
      !value ||
      !ID.test(id) ||
      !Array.isArray(value.targets) ||
      !value.targets.length
    )
      return null;
    const key = createPublicKey(value.publicKey);
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("invalid-key-type");
    const targets = structuredClone(value.targets);
    for (const t of targets)
      if (
        !exact(t, ["origin", "pathPrefix"]) ||
        !validateReviewedCallbackDestination(t.origin + t.pathPrefix, [t]).ok
      )
        throw new Error("invalid-target-policy");
    return { key, targets };
  };
  for (const id of callers.keys())
    if (!loadIdentity(id)) throw new Error("invalid-configuration");
  const readCalls = new Map();
  let readGlobal = [];
  const calls = new Map();
  let global = [],
    active = 0;
  const result = (status, code) => ({ status, body: { code } });
  return async ({ method, path, callerId, signature, bytes }) => {
    const reading = path === "/relay/v1/status";
    if (method !== "POST" || !["/relay/v1", "/relay/v1/status"].includes(path))
      return result(404, "unavailable");
    if ((reading ? readEnabled() : enabled()) !== true)
      return result(503, "unavailable");
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length > (reading ? 1024 : MAX_ENVELOPE)
    )
      return result(413, "invalid-request");
    // Snapshot caller-owned mutable buffers before any asynchronous operation.
    const raw = Buffer.from(bytes);
    let identity;
    try {
      identity = loadIdentity(callerId);
    } catch {
      return result(401, "unauthorized");
    }
    if (
      !identity ||
      typeof signature !== "string" ||
      signature.length !== 88 ||
      Buffer.from(signature, "base64").length !== 64 ||
      Buffer.from(signature, "base64").toString("base64") !== signature
    )
      return result(401, "unauthorized");
    if (
      !verify(
        null,
        (reading ? relayStatusSigningBytes : relaySigningBytes)(raw, callerId),
        identity.key,
        Buffer.from(signature, "base64"),
      )
    )
      return result(401, "unauthorized");
    let envelope;
    try {
      envelope = JSON.parse(raw.toString("utf8"));
    } catch {
      return result(400, "invalid-request");
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0)
      return result(503, "unavailable");
    if (reading) {
      if (
        !exact(envelope, [
          "version",
          "audience",
          "requestId",
          "timestamp",
          "operationDigest",
        ]) ||
        envelope.version !== 1 ||
        envelope.audience !== audience ||
        typeof envelope.requestId !== "string" ||
        !ID.test(envelope.requestId) ||
        !Number.isSafeInteger(envelope.timestamp) ||
        Math.abs(now - envelope.timestamp) > MAX_SKEW ||
        typeof envelope.operationDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(envelope.operationDigest)
      )
        return result(400, "invalid-request");
      // Separate bounded per-process status traffic; never consumes send leases.
      readGlobal = readGlobal.filter((t) => t > now - WINDOW);
      const recentRead = (readCalls.get(callerId) ?? []).filter(
        (t) => t > now - WINDOW,
      );
      if (
        readGlobal.length >= readGlobalPerMinute ||
        recentRead.length >= readPerMinute
      )
        return result(429, "capacity");
      recentRead.push(now);
      readGlobal.push(now);
      readCalls.set(callerId, recentRead);
      if (typeof admissionStore?.readOutcome !== "function")
        return result(503, "unavailable");
      let timer;
      try {
        const outcome = await Promise.race([
          admissionStore.readOutcome({
            callerId,
            requestId: envelope.requestId,
            operationDigest: envelope.operationDigest,
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("read-timeout")),
              reserveTimeoutMs,
            );
          }),
        ]);
        const current = loadIdentity(callerId);
        if (
          readEnabled() !== true ||
          Math.abs(clock() - envelope.timestamp) > MAX_SKEW
        )
          return result(503, "unavailable");
        if (
          !current ||
          !verify(
            null,
            relayStatusSigningBytes(raw, callerId),
            current.key,
            Buffer.from(signature, "base64"),
          )
        )
          return result(401, "unauthorized");
        if (!outcome?.ok)
          return result(
            outcome?.reason === "conflict"
              ? 409
              : outcome?.reason === "invalid"
                ? 400
                : 503,
            "unavailable",
          );
        if (["pending", "unknown"].includes(outcome.state))
          return { status: 200, body: { state: outcome.state } };
        if (
          outcome.state === "completed" &&
          outcome.outcome?.kind === "not-sent"
        )
          return {
            status: 200,
            body: { state: "completed", outcome: { kind: "not-sent" } },
          };
        if (
          outcome.state === "completed" &&
          outcome.outcome?.kind === "http" &&
          Number.isInteger(outcome.outcome.status) &&
          outcome.outcome.status >= 100 &&
          outcome.outcome.status <= 599
        )
          return {
            status: 200,
            body: {
              state: "completed",
              outcome: { kind: "http", status: outcome.outcome.status },
            },
          };
        return result(503, "unavailable");
      } catch {
        return result(503, "unavailable");
      } finally {
        clearTimeout(timer);
      }
    }
    if (
      !exact(envelope, [
        "version",
        "audience",
        "requestId",
        "timestamp",
        "destination",
        "headers",
        "payload",
      ]) ||
      envelope.version !== 1 ||
      envelope.audience !== audience ||
      !ID.test(envelope.requestId) ||
      !Number.isSafeInteger(envelope.timestamp) ||
      Math.abs(now - envelope.timestamp) > MAX_SKEW ||
      !canonicalBase64(envelope.payload) ||
      !exact(envelope.headers, Object.keys(envelope.headers ?? {})) ||
      !validateReviewedCallbackDestination(
        envelope.destination,
        identity.targets,
      ).ok
    )
      return result(400, "invalid-request");
    let headers;
    try {
      headers = checkedHeaders(envelope.headers);
    } catch {
      return result(400, "invalid-request");
    }
    const payload = Buffer.from(envelope.payload, "base64");
    if (payload.length > 16384) return result(413, "invalid-request");
    global = global.filter((t) => t > now - WINDOW);
    const recent = (calls.get(callerId) ?? []).filter((t) => t > now - WINDOW);
    if (
      !admissionStore &&
      (active >= concurrency ||
        recent.length >= perMinute ||
        global.length >= globalPerMinute)
    )
      return result(429, "capacity");
    // Reserve local capacity synchronously, before awaiting replay storage.
    active++;
    recent.push(now);
    calls.set(callerId, recent);
    global.push(now);
    let leaseId;
    let completion;
    try {
      let reserveTimer;
      let reserved;
      try {
        reserved = await Promise.race([
          admissionStore
            ? admissionStore.acquire({
                callerId,
                requestId: envelope.requestId,
                expiresAt: envelope.timestamp + MAX_SKEW,
                operationDigest: relayOperationDigest(envelope, callerId),
              })
            : replayStore.reserve(
                `${callerId}:${envelope.requestId}`,
                envelope.timestamp + MAX_SKEW,
                now,
              ),
          new Promise((_, reject) => {
            reserveTimer = setTimeout(
              () => reject(new Error("reservation-timeout")),
              reserveTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(reserveTimer);
      }
      // A late reservation may persist, but cannot resume this failed handler.
      if (admissionStore) {
        if (reserved?.ok !== true)
          return result(
            ["replay", "duplicate"].includes(reserved?.reason) ? 409 : 429,
            "duplicate-or-capacity",
          );
        leaseId = reserved.leaseId;
        if (
          !(
            typeof leaseId === "string" ||
            (Number.isSafeInteger(leaseId) && leaseId > 0)
          )
        )
          return result(502, "delivery-failed");
      } else if (reserved !== true) return result(409, "duplicate-or-capacity");
      if (enabled() !== true) return result(503, "unavailable");
      // Store/delivery delays cannot turn a stale authorization into a send.
      if (Math.abs(clock() - envelope.timestamp) > MAX_SKEW)
        return result(400, "expired");
      const current = loadIdentity(callerId);
      if (
        !current ||
        !verify(
          null,
          relaySigningBytes(raw, callerId),
          current.key,
          Buffer.from(signature, "base64"),
        ) ||
        !validateReviewedCallbackDestination(
          envelope.destination,
          current.targets,
        ).ok
      )
        return result(401, "unauthorized");
      const delivered = await send(
        envelope.destination,
        current.targets,
        payload,
        headers,
      );
      if (
        !delivered ||
        !Number.isInteger(delivered.status) ||
        delivered.status < 200 ||
        delivered.status >= 300 ||
        !(delivered.body instanceof Uint8Array) ||
        delivered.body.length > 65536
      )
        return result(502, "delivery-failed");
      completion = { kind: "http", status: delivered.status };
      return {
        status: 200,
        body: {
          status: delivered.status,
          payload: Buffer.from(delivered.body).toString("base64"),
        },
      };
    } catch {
      return result(502, "delivery-failed");
    } finally {
      active--;
      if (leaseId) {
        // Failure to release stays conservatively uncertain in durable storage.
        try {
          admissionStore.finish(leaseId, completion);
        } catch {
          /* no unsafe lease reset */
        }
      }
    }
  };
}
