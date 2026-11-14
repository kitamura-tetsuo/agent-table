import { WorkerEntrypoint } from "cloudflare:workers";
import { APPLICATION_SCHEMA_VERSION } from "../../schema/migrations";

const BINDINGS = ["TABLES", "GUESTS", "OAUTH_SERIALIZER", "ADMISSION"] as const;
type RecoveryBinding = (typeof BINDINGS)[number];

export type RecoveryObjectRequest = {
  binding: RecoveryBinding;
  operationId: string;
  objectId: string;
  requestNonce?: string;
};

/**
 * Recovery is an account-internal service entrypoint, never an HTTP route.
 * Each target object separately verifies the signed, expiring reset authority.
 */
export class RecoveryControl extends WorkerEntrypoint<Env> {
  async identity() {
    // Namespace commitments reveal no private records. This allows an operator
    // to prepare an exact plan before changing the deployment's serving state.
    return {
      buildSha: this.env.RELEASE_BUILD_SHA,
      environment: this.env.RELEASE_ENVIRONMENT,
      schemaVersion: APPLICATION_SCHEMA_VERSION,
      commitments: Object.fromEntries(
        BINDINGS.map((name) => [
          name,
          this.env[name]
            .idFromName("agent-table/recovery-namespace/v1")
            .toString(),
        ]),
      ),
    };
  }

  private object(request: RecoveryObjectRequest) {
    if (
      !BINDINGS.includes(request?.binding) ||
      !/^[a-f0-9]{64}$/.test(request?.objectId ?? "")
    ) {
      throw new Error("Invalid recovery object");
    }
    const namespace = this.env[request.binding];
    return namespace.get(namespace.idFromString(request.objectId));
  }

  async inspect(request: RecoveryObjectRequest) {
    return this.object(request).inspectRecovery({
      operationId: request.operationId,
      objectId: request.objectId,
      requestNonce: request.requestNonce,
    });
  }

  async reset(request: RecoveryObjectRequest) {
    return this.object(request).resetRecovery({
      operationId: request.operationId,
      objectId: request.objectId,
      requestNonce: request.requestNonce,
    });
  }
}
