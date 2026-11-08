import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const paths = [
  "src/auth/guest.ts",
  "src/index.ts",
  "src/mcp/server.ts",
  "src/objects/table.ts",
  "src/shared/deletion.ts",
  "src/web/deletion.ts",
  "test/integration/deletion-confirmation.test.ts",
];
for (const path of paths) {
  try {
    execFileSync("./node_modules/.bin/biome", ["check", "--write", path], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // Emit the formatted source even if a semantic lint issue remains.
  }
  const encoded = Buffer.from(readFileSync(path, "utf8")).toString("base64");
  process.stdout.write(`__FORMAT_BEGIN__ ${path}\n`);
  for (let i = 0; i < encoded.length; i += 4000) {
    process.stdout.write(`__FORMAT_CHUNK__ ${encoded.slice(i, i + 4000)}\n`);
  }
  process.stdout.write(`__FORMAT_END__ ${path}\n`);
}
