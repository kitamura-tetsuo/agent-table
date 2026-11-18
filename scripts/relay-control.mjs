/** One private command; no credential, sequence, recovery identity or retry creation. */

import { readSync } from "node:fs";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

const MAX = 65536;
export function relayControl(socketPath, command, { timeoutMs = 20000 } = {}) {
  const wire = JSON.stringify(command) + "\n";
  if (Buffer.byteLength(wire) > MAX)
    return Promise.reject(Error("control-refused"));
  return new Promise((yes, no) => {
    const socket = connect(socketPath);
    let bytes = Buffer.alloc(0),
      complete = false;
    const fail = () => {
      if (!complete) {
        complete = true;
        no(Error("control-outcome-unknown"));
      }
      socket.destroy();
    };
    socket.setTimeout(timeoutMs);
    socket.on("error", fail);
    socket.on("timeout", fail);
    socket.on("connect", () => socket.end(wire));
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX) {
        fail();
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      try {
        const value = JSON.parse(bytes.subarray(0, end).toString());
        complete = true;
        yes(value);
        socket.destroy();
      } catch {
        fail();
      }
    });
    socket.on("end", () => {
      if (!complete) fail();
    });
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (
      process.argv.length !== 5 ||
      process.argv[2] !== "--socket" ||
      !["--inspect", "--stdin"].includes(process.argv[4])
    )
      throw Error("control-refused");
    let raw = null;
    if (process.argv[4] === "--stdin") {
      const chunks = [];
      let size = 0;
      for (;;) {
        const b = Buffer.alloc(4096);
        const n = readSync(0, b);
        if (!n) break;
        size += n;
        if (size > MAX) throw Error("control-refused");
        chunks.push(b.subarray(0, n));
      }
      raw = Buffer.concat(chunks);
    }
    if (raw && raw.length > MAX) throw Error("control-refused");
    const result = await relayControl(
      process.argv[3],
      raw ? JSON.parse(raw.toString()) : { action: "inspect" },
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.ok === false || result.state === "unknown") process.exitCode = 1;
  } catch {
    process.stderr.write(
      "RELAY_CONTROL_OUTCOME_UNKNOWN read status/original identity; do not retry blindly\n",
    );
    process.exitCode = 1;
  }
}
