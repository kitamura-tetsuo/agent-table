import { timingSafeEqual } from "node:crypto";
import { sendVerifiedHttps } from "../../src/notifications/egress";
import {
  parseDestinationPolicy,
  SafeEgressError,
} from "../../src/notifications/egress-policy";

interface ProbeEnv {
  EGRESS_PROBE_AUTH_TOKEN?: string;
  EGRESS_PROBE_ALLOWED_HOSTS?: string;
  EGRESS_PROBE_CASES?: string;
}

interface ProbeCase {
  name: string;
  url: string;
}

function approvedProbe(request: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || secret.length > 256) {
    return false;
  }
  const supplied = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const actualBytes = new TextEncoder().encode(supplied);
  const expectedBytes = new TextEncoder().encode(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function configuredCase(value: string | undefined, name: string): ProbeCase {
  let records: unknown;
  try {
    records = JSON.parse(value ?? "");
  } catch {
    throw new SafeEgressError("policy");
  }
  if (
    !Array.isArray(records) ||
    records.length > 16 ||
    !records.every(
      (record) =>
        record !== null &&
        typeof record === "object" &&
        typeof record.name === "string" &&
        /^[a-z][a-z0-9-]{0,31}$/.test(record.name) &&
        typeof record.url === "string" &&
        record.url.length <= 4_096,
    )
  ) {
    throw new SafeEgressError("policy");
  }
  const found = records.find((record) => record.name === name) as
    | ProbeCase
    | undefined;
  if (!found) {
    throw new SafeEgressError("policy");
  }
  return found;
}

function jsonResult(status: number, result: object): Response {
  return Response.json(result, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Deliberately separate probe Worker; never route this through the app Worker. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      url.pathname !== "/__egress_probe" ||
      !approvedProbe(request, env.EGRESS_PROBE_AUTH_TOKEN)
    ) {
      return jsonResult(404, { result: "not-found" });
    }
    try {
      const probe = configuredCase(
        env.EGRESS_PROBE_CASES,
        url.searchParams.get("case") ?? "",
      );
      const reply = await sendVerifiedHttps(
        {
          url: probe.url,
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: new TextEncoder().encode("synthetic-agent-table-egress-probe"),
        },
        parseDestinationPolicy(env.EGRESS_PROBE_ALLOWED_HOSTS),
      );
      return jsonResult(200, {
        result: "response",
        status: reply.status,
        bodyBytes: reply.body.byteLength,
      });
    } catch (error) {
      return jsonResult(200, {
        result: "failure",
        category: error instanceof SafeEgressError ? error.code : "transport",
      });
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
