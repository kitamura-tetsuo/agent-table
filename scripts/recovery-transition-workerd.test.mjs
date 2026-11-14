import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { recoveryContext } from "../src/shared/recovery.ts";
import {
  ADMISSION_RECOVERY_STORAGE,
  GUEST_RECOVERY_STORAGE,
  OAUTH_RECOVERY_STORAGE,
  recoverySchemaCatalogSha256,
  TABLE_RECOVERY_STORAGE,
} from "../src/shared/recovery-manifests.ts";
import { signedRecoveryConfiguration } from "./recovery-configuration.mjs";

// Synthetic local evidence only: the actual production bundle, native SQLite
// and KV persistence, browser HTTP, OAuth provider, and RecoveryControl RPC all
// run in Workerd. This does not authorize a hosted recovery or certify a journal.
const template = JSON.parse(
  await readFile(
    new URL(
      "../test/fixtures/quarantined-restore-generated.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const NAME = "agent-table-recovery-transition";
const CLIENT = "agent-table-recovery-transition-operator";
const ORIGIN = "http://localhost:8787";
const REDIRECT = "http://localhost:8456/callback";
const RESOURCE = `${ORIGIN}/mcp`;
const SOURCE = "192.0.2.41";
const RESTORED_SOURCE = "192.0.2.42";
const NEXT_SOURCE = "192.0.2.43";
const COMMITMENT = "agent-table/recovery-namespace/v1";
const DO_BINDINGS = ["TABLES", "GUESTS", "OAUTH_SERIALIZER", "ADMISSION"];
const SESSION_COOKIE = "__Host-agent_table_session";
const CSRF_COOKIE = "__Host-agent_table_csrf";
const sha256 = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
const plain = (value) => JSON.parse(JSON.stringify(value));
let directory;
let base;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-table-recovery-transition-"));
  execFileSync(
    "node_modules/.bin/wrangler",
    ["deploy", "--dry-run", "--outdir", join(directory, "bundle")],
    {
      stdio: "pipe",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  const bundle = await readFile(join(directory, "bundle/index.js"));
  base = {
    ...structuredClone(template),
    name: NAME,
    durable_objects: {
      ...template.durable_objects,
      code_update_strategy: { mode: "immediate" },
    },
    vars: {
      ...template.vars,
      RELEASE_ENVIRONMENT: "local",
      RELEASE_BUILD_SHA: createHash("sha1").update(bundle).digest("hex"),
      PUBLIC_ORIGIN: ORIGIN,
      RESTORE_QUARANTINE: "false",
      ALLOW_NEW_GUESTS: "true",
      ALLOW_NEW_TABLES: "true",
    },
  };
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function runtime(persistence, config, outbound) {
  return new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      workers: [
        {
          name: NAME,
          scriptPath: "bundle/index.js",
          modules: true,
          compatibilityDate: "2026-11-07",
          compatibilityFlags: config.compatibility_flags,
          durableObjects: Object.fromEntries(
            config.durable_objects.bindings.map(({ name, class_name }) => [
              name,
              { className: class_name, useSQLite: true },
            ]),
          ),
          kvNamespaces: { OAUTH_KV: config.kv_namespaces[0].id },
          bindings: config.vars,
          outboundService: () => {
            outbound.push("unexpected-outbound-request");
            return new Response(null, { status: 503 });
          },
        },
        {
          name: CLIENT,
          script:
            "export default { fetch() { return new Response(null, { status: 404 }); } };",
          modules: true,
          compatibilityDate: "2026-11-07",
          serviceBindings: {
            RECOVERY: { name: NAME, entrypoint: "RecoveryControl" },
          },
        },
      ],
      resourcePersistencePath: persistence,
      log: new Log(LogLevel.ERROR),
    }),
  );
}

function dispatch(worker, path, source = SOURCE, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", source);
  headers.set("Host", new URL(ORIGIN).host);
  return worker.fetch(
    new Request(new URL(path, ORIGIN), {
      ...init,
      redirect: "manual",
      headers,
    }),
  );
}

function cookie(response, name) {
  const value = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`));
  assert(value, `Missing ${name} response cookie`);
  return value.split(";")[0];
}

function field(html, name) {
  const input = html.match(
    new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`),
  )?.[0];
  const value = input?.match(/\bvalue="([^"]*)"/)?.[1];
  assert(value, `Missing ${name} form field`);
  return value;
}

async function newBrowserGuest(worker, source) {
  const form = await dispatch(worker, "/guest", source);
  assert.equal(form.status, 200);
  const csrf = field(await form.text(), "csrf");
  const created = await dispatch(worker, "/guest/session", source, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Cookie: cookie(form, CSRF_COOKIE),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ choice: "new", csrf }),
  });
  assert.equal(created.status, 303, await created.clone().text());
  const sessionCookie = cookie(created, SESSION_COOKIE);
  const [version, guestId, sessionId, secret] = sessionCookie
    .slice(SESSION_COOKIE.length + 1)
    .split(".");
  assert.equal(version, "v1");
  const identity = await dispatch(worker, "/guest/me", source, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(identity.status, 200);
  assert.equal((await identity.json()).guestId, guestId);
  return { cookie: sessionCookie, guestId, sessionId, secret };
}

async function newBrowserTable(worker, browser, label, source) {
  const form = await dispatch(worker, "/guest/create", source, {
    headers: { Cookie: browser.cookie },
  });
  assert.equal(form.status, 200, await form.clone().text());
  const html = await form.text();
  const response = await dispatch(worker, "/guest/create", source, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Cookie: `${browser.cookie}; ${cookie(form, CSRF_COOKIE)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      csrf: field(html, "csrf"),
      request_id: field(html, "request_id"),
      title: label,
      purpose: "Synthetic recovery transition",
      ttl_seconds: "86400",
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const tableId = (await response.text()).match(
    /\/guest\/table\?table_id=([a-f0-9-]{36})/,
  )?.[1];
  assert(tableId, "Browser creation must return a committed table");
  return tableId;
}

async function oauth(worker, browser, source) {
  const registered = await dispatch(worker, "/oauth/register", source, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Synthetic recovery client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const { client_id: clientId } = await registered.json();
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "tables:read tables:write",
    state: "synthetic_recovery_state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
  };
  const consent = await dispatch(
    worker,
    `/authorize?${new URLSearchParams(params)}`,
    source,
    { headers: { Cookie: browser.cookie } },
  );
  assert.equal(consent.status, 200, await consent.clone().text());
  const html = await consent.text();
  const approved = await dispatch(worker, "/authorize", source, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Cookie: [
        browser.cookie,
        ...consent.headers.getSetCookie().map((line) => line.split(";")[0]),
      ].join("; "),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams([
      ...["handle", "csrf", "guest_id", "binding"].map((name) => [
        name,
        field(html, name),
      ]),
      ["decision", "approve"],
      ["scope", "tables:read"],
      ["scope", "tables:write"],
    ]),
  });
  assert.equal(approved.status, 302, await approved.clone().text());
  // Approval rotates the real browser credential; retain the current cookie
  // so later denial proves recovery, not a credential already invalidated here.
  browser.cookie = cookie(approved, SESSION_COOKIE);
  const [version, guestId, sessionId, secret] = browser.cookie
    .slice(SESSION_COOKIE.length + 1)
    .split(".");
  assert.equal(version, "v1");
  assert.equal(guestId, browser.guestId);
  Object.assign(browser, { sessionId, secret });
  const redirected = new URL(approved.headers.get("Location"));
  assert.equal(redirected.origin, new URL(REDIRECT).origin);
  const code = redirected.searchParams.get("code");
  assert(code);
  const exchanged = await dispatch(worker, "/oauth/token", source, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const tokens = await exchanged.json();
  assert.equal(typeof tokens.access_token, "string");
  return { clientId, params, token: tokens.access_token };
}

async function sdkRead(worker, token, tableId, source) {
  const client = new Client(
    { name: "recovery-transition", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(RESOURCE), {
      authProvider: { token: async () => token },
      fetch: (url, init) => {
        const request = new Request(url, init);
        request.headers.set("CF-Connecting-IP", source);
        request.headers.set("Host", new URL(ORIGIN).host);
        return worker.fetch(new Request(request, { redirect: "manual" }));
      },
    }),
  );
  try {
    const result = await client.callTool({
      name: "get_table",
      arguments: { table_id: tableId },
    });
    assert.notEqual(result.isError, true);
    const text = result.content.find((part) => part.type === "text")?.text;
    assert(text);
    return JSON.parse(text);
  } finally {
    await client.close();
  }
}

async function fixture(mf, label, source) {
  const worker = await mf.getWorker(NAME);
  const bindings = await mf.getBindings(NAME);
  const browser = await newBrowserGuest(worker, source);
  const tableId = await newBrowserTable(worker, browser, label, source);
  const issued = await oauth(worker, browser, source);
  const guest = bindings.GUESTS.get(
    bindings.GUESTS.idFromName(browser.guestId),
  );
  const grants = plain(
    await guest.listConnections(browser.sessionId, browser.secret),
  );
  assert.equal(grants.length, 1);
  const connection = grants[0];
  const actor = (scope) => ({
    kind: "verified-connection",
    guestId: browser.guestId,
    connectionId: connection.connectionId,
    scope,
    expiresAt: connection.expiresAt,
  });
  const table = bindings.TABLES.get(bindings.TABLES.idFromName(tableId));
  const body = `${label}: synthetic private transcript`;
  assert.equal(
    (
      await table.postMessage(actor("tables:write"), {
        request_id: crypto.randomUUID(),
        body,
      })
    ).ok,
    true,
  );
  assert.equal(
    (await table.readMessages(actor("tables:read"), {})).value.messages[0].body,
    body,
  );
  const metadata = await sdkRead(worker, issued.token, tableId, source);
  assert.equal(metadata.tableId, tableId);
  return {
    ...browser,
    ...issued,
    tableId,
    connection,
    actor,
    body,
    guestObjectId: bindings.GUESTS.idFromName(browser.guestId).toString(),
    tableObjectId: bindings.TABLES.idFromName(tableId).toString(),
  };
}

async function diskSql(persistence, objectId, statement, ...parameters) {
  const candidates = (await readdir(persistence, { recursive: true })).filter(
    (path) => path.endsWith(`${objectId}.sqlite`),
  );
  assert.equal(
    candidates.length,
    1,
    "One persisted SQLite database must identify the exact object",
  );
  const db = new DatabaseSync(join(persistence, candidates[0]), {
    readOnly: true,
  });
  try {
    return plain(db.prepare(statement).all(...parameters));
  } finally {
    db.close();
  }
}

async function filesDigest(root) {
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
  return Promise.all(
    files.map(async (path) => [path, sha256(await readFile(join(root, path)))]),
  );
}

function authority(baseConfig, identity) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const verificationKey = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  return (
    generation,
    operationId,
    phase,
    evidenceSha256 = null,
    previousRecordSha256 = "0".repeat(64),
  ) => {
    const config = structuredClone(baseConfig);
    config.vars.RECOVERY_VERIFICATION_KEY = verificationKey;
    config.vars.RESTORE_QUARANTINE = phase === "reset" ? "true" : "false";
    for (const name of ["ALLOW_NEW_GUESTS", "ALLOW_NEW_TABLES"])
      config.vars[name] = phase === "reset" ? "false" : "true";
    return signedRecoveryConfiguration(
      config,
      {
        format: "agent-table.fresh-start.v1",
        phase,
        operationId,
        generation,
        environment: "local",
        buildSha: config.vars.RELEASE_BUILD_SHA,
        configSha256: "0".repeat(64),
        schemaVersion: 12,
        namespaceIdentity: identity,
        planSha256: sha256({
          generation,
          operationId,
          fixture: "same-namespace-local-transition",
        }),
        evidenceSha256,
        previousRecordSha256,
        issuedAt: new Date().toISOString(),
        expiresAt:
          phase === "reset"
            ? new Date(Date.now() + 10 * 60_000).toISOString()
            : null,
        approvalRef: "fixture:recovery-transition-workerd",
      },
      signingKey,
    );
  };
}

function targets(bindings, f, source) {
  return [
    ["GUESTS", f.guestId],
    ["TABLES", f.tableId],
    ["OAUTH_SERIALIZER", "token-exchange-v1"],
    ["ADMISSION", sha256(`edge-v1:${source}`)],
    ["ADMISSION", sha256(`principal-v1:${f.guestId}`)],
  ].map(([binding, name]) => ({
    binding,
    objectId: bindings[binding].idFromName(name).toString(),
  }));
}

async function resetTargets(mf, list, operationId, generation) {
  const bindings = await mf.getBindings(NAME);
  const context = recoveryContext(bindings);
  assert.equal(
    context.kind,
    "authorized",
    "Reconstructed runtime must expose the signed reset configuration",
  );
  const { RECOVERY } = await mf.getBindings(CLIENT);
  const identity = plain(await RECOVERY.identity());
  assert.equal(identity.schemaVersion, 12);
  assert.deepEqual(
    identity.commitments,
    context.claims.namespaceIdentity.commitments,
  );
  const receipts = [];
  for (const target of list) {
    const request = {
      ...target,
      operationId,
      requestNonce: randomBytes(16).toString("hex"),
    };
    let receipt;
    try {
      receipt = plain(await RECOVERY.reset(request));
    } catch (error) {
      throw new Error(`Reset RPC denied ${target.binding}: ${error.message}`, {
        cause: error,
      });
    }
    assert.equal(receipt.objectId, target.objectId);
    assert.equal(receipt.markerGeneration, generation);
    assert.equal(receipt.empty, true);
    assert.equal(receipt.kvEntries, 0);
    assert.deepEqual(plain(await RECOVERY.inspect(request)), receipt);
    for (const [table, count] of Object.entries(receipt.counts))
      assert.equal(count, table === "table_transcript_usage" ? 1 : 0);
    receipts.push(receipt);
  }
  return receipts;
}

async function denied(mf, f, source) {
  const bindings = await mf.getBindings(NAME);
  const worker = await mf.getWorker(NAME);
  assert.equal(
    bindings.GUESTS.idFromName(f.guestId).toString(),
    f.guestObjectId,
  );
  assert.equal(
    bindings.TABLES.idFromName(f.tableId).toString(),
    f.tableObjectId,
  );
  const guest = bindings.GUESTS.get(bindings.GUESTS.idFromName(f.guestId));
  const table = bindings.TABLES.get(bindings.TABLES.idFromName(f.tableId));
  assert.equal(await guest.validateSession(f.sessionId, f.secret), null);
  assert.equal(
    (
      await guest.authorizeConnection(
        f.guestId,
        f.connection.connectionId,
        "tables:read",
      )
    ).allowed,
    false,
  );
  assert.equal(
    (await table.readMessages(f.actor("tables:read"), {})).ok,
    false,
  );
  const browser = await dispatch(worker, "/guest/me", source, {
    headers: { Cookie: f.cookie },
  });
  assert.equal(browser.status, 401);
  const token = await dispatch(worker, "/mcp", source, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${f.token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(token.status, 401);
  assert(!(await token.text()).includes(f.body));
}

test("signed fresh-start generations survive real Worker reconstruction and fence retained snapshots and OAuth keys", {
  timeout: 120_000,
}, async () => {
  const persistence = join(directory, "same-namespace-target");
  const snapshotA = join(directory, "snapshot-markerless-A");
  const snapshotG = join(directory, "snapshot-generation-G");
  const outbound = [];
  let mf;
  let phase = "legacy initialization";
  try {
    mf = runtime(persistence, base, outbound);
    const old = await fixture(mf, "Before recovery", SOURCE);
    const legacy = await mf.getBindings(NAME);
    const namespaceIdentity = {
      accountId: base.account_id,
      workerName: NAME,
      namespaces: {
        TABLES: "2".repeat(32),
        GUESTS: "3".repeat(32),
        OAUTH_SERIALIZER: "4".repeat(32),
        ADMISSION: "5".repeat(32),
        OAUTH_KV: base.kv_namespaces[0].id,
      },
      commitments: Object.fromEntries(
        DO_BINDINGS.map((name) => [
          name,
          legacy[name].idFromName(COMMITMENT).toString(),
        ]),
      ),
    };
    const signConfig = authority(base, namespaceIdentity);
    const resetList = targets(legacy, old, SOURCE);
    const unlistedId = crypto.randomUUID();
    const unlisted = legacy.GUESTS.get(legacy.GUESTS.idFromName(unlistedId));
    const unlistedSession = plain(await unlisted.createSession(unlistedId));
    const oldClientKey = `client:${old.clientId}`;
    const oldClient = await legacy.OAUTH_KV.get(oldClientKey);
    assert(oldClient, "Snapshot contains a genuine unprefixed provider client");
    const oldKeys = (await legacy.OAUTH_KV.list()).keys
      .map(({ name }) => name)
      .sort();
    assert(oldKeys.some((name) => name.startsWith("token:")));
    await mf.dispose();
    mf = undefined;
    await cp(persistence, snapshotA, { recursive: true, errorOnExist: true });
    const digestA = await filesDigest(snapshotA);
    assert(digestA.some(([path]) => path.endsWith(".sqlite")));
    // Miniflare's unsafe inspector adds its own application-visible table.
    // Keep the actual bundle unwrapped and inspect only stopped SQLite files.
    for (const target of resetList) {
      const descriptor = {
        GUESTS: GUEST_RECOVERY_STORAGE,
        TABLES: TABLE_RECOVERY_STORAGE,
        ADMISSION: ADMISSION_RECOVERY_STORAGE,
        OAUTH_SERIALIZER: OAUTH_RECOVERY_STORAGE,
      }[target.binding];
      const catalog = await diskSql(
        persistence,
        target.objectId,
        "SELECT name, type, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA') ORDER BY name",
      );
      assert.equal(
        recoverySchemaCatalogSha256(catalog),
        descriptor.schemaSha256,
        `Canonical production-bundle ${target.binding} catalog`,
      );
    }

    phase = "signed reset deployment";
    const generation = randomBytes(32).toString("hex");
    const operationId = crypto.randomUUID();
    const resetConfig = signConfig(generation, operationId, "reset");
    mf = runtime(persistence, resetConfig, outbound);
    const frozen = await dispatch(
      await mf.getWorker(NAME),
      "/guest/me",
      SOURCE,
      { headers: { Cookie: old.cookie } },
    );
    assert.equal(frozen.status, 503);
    const receipts = await resetTargets(mf, resetList, operationId, generation);
    // Retain old physical KV values as an adversarial stale-cache oracle. Hosted
    // workflow erasure is verified independently; generation scoping must hold
    // even while such old bytes remain readable through the raw test binding.
    assert.equal(
      await (await mf.getBindings(NAME)).OAUTH_KV.get(oldClientKey),
      oldClient,
    );
    await mf.dispose();
    mf = undefined;

    phase = "cleared generation deployment";
    const serveConfig = signConfig(
      generation,
      operationId,
      "serve",
      sha256(receipts),
    );
    mf = runtime(persistence, serveConfig, outbound);
    await denied(mf, old, SOURCE);
    const serving = await mf.getBindings(NAME);
    assert.equal(
      await serving.GUESTS.get(
        serving.GUESTS.idFromName(unlistedId),
      ).validateSession(unlistedSession.sessionId, unlistedSession.secret),
      null,
    );
    const fresh = await fixture(mf, "Fresh generation G", SOURCE);
    const freshClientKey = `agent-table:recovery:${generation}:client:${fresh.clientId}`;
    assert(await serving.OAUTH_KV.get(freshClientKey));
    assert.equal(await serving.OAUTH_KV.get(`client:${fresh.clientId}`), null);
    assert.equal(await serving.OAUTH_KV.get(oldClientKey), oldClient);
    const ignoredClient = await dispatch(
      await mf.getWorker(NAME),
      `/authorize?${new URLSearchParams(old.params)}`,
      SOURCE,
      { headers: { Cookie: fresh.cookie } },
    );
    assert.equal(
      ignoredClient.status,
      400,
      "A still-present unprefixed client must not authorize a fresh guest",
    );
    const prefixed = (
      await serving.OAUTH_KV.list({
        prefix: `agent-table:recovery:${generation}:`,
      })
    ).keys.map(({ name }) => name);
    assert(prefixed.some((name) => name.includes(":grant:")));
    assert(prefixed.some((name) => name.includes(":token:")));
    await mf.dispose();
    mf = undefined;
    await cp(persistence, snapshotG, { recursive: true, errorOnExist: true });
    const digestG = await filesDigest(snapshotG);

    phase = "markerless snapshot restored into the same physical target";
    await rm(persistence, { recursive: true, force: true });
    await cp(snapshotA, persistence, { recursive: true });
    mf = runtime(persistence, serveConfig, outbound);
    // Use a new edge source so its genuinely virgin admission object can run;
    // the old restored rate object is itself intentionally generation-fenced.
    await denied(mf, old, RESTORED_SOURCE);
    const virgin = await newBrowserGuest(
      await mf.getWorker(NAME),
      RESTORED_SOURCE,
    );
    assert.notEqual(virgin.guestId, old.guestId);
    const virginObjectId = (await mf.getBindings(NAME)).GUESTS.idFromName(
      virgin.guestId,
    ).toString();
    await mf.dispose();
    mf = undefined;
    assert.deepEqual(
      await diskSql(
        persistence,
        old.guestObjectId,
        "SELECT * FROM __agent_table_recovery",
      ),
      [],
    );
    assert.deepEqual(
      await diskSql(
        persistence,
        old.tableObjectId,
        "SELECT body FROM table_messages",
      ),
      [{ body: old.body }],
    );
    assert.deepEqual(
      await diskSql(
        persistence,
        virginObjectId,
        "SELECT generation FROM __agent_table_recovery",
      ),
      [{ generation }],
    );

    phase =
      "new reset generation prepared before restoring generation-G snapshot";
    const nextGeneration = randomBytes(32).toString("hex");
    const nextOperation = crypto.randomUUID();
    const previous = sha256({ generation, operationId, receipts });
    const nextReset = signConfig(
      nextGeneration,
      nextOperation,
      "reset",
      null,
      previous,
    );
    await rm(persistence, { recursive: true, force: true });
    await cp(snapshotG, persistence, { recursive: true });
    mf = runtime(persistence, nextReset, outbound);
    const nextReceipts = await resetTargets(
      mf,
      resetList,
      nextOperation,
      nextGeneration,
    );
    await mf.dispose();
    mf = undefined;

    phase = "G2 serving rejects an unenumerated old-G object";
    const nextServe = signConfig(
      nextGeneration,
      nextOperation,
      "serve",
      sha256(nextReceipts),
      previous,
    );
    mf = runtime(persistence, nextServe, outbound);
    // Negative inventory variant: deliberately omit fresh's existing G objects.
    // Production inventory reconciliation separately rejects missing coverage;
    // the runtime fence must still deny any object that escaped enumeration.
    await denied(mf, fresh, NEXT_SOURCE);
    const newest = await fixture(mf, "Fresh generation G2", NEXT_SOURCE);
    const newestBindings = await mf.getBindings(NAME);
    assert(
      await newestBindings.OAUTH_KV.get(
        `agent-table:recovery:${nextGeneration}:client:${newest.clientId}`,
      ),
    );
    assert(
      await newestBindings.OAUTH_KV.get(freshClientKey),
      "Old-G provider keys remain as the stale-namespace oracle",
    );
    assert.equal(
      await newestBindings.OAUTH_KV.get(`client:${newest.clientId}`),
      null,
    );
    assert.deepEqual(outbound, []);
    await mf.dispose();
    mf = undefined;
    assert.deepEqual(
      await diskSql(
        persistence,
        fresh.guestObjectId,
        "SELECT generation FROM __agent_table_recovery",
      ),
      [{ generation }],
    );
    assert.deepEqual(
      await diskSql(
        persistence,
        fresh.tableObjectId,
        "SELECT body FROM table_messages",
      ),
      [{ body: fresh.body }],
    );
    assert.deepEqual(await filesDigest(snapshotA), digestA);
    assert.deepEqual(await filesDigest(snapshotG), digestG);
  } catch (error) {
    throw new Error(
      `Recovery transition failed during ${phase}: ${error.message}`,
      { cause: error },
    );
  } finally {
    await mf?.dispose();
  }
});
