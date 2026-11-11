import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

// Native workerd tests require no listening sockets or Cloudflare credentials.
const directory = await mkdtemp(join(tmpdir(), "agent-table-inbox-"));
try {
  await build({
    entryPoints: ["test/probes/inbox-hint-streams.ts"],
    outfile: join(directory, "probe.mjs"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    // Neutral platform does not consult CommonJS package main fields by default.
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:assert/strict"],
  });
  await writeFile(
    join(directory, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "internet", network = (allow = [])),
    (name = "storage", disk = (path = ${JSON.stringify(directory)}, writable = true)),
    (name = "probe", worker = (
      modules = [(name = "probe.mjs", esModule = embed "probe.mjs")],
      compatibilityDate = "2026-11-07",
      compatibilityFlags = ["nodejs_compat"],
      durableObjectStorage = (localDisk = "storage"),
      durableObjectNamespaces = [
        (className = "ProbeTableDO", uniqueKey = "synthetic-native-inbox-table", enableSql = true),
        (className = "ProbeGuestDO", uniqueKey = "synthetic-native-inbox-guest", enableSql = true)
      ],
      bindings = [
        (name = "TABLES", durableObjectNamespace = "ProbeTableDO"),
        (name = "GUESTS", durableObjectNamespace = "ProbeGuestDO"),
        (name = "PUBLIC_ORIGIN", text = "http://localhost:8787"),
        (name = "RELEASE_ENVIRONMENT", text = "local"),
        (name = "RESTORE_QUARANTINE", text = "false"),
        (name = "INVITATION_RESPONSE_KEYRING", text = "{\\"current\\":{\\"id\\":\\"synthetic-test-2026\\",\\"key\\":\\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\\"},\\"previous\\":[]}")
      ]
    ))
  ]
);
`,
  );
  const result = spawnSync(
    "node_modules/.bin/workerd",
    ["test", join(directory, "config.capnp")],
    { stdio: "inherit", timeout: 30_000 },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
