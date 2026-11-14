import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  authorizationServer,
  canonicalMcpResource,
} from "../../src/auth/provider";
import { oauthRecoveryEnvironment } from "../../src/auth/recovery-kv";
import { AdmissionDO } from "../../src/objects/admission";
import { recoveryFixture } from "../helpers/recovery";

const prefix = (generation: string) => `agent-table:recovery:${generation}:`;

function resetEnvironment(fixture: ReturnType<typeof recoveryFixture>) {
  return fixture.authorize(
    {
      phase: "reset",
      evidenceSha256: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      RESTORE_QUARANTINE: "true",
      ALLOW_NEW_GUESTS: "false",
      ALLOW_NEW_TABLES: "false",
      ENABLE_MCP_SUBSCRIPTIONS: "false",
      ENABLE_OPENAI_EVENTS: "false",
      ALLOW_OUTBOUND_NOTIFICATIONS: "false",
    },
  );
}

describe("OAuth recovery generation namespace", () => {
  it("preserves legacy access only when all recovery bindings are absent", () => {
    expect(oauthRecoveryEnvironment(env)).toBe(env);
    for (const partial of [
      { RECOVERY_AUTHORIZATION: "invalid" },
      { RECOVERY_CONFIG_SHA256: "" },
      { RECOVERY_VERIFICATION_KEY: "" },
      { RECOVERY_NAMESPACE_IDENTITY: "{}" },
    ]) {
      expect(() => oauthRecoveryEnvironment({ ...env, ...partial })).toThrow(
        "OAuth access unavailable during recovery",
      );
    }
    const fixture = recoveryFixture(env);
    expect(() => oauthRecoveryEnvironment(resetEnvironment(fixture))).toThrow(
      "OAuth access unavailable during recovery",
    );
    expect(() =>
      oauthRecoveryEnvironment({
        ...fixture.env,
        RESTORE_QUARANTINE: "true",
      }),
    ).toThrow("OAuth access unavailable during recovery");
  });

  it("never reads or deletes old logical keys and preserves single-read types and metadata", async () => {
    const fixture = recoveryFixture(env);
    const logical = `grant:${crypto.randomUUID()}`;
    await env.OAUTH_KV.put(logical, JSON.stringify({ era: "old" }));
    const scopedEnv = oauthRecoveryEnvironment(fixture.env);
    expect(oauthRecoveryEnvironment(scopedEnv)).toBe(scopedEnv);
    const scoped = scopedEnv.OAUTH_KV;
    expect(await scoped.get(logical, "json")).toBeNull();
    await scoped.put(logical, JSON.stringify({ era: "new" }), {
      metadata: { version: 2 },
    });
    expect(await env.OAUTH_KV.get(logical, "json")).toEqual({ era: "old" });
    expect(
      await env.OAUTH_KV.get(
        `${prefix(fixture.claims.generation)}${logical}`,
        "json",
      ),
    ).toEqual({ era: "new" });
    expect(await scoped.get(logical)).toBe('{"era":"new"}');
    expect(await scoped.get(logical, { type: "json" })).toEqual({ era: "new" });
    expect(
      new TextDecoder().decode(
        (await scoped.get(logical, "arrayBuffer")) ?? undefined,
      ),
    ).toBe('{"era":"new"}');
    const stream = await scoped.get(logical, "stream");
    expect(await new Response(stream).text()).toBe('{"era":"new"}');
    expect(await scoped.getWithMetadata(logical, "json")).toMatchObject({
      value: { era: "new" },
      metadata: { version: 2 },
    });
    await scoped.delete(logical);
    expect(await scoped.get(logical)).toBeNull();
    expect(await env.OAUTH_KV.get(logical, "json")).toEqual({ era: "old" });
  });

  it("keeps bulk get/getWithMetadata map keys logical and retains missing values", async () => {
    const fixture = recoveryFixture(env);
    const scoped = oauthRecoveryEnvironment(fixture.env).OAUTH_KV;
    const logical = `client:${crypto.randomUUID()}`;
    const missing = `client:${crypto.randomUUID()}`;
    await scoped.put(logical, JSON.stringify({ id: 7 }), {
      metadata: { proof: "current" },
    });
    const values = await scoped.get([logical, missing], "json");
    expect(values).toBeInstanceOf(Map);
    expect([...values.keys()].sort()).toEqual([logical, missing].sort());
    expect(values.get(logical)).toEqual({ id: 7 });
    expect(values.get(missing)).toBeNull();
    const textValues = await scoped.get([logical, missing]);
    expect(textValues.get(logical)).toBe('{"id":7}');
    expect(textValues.get(missing)).toBeNull();
    const withMetadata = await scoped.getWithMetadata([logical, missing], {
      type: "json",
    });
    expect(withMetadata).toBeInstanceOf(Map);
    expect(withMetadata.get(logical)).toMatchObject({
      value: { id: 7 },
      metadata: { proof: "current" },
    });
    const nativeMissing = await env.OAUTH_KV.getWithMetadata(
      [`${prefix(fixture.claims.generation)}${missing}`],
      { type: "json" },
    );
    expect(withMetadata.has(missing)).toBe(true);
    expect(withMetadata.get(missing)).toEqual(
      nativeMissing.get(`${prefix(fixture.claims.generation)}${missing}`),
    );
  });

  it("scopes every list page and binds cursors to generation and logical prefix", async () => {
    const fixture = recoveryFixture(env);
    const scoped = oauthRecoveryEnvironment(fixture.env).OAUTH_KV;
    const logicalPrefix = `client:${crypto.randomUUID()}:`;
    const names = ["a", "b", "c"].map((name) => `${logicalPrefix}${name}`);
    for (const [index, name] of names.entries()) {
      await env.OAUTH_KV.put(name, "old");
      await scoped.put(name, "current", { metadata: { index } });
    }
    const first = await scoped.list({ prefix: logicalPrefix, limit: 1 });
    expect(first.list_complete).toBe(false);
    expect(first.keys[0]).toMatchObject({
      name: names[0],
      metadata: { index: 0 },
    });
    if (first.list_complete) throw new Error("Missing continuation cursor");
    const second = await scoped.list({
      prefix: logicalPrefix,
      limit: 1,
      cursor: first.cursor,
    });
    expect(second.keys.map((entry) => entry.name)).toEqual([names[1]]);
    const other = recoveryFixture(env);
    await expect(
      oauthRecoveryEnvironment(other.env).OAUTH_KV.list({
        prefix: logicalPrefix,
        cursor: first.cursor,
      }),
    ).rejects.toThrow("recovery-scoped OAuth KV cursor");
    await expect(
      scoped.list({ prefix: "grant:", cursor: first.cursor }),
    ).rejects.toThrow("recovery-scoped OAuth KV cursor");
    expect(await scoped.get(first.keys[0].name)).toBe("current");
    await scoped.delete(first.keys[0].name);
    expect(await env.OAUTH_KV.get(first.keys[0].name)).toBe("old");
  });

  it("rejects unexpected physical keys and has no raw method passthrough", async () => {
    const fixture = recoveryFixture(env);
    const namespace = {
      ...env.OAUTH_KV,
      get: vi.fn(async () => new Map([["unscoped:secret", "private"]])),
      list: vi.fn(async () => ({
        keys: [{ name: "unscoped:secret" }],
        list_complete: true,
        cacheStatus: null,
      })),
      unsafeRaw: () => "private",
    } as unknown as KVNamespace;
    const scoped = oauthRecoveryEnvironment(
      fixture.authorize({}, { OAUTH_KV: namespace }),
    ).OAUTH_KV;
    await expect(scoped.get(["requested"])).rejects.toThrow(
      "crossed recovery scope",
    );
    await expect(scoped.list()).rejects.toThrow("crossed recovery scope");
    expect("unsafeRaw" in scoped).toBe(false);
  });

  it("revalidates authority after an in-flight KV read before returning its value", async () => {
    const fixture = recoveryFixture(env);
    let release: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(() => pending);
    const target = fixture.authorize(
      {},
      { OAUTH_KV: { get: read } as unknown as KVNamespace },
    );
    const scoped = oauthRecoveryEnvironment(target).OAUTH_KV;
    const outcome = scoped.get("grant:in-flight");
    const refused = expect(outcome).rejects.toThrow(
      "OAuth access unavailable during recovery",
    );
    Object.assign(target, resetEnvironment(fixture));
    release("private value from a superseded generation");
    await refused;
    expect(read).toHaveBeenCalledWith(
      `${prefix(fixture.claims.generation)}grant:in-flight`,
      undefined,
    );
  });

  it("refuses a previously opened stream once quarantine starts without leaking a prefetched chunk", async () => {
    const fixture = recoveryFixture(env);
    const target = fixture.authorize();
    const scoped = oauthRecoveryEnvironment(target).OAUTH_KV;
    const name = `grant:${crypto.randomUUID()}`;
    await scoped.put(name, "private stream contents");
    const stream = await scoped.get(name, "stream");
    if (!stream) throw new Error("Missing stream fixture");
    // Let any eager pull complete before the generation authority changes.
    await Promise.resolve();
    target.RESTORE_QUARANTINE = "true";
    await expect(stream.getReader().read()).rejects.toThrow(
      "OAuth access unavailable during recovery",
    );
  });

  it("refuses retained helpers when a different operation claims the same generation", async () => {
    const fixture = recoveryFixture(env);
    const target = fixture.authorize();
    const scoped = oauthRecoveryEnvironment(target).OAUTH_KV;
    await scoped.put("synthetic-existing-grant", "private");
    Object.assign(
      target,
      fixture.authorize({ operationId: crypto.randomUUID() }),
    );
    await expect(scoped.get("synthetic-existing-grant")).rejects.toThrow(
      "OAuth access unavailable during recovery",
    );
  });

  it("scopes direct provider fetch, helper lists, token validation and maintenance entry points", async () => {
    const fixture = recoveryFixture(env);
    const server = authorizationServer(fixture.env);
    const response = await server.fetch(
      new Request(`${env.PUBLIC_ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Synthetic recovery client",
          redirect_uris: ["https://client.example/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
      fixture.env,
      createExecutionContext(),
    );
    expect(response.status).toBe(201);
    const client = (await response.json()) as { client_id: string };
    expect(await env.OAUTH_KV.get(`client:${client.client_id}`)).toBeNull();
    expect(
      await oauthRecoveryEnvironment(fixture.env).OAUTH_KV.get(
        `client:${client.client_id}`,
      ),
    ).not.toBeNull();
    const listed = await server.getOAuthApi(fixture.env).listClients();
    expect(listed.items.map((entry) => entry.clientId)).toContain(
      client.client_id,
    );
    const reads: string[] = [];
    const target = fixture.authorize(
      {},
      {
        OAUTH_KV: {
          get: async (name: string) => {
            reads.push(name);
            return null;
          },
          list: async (options: KVNamespaceListOptions) => {
            reads.push(options.prefix ?? "");
            return { keys: [], list_complete: true, cacheStatus: null };
          },
        } as unknown as KVNamespace,
      },
    );
    const probe = authorizationServer(target);
    expect(
      await probe.validateToken(
        canonicalMcpResource(target),
        "synthetic-user:synthetic-grant:synthetic-token",
        target,
      ),
    ).toBeNull();
    await probe.purgeExpiredData(target);
    expect(reads.length).toBeGreaterThan(1);
    expect(
      reads.every((name) => name.startsWith(prefix(fixture.claims.generation))),
    ).toBe(true);
    const other = recoveryFixture(env);
    expect(() => server.getOAuthApi(other.env)).toThrow(
      "OAuth access unavailable during recovery",
    );
  });
});

describe("auxiliary Durable Object recovery", () => {
  it("keeps old admission rows denied until reset and refuses another generation after reconstruction", async () => {
    const fixture = recoveryFixture(env);
    const stub = env.ADMISSION.get(
      env.ADMISSION.idFromName(crypto.randomUUID()),
    );
    expect(await stub.consume("application", 10)).toEqual({ allowed: true });
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("synthetic-private-metadata", "retained");
      const mutable = instance as unknown as { env: Env };
      mutable.env = resetEnvironment(fixture);
      const input = {
        objectId: state.id.toString(),
        operationId: fixture.claims.operationId,
      };
      expect(instance.consume("application", 10)).toEqual({
        allowed: false,
        retryAfterMs: 60_000,
      });
      expect(await instance.inspectRecovery(input)).toMatchObject({
        counts: { admission_hits: 1 },
        kvEntries: 1,
        empty: false,
      });
      expect(await instance.resetRecovery(input)).toMatchObject({
        counts: { admission_hits: 0 },
        kvEntries: 0,
        markerGeneration: fixture.claims.generation,
        empty: true,
      });
      mutable.env = fixture.env;
      expect(instance.consume("application", 10)).toEqual({ allowed: true });
      const reconstructed = new AdmissionDO(state, fixture.env);
      expect(reconstructed.consume("application", 10)).toEqual({
        allowed: true,
      });
      const other = recoveryFixture(env);
      const mismatched = new AdmissionDO(state, other.env);
      expect(mismatched.consume("application", 10)).toEqual({
        allowed: false,
        retryAfterMs: 60_000,
      });
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM admission_hits")
          .one(),
      ).toEqual({ n: 2 });
      expect(
        await state.storage.get("synthetic-private-metadata"),
      ).toBeUndefined();
    });
    // The ordinary test binding has no certificate: it must not adopt the marker.
    await runInDurableObject(stub, (instance, state) => {
      (instance as unknown as { env: Env }).env = env;
      expect(instance.consume("application", 10).allowed).toBe(false);
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM admission_hits")
          .one(),
      ).toEqual({ n: 2 });
    });
  });

  it("resets serializer storage and rechecks quarantine after its actual request queue wait", async () => {
    const fixture = recoveryFixture(env);
    const stub = env.OAUTH_SERIALIZER.get(
      env.OAUTH_SERIALIZER.idFromName(crypto.randomUUID()),
    );
    await runInDurableObject(stub, async (instance, state) => {
      const mutable = instance as unknown as { env: Env; tail: Promise<void> };
      mutable.env = resetEnvironment(fixture);
      await state.storage.put("synthetic-old-serializer-state", "private");
      const input = {
        objectId: state.id.toString(),
        operationId: fixture.claims.operationId,
      };
      expect(await instance.inspectRecovery(input)).toMatchObject({
        kvEntries: 1,
        empty: false,
      });
      expect(await instance.resetRecovery(input)).toMatchObject({
        counts: {},
        kvEntries: 0,
        markerGeneration: fixture.claims.generation,
        empty: true,
      });
      mutable.env = fixture.env;
      await instance.armRedemptionReadProbe();
      let release: () => void = () => {};
      mutable.tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = instance.fetch(
        new Request(`${env.PUBLIC_ORIGIN}/oauth/token`, { method: "POST" }),
      );
      expect(await instance.redemptionReadProbeState()).toMatchObject({
        activeRequests: 1,
        providerEntries: 0,
      });
      mutable.env = { ...fixture.env, RESTORE_QUARANTINE: "true" };
      release();
      expect((await pending).status).toBe(503);
      expect(await instance.redemptionReadProbeState()).toMatchObject({
        activeRequests: 0,
        providerEntries: 0,
        grantReads: 0,
      });
      expect(
        await state.storage.get("synthetic-old-serializer-state"),
      ).toBeUndefined();
      await instance.clearRedemptionReadProbe();
    });
  });
});
