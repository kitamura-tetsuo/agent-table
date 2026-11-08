import { describe, expect, it } from "vitest";
import { sendVerifiedHttps } from "../../src/notifications/egress";
import {
  isPublicIpv4,
  parseDestinationPolicy,
  parseVerifiedDestination,
  SafeEgressError,
  selectPinnedIpv4,
} from "../../src/notifications/egress-policy";

const policy = parseDestinationPolicy(
  JSON.stringify(["events.provider.com", "receiver.provider.com"]),
);

function refusesPolicy(fn: () => unknown): void {
  expect(fn).toThrowError(new SafeEgressError("policy"));
}

describe("operator-reviewed egress destination policy", () => {
  it("rejects missing, wildcard, duplicate, localhost and malformed configurations", () => {
    for (const input of [
      undefined,
      "",
      "[]",
      "not-json",
      '["*.provider.com"]',
      '["events.provider.com","events.provider.com"]',
      '["127.0.0.1"]',
      '["localhost"]',
      '["host.internal"]',
      '["UPPER.provider.com"]',
      '["unqualified"]',
    ]) {
      refusesPolicy(() => parseDestinationPolicy(input));
    }
  });

  it("accepts only an exact, canonical HTTPS hostname with bounded path and query", () => {
    expect(
      parseVerifiedDestination(
        "https://events.provider.com/callback?token=x",
        policy,
      ),
    ).toEqual({ hostname: "events.provider.com", target: "/callback?token=x" });
    for (const input of [
      "https://unapproved.provider.com/callback",
      "https://sub.events.provider.com/callback",
      "http://events.provider.com/callback",
      "https://events.provider.com:444/callback",
      "https://user:pass@events.provider.com/callback",
      "https://events.provider.com@127.0.0.1/callback",
      "https://events.provider.com.evil.test/callback",
      "https://events.provider.com/callback#fragment",
      "https://events.provider.com\\@evil.test/",
      "https://events.provider.com%2f.evil.test/",
      "https://events.provider.com./callback",
      " https://events.provider.com/callback",
      "https://events.provider.com/callback\r\nEvil: true",
      "https://0x7f000001/callback",
      "https://[::1]/callback",
    ]) {
      refusesPolicy(() => parseVerifiedDestination(input, policy));
    }
  });

  it("rejects non-public or mixed DNS results, including IPv6 and numeric shortcuts", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.0.1",
      "198.19.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::ffff:127.0.0.1",
      "2001:db8::1",
      "2130706433",
    ]) {
      expect(isPublicIpv4(address), address).toBe(false);
    }
    expect(isPublicIpv4("8.8.8.8")).toBe(true);
    expect(isPublicIpv4("1.1.1.1")).toBe(true);
    expect(selectPinnedIpv4(["8.8.8.8", "1.1.1.1"])).toBe("8.8.8.8");
    for (const answers of [[], ["8.8.8.8", "127.0.0.1"], ["::1"]]) {
      expect(() => selectPinnedIpv4(answers)).toThrowError(
        new SafeEgressError("dns"),
      );
    }
  });

  it("rejects a forbidden destination before any DNS or socket use", async () => {
    await expect(
      sendVerifiedHttps(
        { url: "https://localhost/admin", method: "POST" },
        policy,
      ),
    ).rejects.toMatchObject({ code: "policy" });
    await expect(
      sendVerifiedHttps(
        { url: "https://unapproved.provider.com/", method: "POST" },
        policy,
      ),
    ).rejects.toMatchObject({ code: "policy" });
  });

  it("rejects CRLF header smuggling and oversized requests before DNS", async () => {
    await expect(
      sendVerifiedHttps(
        {
          url: "https://events.provider.com/",
          method: "POST",
          headers: { "x-probe": "value\r\nHost: private.invalid" },
        },
        policy,
      ),
    ).rejects.toMatchObject({ code: "policy" });
    await expect(
      sendVerifiedHttps(
        {
          url: "https://events.provider.com/",
          method: "POST",
          body: new Uint8Array(16_384),
        },
        policy,
      ),
    ).rejects.toMatchObject({ code: "size" });
  });
});
