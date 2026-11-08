import { DurableObject } from "cloudflare:workers";
import { authorizationServer } from "./provider";

/**
 * One global Durable Object serializes the OAuth token/revocation boundary.
 * This cannot make Workers KV transactional: the real-library concurrency
 * tests must still prove code redemption and refresh behavior before release.
 */
export class OAuthTokenDO extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      (path !== "/oauth/token" && path !== "/oauth/revoke")
    )
      return new Response("Not Found", { status: 404 });
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.tail;
    this.tail = before.then(() => current);
    await before;
    try {
      return await authorizationServer(this.env).fetch(
        request,
        this.env,
        this.ctx as unknown as ExecutionContext,
      );
    } finally {
      release();
    }
  }
}
