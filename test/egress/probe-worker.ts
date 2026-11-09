/**
 * Isolated, opt-in test entry for the real callback sender.
 * Never import this handler from the application Worker or log raw errors.
 */
import {
  type CallbackFailure,
  sendVerifiedHttps,
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
  testId?: string,
  cfErrorCode?: number,
): Response {
  const payload: {
    result: ProbeResult;
    upstreamStatus?: number;
    testId?: string;
    cfErrorCode?: number;
  } = { result: category };
  if (upstreamStatus !== undefined) payload.upstreamStatus = upstreamStatus;
  if (testId !== undefined) payload.testId = testId;
  if (cfErrorCode !== undefined) payload.cfErrorCode = cfErrorCode;
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

const TEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export default {
  async fetch(request: Request, env: EgressProbeEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || path !== "/__egress_probe") {
      return new Response(null, { status: 404 });
    }
    const rawTestId = request.headers.get("x-probe-test-id");
    const testId =
      rawTestId && TEST_ID_PATTERN.test(rawTestId) ? rawTestId : undefined;
    if (
      !env.PROBE_AUTH_TOKEN ||
      !env.PROBE_CALLBACK_URL ||
      !env.PROBE_REVIEWED_ORIGIN ||
      !env.PROBE_REVIEWED_PATH_PREFIX
    ) {
      return result(503, "disabled", undefined, testId);
    }
    if (
      request.headers.get("Authorization") !== `Bearer ${env.PROBE_AUTH_TOKEN}`
    ) {
      return new Response(null, { status: 404 });
    }

    const outcome = await sendVerifiedHttps(
      env.PROBE_CALLBACK_URL,
      [
        {
          origin: env.PROBE_REVIEWED_ORIGIN,
          pathPrefix: env.PROBE_REVIEWED_PATH_PREFIX,
        },
      ],
      { method: "POST", body: SYNTHETIC_BODY },
    );
    if (outcome.ok) return result(200, "reachable", undefined, testId);
    const status =
      outcome.reason === "deadline"
        ? 504
        : outcome.reason === "destination-rejected"
          ? 422
          : 502;
    return result(
      status,
      outcome.reason,
      outcome.status,
      testId,
      outcome.cfErrorCode,
    );
  },
};
