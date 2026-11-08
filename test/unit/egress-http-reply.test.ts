import { describe, expect, it } from "vitest";
import { BoundedHttpReplyReader } from "../../src/notifications/http-reply";

const bytes = (input: string) => new TextEncoder().encode(input);

describe("bounded raw HTTPS callback response", () => {
  it("parses a fragmented response without storing more than the configured body", () => {
    const reader = new BoundedHttpReplyReader(1024, 32);
    expect(
      reader.push(bytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n")),
    ).toBeUndefined();
    expect(reader.push(bytes("\r\nhel"))).toBeUndefined();
    const reply = reader.push(bytes("lo"));
    expect(reply?.status).toBe(200);
    expect(new TextDecoder().decode(reply?.body)).toBe("hello");
  });

  it("accepts bounded chunked or close-delimited replies", () => {
    const chunked = new BoundedHttpReplyReader(1024, 32);
    const empty = chunked.push(
      bytes(
        "HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
      ),
    );
    expect(empty?.status).toBe(204);
    expect(empty?.body.byteLength).toBe(0);
    const chunks = new BoundedHttpReplyReader(1024, 32);
    expect(
      chunks.push(
        bytes(
          "HTTP/1.1 202 Accepted\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n",
        ),
      ),
    ).toBeUndefined();
    expect(
      new TextDecoder().decode(chunks.push(bytes("0\r\n\r\n"))?.body),
    ).toBe("hello");
    const closeDelimited = new BoundedHttpReplyReader(1024, 32);
    expect(
      closeDelimited.push(bytes("HTTP/1.0 410 Gone\r\n\r\nmissing")),
    ).toBeUndefined();
    expect(closeDelimited.end().status).toBe(410);
  });

  it("rejects redirects, oversized responses, invalid frames and ambiguous framing", () => {
    const scenarios = [
      {
        raw: "HTTP/1.1 302 Found\r\nLocation: https://elsewhere.test/\r\n\r\n",
        code: "redirect",
      },
      { raw: "HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n", code: "size" },
      {
        raw: "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nhi",
        code: "protocol",
      },
      {
        raw: "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\nhi",
        code: "protocol",
      },
      {
        raw: "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip,chunked\r\n\r\n",
        code: "protocol",
      },
      { raw: "HTTP/1.1 200 OK\r\nX-Foo: bad\nline\r\n\r\n", code: "protocol" },
      {
        raw: "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nff\r\n",
        code: "size",
      },
    ];
    for (const { raw, code } of scenarios) {
      expect(() =>
        new BoundedHttpReplyReader(1024, 16).push(bytes(raw)),
      ).toThrowError(expect.objectContaining({ code }));
    }
  });

  it("does not turn EOF before a complete Content-Length body into success", () => {
    const reader = new BoundedHttpReplyReader(1024, 32);
    expect(
      reader.push(bytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhi")),
    ).toBeUndefined();
    expect(() => reader.end()).toThrowError(
      expect.objectContaining({ code: "protocol" }),
    );
  });
});
