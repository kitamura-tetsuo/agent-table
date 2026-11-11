/** Application policy, independent of Cloudflare's platform quotas. */
export const CREATION_LIMITS = {
  defaultTtlSeconds: 24 * 60 * 60,
  minTtlSeconds: 60 * 60,
  maxTtlSeconds: 7 * 24 * 60 * 60,
  maxTitleCodePoints: 120,
  maxPurposeCodePoints: 2_000,
  maxReservationsPerWindow: 10,
  reservationWindowMs: 24 * 60 * 60 * 1_000,
  reservationRetentionMs: 8 * 24 * 60 * 60 * 1_000,
  maxCleanupBatch: 100,
} as const;

export const TABLE_LIMITS = {
  participants: 2,
  messageBodyBytes: 8 * 1_024,
  maxMessages: 256,
  transcriptBodyBytes: 2 * 1_024 * 1_024,
  readPageDefault: 50,
  readPageMaximum: 100,
} as const;
