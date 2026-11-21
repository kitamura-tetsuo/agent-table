/** Keep the supported Node line, npm, and the relay image in one reviewed update. */
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILES = [
  ".node-version",
  "package.json",
  "package-lock.json",
  "deploy/relay/node-image.txt",
];
const MINIMUM_AGE = 3 * 24 * 60 * 60 * 1000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const IMAGE =
  /^docker\.io\/library\/node:(\d+\.\d+\.\d+)-bookworm-slim@sha256:([a-f0-9]{64})$/;
const INDEX_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];

export function versionParts(version) {
  if (typeof version !== "string" || !VERSION.test(version))
    throw new Error("Expected an exact stable runtime version.");
  const parts = version.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)) || parts[0] === 0)
    throw new Error("Invalid runtime version.");
  return parts;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function readPinnedNodeVersion(root = ROOT) {
  const node = readFileSync(join(root, ".node-version"), "utf8").trim();
  versionParts(node);
  return node;
}

export function assertPinnedNodeRuntime(
  actual = process.versions.node,
  root = ROOT,
) {
  if (actual !== readPinnedNodeVersion(root))
    throw new Error("Running Node does not match .node-version.");
}

function checkDependencyMap(actual, expected) {
  const left = Object.entries(actual || {}).sort();
  const right = Object.entries(expected || {}).sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

export function readRuntimePins(root = ROOT) {
  const source = Object.fromEntries(
    FILES.map((file) => [file, readFileSync(join(root, file), "utf8")]),
  );
  const node = source[".node-version"].trim();
  versionParts(node);
  const manifest = JSON.parse(source["package.json"]);
  const lock = JSON.parse(source["package-lock.json"]);
  const npmMatch = /^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager || "");
  if (!npmMatch)
    throw new Error("packageManager must pin an exact npm version.");
  const npm = npmMatch[1];
  versionParts(npm);
  const image = source["deploy/relay/node-image.txt"].trim();
  const imageMatch = IMAGE.exec(image);
  if (!imageMatch || imageMatch[1] !== node)
    throw new Error(
      "Relay image must pin the same Node version and a SHA-256 digest.",
    );
  const rootPackage = lock.packages?.[""];
  if (
    manifest.engines?.node !== node ||
    lock.lockfileVersion !== 3 ||
    rootPackage?.engines?.node !== node ||
    lock.name !== manifest.name ||
    lock.version !== manifest.version ||
    rootPackage?.name !== manifest.name ||
    rootPackage?.version !== manifest.version ||
    !checkDependencyMap(rootPackage?.dependencies, manifest.dependencies) ||
    !checkDependencyMap(rootPackage?.devDependencies, manifest.devDependencies)
  )
    throw new Error(
      "Node and package-lock root metadata must match package.json.",
    );
  return { node, npm, image, source, manifest, lock };
}

function oldEnough(date, now) {
  const timestamp = typeof date === "string" ? Date.parse(date) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp <= now - MINIMUM_AGE;
}

export function selectNodeVersion(current, releases, now = Date.now()) {
  const major = versionParts(current)[0];
  if (!Array.isArray(releases) || !Number.isFinite(now))
    throw new Error("Invalid Node release index.");
  let selected = current;
  for (const release of releases) {
    const version = release?.version?.replace(/^v/, "");
    if (
      typeof version !== "string" ||
      !VERSION.test(version) ||
      typeof release.lts !== "string" ||
      !release.lts ||
      !/^\d{4}-\d{2}-\d{2}$/.test(release.date || "") ||
      !oldEnough(release.date, now)
    )
      continue;
    if (
      versionParts(version)[0] === major &&
      compareVersions(version, selected) > 0
    )
      selected = version;
  }
  return selected;
}

export function selectNpmVersion(current, metadata, now = Date.now()) {
  const major = versionParts(current)[0];
  if (
    !metadata?.versions ||
    typeof metadata.versions !== "object" ||
    !metadata.time ||
    typeof metadata.time !== "object" ||
    !Number.isFinite(now)
  )
    throw new Error("Invalid npm release metadata.");
  let selected = current;
  for (const [version, release] of Object.entries(metadata.versions)) {
    if (
      !VERSION.test(version) ||
      versionParts(version)[0] !== major ||
      release?.version !== version ||
      release.deprecated ||
      !oldEnough(metadata.time[version], now)
    )
      continue;
    if (compareVersions(version, selected) > 0) selected = version;
  }
  return selected;
}

async function responseBytes(url, fetcher, headers = {}) {
  let response;
  try {
    response = await fetcher(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(
      `Runtime metadata request failed: ${new URL(url).hostname}.`,
    );
  }
  if (!response.ok)
    throw new Error(
      `Runtime metadata request failed: ${new URL(url).hostname} (${response.status}).`,
    );
  const limit = 32 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Runtime metadata response has no body.");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Runtime metadata response exceeds its size limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, length), headers: response.headers };
}

async function readJson(url, fetcher) {
  const { bytes } = await responseBytes(url, fetcher, {
    Accept: "application/json",
  });
  return JSON.parse(bytes.toString("utf8"));
}

export async function resolveNodeImage(node, fetcher = fetch) {
  versionParts(node);
  const authorization = await readJson(
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull",
    fetcher,
  );
  if (
    typeof authorization.token !== "string" ||
    !/^[A-Za-z0-9._~-]{1,16384}$/.test(authorization.token)
  )
    throw new Error("Docker registry authorization is unavailable.");
  const tag = `${node}-bookworm-slim`;
  const { bytes, headers } = await responseBytes(
    `https://registry-1.docker.io/v2/library/node/manifests/${tag}`,
    fetcher,
    {
      Accept: INDEX_TYPES.join(", "),
      Authorization: `Bearer ${authorization.token}`,
    },
  );
  const digest = headers.get("docker-content-digest");
  if (
    !/^sha256:[a-f0-9]{64}$/.test(digest || "") ||
    digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  )
    throw new Error(
      "Docker registry manifest digest does not match its bytes.",
    );
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    manifest.schemaVersion !== 2 ||
    !INDEX_TYPES.includes(manifest.mediaType) ||
    !Array.isArray(manifest.manifests) ||
    !manifest.manifests.some(
      (item) =>
        item.platform?.os === "linux" &&
        item.platform?.architecture === "amd64" &&
        /^sha256:[a-f0-9]{64}$/.test(item.digest || ""),
    )
  )
    throw new Error("Node image must include a pinned Linux amd64 manifest.");
  return `docker.io/library/node:${tag}@${digest}`;
}

function writeTogether(root, source, target) {
  const changed = FILES.filter((file) => source[file] !== target[file]);
  const staged = new Map();
  const committed = [];
  try {
    for (const file of changed) {
      const path = join(root, file);
      const temporary = `${path}.runtime-update-${randomUUID()}`;
      writeFileSync(temporary, target[file], {
        flag: "wx",
        mode: statSync(path).mode & 0o777,
      });
      staged.set(file, temporary);
    }
    // Refuse to overwrite edits made while metadata requests were in flight.
    for (const file of FILES) {
      if (readFileSync(join(root, file), "utf8") !== source[file])
        throw new Error("Runtime pin files changed during the update.");
    }
    for (const file of changed) {
      renameSync(staged.get(file), join(root, file));
      committed.push(file);
    }
  } catch (error) {
    for (const file of committed) writeFileSync(join(root, file), source[file]);
    throw error;
  } finally {
    for (const temporary of staged.values()) rmSync(temporary, { force: true });
  }
  return changed;
}

export async function updateRuntimePins({
  root = ROOT,
  fetcher = fetch,
  now = Date.now(),
} = {}) {
  const pins = readRuntimePins(root);
  const [releases, npmMetadata] = await Promise.all([
    readJson("https://nodejs.org/dist/index.json", fetcher),
    readJson("https://registry.npmjs.org/npm", fetcher),
  ]);
  const node = selectNodeVersion(pins.node, releases, now);
  const npm = selectNpmVersion(pins.npm, npmMetadata, now);
  // Refresh the digest even when Node's version has not changed (base OS fixes).
  const image = await resolveNodeImage(node, fetcher);
  pins.manifest.engines.node = node;
  pins.manifest.packageManager = `npm@${npm}`;
  pins.lock.packages[""].engines.node = node;
  const target = {
    ".node-version": `${node}\n`,
    "package.json": `${JSON.stringify(pins.manifest, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify(pins.lock, null, 2)}\n`,
    "deploy/relay/node-image.txt": `${image}\n`,
  };
  const files = writeTogether(root, pins.source, target);
  return { changed: files.length > 0, node, npm, image, files };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--update") {
      process.stdout.write(`${JSON.stringify(await updateRuntimePins())}\n`);
    } else if (
      args.length === 2 &&
      args[0] === "--print" &&
      ["node", "npm", "image"].includes(args[1])
    ) {
      process.stdout.write(`${readRuntimePins()[args[1]]}\n`);
    } else if (
      args.length === 0 ||
      (args.length === 1 && ["--check", "--check-runtime"].includes(args[0]))
    ) {
      const { node, npm } = readRuntimePins();
      if (args[0] === "--check-runtime") assertPinnedNodeRuntime();
      process.stdout.write(`RUNTIME_PINS_VALID node=${node} npm=${npm}\n`);
    } else {
      throw new Error(
        "Usage: runtime-updates.mjs [--check|--check-runtime|--update|--print node|npm|image]",
      );
    }
  } catch (error) {
    process.stderr.write(`RUNTIME_UPDATE_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
