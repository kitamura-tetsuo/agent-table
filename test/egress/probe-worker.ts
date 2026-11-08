/**
 * Isolated, opt-in test entry for the real callback sender.
 * Never import this handler from the application Worker or log raw errors.
 */
import {
  sendVerifiedHttps,
  type CallbackFailure,
} from "../../src/notifications/egress";

export interface EgressProbeEnv {
  PROBE_AUTH_TOKEN?: string;
  PROBE_CALLBACK_URL?: string;
  PROBE_REVIEWED_ORIGIN?: string;
  PROBE_REVIEWED_PATH_PREFIX?: string;
}

type ProbeResult = "reachable" | "disabled" | CallbackFailure;

const SYNTHETIC_BODY = new TextEncoder().encode(
  JSON.stringify({ probe: "agent-table-egress", value: "synthetic" }),
);

function result(
  status: number,
  category: ProbeResult,
  upstreamStatus?: number,
): Response {
  return Response.json(
    upstreamStatus === undefined
      ? { result: category }
      : { result: category, upstreamStatus },
    { status, headers: { "Cache-Control": "no-store" } },
  );
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
      request.headers.get("Authorization") !== "Bearer " + env.PROBE_AUTH_TOKEN
    ) {
      return new Response(null, { status: 404 });
    }

    const outcome = await sendVerifiedHttps(
      env.PROBE_CALLBACK_URL,
      [{
        origin: env.PROBE_REVIEWED_ORIGIN,
        pathPrefix: env.PROBE_REVIEWED_PATH_PREFIX,
      }],
      { method: "POST", body: SYNTHETIC_BODY },
    );
    if (outcome.ok) return result(200, "reachable");
    const status = outcome.reason === "deadline"
      ? 504
      : outcome.reason === "destination-rejected"
        ? 422
        : 502;
    return result(status, outcome.reason, outcome.status);
  },
};
