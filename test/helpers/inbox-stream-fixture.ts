import type {
  ConnectionScope,
  VerifiedConnectionActor,
} from "../../src/shared/auth";

async function guest(env: Env) {
  const id = crypto.randomUUID();
  const stub = env.GUESTS.get(env.GUESTS.idFromName(id));
  const session = await stub.createSession(id);
  const grant = await stub.createConnection(
    session.sessionId,
    session.secret,
    ["tables:write", "tables:read", "events:subscribe"],
    Date.now() + 3_600_000,
  );
  if (!grant) throw new Error("Missing grant");
  const actor = (scope: ConnectionScope): VerifiedConnectionActor => ({
    kind: "verified-connection",
    guestId: id,
    connectionId: grant.connectionId,
    scope,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  return { id, stub, session, grant, actor };
}

export async function inboxStreamFixture(env: Env) {
  const owner = await guest(env);
  const peer = await guest(env);
  const input = {
    request_id: "hint_stream_create_00001",
    title: "Internal hints",
  };
  const write = owner.actor("tables:write");
  const reserved = await owner.stub.reserveCreation(write, input);
  if (!reserved.ok) throw new Error("Missing reservation");
  const tableId = reserved.reservation.tableId;
  const table = env.TABLES.get(env.TABLES.idFromName(tableId));
  const created = await table.initializeTable(
    write,
    input,
    reserved.reservation,
  );
  if (!created.ok) throw new Error("Missing table");
  const invitation = await table.issueInvite(write, "hint_stream_invite_00001");
  if (!invitation.ok) throw new Error("Missing invitation");
  const joined = await table.redeemInvite(
    peer.actor("tables:write"),
    invitation.value.invitation,
    "hint_stream_join_000001",
  );
  if (!joined.ok) throw new Error("Missing peer");
  const filter = { resourceSubscriptions: [created.value.ownInboxUri] };
  const open = (expires = Date.now() + 30_000) =>
    table.openInboxHintStream(owner.actor("events:subscribe"), filter, expires);
  return { owner, peer, table, tableId, created, joined, filter, open };
}
