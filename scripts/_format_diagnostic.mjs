import { execFileSync } from "node:child_process";

const paths = [
  "src/objects/table.ts",
  "src/services/tables.ts",
  "src/mcp/server.ts",
  "src/shared/lifecycle.ts",
  "test/integration/table-lifecycle.test.ts",
  "test/integration/public-table-tools.test.ts",
];
for (const path of paths) {
  const formatted = execFileSync("./node_modules/.bin/biome", ["format", path], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(`__FORMAT_BEGIN__ ${path}\n`);
  const encoded = Buffer.from(formatted).toString("base64");
  for (let i = 0; i < encoded.length; i += 4000) {
    process.stdout.write(`__FORMAT_CHUNK__ ${encoded.slice(i, i + 4000)}\n`);
  }
  process.stdout.write(`__FORMAT_END__ ${path}\n`);
}
