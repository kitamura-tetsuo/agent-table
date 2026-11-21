import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPinnedNodeRuntime,
  readRuntimePins,
  resolveNodeImage,
  selectNodeVersion,
  selectNpmVersion,
  updateRuntimePins,
  versionParts,
} from "./runtime-updates.mjs";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const ORIGINAL_IMAGE = `docker.io/library/node:24.22.1-bookworm-slim@sha256:${"a".repeat(64)}`;
const IMAGE_MANIFEST = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    {
      digest: `sha256:${"b".repeat(64)}`,
      platform: { architecture: "amd64", os: "linux" },
    },
  ],
});
const IMAGE_DIGEST = createHash("sha256").update(IMAGE_MANIFEST).digest("hex");
const RELEASES = [
  { version: "v24.22.1", lts: "Krypton", date: "2026-11-01" },
  { version: "v24.22.3", lts: "Krypton", date: "2026-11-15" },
  { version: "v24.22.4", lts: "Krypton", date: "2026-11-20" },
  { version: "v26.1.0", lts: "Other", date: "2026-11-01" },
];
const NPM_METADATA = {
  versions: {
    "11.9.0": { version: "11.9.0" },
    "11.19.1": { version: "11.19.1" },
    "11.20.0": { version: "11.20.0" },
    "12.0.0": { version: "12.0.0" },
  },
  time: {
    "11.9.0": "2026-11-01T10:00:00Z",
    "11.19.1": "2026-11-15T10:00:00Z",
    "11.20.0": "2026-11-20T10:00:00Z",
    "12.0.0": "2026-11-01T10:00:00Z",
  },
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agent-table-runtime-update-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, "deploy/relay"), { recursive: true });
  const manifest = {
    name: "fixture",
    version: "0.1.0",
    private: true,
    engines: { node: "24.22.1" },
    packageManager: "npm@11.9.0",
    scripts: { test: "node --test" },
    dependencies: { example: "1.0.0" },
    devDependencies: { checker: "2.0.0" },
  };
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        engines: manifest.engines,
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
      },
      "node_modules/example": { version: "1.0.0", integrity: "unchanged" },
    },
  };
  const files = {
    ".node-version": "24.22.1\n",
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify(lock, null, 2)}\n`,
    "deploy/relay/node-image.txt": `${ORIGINAL_IMAGE}\n`,
  };
  for (const [file, text] of Object.entries(files))
    writeFileSync(join(root, file), text);
  return {
    root,
    files,
    snapshot: () =>
      Object.fromEntries(
        Object.keys(files).map((file) => [
          file,
          readFileSync(join(root, file), "utf8"),
        ]),
      ),
  };
}

function fakeFetch({
  releases = RELEASES,
  npm = NPM_METADATA,
  imageStatus = 200,
  digest = `sha256:${IMAGE_DIGEST}`,
  manifest = IMAGE_MANIFEST,
  onRequest = () => {},
} = {}) {
  return async (url, options) => {
    onRequest(url, options);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (url === "https://nodejs.org/dist/index.json")
      return Response.json(releases);
    if (url === "https://registry.npmjs.org/npm") return Response.json(npm);
    if (url.startsWith("https://auth.docker.io/token?"))
      return Response.json({ token: "synthetic.registry.token" });
    if (
      url.startsWith("https://registry-1.docker.io/v2/library/node/manifests/")
    ) {
      assert.equal(
        options.headers.Authorization,
        "Bearer synthetic.registry.token",
      );
      return new Response(manifest, {
        status: imageStatus,
        headers: { "docker-content-digest": digest },
      });
    }
    throw new Error("Unexpected URL in runtime updater test.");
  };
}

test("runtime pins agree and the relay checks the exact version", (t) => {
  const { root } = fixture(t);
  assert.equal(readRuntimePins(root).node, "24.22.1");
  assert.doesNotThrow(() => assertPinnedNodeRuntime("24.22.1", root));
  assert.throws(
    () => assertPinnedNodeRuntime("24.22.2", root),
    /does not match/,
  );
  for (const invalid of [
    "24",
    "v24.22.1",
    "24.22.1-beta",
    "024.22.1",
    "24.22.1\n",
    "0.1.0",
  ])
    assert.throws(() => versionParts(invalid));
});

test("inconsistent engines, dependencies, or an unpinned image fail validation", (t) => {
  const { root, files } = fixture(t);
  const invalidCases = [
    [".node-version", "24.22.2\n"],
    ["deploy/relay/node-image.txt", "node:24-bookworm-slim\n"],
    [
      "package.json",
      files["package.json"].replace('"npm@11.9.0"', '"npm@latest"'),
    ],
    [
      "package-lock.json",
      files["package-lock.json"].replace('"24.22.1"', '"24.22.2"'),
    ],
    [
      "package-lock.json",
      files["package-lock.json"].replace(
        '"example": "1.0.0"',
        '"example": "1.0.1"',
      ),
    ],
  ];
  for (const [file, contents] of invalidCases) {
    writeFileSync(join(root, file), contents);
    assert.throws(() => readRuntimePins(root));
    writeFileSync(join(root, file), files[file]);
  }
  rmSync(join(root, "package-lock.json"));
  assert.throws(() => readRuntimePins(root), /ENOENT/);
});

test("release selection stays on supported majors, ages releases, and never downgrades", () => {
  assert.equal(selectNodeVersion("24.22.1", RELEASES, NOW), "24.22.3");
  assert.equal(selectNodeVersion("24.23.0", RELEASES, NOW), "24.23.0");
  assert.equal(selectNpmVersion("11.9.0", NPM_METADATA, NOW), "11.19.1");
  assert.equal(selectNpmVersion("11.21.0", NPM_METADATA, NOW), "11.21.0");
  const invalidNodeReleases = [
    { version: "v24.99.0-rc.1", lts: "Krypton", date: "2026-11-01" },
    { version: "v24.99.1", lts: false, date: "2026-11-01" },
    { version: "v24.99.2", lts: "Krypton", date: "invalid" },
  ];
  assert.equal(
    selectNodeVersion("24.22.1", invalidNodeReleases, NOW),
    "24.22.1",
  );
  const npm = structuredClone(NPM_METADATA);
  npm.versions["11.19.1"].deprecated = "do not use";
  assert.equal(selectNpmVersion("11.9.0", npm, NOW), "11.9.0");
  assert.throws(() => selectNodeVersion("24.22.1", {}));
  assert.throws(() => selectNpmVersion("11.9.0", {}));
});

test("a runtime update changes every pin together without resolving dependencies", async (t) => {
  const f = fixture(t);
  const before = readRuntimePins(f.root);
  const result = await updateRuntimePins({
    root: f.root,
    fetcher: fakeFetch(),
    now: NOW,
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.files, Object.keys(f.files));
  const after = readRuntimePins(f.root);
  assert.equal(after.node, "24.22.3");
  assert.equal(after.npm, "11.19.1");
  assert.equal(
    after.image,
    `docker.io/library/node:24.22.3-bookworm-slim@sha256:${IMAGE_DIGEST}`,
  );
  assert.deepEqual(after.manifest.scripts, before.manifest.scripts);
  assert.deepEqual(after.manifest.dependencies, before.manifest.dependencies);
  assert.deepEqual(
    after.lock.packages["node_modules/example"],
    before.lock.packages["node_modules/example"],
  );
  const repeated = await updateRuntimePins({
    root: f.root,
    fetcher: fakeFetch(),
    now: NOW,
  });
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.files, []);
});

test("base OS image changes are proposed even without Node or npm changes", async (t) => {
  const f = fixture(t);
  const result = await updateRuntimePins({
    root: f.root,
    now: NOW,
    fetcher: fakeFetch({
      releases: [],
      npm: { versions: {}, time: {} },
    }),
  });
  assert.equal(result.node, "24.22.1");
  assert.equal(result.npm, "11.9.0");
  assert.deepEqual(result.files, ["deploy/relay/node-image.txt"]);
});

test("missing Docker manifests and digest mismatches leave all pins untouched", async (t) => {
  const f = fixture(t);
  for (const fetcher of [
    fakeFetch({ imageStatus: 404 }),
    fakeFetch({ digest: `sha256:${"c".repeat(64)}` }),
    fakeFetch({ digest: "not-a-digest" }),
  ]) {
    await assert.rejects(
      updateRuntimePins({ root: f.root, fetcher, now: NOW }),
    );
    assert.deepEqual(f.snapshot(), f.files);
  }
});

test("an incomplete upstream response never produces a partial update", async (t) => {
  const f = fixture(t);
  const upstream = fakeFetch();
  await assert.rejects(
    updateRuntimePins({
      root: f.root,
      now: NOW,
      fetcher: async (url, options) => {
        if (url === "https://registry.npmjs.org/npm") return Response.json({});
        return upstream(url, options);
      },
    }),
    /Invalid npm release metadata/,
  );
  assert.deepEqual(f.snapshot(), f.files);
});

test("edits made during an update are preserved and prevent all writes", async (t) => {
  const f = fixture(t);
  const updatedPackage = f.files["package.json"].replace(
    '"private": true',
    '"private": false',
  );
  await assert.rejects(
    updateRuntimePins({
      root: f.root,
      now: NOW,
      fetcher: fakeFetch({
        onRequest(url) {
          if (url.startsWith("https://auth.docker.io/"))
            writeFileSync(join(f.root, "package.json"), updatedPackage);
        },
      }),
    }),
    /changed during the update/,
  );
  assert.deepEqual(f.snapshot(), {
    ...f.files,
    "package.json": updatedPackage,
  });
});

test("image resolution rejects indexes without the CI runner architecture", async () => {
  const manifest = IMAGE_MANIFEST.replace('"amd64"', '"arm64"');
  await assert.rejects(
    resolveNodeImage(
      "24.22.3",
      fakeFetch({
        manifest,
        digest: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
      }),
    ),
    /Linux amd64/,
  );
});
