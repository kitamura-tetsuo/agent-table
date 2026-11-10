import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  emitOperationalEvent,
  recordFutureMetric,
  unobservedProgress,
} from "../../src/shared/telemetry";

afterEach(() => vi.restoreAllMocks());

describe("allowlisted Worker operational telemetry", () => {
  it("captures real successful and rejected routes without private input", async () => {
    const captured: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      captured.push(JSON.stringify(value));
    });
    const sentinel = `private-secret-${crypto.randomUUID()}`;
    const passed = await worker.fetch(
      new Request(`http://localhost:8787/health?title=${sentinel}`, {
        headers: { Cookie: `session=${sentinel}` },
      }) as Parameters<typeof worker.fetch>[0],
      env,
      createExecutionContext(),
    );
    expect(passed.status).toBe(200);
    const rejected = await worker.fetch(
      new Request(`http://localhost:8787/health?callback=${sentinel}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sentinel}` },
        body: sentinel,
      }) as Parameters<typeof worker.fetch>[0],
      env,
      createExecutionContext(),
    );
    expect(rejected.status).toBe(405);
    const records = captured.map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.status)).toEqual([200, 405]);
    expect(records.every((r) => r.kind === "http" && r.route === "other")).toBe(
      true,
    );
    expect(records.every((r) => /^[a-f0-9]{12}$/.test(r.correlationId))).toBe(
      true,
    );
    expect(new Set(records.map((r) => r.correlationId)).size).toBe(2);
    expect(captured.join("\n")).not.toContain(sentinel);
    expect(captured.join("\n")).not.toContain("callback=");
    expect(captured.join("\n")).not.toContain("Authorization");
  });

  it("refuses unbounded or user-controlled diagnostic fields", () => {
    const captured: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      captured.push(JSON.stringify(value));
    });
    emitOperationalEvent({
      kind: "http",
      route: "personal-private-path" as "other",
      outcome: "response",
      status: 200,
      durationMs: 1,
      correlationId: "bad-correlation",
    });
    recordFutureMetric({
      name: "secret.dynamic.label" as "stream.active",
      value: 1,
    });
    recordFutureMetric({ name: "outbox.retry", value: Number.NaN });
    expect(captured).toHaveLength(0);
    recordFutureMetric({ name: "outbox.retry", value: 2 });
    expect(captured.map((s) => JSON.parse(s))).toMatchObject([
      { kind: "metric", name: "outbox.retry", value: 2 },
    ]);
  });

  it("never promotes a transport response into host or reply evidence", () => {
    expect(unobservedProgress).toEqual({
      storage: "unknown",
      transport: "unknown",
      receiver: "unknown",
      hostRun: "unknown",
      reply: "unknown",
    });
  });

  it("records only fixed-category stream termination and duration", () => {
    const captured: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      captured.push(JSON.stringify(value));
    });
    emitOperationalEvent({
      kind: "stream",
      reason: "private-actor-name" as "transport",
      durationMs: 4,
    });
    expect(captured).toEqual([]);
    emitOperationalEvent({
      kind: "stream",
      reason: "slow_consumer",
      durationMs: 5,
    });
    expect(JSON.parse(captured[0])).toEqual({
      schema: "agent-table.telemetry.v1",
      kind: "stream",
      reason: "slow_consumer",
      durationMs: 5,
    });
  });
});
