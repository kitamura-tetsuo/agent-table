import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import application from "../../src/index";
import { GuestDO as ApplicationGuestDO } from "../../src/objects/guest";
import { TableDO as ApplicationTableDO } from "../../src/objects/table";
import { RecoveryControl } from "../../src/recovery/control";
import type { VerifiedConnectionActor } from "../../src/shared/auth";
import type { BrowserDeletionCredential } from "../../src/shared/deletion";
import { digestSessionSecret } from "../../src/shared/random";
import { recoveryContext } from "../../src/shared/recovery";
import {
  GUEST_RECOVERY_STORAGE,
  type RecoveryStorageDescriptor,
  TABLE_RECOVERY_STORAGE,
} from "../../src/shared/recovery-manifests";
import type { RecoveryObjectRequest } from "../../src/shared/recovery-storage";
import {
  initializeApplicationSchema,
  UnsupportedApplicationSchemaError,
} from "../../src/shared/schema";

export { OAuthTokenDO } from "../../src/auth/token-do";
export { AdmissionDO } from "../../src/objects/admission";
export { RecoveryControl };

interface FixtureEnv extends Env {
  HOSTED_RECOVERY_FIXTURE: string;
  HOSTED_RECOVERY_FIXTURE_WORKER: string;
  HOSTED_RECOVERY_FIXTURE_RUN_ID: string;
}
export interface HostedScenario {
  runId: string;
  guestId: string;
  tableId: string;
  sessionId: string;
  secret: string;
  connectionId: string;
  expiringConnectionId: string;
  requestId: string;
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OBJECT_ID = /^[a-f0-9]{64}$/;
const PRIVATE_BODY = "Issue 51 isolated synthetic transcript";
const FIXTURE_KV = "issue51-hosted-fixture";
const RECOVERY_WORKER = "agent-table-pr51-recovery-staging";
const FUTURE_WORKER = "agent-table-pr51-schema-staging";
const RECHECK_MS = 6 * 60 * 60_000;

function requireFixture(value: unknown): asserts value {
  if (!value) throw new Error("Hosted recovery fixture unavailable");
}
function fixtureEnvironment(
  env: Env,
  runId?: string,
): asserts env is FixtureEnv {
  const fixture = env as FixtureEnv;
  requireFixture(
    fixture.HOSTED_RECOVERY_FIXTURE === "issue51-synthetic-only" &&
      [RECOVERY_WORKER, FUTURE_WORKER].includes(
        fixture.HOSTED_RECOVERY_FIXTURE_WORKER,
      ) &&
      UUID.test(fixture.HOSTED_RECOVERY_FIXTURE_RUN_ID ?? "") &&
      (runId === undefined ||
        runId === fixture.HOSTED_RECOVERY_FIXTURE_RUN_ID) &&
      env.RELEASE_ENVIRONMENT === "staging" &&
      env.RESTORE_QUARANTINE === "true" &&
      /^[a-f0-9]{40}$/.test(env.RELEASE_BUILD_SHA ?? "") &&
      [
        env.ALLOW_NEW_GUESTS,
        env.ALLOW_NEW_TABLES,
        env.ENABLE_MCP_SUBSCRIPTIONS,
        env.ENABLE_OPENAI_EVENTS,
        env.ALLOW_OUTBOUND_NOTIFICATIONS,
      ].every((flag) => flag === "false"),
  );
  const origin = new URL(env.PUBLIC_ORIGIN);
  requireFixture(
    origin.origin === env.PUBLIC_ORIGIN &&
      origin.protocol === "https:" &&
      !origin.port &&
      origin.hostname.startsWith(
        `${fixture.HOSTED_RECOVERY_FIXTURE_WORKER}.`,
      ) &&
      /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname),
  );
  if (
    [
      env.RECOVERY_AUTHORIZATION,
      env.RECOVERY_VERIFICATION_KEY,
      env.RECOVERY_CONFIG_SHA256,
      env.RECOVERY_NAMESPACE_IDENTITY,
    ].some((value) => value !== undefined)
  ) {
    const context = recoveryContext(env);
    requireFixture(
      context.kind === "authorized" &&
        context.claims.phase === "reset" &&
        context.claims.namespaceIdentity.workerName ===
          fixture.HOSTED_RECOVERY_FIXTURE_WORKER,
    );
  }
}
function scenario(env: Env, input: HostedScenario) {
  fixtureEnvironment(env, input?.runId);
  requireFixture(
    input &&
      Object.keys(input).sort().join(",") ===
        "connectionId,expiringConnectionId,guestId,requestId,runId,secret,sessionId,tableId" &&
      [
        input.runId,
        input.guestId,
        input.tableId,
        input.sessionId,
        input.connectionId,
        input.expiringConnectionId,
        input.requestId,
      ].every((id) => typeof id === "string" && UUID.test(id)) &&
      new Set([
        input.guestId,
        input.tableId,
        input.sessionId,
        input.connectionId,
        input.expiringConnectionId,
        input.requestId,
      ]).size === 6 &&
      typeof input.secret === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(input.secret),
  );
}
function credential(input: HostedScenario): BrowserDeletionCredential {
  return {
    guestId: input.guestId,
    sessionId: input.sessionId,
    secret: input.secret,
  };
}
function counts(
  storage: DurableObjectStorage,
  descriptor: RecoveryStorageDescriptor,
) {
  return Object.fromEntries(
    descriptor.tables.map(({ name }) => [
      name,
      storage.sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM "${name}"`)
        .one().count,
    ]),
  );
}
async function emptyBeforeSeed(
  storage: DurableObjectStorage,
  descriptor: RecoveryStorageDescriptor,
) {
  requireFixture(
    Object.entries(counts(storage, descriptor)).every(
      ([name, count]) => count === (name === "table_transcript_usage" ? 1 : 0),
    ) &&
      storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM __agent_table_recovery",
        )
        .one().count === 0 &&
      (await storage.list({ limit: 1 })).size === 0,
  );
}
async function fixtureMarker(storage: DurableObjectStorage, runId: string) {
  const marker = await storage.get<{ runId: string; phase: string }>(
    FIXTURE_KV,
  );
  requireFixture(
    marker?.runId === runId &&
      ["snapshot-a", "post-event", "future-schema"].includes(marker.phase),
  );
  return marker;
}
/** Hashes remain in the independent driver; private SQL and KV values never leave. */
async function canonicalState(storage: DurableObjectStorage) {
  const catalog = storage.sql
    .exec<{ name: string; type: string; sql: string }>(
      "SELECT name, type, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name, type",
    )
    .toArray();
  const rows = catalog
    .filter((item) => item.type === "table")
    .map(({ name }) => ({
      name,
      rows: storage.sql
        .exec(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)
        .toArray(),
    }));
  const values = await storage.list({ limit: 128 });
  requireFixture(values.size < 128);
  const canonicalSha256 = await digestSessionSecret(
    JSON.stringify({ catalog, rows, kv: [...values.entries()] }),
  );
  return {
    canonicalSha256,
    counts: Object.fromEntries(
      rows.map((item) => [item.name, item.rows.length]),
    ),
    kvEntries: values.size,
  };
}
/** Only the blocked synthetic event RPCs use this temporary local application context. */
function operationalEnvironment(env: Env): Env {
  return {
    ...env,
    RELEASE_ENVIRONMENT: "local",
    PUBLIC_ORIGIN: "http://localhost:8787",
    RESTORE_QUARANTINE: "false",
    RECOVERY_AUTHORIZATION: undefined,
    RECOVERY_VERIFICATION_KEY: undefined,
    RECOVERY_CONFIG_SHA256: undefined,
    RECOVERY_NAMESPACE_IDENTITY: undefined,
    RELEASE_PROFILE: undefined,
    PRIVATE_PILOT_POLICY: undefined,
  };
}
async function restore(
  storage: DurableObjectStorage,
  ctx: DurableObjectState,
  bookmark: string,
): Promise<never> {
  requireFixture(
    typeof bookmark === "string" &&
      bookmark.length > 0 &&
      bookmark.length <= 256 &&
      /^[A-Za-z0-9-]+$/.test(bookmark),
  );
  // This API is real Cloudflare PITR. Miniflare deliberately cannot stand in for it.
  await storage.onNextSessionRestoreBookmark(bookmark);
  ctx.abort("Synthetic recovery fixture restarting after PITR request");
  throw new Error("Synthetic PITR restart did not terminate the session");
}

export class GuestDO extends ApplicationGuestDO {
  #check(input: HostedScenario) {
    scenario(this.env, input);
    requireFixture(
      this.ctx.id.equals(this.env.GUESTS.idFromName(input.guestId)),
    );
  }
  async #operational<T>(operation: () => Promise<T> | T): Promise<T> {
    const original = this.env;
    this.env = operationalEnvironment(original);
    try {
      return await operation();
    } finally {
      this.env = original;
    }
  }
  async fixtureSeed(input: HostedScenario) {
    this.#check(input);
    return this.ctx.blockConcurrencyWhile(async () => {
      await emptyBeforeSeed(this.ctx.storage, GUEST_RECOVERY_STORAGE);
      const now = Date.now();
      const expiresAt = now + 5_000;
      const secretDigest = await digestSessionSecret(input.secret);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO guest_identity(singleton,guest_id,created_at) VALUES (1,?,?)",
          input.guestId,
          now,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO guest_sessions(session_id,secret_digest,created_at,expires_at,invalidated_at) VALUES (?,?,?,?,NULL)",
          input.sessionId,
          secretDigest,
          now,
          now + 30 * 60_000,
        );
        for (const [id, deadline] of [
          [input.connectionId, now + 30 * 60_000],
          [input.expiringConnectionId, expiresAt],
        ] as const) {
          this.ctx.storage.sql.exec(
            "INSERT INTO guest_connections(connection_id,guest_id,scopes_json,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?,NULL)",
            id,
            input.guestId,
            '["tables:read","tables:write","tables:delete","events:subscribe"]',
            now,
            deadline,
          );
        }
      });
      await this.ctx.storage.put(FIXTURE_KV, {
        runId: input.runId,
        phase: "snapshot-a",
      });
      const authorized = await this.#operational(async () => ({
        session:
          (await super.validateSession(input.sessionId, input.secret)) !== null,
        revocable: super.authorizeConnection(
          input.guestId,
          input.connectionId,
          "tables:read",
        ).allowed,
        expiring: super.authorizeConnection(
          input.guestId,
          input.expiringConnectionId,
          "tables:read",
        ).allowed,
      }));
      requireFixture(
        authorized.session && authorized.revocable && authorized.expiring,
      );
      await this.ctx.storage.setAlarm(Date.now() + RECHECK_MS);
      await this.ctx.storage.sync();
      const bookmark = await this.ctx.storage.getCurrentBookmark();
      const capturedAt = Date.now();
      requireFixture(capturedAt < expiresAt);
      return {
        binding: "GUESTS" as const,
        objectId: this.ctx.id.toString(),
        bookmark,
        capturedAt,
        expiresAt,
        authorized,
        ...(await canonicalState(this.ctx.storage)),
      };
    });
  }
  /** Used only by the isolated TableDO's browser confirmation call. */
  async fixtureValidateSession(input: HostedScenario) {
    this.#check(input);
    return this.ctx.blockConcurrencyWhile(async () => {
      await fixtureMarker(this.ctx.storage, input.runId);
      return this.#operational(() =>
        super.validateSession(input.sessionId, input.secret),
      );
    });
  }
  async fixtureRevoke(input: HostedScenario) {
    this.#check(input);
    return this.ctx.blockConcurrencyWhile(async () => {
      const marker = await fixtureMarker(this.ctx.storage, input.runId);
      requireFixture(marker.phase === "snapshot-a");
      const result = await this.#operational(async () => {
        const revoked = await super.revokeConnection(
          input.sessionId,
          input.secret,
          input.connectionId,
        );
        const decision = super.authorizeConnection(
          input.guestId,
          input.connectionId,
          "tables:read",
        );
        return {
          revoked: revoked.status === "revoked",
          denied: !decision.allowed && decision.reason === "revoked",
          oldSessionDenied:
            (await super.validateSession(input.sessionId, input.secret)) ===
            null,
        };
      });
      requireFixture(
        result.revoked && result.denied && result.oldSessionDenied,
      );
      await this.ctx.storage.put(FIXTURE_KV, {
        runId: input.runId,
        phase: "post-event",
      });
      await this.ctx.storage.setAlarm(Date.now() + RECHECK_MS);
      return {
        ...result,
        observedAt: Date.now(),
        ...(await canonicalState(this.ctx.storage)),
      };
    });
  }
  async fixtureObserveExpiry(input: HostedScenario) {
    this.#check(input);
    return this.ctx.blockConcurrencyWhile(async () => {
      const marker = await fixtureMarker(this.ctx.storage, input.runId);
      requireFixture(marker.phase === "post-event");
      const row = this.ctx.storage.sql
        .exec<{ expires_at: number }>(
          "SELECT expires_at FROM guest_connections WHERE connection_id = ?",
          input.expiringConnectionId,
        )
        .one();
      const decision = await this.#operational(() =>
        super.authorizeConnection(
          input.guestId,
          input.expiringConnectionId,
          "tables:read",
        ),
      );
      const expired =
        Date.now() >= row.expires_at &&
        !decision.allowed &&
        decision.reason === "expired";
      requireFixture(expired);
      return { expired, expiresAt: row.expires_at, observedAt: Date.now() };
    });
  }
  async fixtureHistorical(input: HostedScenario) {
    this.#check(input);
    return this.ctx.blockConcurrencyWhile(async () => {
      const marker = await fixtureMarker(this.ctx.storage, input.runId);
      const before = await canonicalState(this.ctx.storage);
      const row = this.ctx.storage.sql
        .exec<{ revoked_at: number | null }>(
          "SELECT revoked_at FROM guest_connections WHERE connection_id = ?",
          input.connectionId,
        )
        .one();
      const session = this.ctx.storage.sql
        .exec<{ invalidated_at: number | null }>(
          "SELECT invalidated_at FROM guest_sessions WHERE session_id = ?",
          input.sessionId,
        )
        .one();
      const denied =
        (await super.validateSession(input.sessionId, input.secret)) === null &&
        !super.authorizeConnection(
          input.guestId,
          input.connectionId,
          "tables:read",
        ).allowed &&
        !super.authorizeConnection(
          input.guestId,
          input.expiringConnectionId,
          "tables:read",
        ).allowed;
      const rejectedCreation = await super
        .createSession(crypto.randomUUID())
        .then(
          () => false,
          () => true,
        );
      const rejectedWrite =
        (await super.createConnection(
          input.sessionId,
          input.secret,
          ["tables:read"],
          Date.now() + 60_000,
        )) === null;
      await super.alarm();
      const after = await canonicalState(this.ctx.storage);
      requireFixture(
        denied &&
          rejectedCreation &&
          rejectedWrite &&
          before.canonicalSha256 === after.canonicalSha256,
      );
      return {
        binding: "GUESTS" as const,
        objectId: this.ctx.id.toString(),
        restoredSnapshotMarker: marker.phase === "snapshot-a",
        rawRevocationRolledBack: row.revoked_at === null,
        rawSessionInvalidationRolledBack: session.invalidated_at === null,
        privateAccessDenied: denied,
        creationDenied: rejectedCreation,
        writeDenied: rejectedWrite,
        alarmInvoked: true,
        alarmScheduledAt: await this.ctx.storage.getAlarm(),
        ...after,
      };
    });
  }
  async fixtureRestore(input: {
    runId: string;
    objectId: string;
    bookmark: string;
  }): Promise<never> {
    fixtureEnvironment(this.env, input?.runId);
    requireFixture(input.objectId === this.ctx.id.toString());
    await fixtureMarker(this.ctx.storage, input.runId);
    return restore(this.ctx.storage, this.ctx, input.bookmark);
  }
  async fixtureInspectReset(
    input: HostedScenario,
    request: RecoveryObjectRequest,
  ) {
    this.#check(input);
    const inspection = await super.inspectRecovery(request);
    requireFixture(
      inspection.empty &&
        inspection.kvEntries === 0 &&
        inspection.markerGeneration === inspection.generation,
    );
    return this.ctx.blockConcurrencyWhile(async () => {
      const before = await canonicalState(this.ctx.storage);
      const privateAccessDenied =
        (await super.validateSession(input.sessionId, input.secret)) === null &&
        !super.authorizeConnection(
          input.guestId,
          input.connectionId,
          "tables:read",
        ).allowed &&
        !super.authorizeConnection(
          input.guestId,
          input.expiringConnectionId,
          "tables:read",
        ).allowed &&
        (await super.createConnection(
          input.sessionId,
          input.secret,
          ["tables:read"],
          Date.now() + 60_000,
        )) === null &&
        (await super.createSession(crypto.randomUUID()).then(
          () => false,
          () => true,
        ));
      const alarmBeforeInvocation = await this.ctx.storage.getAlarm();
      await super.alarm();
      const after = await canonicalState(this.ctx.storage);
      requireFixture(
        privateAccessDenied && before.canonicalSha256 === after.canonicalSha256,
      );
      return {
        inspection,
        privateAccessDenied,
        alarmBeforeInvocation,
        alarmScheduledAt: await this.ctx.storage.getAlarm(),
        alarmInvoked: true,
        canonicalSha256: after.canonicalSha256,
      };
    });
  }
}

export class TableDO extends ApplicationTableDO {
  #check(input: HostedScenario) {
    scenario(this.env, input);
    requireFixture(
      this.ctx.id.equals(this.env.TABLES.idFromName(input.tableId)),
    );
  }
  async #operational<T>(
    input: HostedScenario,
    operation: () => Promise<T>,
  ): Promise<T> {
    const original = this.env;
    const namespace =
      original.GUESTS as unknown as DurableObjectNamespace<GuestDO>;
    const syntheticGuest = namespace.get(namespace.idFromName(input.guestId));
    const adapter = {
      idFromName: (name: string) => {
        requireFixture(name === input.guestId);
        return namespace.idFromName(name);
      },
      get: (id: DurableObjectId) => {
        requireFixture(id.equals(namespace.idFromName(input.guestId)));
        return {
          validateSession: (sessionId: string, secret: string) => {
            requireFixture(
              sessionId === input.sessionId && secret === input.secret,
            );
            return syntheticGuest.fixtureValidateSession(input);
          },
        };
      },
    };
    this.env = {
      ...operationalEnvironment(original),
      GUESTS: adapter as unknown as Env["GUESTS"],
    };
    try {
      return await operation();
    } finally {
      this.env = original;
    }
  }
  async fixtureSeed(input: HostedScenario) {
    this.#check(input);
    return this.ctx.blockConcurrencyWhile(async () => {
      await emptyBeforeSeed(this.ctx.storage, TABLE_RECOVERY_STORAGE);
      const now = Date.now();
      const membershipId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const inviteId = crypto.randomUUID();
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO table_metadata(singleton,table_id,creation_request_id,request_digest,creator_guest_id,title,purpose,state,created_at,expires_at,closed_at,deleted_at,last_seq) VALUES (1,?,?,?,?,?,'synthetic PITR rehearsal','waiting',?,?,NULL,NULL,1)",
          input.tableId,
          input.requestId,
          "a".repeat(64),
          input.guestId,
          "Issue 51 synthetic only",
          now,
          now + 30 * 60_000,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO table_memberships(membership_id,table_id,guest_id,seat,role,joined_at,latest_peer_seq) VALUES (?,?,?,1,'creator',?,0)",
          membershipId,
          input.tableId,
          input.guestId,
          now,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO table_messages(seq,message_id,sender_membership_id,body,body_bytes,created_at,reply_to_message_id) VALUES (1,?,?,?,?,?,NULL)",
          messageId,
          membershipId,
          PRIVATE_BODY,
          new TextEncoder().encode(PRIVATE_BODY).byteLength,
          now,
        );
        this.ctx.storage.sql.exec(
          "UPDATE table_transcript_usage SET body_bytes = ? WHERE singleton = 1",
          new TextEncoder().encode(PRIVATE_BODY).byteLength,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO table_invitations(invite_id,request_id,issuer_guest_id,secret_digest,response_envelope,issued_at,expires_at,state,consumed_by,consumed_at) VALUES (?,?,?,?,'synthetic-only',?,?,'active',NULL,NULL)",
          inviteId,
          crypto.randomUUID(),
          input.guestId,
          "b".repeat(64),
          now,
          now + 30 * 60_000,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO table_event_subscriptions(membership_id,generation,fence,status,guest_id,connection_id,subscription_id,callback_url,secret_envelope,previous_secret_envelope,rotation_until,expires_at) VALUES (?,1,1,'active',?,?,?,'http://localhost:9/synthetic-never-send','synthetic-only',NULL,NULL,?)",
          membershipId,
          input.guestId,
          input.connectionId,
          crypto.randomUUID(),
          now + 30 * 60_000,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO table_event_outbox(event_id,message_id,message_seq,recipient_membership_id,subscription_id,subscription_generation,status,attempt_count,created_at,expires_at) VALUES (?,?,1,?,?,1,'pending',0,?,?)",
          crypto.randomUUID(),
          messageId,
          membershipId,
          crypto.randomUUID(),
          now,
          now + 30 * 60_000,
        );
      });
      await this.ctx.storage.put(FIXTURE_KV, {
        runId: input.runId,
        phase: "snapshot-a",
      });
      const readable = await this.#operational(input, async () => {
        const metadata = await super.getBrowserMetadata(credential(input));
        const transcript = await super.readBrowserMessages(credential(input), {
          limit: 5,
        });
        return (
          metadata.ok && transcript.ok && transcript.value.messages.length === 1
        );
      });
      requireFixture(readable);
      await this.ctx.storage.setAlarm(Date.now() + RECHECK_MS);
      await this.ctx.storage.sync();
      const bookmark = await this.ctx.storage.getCurrentBookmark();
      return {
        binding: "TABLES" as const,
        objectId: this.ctx.id.toString(),
        bookmark,
        capturedAt: Date.now(),
        readable,
        ...(await canonicalState(this.ctx.storage)),
      };
    });
  }
  async fixtureDelete(input: HostedScenario) {
    this.#check(input);
    return this.ctx.blockConcurrencyWhile(async () => {
      const marker = await fixtureMarker(this.ctx.storage, input.runId);
      requireFixture(marker.phase === "snapshot-a");
      const result = await this.#operational(input, async () => {
        const requested = await super.requestBrowserDeletion(
          credential(input),
          input.requestId,
        );
        const pending = super.deletionView(input.guestId, input.requestId);
        const resolved = await super.resolveDeletion(
          credential(input),
          input.requestId,
          "approve",
        );
        const view = super.deletionView(input.guestId, input.requestId);
        const metadata = await super.getBrowserMetadata(credential(input));
        const transcript = await super.readBrowserMessages(credential(input), {
          limit: 5,
        });
        return {
          confirmationRequired:
            requested.ok && requested.value.confirmation_required,
          pending: pending.ok && pending.value.state === "pending",
          deleted:
            resolved.ok &&
            resolved.value.state === "deleted" &&
            view.ok &&
            view.value.state === "deleted",
          privateReadsDenied: !metadata.ok && !transcript.ok,
        };
      });
      requireFixture(
        result.confirmationRequired &&
          result.pending &&
          result.deleted &&
          result.privateReadsDenied,
      );
      const currentCounts = counts(this.ctx.storage, TABLE_RECOVERY_STORAGE);
      requireFixture(
        currentCounts.table_messages === 0 &&
          currentCounts.table_invitations === 0 &&
          currentCounts.table_metadata === 0 &&
          currentCounts.table_event_outbox === 0 &&
          currentCounts.table_tombstones === 1,
      );
      await this.ctx.storage.put(FIXTURE_KV, {
        runId: input.runId,
        phase: "post-event",
      });
      await this.ctx.storage.setAlarm(Date.now() + RECHECK_MS);
      return {
        ...result,
        observedAt: Date.now(),
        ...(await canonicalState(this.ctx.storage)),
      };
    });
  }
  async fixtureHistorical(input: HostedScenario) {
    this.#check(input);
    return this.ctx.blockConcurrencyWhile(async () => {
      const marker = await fixtureMarker(this.ctx.storage, input.runId);
      const before = await canonicalState(this.ctx.storage);
      const actor: VerifiedConnectionActor = {
        kind: "verified-connection",
        guestId: input.guestId,
        connectionId: input.connectionId,
        scope: "tables:write",
        expiresAt: Date.now() + 30 * 60_000,
      };
      const metadata = await super.getBrowserMetadata(credential(input));
      const transcript = await super.readBrowserMessages(credential(input), {
        limit: 5,
      });
      const posted = await super.postMessage(actor, {
        request_id: crypto.randomUUID(),
        body: "Synthetic denied write",
      });
      const invite = await super.issueBrowserInvite(
        credential(input),
        crypto.randomUUID(),
      );
      const deletion = await super.requestBrowserDeletion(
        credential(input),
        crypto.randomUUID(),
      );
      await super.alarm();
      const after = await canonicalState(this.ctx.storage);
      const privateAccessDenied =
        !metadata.ok &&
        !transcript.ok &&
        !posted.ok &&
        !invite.ok &&
        !deletion.ok;
      requireFixture(
        privateAccessDenied && before.canonicalSha256 === after.canonicalSha256,
      );
      return {
        binding: "TABLES" as const,
        objectId: this.ctx.id.toString(),
        restoredSnapshotMarker: marker.phase === "snapshot-a",
        rawDeletionRolledBack:
          after.counts.table_messages === 1 &&
          after.counts.table_invitations === 1 &&
          after.counts.table_metadata === 1 &&
          after.counts.table_tombstones === 0,
        privateAccessDenied,
        alarmInvoked: true,
        alarmScheduledAt: await this.ctx.storage.getAlarm(),
        ...after,
      };
    });
  }
  async fixtureRestore(input: {
    runId: string;
    objectId: string;
    bookmark: string;
  }): Promise<never> {
    fixtureEnvironment(this.env, input?.runId);
    requireFixture(input.objectId === this.ctx.id.toString());
    await fixtureMarker(this.ctx.storage, input.runId);
    return restore(this.ctx.storage, this.ctx, input.bookmark);
  }
  async fixtureInspectReset(
    input: HostedScenario,
    request: RecoveryObjectRequest,
  ) {
    this.#check(input);
    const inspection = await super.inspectRecovery(request);
    requireFixture(
      inspection.empty &&
        inspection.kvEntries === 0 &&
        inspection.markerGeneration === inspection.generation,
    );
    return this.ctx.blockConcurrencyWhile(async () => {
      const before = await canonicalState(this.ctx.storage);
      const actor: VerifiedConnectionActor = {
        kind: "verified-connection",
        guestId: input.guestId,
        connectionId: input.connectionId,
        scope: "tables:write",
        expiresAt: Date.now() + 30 * 60_000,
      };
      const metadata = await super.getBrowserMetadata(credential(input));
      const transcript = await super.readBrowserMessages(credential(input), {
        limit: 5,
      });
      const posted = await super.postMessage(actor, {
        request_id: crypto.randomUUID(),
        body: "Synthetic denied post-reset write",
      });
      const invite = await super.issueBrowserInvite(
        credential(input),
        crypto.randomUUID(),
      );
      const deletion = await super.requestBrowserDeletion(
        credential(input),
        crypto.randomUUID(),
      );
      const privateAccessDenied =
        !metadata.ok &&
        !transcript.ok &&
        !posted.ok &&
        !invite.ok &&
        !deletion.ok;
      const alarmBeforeInvocation = await this.ctx.storage.getAlarm();
      await super.alarm();
      const after = await canonicalState(this.ctx.storage);
      requireFixture(
        privateAccessDenied && before.canonicalSha256 === after.canonicalSha256,
      );
      return {
        inspection,
        privateAccessDenied,
        alarmBeforeInvocation,
        alarmScheduledAt: await this.ctx.storage.getAlarm(),
        alarmInvoked: true,
        canonicalSha256: after.canonicalSha256,
      };
    });
  }
  async fixtureFutureSchema(
    input: HostedScenario,
    request: RecoveryObjectRequest,
  ) {
    this.#check(input);
    requireFixture(
      (this.env as FixtureEnv).HOSTED_RECOVERY_FIXTURE_WORKER === FUTURE_WORKER,
    );
    const context = recoveryContext(this.env);
    requireFixture(
      context.kind === "authorized" &&
        context.claims.phase === "reset" &&
        request.operationId === context.claims.operationId &&
        request.objectId === this.ctx.id.toString(),
    );
    await fixtureMarker(this.ctx.storage, input.runId);
    // Prove this exact signed request and known schema are accepted before the
    // future-schema mutation, so a malformed request cannot fake the refusal.
    await super.inspectRecovery(request);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE future_recovery_payload (singleton INTEGER PRIMARY KEY, payload TEXT NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO future_recovery_payload VALUES (1, 'retained synthetic future schema')",
      );
      this.ctx.storage.sql.exec(
        "UPDATE __agent_table_schema SET version = 13 WHERE singleton = 1",
      );
    });
    await this.ctx.storage.put(FIXTURE_KV, {
      runId: input.runId,
      phase: "future-schema",
    });
    const before = await canonicalState(this.ctx.storage);
    let constructorValidatorRefused = false;
    try {
      initializeApplicationSchema(this.ctx.storage, "table");
    } catch (error) {
      constructorValidatorRefused =
        error instanceof UnsupportedApplicationSchemaError;
    }
    const inspectionRefused = await super.inspectRecovery(request).then(
      () => false,
      () => true,
    );
    const resetRefused = await super.resetRecovery(request).then(
      () => false,
      () => true,
    );
    const after = await canonicalState(this.ctx.storage);
    requireFixture(
      constructorValidatorRefused &&
        inspectionRefused &&
        resetRefused &&
        before.canonicalSha256 === after.canonicalSha256,
    );
    await this.ctx.storage.sync();
    return {
      binding: "TABLES" as const,
      objectId: this.ctx.id.toString(),
      schemaVersion: 13,
      constructorValidatorRefused,
      inspectionRefused,
      resetRefused,
      bookmark: await this.ctx.storage.getCurrentBookmark(),
      ...after,
    };
  }
  async fixtureRestart(input: {
    runId: string;
    objectId: string;
  }): Promise<never> {
    fixtureEnvironment(this.env, input?.runId);
    requireFixture(
      (this.env as FixtureEnv).HOSTED_RECOVERY_FIXTURE_WORKER ===
        FUTURE_WORKER && input.objectId === this.ctx.id.toString(),
    );
    const marker = await fixtureMarker(this.ctx.storage, input.runId);
    requireFixture(marker.phase === "future-schema");
    this.ctx.abort("Synthetic future-schema constructor refusal probe");
    throw new Error("Synthetic schema restart did not terminate the session");
  }
}

/**
 * For the separate future-schema Worker only. After production construction has
 * refused N+1, an isolated read-only entry module may export this as TableDO.
 * The binding name and namespace ID stay unchanged; no migration or reset runs.
 */
export class FutureSchemaReadback extends DurableObject<FixtureEnv> {
  async fixtureReadFuture(input: { runId: string; objectId: string }) {
    fixtureEnvironment(this.env, input?.runId);
    requireFixture(
      this.env.HOSTED_RECOVERY_FIXTURE_WORKER === FUTURE_WORKER &&
        input.objectId === this.ctx.id.toString(),
    );
    const marker = await fixtureMarker(this.ctx.storage, input.runId);
    requireFixture(marker.phase === "future-schema");
    const schema = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT version FROM __agent_table_schema WHERE singleton = 1",
      )
      .one();
    requireFixture(schema.version === 13);
    return {
      binding: "TABLES" as const,
      objectId: this.ctx.id.toString(),
      schemaVersion: schema.version,
      ...(await canonicalState(this.ctx.storage)),
    };
  }
  async alarm(): Promise<void> {
    // The forensic deployment never runs application cleanup or dispatch.
  }
}

/** Account-internal service binding only; no HTTP route exposes these methods. */
export class RecoveryRehearsal extends WorkerEntrypoint<FixtureEnv> {
  #guest(input: HostedScenario) {
    scenario(this.env, input);
    const namespace = this.env
      .GUESTS as unknown as DurableObjectNamespace<GuestDO>;
    return namespace.get(namespace.idFromName(input.guestId));
  }
  #table(input: HostedScenario) {
    scenario(this.env, input);
    const namespace = this.env
      .TABLES as unknown as DurableObjectNamespace<TableDO>;
    return namespace.get(namespace.idFromName(input.tableId));
  }
  async prepare(input: HostedScenario) {
    scenario(this.env, input);
    const guest = await this.#guest(input).fixtureSeed(input);
    const table = await this.#table(input).fixtureSeed(input);
    await this.env.OAUTH_KV.put(
      `grant:issue51-synthetic:${input.runId}`,
      JSON.stringify({ synthetic: true, phase: "snapshot-a" }),
    );
    await this.env.OAUTH_KV.put(
      `client:issue51-synthetic:${input.runId}`,
      JSON.stringify({ synthetic: true, phase: "snapshot-a" }),
    );
    return { guest, table, oauthKeysWritten: 2 };
  }
  async performPostSnapshotEvents(input: HostedScenario) {
    const deletion = await this.#table(input).fixtureDelete(input);
    const revocation = await this.#guest(input).fixtureRevoke(input);
    return { deletion, revocation };
  }
  async observeExpiry(input: HostedScenario) {
    return this.#guest(input).fixtureObserveExpiry(input);
  }
  async restoreSnapshot(input: {
    runId: string;
    binding: "TABLES" | "GUESTS";
    objectId: string;
    bookmark: string;
  }): Promise<never> {
    fixtureEnvironment(this.env, input?.runId);
    requireFixture(
      ["TABLES", "GUESTS"].includes(input.binding) &&
        OBJECT_ID.test(input.objectId),
    );
    const namespace = this.env[
      input.binding
    ] as unknown as DurableObjectNamespace<TableDO | GuestDO>;
    return namespace
      .get(namespace.idFromString(input.objectId))
      .fixtureRestore({
        runId: input.runId,
        objectId: input.objectId,
        bookmark: input.bookmark,
      });
  }
  async inspectHistorical(input: HostedScenario) {
    return {
      guest: await this.#guest(input).fixtureHistorical(input),
      table: await this.#table(input).fixtureHistorical(input),
    };
  }
  async inspectReset(
    input: HostedScenario,
    authority: { operationId: string; requestNonce: string },
  ) {
    scenario(this.env, input);
    const guestId = this.env.GUESTS.idFromName(input.guestId).toString();
    const tableId = this.env.TABLES.idFromName(input.tableId).toString();
    return {
      guest: await this.#guest(input).fixtureInspectReset(input, {
        ...authority,
        objectId: guestId,
      }),
      table: await this.#table(input).fixtureInspectReset(input, {
        ...authority,
        objectId: tableId,
      }),
    };
  }
  async prepareFutureSchema(
    input: HostedScenario,
    request: RecoveryObjectRequest,
  ) {
    return this.#table(input).fixtureFutureSchema(input, request);
  }
  async restartFutureSchema(input: {
    runId: string;
    objectId: string;
  }): Promise<never> {
    fixtureEnvironment(this.env, input?.runId);
    requireFixture(
      this.env.HOSTED_RECOVERY_FIXTURE_WORKER === FUTURE_WORKER &&
        OBJECT_ID.test(input.objectId),
    );
    const namespace = this.env
      .TABLES as unknown as DurableObjectNamespace<TableDO>;
    return namespace
      .get(namespace.idFromString(input.objectId))
      .fixtureRestart(input);
  }
  async inspectFutureSchema(input: { runId: string; objectId: string }) {
    fixtureEnvironment(this.env, input?.runId);
    requireFixture(
      this.env.HOSTED_RECOVERY_FIXTURE_WORKER === FUTURE_WORKER &&
        OBJECT_ID.test(input.objectId),
    );
    const namespace = this.env
      .TABLES as unknown as DurableObjectNamespace<FutureSchemaReadback>;
    return namespace
      .get(namespace.idFromString(input.objectId))
      .fixtureReadFuture(input);
  }
  async fetch(
    request: Parameters<typeof application.fetch>[0],
  ): Promise<Response> {
    fixtureEnvironment(this.env);
    return application.fetch(request, this.env, this.ctx);
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      fixtureEnvironment(env);
    } catch {
      return new Response("Synthetic fixture unavailable", { status: 503 });
    }
    return application.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<FixtureEnv>;
