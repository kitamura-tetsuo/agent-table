import { createHash } from "node:crypto";

export const buildSha = "a".repeat(40);
export const now = Date.parse("2026-11-11T12:00:00Z");
export const runId = "1234";
const DO_CLASSES = [
  ["TABLES", "TableDO"],
  ["GUESTS", "GuestDO"],
  ["OAUTH_SERIALIZER", "OAuthTokenDO"],
  ["ADMISSION", "AdmissionDO"],
];
const REQUIRED_SECRETS = [
  "INVITATION_RESPONSE_KEYRING",
  "CALLBACK_CREDENTIAL_KEYRING",
];
export const ciSteps = [
  "Typecheck",
  "Lint",
  "Application unit tests",
  "Worker integration tests",
  "Restore runtime tests",
  "Browser E2E tests",
  "Wrangler dry-run",
];

export function makeConfig(environment) {
  return {
    name: `agent-table-${environment}`,
    account_id: "f".repeat(32),
    main: "src/index.ts",
    workers_dev: false,
    preview_urls: false,
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    durable_objects: {
      bindings: DO_CLASSES.map(([name, class_name]) => ({ name, class_name })),
    },
    migrations: [
      { tag: "v1", new_sqlite_classes: ["TableDO", "GuestDO"] },
      { tag: "v2", new_sqlite_classes: ["OAuthTokenDO"] },
      { tag: "v3", new_sqlite_classes: ["AdmissionDO"] },
    ],
    kv_namespaces: [
      {
        binding: "OAUTH_KV",
        id: (environment === "staging" ? "1" : "2").repeat(32),
      },
    ],
    vars: {
      RELEASE_ENVIRONMENT: environment,
      RELEASE_BUILD_SHA: buildSha,
      RELEASE_PROFILE: "manual",
      RESTORE_QUARANTINE: "false",
      PUBLIC_ORIGIN: `https://${environment}.service.test`,
      ENABLE_MCP_SUBSCRIPTIONS: "false",
      ENABLE_OPENAI_EVENTS: "false",
      ALLOW_OUTBOUND_NOTIFICATIONS: "false",
      ALLOW_NEW_GUESTS: "false",
      ALLOW_NEW_TABLES: "true",
    },
  };
}

export function makeFixture(environment = "staging") {
  const config = makeConfig(environment);
  const peer = makeConfig(environment === "staging" ? "production" : "staging");
  const configText = JSON.stringify(config);
  const configSha256 = createHash("sha256").update(configText).digest("hex");
  const ref = `https://github.com/kitamura-tetsuo/agent-table/actions/runs/${runId}`;
  return {
    environment,
    profile: "manual",
    buildSha,
    configText,
    peerText: JSON.stringify(peer),
    inventory: {
      environment,
      workerName: config.name,
      bindings: REQUIRED_SECRETS,
    },
    evidence: {
      environment,
      buildSha,
      configSha256,
      checks: Object.fromEntries(
        ["application", "security", "browser"].map((name) => [
          name,
          { status: "passed", refs: [ref] },
        ]),
      ),
    },
    operations: {
      environment,
      profile: "manual",
      buildSha,
      configSha256,
      origin: config.vars.PUBLIC_ORIGIN,
      review: {
        operator: "kitamura-tetsuo",
        decision: "approve",
        reviewedAt: new Date(now).toISOString(),
      },
      retention: Object.fromEntries(
        ["backup", "logs"].map((name) => [
          name,
          {
            status: "operator-verified",
            reviewedAt: new Date(now).toISOString(),
            policy: "verified policy: test-only",
            source: `https://developers.cloudflare.com/${name}`,
          },
        ]),
      ),
      schema: {
        testedVersion: 11,
        nonDestructiveRollback: true,
        rollbackRunbook: `https://github.com/kitamura-tetsuo/agent-table/blob/${buildSha}/docs/operations.md`,
      },
      restore: { type: "no-restore", independentlyReviewed: true },
      cost: {
        usageObserved: true,
        measurementSource:
          "https://github.com/kitamura-tetsuo/agent-table/actions/runs/1234",
        currentPricingSource:
          "https://developers.cloudflare.com/workers/platform/pricing/",
      },
    },
    workflow: {
      repository: "kitamura-tetsuo/agent-table",
      ref: "refs/heads/main",
      eventName: "workflow_dispatch",
      sha: buildSha,
      environment,
      runId: "2345",
      runAttempt: "1",
      cloudflareAccountId: config.account_id,
    },
  };
}

export function makePrivatePilotFixture({
  mode = "a-only",
  observationMode = mode === "a-only-discovery"
    ? "private-redacted"
    : undefined,
} = {}) {
  const fixture = makeFixture("staging");
  const config = JSON.parse(fixture.configText);
  const policy = {
    schemaVersion: 1,
    mode,
    ...(observationMode === undefined ? {} : { observationMode }),
    buildSha,
    approvedAt: new Date(now - 60_000).toISOString(),
    notBefore: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    approvalRef: "fixture-pilot-approval",
    recipientGuestId: "11111111-1111-4111-8111-111111111111",
    recipientConnectionId: "22222222-2222-4222-8222-222222222222",
    tableIds: ["33333333-3333-4333-8333-333333333333"],
    callbackTargets:
      mode === "a-only-discovery"
        ? []
        : [
            {
              origin: "https://receiver.example.com",
              pathPrefix: "/mcp-events",
            },
          ],
  };
  config.vars.RELEASE_PROFILE = "private-pilot-a-only";
  config.vars.PRIVATE_PILOT_POLICY = JSON.stringify(policy);
  config.vars.ALLOW_OUTBOUND_NOTIFICATIONS =
    mode === "a-only-discovery" ? "false" : "true";
  fixture.profile = config.vars.RELEASE_PROFILE;
  fixture.configText = JSON.stringify(config);
  const configSha256 = createHash("sha256")
    .update(fixture.configText)
    .digest("hex");
  fixture.evidence.configSha256 = configSha256;
  fixture.operations.configSha256 = configSha256;
  fixture.operations.profile = fixture.profile;
  fixture.operations.privatePilot = {
    mode,
    policySha256: createHash("sha256")
      .update(config.vars.PRIVATE_PILOT_POLICY)
      .digest("hex"),
    approvalRef: policy.approvalRef,
    independentOwnerConsentsReviewed: true,
    ...(mode === "a-only-discovery"
      ? { callbackDiscoveryReviewed: true, noOutboundReviewed: true }
      : { callbackControlReviewed: true, nativeFetchRiskAccepted: true }),
    ...(observationMode === undefined
      ? {}
      : { privateObservationReviewed: true }),
    boundedCanaryReviewed: true,
    stopPlanReviewed: true,
  };
  return fixture;
}

const namespace = (env, index) =>
  `${env === "staging" ? "1" : "2"}${String(index + 1).repeat(31)}`;

export function makeProviderMock(config, peer) {
  const routes = new Map();
  const namespaces = [];
  const domains = [config, peer].map((worker) => ({
    service: worker.name,
    hostname: new URL(worker.vars.PUBLIC_ORIGIN).hostname,
    enabled: true,
    previews_enabled: false,
  }));
  for (const worker of [config, peer]) {
    const env = worker.vars.RELEASE_ENVIRONMENT;
    namespaces.push(
      ...DO_CLASSES.map(([, className], index) => ({
        id: namespace(env, index),
        class: className,
        name: className,
        script: worker.name,
        use_sqlite: true,
      })),
    );
    const base = `/client/v4/accounts/${worker.account_id}/workers/scripts/${worker.name}`;
    const bindings = [
      ...DO_CLASSES.map(([name, class_name], i) => ({
        name,
        type: "durable_object_namespace",
        class_name,
        namespace_id: namespace(env, i),
      })),
      {
        name: "OAUTH_KV",
        type: "kv_namespace",
        namespace_id: worker.kv_namespaces[0].id,
      },
      ...Object.entries(worker.vars).map(([name, text]) => ({
        name,
        type: "plain_text",
        text,
      })),
    ];
    routes.set(`${base}/settings`, { bindings });
    routes.set(`${base}/subdomain`, {
      enabled: false,
      previews_enabled: false,
    });
    routes.set(
      `${base}/secrets`,
      REQUIRED_SECRETS.map((name) => ({
        name,
        type: "secret_text",
        text: "NEVER_ECHO_ME",
      })),
    );
    routes.set(
      `/client/v4/accounts/${worker.account_id}/storage/kv/namespaces/${worker.kv_namespaces[0].id}`,
      { id: worker.kv_namespaces[0].id },
    );
    routes.set(`${base}/deployments`, {
      deployments: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          versions: [
            {
              percentage: 100,
              version_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            },
          ],
        },
      ],
    });
    routes.set(`${base}/versions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, {
      resources: {
        bindings: structuredClone(bindings),
        script: {
          named_handlers: DO_CLASSES.map(([, className]) => ({
            name: className,
            handlers: ["class"],
          })),
        },
        script_runtime: {
          migration_tag: "v3",
          exports: Object.fromEntries(
            DO_CLASSES.map(([, className]) => [
              className,
              { type: "durable-object", state: "created", storage: "sqlite" },
            ]),
          ),
        },
      },
    });
  }
  routes.set(
    `/client/v4/accounts/${config.account_id}/workers/domains?page=1&per_page=100`,
    {
      result: domains,
      resultInfo: {
        page: 1,
        per_page: 100,
        count: domains.length,
        total_count: domains.length,
      },
    },
  );
  routes.set(
    `/client/v4/accounts/${config.account_id}/workers/durable_objects/namespaces?page=1&per_page=100`,
    {
      result: namespaces,
      resultInfo: {
        page: 1,
        per_page: 100,
        count: namespaces.length,
        total_count: namespaces.length,
      },
    },
  );
  return {
    routes,
    read: async (path) => {
      if (!routes.has(path)) throw Error("not mocked");
      return structuredClone(routes.get(path));
    },
  };
}

export function makeGithubMock(environment = "staging") {
  const deploymentPath = "/repos/kitamura-tetsuo/agent-table/actions/runs/2345";
  const routes = new Map([
    [
      deploymentPath,
      {
        id: 2345,
        repository: { full_name: "kitamura-tetsuo/agent-table" },
        head_sha: buildSha,
        head_branch: "main",
        event: "workflow_dispatch",
        path: `.github/workflows/deploy-${environment}.yml`,
        run_attempt: 1,
        status: "in_progress",
        actor: { login: "kitamura-tetsuo", type: "User" },
      },
    ],
    [
      `${deploymentPath}/approvals`,
      [
        {
          state: "approved",
          environments: [{ name: environment }],
          user: { login: "kitamura-tetsuo", type: "User" },
        },
      ],
    ],
    [
      "/repos/kitamura-tetsuo/agent-table/git/ref/heads/main",
      {
        ref: "refs/heads/main",
        object: { type: "commit", sha: buildSha },
      },
    ],
    [
      `/repos/kitamura-tetsuo/agent-table/actions/runs/${runId}`,
      {
        repository: { full_name: "kitamura-tetsuo/agent-table" },
        head_sha: buildSha,
        head_branch: "main",
        path: ".github/workflows/ci.yml",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
      },
    ],
    [
      `/repos/kitamura-tetsuo/agent-table/actions/runs/${runId}/jobs?per_page=100`,
      {
        total_count: 1,
        jobs: [
          {
            name: "verify",
            conclusion: "success",
            steps: ciSteps.map((name) => ({
              name,
              status: "completed",
              conclusion: "success",
            })),
          },
        ],
      },
    ],
  ]);
  return {
    routes,
    read: async (path) => {
      if (!routes.has(path)) throw Error("not mocked");
      return structuredClone(routes.get(path));
    },
  };
}
