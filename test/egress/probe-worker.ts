/**
 * Isolated, opt-in Cloudflare fetch reachability probe for Issue #19.
 *
 * Never import this handler from the application Worker. A successful probe
 * says nothing about connection-time IP policy, rebinding or TLS-name proof.
 */
import { validateReviewedCallbackDestination } from "../../src/notifications/egress";

export interface EgressProbeEnv {
  PROBE_AUTH_TOKEN?: string;
  PROBE_CALLBACK_URL?: string;
  PROBE_REVIEWED_ORIGIN?: string;
  PROBE_REVIEWED_PATH_PREFIX?: string;
}

type ProbeResult =
  | "reachable"
  | "disabled"
  | "destination-rejected"
  | "redirect-refused"
  | "upstream-non-2xx"
  | "response-too-large"
  | "deadline"
  | "transport-error";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SYNTHETIC_BODY = JSON.stringify({
  probe: "agent-table-egress",
  value: "synthetic",
});

function result(
  status: number,
  category: ProbeResult,
  extra?: Record<string, unknown>,
): Response {
  return Response.json(
    { result: category, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Count bytes without ever collecting or echoing the receiver's response. */
async function responseWithinLimit(response: Response): Promise<boolean> {
  const claimed = response.headers.get("Content-Length");
  if (
    claimed !== null &&
    /^\d+$/.test(claimed) &&
    Number(claimed) > MAX_RESPONSE_BYTES
  ) {
    return false;
  }
  if (!response.body) {
    return true;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return true;
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        return false;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export default {
  async fetch(request: Request, env: EgressProbeEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || path !== "/__egress_probe") {
      return new Response(null, { status: 404 });
    }
    if (
      !env.PROBE_AUTH_TOKEN ||
      !env.PROBE_CALLBACK_URL ||
      !env.PROBE_REVIEWED_ORIGIN ||
      !env.PROBE_REVIEWED_PATH_PREFIX
    ) {
      return result(503, "disabled");
    }
    if (
      request.headers.get("Authorization") !== `Bearer ${env.PROBE_AUTH_TOKEN}`
    ) {
      return new Response(null, { status: 404 });
    }

    const decision = validateReviewedCallbackDestination(
      env.PROBE_CALLBACK_URL,
      [
        {
          origin: env.PROBE_REVIEWED_ORIGIN,
          pathPrefix: env.PROBE_REVIEWED_PATH_PREFIX,
        },
      ],
    );
    if (!decision.ok) {
      return result(422, "destination-rejected");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(decision.url.toString(), {
        method: "POST",
        body: SYNTHETIC_BODY,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        return result(502, "redirect-refused");
      }
      if (!(await responseWithinLimit(response))) {
        return result(502, "response-too-large");
      }
      console.log(
        "probe-upstream-status:",
        response.status,
        response.statusText,
      );
      for (const [k, v] of response.headers.entries()) {
        console.log(`probe-upstream-header: ${k}: ${v}`);
      }
      return response.ok
        ? result(200, "reachable")
        : result(502, "upstream-non-2xx", {
            upstreamStatus: response.status,
          });
    } catch (err) {
      console.error("probe-fetch-error:", err);
      return result(
        controller.signal.aborted ? 504 : 502,
        controller.signal.aborted ? "deadline" : "transport-error",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  },
};
