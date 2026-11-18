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
  let clock = 0;
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
      healthNow: () => clock,
      waitForHealth: async (ms) => {
        clock += ms;
      },
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
      /post-deploy-build-not-observed|post-deploy-health-unverified|post-deploy-health-invalid|post-deploy-health-oversized|post-deploy-origin-unreachable/,
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

function publicHealth(candidate = config, release = {}) {
  return Response.json(
    {
      status: "ok",
      release: {
        environment: candidate.vars.RELEASE_ENVIRONMENT,
        profile: candidate.vars.RELEASE_PROFILE,
        buildSha: candidate.vars.RELEASE_BUILD_SHA,
        ...release,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const targetBase = `/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}`;
const initialVersion = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("a delayed release tuple converges without changing expected identity or leaking body values", async () => {
  const { options, provider } = await harness();
  const diagnostics = [];
  const requests = [];
  let healthCalls = 0;
  let deploymentReads = 0;
  const secret = "private-callback-or-body-value-MUST-NOT-BE-LOGGED";
  const result = await verifyPublishedRelease({
    ...options,
    cloudflareRead: async (path) => {
      if (path === `${targetBase}/deployments`) deploymentReads++;
      return provider.read(path);
    },
    httpFetch: async (url, init) => {
      requests.push({ url, method: init.method, redirect: init.redirect });
      return ++healthCalls === 1
        ? publicHealth(config, { profile: secret })
        : publicHealth();
    },
    onHealthMismatch: (entry) => diagnostics.push(entry),
  });
  assert.equal(result.verified, true);
  assert.equal(result.newVersionId, initialVersion);
  assert.equal(healthCalls, 2);
  assert.equal(deploymentReads, 2);
  assert.deepEqual(diagnostics, [
    { attempt: 1, elapsedMs: 0, mismatches: ["release.profile"] },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes(secret), false);
  assert.deepEqual(
    requests,
    Array(2).fill({
      url: `${config.vars.PUBLIC_ORIGIN}/health`,
      method: "GET",
      redirect: "error",
    }),
  );
});

test("each public tuple component must converge to its original expected value", async () => {
  for (const release of [
    { environment: "production" },
    { profile: "test-native-events" },
    { buildSha: "b".repeat(40) },
  ]) {
    const { options } = await harness();
    let calls = 0;
    const result = await verifyPublishedRelease({
      ...options,
      httpFetch: async () =>
        ++calls === 1 ? publicHealth(config, release) : publicHealth(),
    });
    assert.equal(result.verified, true);
    assert.equal(calls, 2);
    assert.equal(result.buildSha, config.vars.RELEASE_BUILD_SHA);
    assert.equal(result.environment, "staging");
    assert.equal(result.profile, "manual");
  }
});

test("permanent tuple mismatch stops at the fixed 30 second deadline without another health GET", async () => {
  const { options } = await harness();
  let now = 0;
  let calls = 0;
  const waits = [];
  await assert.rejects(
    verifyPublishedRelease({
      ...options,
      healthNow: () => now,
      waitForHealth: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      httpFetch: async () => {
        assert.ok(now < 30_000);
        calls++;
        return publicHealth(config, { buildSha: "b".repeat(40) });
      },
    }),
    /post-deploy-build-not-observed/,
  );
  assert.equal(now, 30_000);
  assert.equal(calls, 15);
  assert.equal(
    waits.reduce((a, b) => a + b, 0),
    30_000,
  );
});

test("a matching health response arriving at the deadline is not accepted", async () => {
  const { options } = await harness();
  let now = 0;
  let calls = 0;
  await assert.rejects(
    verifyPublishedRelease({
      ...options,
      healthNow: () => now,
      waitForHealth: async (ms) => {
        now += ms;
      },
      httpFetch: async () => {
        if (++calls === 1)
          return publicHealth(config, { profile: "test-native-events" });
        now = 30_000;
        return publicHealth();
      },
    }),
    /post-deploy-build-not-observed/,
  );
  assert.equal(calls, 2);
});

test("the real fixed deadline aborts a hung health request even when the transport has not returned", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { options } = await harness();
  let entered;
  let requestSignal;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const verification = verifyPublishedRelease({
    ...options,
    httpFetch: async (_url, init) => {
      requestSignal = init.signal;
      entered();
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(Error("aborted")), {
          once: true,
        });
      });
    },
  });
  const rejected = assert.rejects(
    verification,
    /post-deploy-build-not-observed/,
  );
  await started;
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test("final provider verification also must finish inside the same deadline", async () => {
  const { options, provider } = await harness();
  let now = 0;
  let calls = 0;
  let finalRead = false;
  await assert.rejects(
    verifyPublishedRelease({
      ...options,
      healthNow: () => now,
      waitForHealth: async (ms) => {
        now += ms;
      },
      httpFetch: async () => {
        if (++calls === 1)
          return publicHealth(config, { profile: "test-native-events" });
        finalRead = true;
        return publicHealth();
      },
      cloudflareRead: async (path) => {
        if (finalRead) now = 30_000;
        return provider.read(path);
      },
    }),
    /post-deploy-build-not-observed/,
  );
  assert.equal(calls, 2);
});

test("a healthy tuple cannot bless a different provider version or deployment after retry", async () => {
  for (const changed of ["version", "deployment"]) {
    const { options, provider } = await harness();
    let calls = 0;
    await assert.rejects(
      verifyPublishedRelease({
        ...options,
        httpFetch: async () => {
          if (++calls === 1)
            return publicHealth(config, { profile: "test-native-events" });
          const deployment = provider.routes.get(`${targetBase}/deployments`)
            .deployments[0];
          if (changed === "version") {
            const next = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
            provider.routes.set(
              `${targetBase}/versions/${next}`,
              structuredClone(
                provider.routes.get(`${targetBase}/versions/${initialVersion}`),
              ),
            );
            deployment.versions[0].version_id = next;
          } else deployment.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
          return publicHealth();
        },
      }),
      /post-deploy-version-changed/,
    );
    assert.equal(calls, 2);
  }
});

test("namespace drift during convergence is rejected by the original resource proof", async () => {
  const { options, provider } = await harness();
  let calls = 0;
  await assert.rejects(
    verifyPublishedRelease({
      ...options,
      httpFetch: async () => {
        if (++calls === 1)
          return publicHealth(config, { profile: "test-native-events" });
        const next = "cccccccccccccccccccccccccccccccc";
        provider.routes
          .get(`${targetBase}/settings`)
          .bindings.find((x) => x.name === "TABLES").namespace_id = next;
        provider.routes
          .get(`${targetBase}/versions/${initialVersion}`)
          .resources.bindings.find((x) => x.name === "TABLES").namespace_id =
          next;
        provider.routes
          .get(
            `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=1&per_page=100`,
          )
          .result.find(
            (x) => x.script === config.name && x.class === "TableDO",
          ).id = next;
        return publicHealth();
      },
    }),
    /post-deploy-resource-identity-changed/,
  );
  assert.equal(calls, 2);
});

test("HTTP, authentication, caching, size, JSON and malformed envelope failures never enter retry", async () => {
  const safeHeaders = { "Cache-Control": "no-store" };
  for (const makeResponse of [
    () => new Response("denied", { status: 401 }),
    () => new Response("denied", { status: 403 }),
    () => new Response("redirect", { status: 302 }),
    () => new Response("not found", { status: 404 }),
    () => Response.json({ status: "ok" }),
    () => new Response("x".repeat(2048), { headers: safeHeaders }),
    () =>
      new Response("{}", {
        headers: { ...safeHeaders, "Content-Length": "2048" },
      }),
    () => new Response("{", { headers: safeHeaders }),
    () => Response.json(null, { headers: safeHeaders }),
    () => Response.json({ status: "unauthorized" }, { headers: safeHeaders }),
    () =>
      Response.json(
        { status: "ok", release: { buildSha: "not-a-sha" } },
        { headers: safeHeaders },
      ),
    () => {
      throw Error("private transport error MUST NOT BE REPORTED");
    },
  ]) {
    const { options } = await harness();
    let calls = 0;
    let waits = 0;
    const diagnostics = [];
    await assert.rejects(
      verifyPublishedRelease({
        ...options,
        httpFetch: async () => {
          calls++;
          return makeResponse();
        },
        waitForHealth: async () => {
          waits++;
        },
        onHealthMismatch: (entry) => diagnostics.push(entry),
      }),
      /post-deploy-health-unverified|post-deploy-health-oversized|post-deploy-health-invalid|post-deploy-origin-unreachable/,
    );
    assert.equal(calls, 1);
    assert.equal(waits, 0);
    assert.deepEqual(diagnostics, []);
  }
});

test("provider authentication failure does not reach health or retry", async () => {
  const { options } = await harness();
  let calls = 0;
  await assert.rejects(
    verifyPublishedRelease({
      ...options,
      cloudflareRead: async () => {
        throw Error("provider access denied");
      },
      httpFetch: async () => {
        calls++;
        return publicHealth();
      },
    }),
    /provider access denied/,
  );
  assert.equal(calls, 0);
});

test("a matching JSON prefix without EOF remains a failure when its request aborts", async (t) => {
  const request = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => request.signal);
  const { options } = await harness();
  let pendingRead;
  const pending = new Promise((resolve) => {
    pendingRead = resolve;
  });
  let cancelled = 0;
  let calls = 0;
  let waits = 0;
  const diagnostics = [];
  const prefix = JSON.stringify({
    status: "ok",
    release: {
      environment: config.vars.RELEASE_ENVIRONMENT,
      profile: config.vars.RELEASE_PROFILE,
      buildSha: config.vars.RELEASE_BUILD_SHA,
    },
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
    },
    pull() {
      pendingRead();
    },
    cancel() {
      cancelled++;
    },
  });
  const verification = verifyPublishedRelease({
    ...options,
    httpFetch: async () => {
      calls++;
      return new Response(body, {
        headers: { "Cache-Control": "no-store" },
      });
    },
    waitForHealth: async () => {
      waits++;
    },
    onHealthMismatch: (entry) => diagnostics.push(entry),
  });
  const rejected = assert.rejects(verification, /post-deploy-health-invalid/);
  await pending;
  request.abort();
  await rejected;
  assert.equal(calls, 1);
  assert.equal(waits, 0);
  assert.equal(cancelled, 1);
  assert.deepEqual(diagnostics, []);
});
