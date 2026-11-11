import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  makeConfig,
  makeProviderMock,
} from "../test/helpers/release-fixtures.mjs";
import { ProviderVerificationError } from "./release-provider.mjs";
import { verifyReleaseReadAccess } from "./verify-release-credentials.mjs";

const staging = makeConfig("staging");
const production = makeConfig("production");

test("protected credential probe inspects the complete read API surface for both Workers", async () => {
  const provider = makeProviderMock(staging, production);
  const paths = [];
  const result = await verifyReleaseReadAccess(
    staging.account_id,
    async (path, withPageInfo) => {
      paths.push(path);
      return provider.read(path, withPageInfo);
    },
  );
  assert.deepEqual(result, { verified: true, workersInspected: 2 });
  assert.equal(paths.length, 14);
  for (const name of [staging.name, production.name]) {
    for (const suffix of [
      "settings",
      "subdomain",
      "secrets",
      "deployments",
      "versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]) {
      assert.ok(paths.some((path) => path.endsWith(`/${name}/${suffix}`)));
    }
  }
  assert.ok(paths.some((path) => path.includes("/workers/domains?")));
  assert.ok(
    paths.some((path) => path.includes("/workers/durable_objects/namespaces?")),
  );
  assert.equal(
    paths.filter((path) => path.includes("/storage/kv/namespaces/")).length,
    2,
  );
});

test("credential probe reports all denied independent GETs without provider details", async () => {
  const provider = makeProviderMock(staging, production);
  const requested = [];
  const deniedSuffixes = [
    "/workers/domains?",
    "/workers/durable_objects/namespaces?",
    "/agent-table-staging/secrets",
    "/agent-table-production/deployments",
  ];
  await assert.rejects(
    verifyReleaseReadAccess(staging.account_id, (path, withPageInfo) => {
      requested.push(path);
      if (deniedSuffixes.some((suffix) => path.includes(suffix))) {
        throw new ProviderVerificationError("provider-read-refused");
      }
      return provider.read(path, withPageInfo);
    }),
    (error) =>
      error instanceof ProviderVerificationError &&
      error.message ===
        "credential-read-refused:domains,durable-objects,agent-table-staging-secrets,agent-table-production-deployments",
  );
  assert.equal(requested.length, 10);
  assert.equal(
    requested.filter((path) => path.includes("/versions/")).length,
    0,
  );
});

test("credential probe reports all denied version and KV GETs", async () => {
  const provider = makeProviderMock(staging, production);
  const requested = [];
  await assert.rejects(
    verifyReleaseReadAccess(staging.account_id, (path, withPageInfo) => {
      requested.push(path);
      if (
        path.includes("/versions/") ||
        path.includes("/storage/kv/namespaces/")
      ) {
        throw new ProviderVerificationError("provider-result-unverified");
      }
      return provider.read(path, withPageInfo);
    }),
    (error) =>
      error instanceof ProviderVerificationError &&
      error.message ===
        "credential-read-refused:agent-table-staging-version,agent-table-staging-kv,agent-table-production-version,agent-table-production-kv",
  );
  assert.equal(requested.length, 14);
});

test("token verification fails closed on missing target, incomplete resources and denied GETs", async () => {
  await assert.rejects(
    verifyReleaseReadAccess("not-an-account", async () => ({})),
    /credential-account-invalid/,
  );
  const scenarios = [
    [
      "/workers/domains?",
      () => ({ result: "invalid" }),
      "credential-domains-unreadable",
    ],
    [
      "/agent-table-production/settings",
      () => ({}),
      "credential-worker-settings-unreadable",
    ],
    [
      "/agent-table-staging/secrets",
      () => ({}),
      "credential-secret-names-unreadable",
    ],
    [
      "/agent-table-production/deployments",
      () => ({}),
      "credential-deployments-unreadable",
    ],
    [
      "/storage/kv/namespaces/",
      () => ({}),
      "credential-kv-metadata-unreadable",
    ],
  ];
  for (const [suffix, replace, code] of scenarios) {
    const provider = makeProviderMock(staging, production);
    await assert.rejects(
      verifyReleaseReadAccess(staging.account_id, (path, withPageInfo) =>
        path.includes(suffix) ? replace() : provider.read(path, withPageInfo),
      ),
      (error) =>
        error instanceof ProviderVerificationError && error.message === code,
      suffix,
    );
  }
  const provider = makeProviderMock(staging, production);
  await assert.rejects(
    verifyReleaseReadAccess(staging.account_id, (path, withPageInfo) => {
      if (path.endsWith("/agent-table-production/secrets")) {
        throw new ProviderVerificationError("provider-read-refused");
      }
      return provider.read(path, withPageInfo);
    }),
    /credential-read-refused:agent-table-production-secrets/,
  );
});

test("manual read-token job is pinned to main, protected and never exposes a write token", () => {
  const workflow = readFileSync(
    new URL(
      "../.github/workflows/verify-release-credentials.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /type: choice\s+options: \[staging, production\]/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /name: \$\{\{ inputs\.target_environment \}\}/);
  assert.match(workflow, /deployment: false/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write|actions: write/);
  assert.match(workflow, /EXPECTED_SHA.*GITHUB_SHA/);
  assert.match(workflow, /secrets\.CLOUDFLARE_READ_TOKEN/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN|wrangler|deploy --/);
});
