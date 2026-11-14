import { DurableObject } from "cloudflare:workers";
import {
  initializeRecoveryFence,
  inspectRecoveryObject,
  OAUTH_RECOVERY_STORAGE,
  RECOVERY_MARKER_SQL,
  type RecoveryObjectRequest,
  recoveryObjectDenied,
  recoveryStorageWasVirgin,
  resetRecoveryObject,
} from "../shared/recovery-storage";
import {
  deferQuarantinedAlarm,
  RESTORE_QUARANTINE_RECHECK_MS,
  rejectRestoredAccess,
} from "../shared/release-quarantine";
import { authorizationServer } from "./provider";
import {
  oauthRecoveryEnvironment,
  observeOAuthRecoveryReads,
} from "./recovery-kv";

export { OAUTH_RECOVERY_STORAGE } from "../shared/recovery-manifests";

interface RedemptionReadProbe {
  grantReads: number;
  providerEntries: number;
  requestArrivals: number;
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const virgin = recoveryStorageWasVirgin(ctx.storage);
    ctx.storage.sql.exec(RECOVERY_MARKER_SQL);
    ctx.blockConcurrencyWhile(() =>
      initializeRecoveryFence(ctx, env, OAUTH_RECOVERY_STORAGE, virgin),
    );
  }

  private refusal(): Response | null {
    const quarantine = rejectRestoredAccess(this.env);
    if (quarantine) return quarantine;
    if (
      !recoveryObjectDenied(this.ctx.storage, this.env, OAUTH_RECOVERY_STORAGE)
    )
      return null;
    return new Response("Service unavailable during recovery", {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": "300",
      },
    });
  }

  inspectRecovery(input: RecoveryObjectRequest) {
    if (this.activeRequests !== 0)
      throw new Error("OAuth recovery requires an idle serializer");
    return inspectRecoveryObject(
      this.ctx,
      this.env,
      OAUTH_RECOVERY_STORAGE,
      input,
    );
  }

  resetRecovery(input: RecoveryObjectRequest) {
    if (this.activeRequests !== 0)
      throw new Error("OAuth recovery requires an idle serializer");
    return resetRecoveryObject(
      this.ctx,
      this.env,
      OAUTH_RECOVERY_STORAGE,
      input,
    );
  }

  async alarm(): Promise<void> {
    if (await deferQuarantinedAlarm(this.env, this.ctx.storage)) return;
    if (
      recoveryObjectDenied(this.ctx.storage, this.env, OAUTH_RECOVERY_STORAGE)
    ) {
      await this.ctx.storage.setAlarm(
        Date.now() + RESTORE_QUARANTINE_RECHECK_MS,
      );
      return;
    }
    await this.ctx.storage.deleteAlarm();
  }

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
    this.probe = {
      grantReads: 0,
      providerEntries: 0,
      requestArrivals: 0,
      barrier,
      release,
    };
  }

  async redemptionReadProbeState(): Promise<{
    activeRequests: number;
    requestArrivals: number;
    grantReads: number;
    providerEntries: number;
  }> {
    this.assertLocalProbe();
    return {
      activeRequests: this.activeRequests,
      requestArrivals: this.probe?.requestArrivals ?? 0,
      grantReads: this.probe?.grantReads ?? 0,
      providerEntries: this.probe?.providerEntries ?? 0,
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
    if (!probe) return oauthRecoveryEnvironment(this.env);
    // Observe logical grant keys after the generation prefix is enforced.
    return observeOAuthRecoveryReads(this.env, async (keys, result) => {
      if (
        typeof keys === "string" &&
        keys.startsWith("grant:") &&
        result !== null
      ) {
        probe.grantReads++;
        if (probe.grantReads === 1) await probe.barrier;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const initialRefusal = this.refusal();
    if (initialRefusal) return initialRefusal;
    const path = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      (path !== "/oauth/token" && path !== "/oauth/revoke")
    )
      return new Response("Not Found", { status: 404 });
    this.activeRequests++;
    // Monotonic probe arrivals survive a fast request finishing before polling.
    if (this.probe) this.probe.requestArrivals++;
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.tail;
    this.tail = before.then(() => current);
    try {
      await before;
      const queuedRefusal = this.refusal();
      if (queuedRefusal) return queuedRefusal;
      if (this.probe) this.probe.providerEntries++;
      const environment = this.observedEnvironment();
      const response = await authorizationServer(environment).fetch(
        request,
        environment,
        this.ctx as unknown as ExecutionContext,
      );
      return this.refusal() ?? response;
    } finally {
      this.activeRequests--;
      release();
    }
  }
}
