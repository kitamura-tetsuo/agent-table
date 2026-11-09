import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

describe("telemetry from real GuestDO cleanup alarms", () => {
  it("logs committed cleanup counts without credentials", async () => {
    const captured: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      captured.push(JSON.stringify(value));
    });
    const guestId = crypto.randomUUID();
    const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    const session = await stub.createSession(guestId);
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "UPDATE guest_sessions SET created_at = ?, expires_at = ? WHERE session_id = ?",
        now - 2_000,
        now - 1_000,
        session.sessionId,
      );
      await state.storage.setAlarm(Date.now());
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const events = captured
      .filter((s) => s.includes('"kind":"alarm"'))
      .map((s) => JSON.parse(s));
    expect(events).toMatchObject([
      { kind: "alarm", component: "guest", outcome: "committed", processed: 1 },
    ]);
    expect(captured.join("\n")).not.toContain(guestId);
    expect(captured.join("\n")).not.toContain(session.secret);
  });

  it("redacts a sentinel-bearing cleanup failure instead of logging an error", async () => {
    const captured: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      captured.push(JSON.stringify(value));
    });
    const guestId = crypto.randomUUID();
    const stub = env.GUESTS.get(env.GUESTS.idFromName(guestId));
    await stub.createSession(guestId);
    const secret = `unexpected-error-${crypto.randomUUID()}`;
    await runInDurableObject(stub, async (instance) => {
      const internal = instance as unknown as {
        deadlines: { checkpoint: (phase: string) => Promise<void> };
      };
      internal.deadlines.checkpoint = async () => {
        throw new Error(secret);
      };
      await expect(instance.alarm()).rejects.toThrow(
        "Guest cleanup unavailable",
      );
    });
    const events = captured
      .filter((s) => s.includes('"kind":"alarm"'))
      .map((s) => JSON.parse(s));
    expect(events).toMatchObject([
      {
        kind: "alarm",
        component: "guest",
        outcome: "unknown",
        processed: null,
      },
    ]);
    expect(captured.join("\n")).not.toContain(secret);
  });
});
