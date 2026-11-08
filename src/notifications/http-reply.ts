import { SafeEgressError } from "./egress-policy";

export interface BoundedReply {
  readonly status: number;
  readonly body: Uint8Array;
}

/** A deliberately narrow HTTP/1.1 response reader with bounded raw memory. */
export class BoundedHttpReplyReader {
  private chunks: Uint8Array[] = [];
  private received = 0;
  private readonly rawLimit: number;

  constructor(
    private readonly maxHeaderBytes: number,
    private readonly maxBodyBytes: number,
  ) {
    this.rawLimit = maxHeaderBytes + 2 * maxBodyBytes + 8_192;
  }

  push(chunk: Uint8Array): BoundedReply | undefined {
    if (this.received + chunk.byteLength > this.rawLimit) {
      throw new SafeEgressError("size");
    }
    this.received += chunk.byteLength;
    this.chunks.push(chunk);
    return this.read(false);
  }

  end(): BoundedReply {
    const reply = this.read(true);
    if (!reply) {
      throw new SafeEgressError("protocol");
    }
    return reply;
  }

  private read(ended: boolean): BoundedReply | undefined {
    const all = Buffer.concat(this.chunks, this.received);
    const delimiter = all.indexOf("\r\n\r\n");
    if (delimiter === -1) {
      if (all.length > this.maxHeaderBytes) {
        throw new SafeEgressError("size");
      }
      return undefined;
    }
    if (delimiter + 4 > this.maxHeaderBytes) {
      throw new SafeEgressError("size");
    }
    const lines = all.subarray(0, delimiter).toString("latin1").split("\r\n");
    const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: [\x20-\x7e]*)?$/.exec(
      lines.shift() ?? "",
    );
    if (!status) {
      throw new SafeEgressError("protocol");
    }
    const statusCode = Number(status[1]);
    if (statusCode >= 300 && statusCode < 400) {
      throw new SafeEgressError("redirect");
    }
    if (statusCode < 200) {
      throw new SafeEgressError("protocol");
    }
    let length: number | undefined;
    let chunked = false;
    for (const line of lines) {
      const field = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
      if (
        !field ||
        Array.from(field[2]).some((char) => {
          const code = char.charCodeAt(0);
          return (code < 32 && code !== 9) || code === 127;
        })
      ) {
        throw new SafeEgressError("protocol");
      }
      const name = field[1].toLowerCase();
      if (name === "content-length") {
        if (length !== undefined || !/^(?:0|[1-9]\d*)$/.test(field[2])) {
          throw new SafeEgressError("protocol");
        }
        length = Number(field[2]);
        if (!Number.isSafeInteger(length) || length > this.maxBodyBytes) {
          throw new SafeEgressError("size");
        }
      } else if (name === "transfer-encoding") {
        if (chunked || field[2].toLowerCase() !== "chunked") {
          throw new SafeEgressError("protocol");
        }
        chunked = true;
      }
    }
    if (chunked && length !== undefined) {
      throw new SafeEgressError("protocol");
    }
    const body = all.subarray(delimiter + 4);
    if (chunked) {
      const decoded = this.decodeChunks(body);
      return decoded === undefined
        ? undefined
        : { status: statusCode, body: decoded };
    }
    if (length !== undefined) {
      if (body.length < length) {
        return undefined;
      }
      if (body.length > length) {
        throw new SafeEgressError("protocol");
      }
      return { status: statusCode, body: body.slice() };
    }
    if (body.length > this.maxBodyBytes) {
      throw new SafeEgressError("size");
    }
    return ended ? { status: statusCode, body: body.slice() } : undefined;
  }

  private decodeChunks(wire: Uint8Array): Uint8Array | undefined {
    const bytes = Buffer.from(wire);
    const parts: Uint8Array[] = [];
    let offset = 0;
    let total = 0;
    for (;;) {
      const lineEnd = bytes.indexOf("\r\n", offset);
      if (lineEnd === -1) {
        if (bytes.length - offset > 32) {
          throw new SafeEgressError("protocol");
        }
        return undefined;
      }
      const sizeText = bytes.subarray(offset, lineEnd).toString("ascii");
      if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) {
        throw new SafeEgressError("protocol");
      }
      const size = Number.parseInt(sizeText, 16);
      offset = lineEnd + 2;
      if (size === 0) {
        if (bytes.length - offset < 2) {
          return undefined;
        }
        if (bytes.subarray(offset).toString("ascii") !== "\r\n") {
          throw new SafeEgressError("protocol");
        }
        return Buffer.concat(parts, total);
      }
      if (total + size > this.maxBodyBytes) {
        throw new SafeEgressError("size");
      }
      if (bytes.length - offset < size + 2) {
        return undefined;
      }
      if (bytes[offset + size] !== 13 || bytes[offset + size + 1] !== 10) {
        throw new SafeEgressError("protocol");
      }
      parts.push(bytes.subarray(offset, offset + size));
      total += size;
      offset += size + 2;
    }
  }
}
