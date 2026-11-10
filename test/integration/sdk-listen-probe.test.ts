import { describe, it } from "vitest";
import {
  probeAckUpdateCompletion,
  probeCancellationAndReconnect,
  probeDisabledCapabilities,
  probeUnreadStreamBuffering,
  probeZeroCapacityRefusal,
} from "../probes/sdk-subscriptions";

describe("official SDK 2.4.0 subscription wire in workerd (not application delivery)", () => {
  it(
    "demonstrates that the SDK count cap does not bound unread frames",
    probeUnreadStreamBuffering,
  );
  it(
    "acknowledges before updates and correlates graceful completion",
    probeAckUpdateCompletion,
  );
  it(
    "releases cancelled listeners and supports reconnect",
    probeCancellationAndReconnect,
  );
  it(
    "honors no unavailable notification capabilities",
    probeDisabledCapabilities,
  );
  it(
    "refuses disabled admission before acknowledgment",
    probeZeroCapacityRefusal,
  );
});
