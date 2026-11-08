import { CREATION_LIMITS } from "./limits";

const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;

export function validCreationRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

export type CreationRequest = {
  request_id: string;
  title: string;
  purpose?: string;
  ttl_seconds?: number;
};

export type ParsedCreationRequest = {
  requestId: string;
  arguments: {
    title: string;
    purpose?: string;
    ttl_seconds: number;
  };
};

export class InvalidCreationRequestError extends Error {
  constructor() {
    super("Invalid creation request");
    this.name = "InvalidCreationRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Count Unicode code points and refuse malformed surrogate sequences. */
function validText(value: unknown, maxCodePoints: number): value is string {
  if (typeof value !== "string") return false;
  let count = 0;
  for (const symbol of value) {
    const codePoint = symbol.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      ++count > maxCodePoints
    ) {
      return false;
    }
  }
  return true;
}

/** Strict API validation; accepted text is never trimmed or normalized. */
export function parseCreationRequest(value: unknown): ParsedCreationRequest {
  if (!isRecord(value)) throw new InvalidCreationRequestError();
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) => !["request_id", "title", "purpose", "ttl_seconds"].includes(key),
    ) ||
    !validCreationRequestId(value.request_id) ||
    !validText(value.title, CREATION_LIMITS.maxTitleCodePoints) ||
    value.title.trim().length === 0 ||
    (value.purpose !== undefined &&
      !validText(value.purpose, CREATION_LIMITS.maxPurposeCodePoints))
  ) {
    throw new InvalidCreationRequestError();
  }
  const ttl = value.ttl_seconds ?? CREATION_LIMITS.defaultTtlSeconds;
  if (
    typeof ttl !== "number" ||
    !Number.isSafeInteger(ttl) ||
    ttl < CREATION_LIMITS.minTtlSeconds ||
    ttl > CREATION_LIMITS.maxTtlSeconds
  ) {
    throw new InvalidCreationRequestError();
  }

  return {
    requestId: value.request_id,
    arguments: {
      title: value.title,
      ...(value.purpose === undefined ? {} : { purpose: value.purpose }),
      ttl_seconds: ttl,
    },
  };
}

/** Canonical JSON sorts keys but retains exact text and effective defaults. */
export async function creationRequestDigest(
  args: ParsedCreationRequest["arguments"],
): Promise<string> {
  const sorted: Record<string, string | number> = {};
  for (const key of Object.keys(args).sort()) {
    const value = args[key as keyof typeof args];
    if (value !== undefined) sorted[key] = value;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(sorted));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
