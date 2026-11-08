import { DurableObject } from "cloudflare:workers";
import { authorizationServer } from "./provider";

interface RedemptionReadProbe {
  grantReads: number;
  release: () => void;
  barrier: Promise<void>;
}

/**
 * A single object serializes OAuth token and revocation requests.
 *
 * KV cannot atomically consume a code by itself. The promise queue prevents a
 * second redemption from reading an unconsumed grant while the first exchange
 * is inside the pinned provider's KV read/modify/write sequence.
 */
export class OAuthTokenDO extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();
  private activeRequests = 0;
  private probe: RedemptionReadProbe | null = null;

  private assertLocalProbe(): void {
    // The probe is an internal DO RPC, never a public Worker HTTP endpoint.
    // Refuse it for any origin other than the isolated test harness.
    if (this.env.PUBLIC_ORIGIN !== "http://localhost:8787") {
      throw new Error("Redemption probe is restricted to isolated local tests");
    }
  }

  async armRedemptionReadProbe(): Promise<void> {
    this.assertLocalProbe();
    if (this.probe) throw new Error("Redemption probe is already armed");
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.probe = { grantReads: 0, barrier, release };
  }

  async redemptionReadProbeState(): Promise<{
    activeRequests: number;
    grantReads: number;
  }> {
    this.assertLocalProbe();
    return {
      activeRequests: this.activeRequests,
      grantReads: this.probe?.grantReads ?? 0,
    };
  }

  async releaseRedemptionReadProbe(): Promise<void> {
    this.assertLocalProbe();
    this.probe?.release();
  }

  async clearRedemptionReadProbe(): Promise<void> {
    this.assertLocalProbe();
    this.probe?.release();
    this.probe = null;
  }

  private observedEnvironment(): Env {
    const probe = this.probe;
    if (!probe) return this.env;
    // Intercept the real library's grant read, AFTER the KV read has returned
    // but BEFORE that grant can be mutated. This leaves PKCE and the provider's
    // redemption and persistence logic intact; it is not a mocked verdict.
    const kv = new Proxy(this.env.OAUTH_KV, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "get" && typeof value === "function") {
          return async (...args: unknown[]): Promise<unknown> => {
            const result = await (
              value.bind(target) as (...params: unknown[]) => Promise<unknown>
            )(...args);
            if (
              typeof args[0] === "string" &&
              args[0].startsWith("grant:") &&
              result !== null
            ) {
              probe.grantReads++;
              if (probe.grantReads === 1) await probe.barrier;
            }
            return result;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ...this.env, OAUTH_KV: kv };
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      (path !== "/oauth/token" && path !== "/oauth/revoke")
    )
      return new Response("Not Found", { status: 404 });
    this.activeRequests++;
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.tail;
    this.tail = before.then(() => current);
    try {
      await before;
      const environment = this.observedEnvironment();
      return await authorizationServer(environment).fetch(
        request,
        environment,
        this.ctx as unknown as ExecutionContext,
      );
    } finally {
      this.activeRequests--;
      release();
    }
  }
}
