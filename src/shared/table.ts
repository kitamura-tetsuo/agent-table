import { CREATION_LIMITS, TABLE_LIMITS } from "./limits";

export type TableState = "waiting" | "open" | "closed" | "expired" | "deleted";

export type SafeMembership = {
  membershipId: string;
  seat: 1 | 2;
  role: "creator" | "invitee";
  joinedAt: string;
};

export type SafeTableMetadata = {
  tableId: string;
  title: string;
  purpose?: string;
  state: TableState;
  createdAt: string;
  expiresAt: string;
  memberships: SafeMembership[];
  ownMembershipId: string;
  ownInboxUri: string;
  limits: {
    participants: number;
    ttlDefaultSeconds: number;
    ttlMinSeconds: number;
    ttlMaxSeconds: number;
    messageBodyBytes: number;
    maxMessages: number;
    transcriptBodyBytes: number;
    readPageDefault: number;
    readPageMaximum: number;
  };
};

export type OwnInboxStatus = {
  tableId: string;
  membershipId: string;
  state: TableState;
  lastSeq: number;
  latestPeerSeq: number;
  expiresAt: string;
};

export type TableFailureCode =
  | "TABLE_NOT_FOUND"
  | "TABLE_EXPIRED"
  | "TABLE_TERMINAL"
  | "INVITATION_INVALID"
  | "INVITATION_EXPIRED"
  | "INVITATION_REVOKED"
  | "INVITATION_CONSUMED"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_RESERVATION"
  | "TEMPORARILY_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "INVALID_REPLY"
  | "INVALID_CURSOR"
  | "LIMIT_REACHED"
  | "RATE_LIMITED";

export type TableResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: TableFailureCode };

export const EFFECTIVE_TABLE_LIMITS = {
  participants: TABLE_LIMITS.participants,
  ttlDefaultSeconds: CREATION_LIMITS.defaultTtlSeconds,
  ttlMinSeconds: CREATION_LIMITS.minTtlSeconds,
  ttlMaxSeconds: CREATION_LIMITS.maxTtlSeconds,
  messageBodyBytes: TABLE_LIMITS.messageBodyBytes,
  maxMessages: TABLE_LIMITS.maxMessages,
  transcriptBodyBytes: TABLE_LIMITS.transcriptBodyBytes,
  readPageDefault: TABLE_LIMITS.readPageDefault,
  readPageMaximum: TABLE_LIMITS.readPageMaximum,
} as const;
