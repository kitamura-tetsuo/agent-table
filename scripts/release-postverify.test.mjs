import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeConfig,
  makeProviderMock,
} from "../test/helpers/release-fixtures.mjs";
import { verifyPublishedRelease } from "./release-postverify.mjs";
import {
  readCloudflareDeployment,
  redactedProviderReceipt,
} from "./release-provider.mjs";

const config = makeConfig("staging");
const peer = makeConfig("production");

async function harness() {
  const provider = makeProviderMock(config, peer);
  const observed = await readCloudflareDeployment(config, peer, provider.read);
  return {
    provider,
    approval: {
      providerReceipt: redactedProviderReceipt(
        observed.targetState,
        "staging",
        "2026-11-11T12:00:00Z",
      ),
    },
    httpFetch: async () =>
      Response.json(
        {
          status: "ok",
          release: {
            environment: "staging",
            profile: "manual",
            buildSha: config.vars.RELEASE_BUILD_SHA,
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      ),
  };
}

test("postdeploy verifies the same SQL DO/KV resources, exact flags and HTTPS build receipt", async () => {
  const { provider, approval, httpFetch } = await harness();
  const result = await verifyPublishedRelease({
    config,
    peer,
    approval,
    cloudflareRead: provider.read,
    httpFetch,
  });
  assert.equal(result.verified, true);
  assert.equal(result.buildSha, config.vars.RELEASE_BUILD_SHA);
});

test("changed private namespace refuses success after a seemingly healthy release", async () => {
  const { provider, approval, httpFetch } = await harness();
  const path = [...provider.routes.keys()].find((x) =>
    x.endsWith("/agent-table-staging/settings"),
  );
  provider.routes
    .get(path)
    .bindings.find((x) => x.name === "TABLES").namespace_id =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const nsPath = `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=1&per_page=100`;
  provider.routes
    .get(nsPath)
    .result.find(
      (entry) => entry.script === config.name && entry.class === "TableDO",
    ).id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await assert.rejects(
    verifyPublishedRelease({
      config,
      peer,
      approval,
      cloudflareRead: provider.read,
      httpFetch,
    }),
    /post-deploy-resource-identity-changed/,
  );
});

test("wrong public build, bad HTTP response or unavailable origin blocks postdeploy acceptance", async () => {
  for (const httpFetch of [
    async () =>
      Response.json(
        { status: "ok", release: { buildSha: "b".repeat(40) } },
        { headers: { "Cache-Control": "no-store" } },
      ),
    async () => new Response("not found", { status: 404 }),
    async () =>
      new Response("x".repeat(4096), {
        headers: { "Cache-Control": "no-store" },
      }),
    async () => {
      throw Error("simulated TLS refusal");
    },
  ]) {
    const { provider, approval } = await harness();
    await assert.rejects(
      verifyPublishedRelease({
        config,
        peer,
        approval,
        cloudflareRead: provider.read,
        httpFetch,
      }),
      /post-deploy-build-not-observed|post-deploy-health-unverified|post-deploy-health-oversized|post-deploy-origin-unreachable/,
    );
  }
});
