import { test } from "node:test";
import {
  probeAckUpdateCompletion,
  probeCancellationAndReconnect,
  probeDisabledCapabilities,
  probeUnreadStreamBuffering,
  probeZeroCapacityRefusal,
} from "../test/probes/sdk-subscriptions.ts";

test(
  "SDK 2.4.0 evidence: stream count cap still buffers 256 unread updates",
  { timeout: 5000 },
  probeUnreadStreamBuffering,
);
test(
  "SDK 2.4.0: ack before update, exact URI filtering, correlation and completion",
  { timeout: 5000 },
  probeAckUpdateCompletion,
);
test(
  "SDK 2.4.0: cancellation releases listeners and allows reconnect",
  { timeout: 5000 },
  probeCancellationAndReconnect,
);
test(
  "SDK 2.4.0: unavailable capabilities honor no notification types",
  { timeout: 5000 },
  probeDisabledCapabilities,
);
test(
  "SDK 2.4.0: zero capacity refuses before acknowledgment",
  { timeout: 5000 },
  probeZeroCapacityRefusal,
);
