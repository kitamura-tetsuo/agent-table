import { recoveryServingGeneration } from "../shared/recovery";
import { isRestoreQuarantined } from "../shared/release-quarantine";

const PREFIX = "agent-table:recovery:";
const GENERATION = /^[a-f0-9]{64}$/;

type ReadType = "text" | "json" | "arrayBuffer" | "stream";
type ReadOptions = ReadType | Partial<KVNamespaceGetOptions<ReadType>>;
type ReadKeys = string | string[];
type ReadMethod = (keys: ReadKeys, options?: ReadOptions) => Promise<unknown>;
type ReadObserver = (keys: ReadKeys, result: unknown) => Promise<void>;
type FacadeRecord = {
  source: Env;
  generation: string | null;
  authorization: string | undefined;
  namespace: KVNamespace;
};

const environments = new WeakMap<Env, FacadeRecord>();

export class RecoveryOAuthUnavailableError extends Error {
  constructor() {
    super("OAuth access unavailable during recovery");
    this.name = "RecoveryOAuthUnavailableError";
  }
}

function generationFor(env: Env): string | null {
  try {
    if (isRestoreQuarantined(env)) throw new RecoveryOAuthUnavailableError();
    const generation = recoveryServingGeneration(env);
    if (generation !== null && !GENERATION.test(generation)) {
      throw new RecoveryOAuthUnavailableError();
    }
    return generation;
  } catch {
    throw new RecoveryOAuthUnavailableError();
  }
}

function assertCurrent(record: FacadeRecord): void {
  if (
    generationFor(record.source) !== record.generation ||
    record.source.RECOVERY_AUTHORIZATION !== record.authorization
  ) {
    throw new RecoveryOAuthUnavailableError();
  }
}

function key(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Invalid OAuth KV key");
  }
  return value;
}

function encodeCursor(generation: string, prefix: string, cursor: string) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, generation, prefix, cursor }),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(value: string, generation: string, prefix: string) {
  try {
    if (value.length > 32_768 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("Invalid cursor");
    }
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      ),
    );
    if (
      !decoded ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      Object.keys(decoded).length !== 4 ||
      decoded.version !== 1 ||
      decoded.generation !== generation ||
      decoded.prefix !== prefix ||
      typeof decoded.cursor !== "string" ||
      decoded.cursor.length === 0
    ) {
      throw new Error("Invalid cursor");
    }
    return decoded.cursor as string;
  } catch {
    throw new TypeError("Invalid recovery-scoped OAuth KV cursor");
  }
}

function guardStream(value: unknown, record: FacadeRecord): unknown {
  if (!(value instanceof ReadableStream)) return value;
  const reader = value.getReader();
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          assertCurrent(record);
          const next = await reader.read();
          assertCurrent(record);
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          await reader.cancel().catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    // Do not prefetch a private chunk before a caller asks to consume it.
    { highWaterMark: 0 },
  );
}

function scopedNamespace(raw: KVNamespace, record: FacadeRecord): KVNamespace {
  const generation = record.generation;
  if (generation === null) throw new RecoveryOAuthUnavailableError();
  const physicalPrefix = `${PREFIX}${generation}:`;
  const physical = (value: unknown) => `${physicalPrefix}${key(value)}`;

  const read = async (
    method: "get" | "getWithMetadata",
    keys: ReadKeys,
    options?: ReadOptions,
  ): Promise<unknown> => {
    assertCurrent(record);
    const logical = Array.isArray(keys) ? keys.map(key) : key(keys);
    const requested = Array.isArray(logical)
      ? logical.map(physical)
      : physical(logical);
    const result = await (raw[method].bind(raw) as ReadMethod)(
      requested,
      options,
    );
    assertCurrent(record);
    const guarded = (value: unknown) => {
      if (method === "get") return guardStream(value, record);
      // Native bulk reads return null for an absent key; preserve that result.
      if (Array.isArray(logical) && value === null) return null;
      if (!value || typeof value !== "object" || !("value" in value)) {
        throw new Error("Invalid OAuth KV metadata response");
      }
      return { ...value, value: guardStream(value.value, record) };
    };
    if (!Array.isArray(logical)) return guarded(result);
    if (!(result instanceof Map))
      throw new Error("Invalid OAuth KV bulk response");
    const allowed = new Map(logical.map((name) => [physical(name), name]));
    const mapped = new Map<string, unknown>();
    for (const [name, value] of result) {
      const logicalName = allowed.get(name);
      if (logicalName === undefined) {
        throw new Error("OAuth KV bulk response crossed recovery scope");
      }
      mapped.set(logicalName, guarded(value));
    }
    return mapped;
  };

  // Deliberately expose only the complete KV interface; no raw method fallback.
  return {
    get: (keys: ReadKeys, options?: ReadOptions) => read("get", keys, options),
    getWithMetadata: (keys: ReadKeys, options?: ReadOptions) =>
      read("getWithMetadata", keys, options),
    async put(
      name: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) {
      assertCurrent(record);
      await raw.put(physical(name), value, options);
      assertCurrent(record);
    },
    async delete(name: string) {
      assertCurrent(record);
      await raw.delete(physical(name));
      assertCurrent(record);
    },
    async list(options: KVNamespaceListOptions = {}) {
      assertCurrent(record);
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("Invalid OAuth KV list options");
      }
      const logicalPrefix = options.prefix ?? "";
      if (typeof logicalPrefix !== "string") {
        throw new TypeError("Invalid OAuth KV list prefix");
      }
      const nativeOptions: KVNamespaceListOptions = {
        ...options,
        prefix: `${physicalPrefix}${logicalPrefix}`,
      };
      if (options.cursor) {
        nativeOptions.cursor = decodeCursor(
          options.cursor,
          generation,
          logicalPrefix,
        );
      } else {
        delete nativeOptions.cursor;
      }
      const result = await raw.list(nativeOptions);
      assertCurrent(record);
      const names = new Set<string>();
      const keys = result.keys.map((entry) => {
        if (
          typeof entry.name !== "string" ||
          !entry.name.startsWith(`${physicalPrefix}${logicalPrefix}`) ||
          names.has(entry.name)
        ) {
          throw new Error("OAuth KV list response crossed recovery scope");
        }
        names.add(entry.name);
        return { ...entry, name: entry.name.slice(physicalPrefix.length) };
      });
      if (result.list_complete)
        return { list_complete: true, keys, cacheStatus: result.cacheStatus };
      if (typeof result.cursor !== "string" || result.cursor.length === 0) {
        throw new Error("Invalid OAuth KV continuation response");
      }
      return {
        list_complete: false,
        keys,
        cacheStatus: result.cacheStatus,
        cursor: encodeCursor(generation, logicalPrefix, result.cursor),
      };
    },
  } as KVNamespace;
}

/** Every OAuth provider entry uses this facade, including helper and token RPCs. */
export function oauthRecoveryEnvironment(env: Env): Env {
  const current = generationFor(env);
  const existing = environments.get(env);
  if (existing) {
    assertCurrent(existing);
    if (
      existing.generation !== current ||
      existing.namespace !== env.OAUTH_KV
    ) {
      throw new RecoveryOAuthUnavailableError();
    }
    return env;
  }
  if (current === null) return env;
  const record: FacadeRecord = {
    source: env,
    generation: current,
    authorization: env.RECOVERY_AUTHORIZATION,
    namespace: env.OAUTH_KV,
  };
  const namespace = scopedNamespace(env.OAUTH_KV, record);
  const wrapped = { ...env, OAUTH_KV: namespace };
  environments.set(wrapped, { ...record, namespace });
  return wrapped;
}

/** Local regression probes observe logical keys after scope enforcement. */
export function observeOAuthRecoveryReads(
  env: Env,
  observer: ReadObserver,
): Env {
  const scoped = oauthRecoveryEnvironment(env);
  const generation = generationFor(scoped);
  const record: FacadeRecord = {
    source: env,
    generation,
    authorization: env.RECOVERY_AUTHORIZATION,
    namespace: scoped.OAUTH_KV,
  };
  const observed = new Proxy(scoped.OAUTH_KV, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "get" && typeof value === "function") {
        return async (keys: ReadKeys, options?: ReadOptions) => {
          const result = await (value.bind(target) as ReadMethod)(
            keys,
            options,
          );
          await observer(keys, result);
          assertCurrent(record);
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wrapped = { ...scoped, OAUTH_KV: observed };
  environments.set(wrapped, { ...record, namespace: observed });
  return wrapped;
}
