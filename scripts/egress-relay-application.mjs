/**
 * Composition of relay listener, authenticated intake, durable admission and
 * bounded transport. No CLI, automatic bind, key generation or deployment.
 * Starts paused after every process start. An approved operator must explicitly
 * enable it, after checking persisted uncertain leases and environment identity.
 */

import { createRelayHttpsServer } from "./egress-relay-http.mjs";
import { createRelayIngress } from "./egress-relay-ingress-prototype.mjs";
import { sendPinnedPrototype } from "./egress-relay-prototype.mjs";
import { openRelayAdmissionStore } from "./relay-admission-store.mjs";

export function createRelayApplication({
  databasePath,
  environment,
  serviceId,
  callers,
  key,
  cert,
  admission = {},
}) {
  // Binding identity may not be overridden inside general quota configuration.
  if (
    Object.hasOwn(admission, "environment") ||
    Object.hasOwn(admission, "serviceId")
  )
    throw new Error("invalid-application-configuration");
  const store = openRelayAdmissionStore(databasePath, {
    ...admission,
    environment,
    serviceId,
  });
  let enabled = false,
    closing = false;
  try {
    const handler = createRelayIngress({
      callers,
      audience: `${environment}:${serviceId}`,
      admissionStore: store,
      enabled: () => enabled && !closing,
      readEnabled: () => !closing,
      send: sendPinnedPrototype,
    });
    const listener = createRelayHttpsServer({ key, cert, handler });
    return {
      server: listener.server,
      /** Local operator API only. No HTTP route changes operational state. */
      setEnabled(value) {
        if (typeof value !== "boolean" || closing)
          throw new Error("invalid-operational-state");
        if (value) {
          const uncertain = store.listUncertainLeases();
          if (!uncertain.ok || uncertain.leases.length !== 0)
            throw new Error("uncertain-attempts-require-review");
        }
        enabled = value;
      },
      inspectUncertainAttempts: () => store.listUncertainLeases(),
      async close() {
        enabled = false;
        closing = true;
        // Listener allows existing bounded attempts to settle before storage
        // closes. Crash recovery never silently frees unresolved leases.
        const result = await listener.close(15000);
        if (!result.settled) throw new Error("shutdown-attempts-unresolved");
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
