import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPrivateClearanceTransport } from "./recovery-hosted-clearance-transport.mjs";

const ORIGIN =
  "https://agent-table-pr51-recovery-staging.kitamura-tetsuo.workers.dev";
const MARKER = { "X-Private-Clearance-Transport": "forwarded" };
const CSRF = "a".repeat(43);
const secret = "b".repeat(43);
const session = `__Host-agent_table_session=v1.11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.${secret}`;
const post = (signal = new AbortController().signal) => ({
  method: "POST",
  headers: {
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: `__Host-agent_table_csrf=${CSRF}`,
  },
  body: new URLSearchParams({ choice: "new", csrf: CSRF }).toString(),
  redirect: "manual",
  signal,
});
const get = (signal = new AbortController().signal) => ({
  redirect: "manual",
  signal,
});

test("the local factory pins the private service and removes all temporary files", async () => {
  let script;
  let configPath;
  let stopped = 0;
  const transport = await createPrivateClearanceTransport({
    unstable_dev: async (sourcePath, options) => {
      script = sourcePath;
      configPath = options.config;
      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.account_id, "0fbaae27d3ff021bc17109f1493d0b2d");
      assert.deepEqual(config.services, [
        {
          binding: "APPLICATION",
          service: "agent-table-pr51-recovery-staging",
          remote: true,
        },
      ]);
      assert.equal(config.workers_dev, false);
      assert.equal(config.preview_urls, false);
      assert.deepEqual(config.routes, []);
      // Explicit local:true makes Wrangler treat remote services as missing
      // local Workers. Its default keeps the relay local with remote bindings.
      assert.equal(Object.hasOwn(options, "local"), false);
      assert.equal(Object.hasOwn(options, "remote"), false);
      assert.equal(Object.hasOwn(options.experimental, "forceLocal"), false);
      assert.equal(options.ip, "127.0.0.1");
      assert.equal(options.port, 0);
      assert.equal(options.persist, false);
      assert.equal(options.logLevel, "none");
      assert.deepEqual(options.envFiles, []);
      assert.equal(options.experimental.watch, false);
      assert.equal(options.experimental.disableDevRegistry, true);
      assert.equal(options.experimental.enableContainers, false);
      assert.equal((await stat(script)).mode & 0o777, 0o600);
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(script))).mode & 0o777, 0o700);
      assert.equal(
        (await readFile(script, "utf8")).includes(
          config.vars.PRIVATE_CLEARANCE_TRANSPORT_TOKEN,
        ),
        false,
      );
      return {
        address: "127.0.0.1",
        fetch: async () => new Response("ok", { headers: MARKER }),
        stop: async () => stopped++,
      };
    },
  });
  await transport.dispose();
  await transport.dispose();
  assert.equal(stopped, 1);
  await assert.rejects(stat(script), { code: "ENOENT" });
  await assert.rejects(stat(configPath), { code: "ENOENT" });
  await assert.rejects(
    transport.application.fetch(`${ORIGIN}/health`, get()),
    /private-clearance-transport-disposed/,
  );
});

test("Origin and browser credentials stay inside the authenticated loopback envelope", async (t) => {
  let localCalls = 0;
  const transport = await createPrivateClearanceTransport({
    unstable_dev: async () => ({
      address: "127.0.0.1",
      stop: async () => undefined,
      fetch: async (input, init) => {
        localCalls++;
        assert.equal(input, "http://localhost/__private_clearance");
        const headers = new Headers(init.headers);
        assert.equal(headers.has("Origin"), false);
        assert.equal(headers.has("Cookie"), false);
        assert.match(headers.get("X-Private-Clearance-Token"), /^[\w-]{43}$/);
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "manual");
        const envelope = JSON.parse(init.body);
        assert.equal(envelope.url, `${ORIGIN}/guest/session`);
        assert.equal(envelope.method, "POST");
        assert.equal(new Headers(envelope.headers).get("Origin"), ORIGIN);
        assert.equal(
          new Headers(envelope.headers).get("Cookie"),
          `__Host-agent_table_csrf=${CSRF}; ${session}`,
        );
        assert.equal(new URLSearchParams(envelope.body).get("choice"), "reuse");
        return new Response("No valid guest session", {
          status: 401,
          headers: MARKER,
        });
      },
    }),
  });
  t.after(() => transport.dispose());
  const request = post();
  request.headers.Cookie += `; ${session}`;
  request.body = new URLSearchParams({
    choice: "reuse",
    csrf: CSRF,
  }).toString();
  const response = await transport.application.fetch(
    `${ORIGIN}/guest/session`,
    request,
  );
  assert.equal(response.status, 401);
  assert.equal(await response.text(), "No valid guest session");
  assert.equal(localCalls, 1);
});

test("the facade rejects other targets, paths, methods and credential headers before local dispatch", async (t) => {
  const transport = await createPrivateClearanceTransport({
    unstable_dev: async () => ({
      address: "127.0.0.1",
      stop: async () => undefined,
      fetch: async () => assert.fail("Out-of-scope request was forwarded"),
    }),
  });
  t.after(() => transport.dispose());
  const requests = [
    ["https://agent-table-staging.workers.dev/health", get()],
    [`${ORIGIN}/mcp`, get()],
    [`${ORIGIN}/guest/session`, { ...post(), method: "DELETE" }],
    [`${ORIGIN}/health`, { ...get(), headers: { Authorization: "secret" } }],
    [
      `${ORIGIN}/guest/session`,
      { ...post(), headers: { ...post().headers, Origin: "http://localhost" } },
    ],
    [`${ORIGIN}/guest/session?other=true`, post()],
    [
      `${ORIGIN}/guest/me`,
      { ...get(), headers: { Cookie: `${session}; other=value` } },
    ],
  ];
  for (const [url, init] of requests)
    await assert.rejects(
      transport.application.fetch(url, init),
      /private-clearance-transport-out-of-scope-request/,
    );
});

test("caller abort bounds stalled local fetch and cancels a late private body", async (t) => {
  let localSignal;
  let resolveResponse;
  let cancelled = false;
  const transport = await createPrivateClearanceTransport({
    unstable_dev: async () => ({
      address: "127.0.0.1",
      stop: async () => undefined,
      fetch: (_url, init) => {
        localSignal = init.signal;
        return new Promise((resolve) => {
          resolveResponse = resolve;
        });
      },
    }),
  });
  t.after(() => transport.dispose());
  const abort = new AbortController();
  const result = transport.application.fetch(
    `${ORIGIN}/health`,
    get(abort.signal),
  );
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort(new Error(secret));
  await assert.rejects(result, (error) => {
    assert.equal(error.message, "private-clearance-transport-aborted");
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(localSignal.aborted, true);
  resolveResponse(
    new Response(
      new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      }),
      { headers: MARKER },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("transport failures expose only fixed diagnostics and a safe HTTP status", async (t) => {
  let response = false;
  const transport = await createPrivateClearanceTransport({
    unstable_dev: async () => ({
      address: "127.0.0.1",
      stop: async () => undefined,
      fetch: async () => {
        if (!response) throw new Error(secret);
        return new Response(secret, { status: 403 });
      },
    }),
  });
  t.after(() => transport.dispose());
  await assert.rejects(
    transport.application.fetch(`${ORIGIN}/health`, get()),
    (error) => {
      assert.equal(error.message, "private-clearance-transport-request-failed");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  response = true;
  await assert.rejects(
    transport.application.fetch(`${ORIGIN}/health`, get()),
    (error) => {
      assert.equal(
        error.message,
        "private-clearance-transport-local-response:403",
      );
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("startup failure redacts diagnostics and removes private local configuration", async () => {
  let path;
  await assert.rejects(
    createPrivateClearanceTransport({
      unstable_dev: async (_script, options) => {
        path = options.config;
        throw new Error(secret);
      },
    }),
    (error) => {
      assert.equal(error.message, "private-clearance-transport-start-failed");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("Workerd preserves its Origin guard while the relay reaches the real disabled guest handler", async (t) => {
  const { build } = await import("esbuild");
  const { convertV4MiniflareOptions, Log, LogLevel, Miniflare } = await import(
    "miniflare"
  );
  const guestPath = fileURLToPath(
    new URL("../src/auth/guest.ts", import.meta.url),
  );
  const bundled = await build({
    stdin: {
      contents: `import { handleGuestChoice } from ${JSON.stringify(guestPath)};
        export default { fetch(request) {
          return handleGuestChoice(request, { ALLOW_NEW_GUESTS: "false" });
        } };`,
      resolveDir: dirname(guestPath),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["node:*", "cloudflare:*"],
    write: false,
    logLevel: "silent",
  });
  let miniflare;
  let clientName;
  let localToken;
  const transport = await createPrivateClearanceTransport({
    unstable_dev: async (script, options) => {
      const config = JSON.parse(await readFile(options.config, "utf8"));
      clientName = config.name;
      localToken = config.vars.PRIVATE_CLEARANCE_TRANSPORT_TOKEN;
      miniflare = new Miniflare(
        convertV4MiniflareOptions({
          cf: false,
          workers: [
            {
              name: config.name,
              script: await readFile(script, "utf8"),
              modules: true,
              compatibilityDate: config.compatibility_date,
              bindings: config.vars,
              serviceBindings: {
                APPLICATION: { name: config.services[0].service },
              },
              outboundService: () =>
                assert.fail("Unexpected external relay request"),
            },
            {
              name: config.services[0].service,
              script: bundled.outputFiles[0].text,
              modules: true,
              compatibilityDate: config.compatibility_date,
              compatibilityFlags: ["nodejs_compat"],
              outboundService: () =>
                assert.fail("Unexpected external application request"),
            },
          ],
          log: new Log(LogLevel.NONE),
        }),
      );
      await miniflare.ready;
      return {
        address: "127.0.0.1",
        fetch: (input, init) => miniflare.dispatchFetch(input, init),
        stop: () => miniflare.dispose(),
      };
    },
  });
  t.after(() => transport.dispose());
  const bindings = await miniflare.getBindings(clientName);
  const direct = await bindings.APPLICATION.fetch(
    `${ORIGIN}/guest/session`,
    post(),
  );
  assert.equal(direct.status, 403);
  assert.equal(await direct.text(), "Invalid Origin header");
  const relayed = await transport.application.fetch(
    `${ORIGIN}/guest/session`,
    post(),
  );
  assert.equal(relayed.status, 503);
  assert.equal(await relayed.text(), "New guest admission is disabled");
  assert.equal(relayed.headers.get("Cache-Control"), "no-store");
  assert.equal(relayed.headers.get("Set-Cookie"), null);
  const unauthorized = await miniflare.dispatchFetch(
    "http://localhost/__private_clearance",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(unauthorized.status, 403);
  const wrongTarget = await miniflare.dispatchFetch(
    "http://localhost/__private_clearance",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Private-Clearance-Token": localToken,
      },
      body: JSON.stringify({
        version: 1,
        url: "https://agent-table-staging.workers.dev/health",
        method: "GET",
        headers: [],
        body: "",
      }),
    },
  );
  assert.equal(wrongTarget.status, 400);
  assert.equal(
    wrongTarget.headers.get("X-Private-Clearance-Transport"),
    "rejected",
  );
});

test("startup deadline returns control and disposes a late local runtime", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let finishStartup;
  let path;
  let stopped = 0;
  const result = createPrivateClearanceTransport({
    unstable_dev: async (_script, options) => {
      path = options.config;
      markStarted();
      return new Promise((resolve) => {
        finishStartup = resolve;
      });
    },
  });
  const rejected = assert.rejects(
    result,
    /private-clearance-transport-start-failed/,
  );
  await started;
  t.mock.timers.tick(45_000);
  await rejected;
  await assert.rejects(stat(path), { code: "ENOENT" });
  finishStartup({
    address: "127.0.0.1",
    fetch: async () => assert.fail("Timed-out runtime must never be reused"),
    stop: async () => {
      stopped++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, 1);
});

test("stalled disposal cannot block controller compensation and removes credentials", async (t) => {
  let path;
  const transport = await createPrivateClearanceTransport({
    unstable_dev: async (_script, options) => {
      path = options.config;
      return {
        address: "127.0.0.1",
        fetch: async () => new Response(null, { headers: MARKER }),
        stop: () => new Promise(() => undefined),
      };
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = transport.dispose();
  const rejected = assert.rejects(
    result,
    /private-clearance-transport-dispose-failed/,
  );
  t.mock.timers.tick(10_000);
  await rejected;
  await assert.rejects(stat(path), { code: "ENOENT" });
});
