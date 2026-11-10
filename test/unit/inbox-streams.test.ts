import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INBOX_AUTH_POLL_MS,
  InboxHintStreams,
} from "../../src/mcp/inbox-streams";
import type { InboxSubscriptionCheck } from "../../src/mcp/subscriptions";

const snapshot = (): InboxSubscriptionCheck => ({
  uri: "agent-table://tables/table/inbox/member",
  tableId: "table",
  membershipId: "member",
  lastSeq: 0,
  latestPeerSeq: 0,
  expiresAt: Date.now() + 60_000,
});

// Queue/lifecycle tests only. Real DO RPC and SQLite coverage lives separately.
describe("bounded internal inbox hint registry", () => {
  let registry: InboxHintStreams;
  let observe: ReturnType<
    typeof vi.fn<(active: number, durationMs?: number) => void>
  >;
  beforeEach(() => {
    vi.useFakeTimers();
    observe = vi.fn();
    registry = new InboxHintStreams(observe);
  });
  afterEach(() => {
    registry.closeAll();
    vi.useRealTimers();
  });

  it("checks every hint and emits only a URI, without advancing cursors", async () => {
    const value = snapshot();
    const check = vi.fn(async () => value);
    const reader = registry.attach(value, check).getReader();
    for (let i = 0; i < 2; i++) {
      await registry.notify(value.membershipId);
      const chunk = await reader.read();
      expect(JSON.parse(new TextDecoder().decode(chunk.value))).toEqual({
        kind: "resource_updated",
        uri: value.uri,
      });
    }
    expect(check).toHaveBeenCalledTimes(2);
    expect(value.lastSeq).toBe(0);
    await reader.cancel();
    expect(observe).toHaveBeenLastCalledWith(0, 0);
  });

  it("discards the bounded queued hint and terminates a slow consumer", async () => {
    const value = snapshot();
    const reader = registry.attach(value, async () => value).getReader();
    await registry.notify(value.membershipId);
    await registry.notify(value.membershipId);
    await expect(reader.read()).rejects.toThrow("Inbox stream ended");
    expect(observe).toHaveBeenLastCalledWith(0, 0);
  });

  it("replacement prevents an old authority check delivering into a new stream", async () => {
    const value = snapshot();
    let release!: (value: InboxSubscriptionCheck) => void;
    const old = registry
      .attach(
        value,
        () =>
          new Promise((r) => {
            release = r;
          }),
      )
      .getReader();
    const pending = registry.notify(value.membershipId);
    const reader = registry.attach(value, async () => value).getReader();
    await expect(old.read()).rejects.toThrow("Inbox stream ended");
    release(value);
    await pending;
    await registry.notify(value.membershipId);
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
  });

  it("bounds in-flight work instead of queuing overlapping posts", async () => {
    const value = snapshot();
    let release!: (value: InboxSubscriptionCheck) => void;
    const check = vi.fn(
      () =>
        new Promise<InboxSubscriptionCheck>((r) => {
          release = r;
        }),
    );
    const reader = registry.attach(value, check).getReader();
    const first = registry.notify(value.membershipId);
    await registry.notify(value.membershipId);
    await expect(reader.read()).rejects.toThrow("Inbox stream ended");
    release(value);
    await first;
    expect(check).toHaveBeenCalledTimes(1);
  });

  it.each(["revoked", "unavailable", "foreign"])(
    "fails closed on %s while idle",
    async (reason) => {
      const value = snapshot();
      const reader = registry
        .attach(value, async () => {
          if (reason === "unavailable")
            throw new Error("private upstream detail");
          return reason === "foreign" ? { ...value, uri: "foreign" } : null;
        })
        .getReader();
      await vi.advanceTimersByTimeAsync(INBOX_AUTH_POLL_MS);
      await expect(reader.read()).rejects.toThrow("Inbox stream ended");
    },
  );

  it("enforces the original deadline even with a hung grant check", async () => {
    const value = { ...snapshot(), expiresAt: Date.now() + 50 };
    let release!: (value: InboxSubscriptionCheck) => void;
    const reader = registry
      .attach(
        value,
        () =>
          new Promise((r) => {
            release = r;
          }),
      )
      .getReader();
    const pending = registry.notify(value.membershipId);
    await vi.advanceTimersByTimeAsync(50);
    await expect(reader.read()).rejects.toThrow("Inbox stream ended");
    release(value);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shortens a grant deadline but never renews stream lifetime", async () => {
    const value = snapshot();
    const reader = registry
      .attach(value, async () => ({ ...value, expiresAt: Date.now() + 25 }))
      .getReader();
    await registry.notify(value.membershipId);
    await reader.read();
    await vi.advanceTimersByTimeAsync(25);
    await expect(reader.read()).rejects.toThrow("Inbox stream ended");
  });

  it("cancellation clears timers and terminal invalidation defeats pending checks", async () => {
    const value = snapshot();
    const stream = registry.attach(value, async () => value);
    await stream.cancel();
    expect(vi.getTimerCount()).toBe(0);
    let release!: (value: InboxSubscriptionCheck) => void;
    const reader = registry
      .attach(
        value,
        () =>
          new Promise((r) => {
            release = r;
          }),
      )
      .getReader();
    const pending = registry.notify(value.membershipId);
    registry.closeAll();
    release(value);
    await pending;
    await expect(reader.read()).rejects.toThrow("Inbox stream ended");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits the registry to two table memberships", async () => {
    for (const membershipId of ["a", "b"]) {
      const value = { ...snapshot(), membershipId };
      registry.attach(value, async () => value);
    }
    expect(() => registry.attach(snapshot(), async () => snapshot())).toThrow(
      "Inbox stream unavailable",
    );
  });

  it("explicit cancellation requires the current generation capability", async () => {
    const value = snapshot();
    const first = registry.attach(value, async () => value, "old").getReader();
    const second = registry
      .attach(value, async () => value, "current")
      .getReader();
    await expect(first.read()).rejects.toThrow("Inbox stream ended");
    registry.cancel(value.membershipId, "old");
    registry.cancel(value.membershipId, "random");
    await registry.notify(value.membershipId);
    expect((await second.read()).done).toBe(false);
    registry.cancel(value.membershipId, "current");
    await expect(second.read()).rejects.toThrow("Inbox stream ended");
    expect(vi.getTimerCount()).toBe(0);
  });
});
