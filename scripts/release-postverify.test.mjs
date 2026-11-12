import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  makeConfig,
  makePrivatePilotFixture,
  makeProviderMock,
} from "../test/helpers/release-fixtures.mjs";
import { verifyPublishedRelease } from "./release-postverify.mjs";
import {
  readCloudflareDeployment,
  redactedProviderReceipt,
} from "./release-provider.mjs";

const config = makeConfig("staging");
const peer = makeConfig("production");
const hash = (text) => createHash("sha256").update(text).digest("hex");

async function harness(candidate = config, peerConfig = peer) {
  const configText = JSON.stringify(candidate);
  const provider = makeProviderMock(candidate, peerConfig);
  const observed = await readCloudflareDeployment(
    candidate,
    peerConfig,
    provider.read,
  );
  const policy = candidate.vars.PRIVATE_PILOT_POLICY
    ? JSON.parse(candidate.vars.PRIVATE_PILOT_POLICY)
    : null;
  const approval = {
    deploymentApproved: true,
    environment: candidate.vars.RELEASE_ENVIRONMENT,
    buildSha: candidate.vars.RELEASE_BUILD_SHA,
    profile: candidate.vars.RELEASE_PROFILE,
    configSha256: hash(configText),
    ...(policy
      ? {
          privatePilot: {
            mode: policy.mode,
            ...(policy.observationMode === undefined
              ? {}
              : { observationMode: policy.observationMode }),
            policySha256: hash(candidate.vars.PRIVATE_PILOT_POLICY),
            notBefore: policy.notBefore,
            expiresAt: policy.expiresAt,
            deliveryEnabled:
              candidate.vars.ALLOW_OUTBOUND_NOTIFICATIONS === "true",
          },
        }
      : {}),
    providerReceipt: redactedProviderReceipt(
      observed.targetState,
      candidate.vars.RELEASE_ENVIRONMENT,
      "2026-11-11T12:00:00Z",
    ),
  };
  const httpFetch = async () =>
    Response.json(
      {
        status: "ok",
        release: {
          environment: candidate.vars.RELEASE_ENVIRONMENT,
          profile: candidate.vars.RELEASE_PROFILE,
          buildSha: candidate.vars.RELEASE_BUILD_SHA,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  return {
    provider,
    options: {
      configText,
      peer: peerConfig,
      approval,
      cloudflareRead: provider.read,
      httpFetch,
    },
  };
}

function privateConfig() {
  return JSON.parse(makePrivatePilotFixture().configText);
}

test("postdeploy verifies manual SQL DO/KV resources, exact config bytes and HTTPS build receipt", async () => {
  const { options } = await harness();
  const result = await verifyPublishedRelease(options);
  assert.equal(result.verified, true);
  assert.equal(result.profile, "manual");
  assert.equal(result.buildSha, config.vars.RELEASE_BUILD_SHA);
});

test("changed private namespace refuses success after a seemingly healthy release", async () => {
  const { provider, options } = await harness();
  const path = [...provider.routes.keys()].find((x) =>
    x.endsWith("/agent-table-staging/settings"),
  );
  provider.routes
    .get(path)
    .bindings.find((x) => x.name === "TABLES").namespace_id =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const versionPath = [...provider.routes.keys()].find((x) =>
    x.endsWith(
      "/agent-table-staging/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ),
  );
  provider.routes
    .get(versionPath)
    .resources.bindings.find((x) => x.name === "TABLES").namespace_id =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const nsPath = `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=1&per_page=100`;
  provider.routes
    .get(nsPath)
    .result.find(
      (entry) => entry.script === config.name && entry.class === "TableDO",
    ).id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await assert.rejects(
    verifyPublishedRelease(options),
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
    const { options } = await harness();
    await assert.rejects(
      verifyPublishedRelease({ ...options, httpFetch }),
      /post-deploy-build-not-observed|post-deploy-health-unverified|post-deploy-health-oversized|post-deploy-origin-unreachable/,
    );
  }
});

test("private staging postverify binds exact policy and exposes only safe release identity", async () => {
  const candidate = privateConfig();
  const { options } = await harness(candidate);
  const result = await verifyPublishedRelease(options);
  assert.equal(result.verified, true);
  assert.equal(result.profile, "private-pilot-a-only");
  const serialized = JSON.stringify(result);
  const policy = JSON.parse(candidate.vars.PRIVATE_PILOT_POLICY);
  for (const privateValue of [
    policy.recipientGuestId,
    policy.recipientConnectionId,
    ...policy.tableIds,
    policy.callbackTargets[0].origin,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("discovery postverify binds its observation-only mode and checks both provider surfaces", async () => {
  const candidate = JSON.parse(
    makePrivatePilotFixture({ mode: "a-only-discovery" }).configText,
  );
  const { options } = await harness(candidate);
  assert.equal((await verifyPublishedRelease(options)).verified, true);
  for (const patch of [
    { mode: "a-only" },
    { observationMode: undefined },
    { observationMode: "raw" },
    { deliveryEnabled: true },
  ]) {
    const changed = await harness(candidate);
    Object.assign(changed.options.approval.privatePilot, patch);
    let reads = 0;
    changed.options.cloudflareRead = async () => {
      reads++;
    };
    await assert.rejects(
      verifyPublishedRelease(changed.options),
      /post-deploy-private-pilot-approval-mismatch/,
    );
    assert.equal(reads, 0);
  }
  for (const surface of ["settings", "version"]) {
    const changed = await harness(candidate);
    const path = [...changed.provider.routes.keys()].find((key) =>
      key.endsWith(
        surface === "settings"
          ? "/agent-table-staging/settings"
          : "/agent-table-staging/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ),
    );
    const record = changed.provider.routes.get(path);
    const bindings =
      surface === "settings" ? record.bindings : record.resources.bindings;
    bindings.find(
      (binding) => binding.name === "ALLOW_OUTBOUND_NOTIFICATIONS",
    ).text = "true";
    await assert.rejects(
      verifyPublishedRelease(changed.options),
      /provider-version-config-unverified/,
    );
  }
});

test("postverify refuses mismatched approval, profile or exact configuration bytes before any request", async () => {
  const changes = [
    (options) => {
      options.approval.deploymentApproved = false;
    },
    (options) => {
      options.approval.profile = "private-pilot-a-only";
    },
    (options) => {
      options.approval.environment = "production";
    },
    (options) => {
      options.approval.buildSha = "b".repeat(40);
    },
    (options) => {
      options.approval.configSha256 = "b".repeat(64);
    },
    (options) => {
      options.configText += "\n";
    },
  ];
  for (const change of changes) {
    const { options } = await harness();
    change(options);
    let requests = 0;
    options.cloudflareRead = async () => {
      requests += 1;
      throw Error("must not be reached");
    };
    options.httpFetch = options.cloudflareRead;
    await assert.rejects(
      verifyPublishedRelease(options),
      /post-deploy-approval-target-mismatch/,
    );
    assert.equal(requests, 0);
  }
});

test("the shared private policy parser rejects malformed, out-of-scope or inconsistent configurations", async () => {
  const mutations = [
    (candidate) => {
      candidate.vars.PRIVATE_PILOT_POLICY = "{}";
    },
    (candidate) => {
      candidate.vars.ENABLE_OPENAI_EVENTS = "true";
    },
    (candidate) => {
      candidate.vars.RELEASE_BUILD_SHA = "b".repeat(40);
    },
    (candidate) => {
      candidate.vars.RESTORE_QUARANTINE = "true";
    },
    (candidate) => {
      candidate.vars.RELEASE_ENVIRONMENT = "production";
    },
  ];
  for (const mutate of mutations) {
    const candidate = privateConfig();
    const { options } = await harness(candidate);
    mutate(candidate);
    options.configText = JSON.stringify(candidate);
    options.approval.configSha256 = hash(options.configText);
    options.approval.environment = candidate.vars.RELEASE_ENVIRONMENT;
    options.approval.buildSha = candidate.vars.RELEASE_BUILD_SHA;
    let requests = 0;
    options.cloudflareRead = async () => {
      requests += 1;
      throw Error("must not be reached");
    };
    await assert.rejects(
      verifyPublishedRelease(options),
      /post-deploy-profile-unverified/,
    );
    assert.equal(requests, 0);
  }
});

test("expiry or the outbound kill switch retains configured read/health/close verification", async () => {
  for (const enabled of ["true", "false"]) {
    const candidate = privateConfig();
    candidate.vars.ALLOW_OUTBOUND_NOTIFICATIONS = enabled;
    // The fixed fixture window is expired; configuration readback is not a claim of live effects.
    const { options } = await harness(candidate);
    assert.equal((await verifyPublishedRelease(options)).verified, true);
  }
});

test("exact deployment readback refuses an orphan policy after a requested manual removal", async () => {
  const { options, provider } = await harness();
  const policy = privateConfig().vars.PRIVATE_PILOT_POLICY;
  const prefix = `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}`;
  provider.routes.get(`${prefix}/settings`).bindings.push({
    name: "PRIVATE_PILOT_POLICY",
    type: "plain_text",
    text: policy,
  });
  provider.routes
    .get(`${prefix}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)
    .resources.bindings.push({
      name: "PRIVATE_PILOT_POLICY",
      type: "plain_text",
      text: policy,
    });
  await assert.rejects(
    verifyPublishedRelease(options),
    /provider-deployed-private-pilot-policy-mismatch/,
  );
});

test("postverify refuses changed private activation bounds despite matching config approval", async () => {
  for (const [field, value] of [
    ["mode", "bidirectional"],
    ["observationMode", "private-redacted"],
    ["policySha256", "b".repeat(64)],
    ["notBefore", "2026-11-10T00:00:00.000Z"],
    ["expiresAt", "2026-11-12T00:00:00.000Z"],
    ["deliveryEnabled", false],
  ]) {
    const { options } = await harness(privateConfig());
    options.approval.privatePilot[field] = value;
    let requests = 0;
    options.cloudflareRead = async () => {
      requests += 1;
      throw Error("must not be reached");
    };
    await assert.rejects(
      verifyPublishedRelease(options),
      /post-deploy-private-pilot-approval-mismatch/,
    );
    assert.equal(requests, 0);
  }
});
