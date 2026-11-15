import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayAttemptLedgerSchema } from "../schema/candidates/013_relay_attempt_ledger.ts";
import { prepareRelayAttempt, markRelayDispatched, markRelayUnknown, recordRelayReceipt, readRelayDisposition } from "../src/notifications/relay-attempt-ledger.ts";

const identity = () => ({
  requestId:"synthetic-request-1",eventId:"synthetic-event-01",subscriptionId:"synthetic-subscribe-1",
  generation:1,ordinal:1,leaseToken:"synthetic-lease-01",firstAttemptAt:100000,leaseDeadline:130000,
  audience:"test:synthetic-relay",callerId:"synthetic-caller-1",issuedAt:100000,
  acceptanceExpiresAt:160000,operationDigest:"a".repeat(64),
});
const current = (i) => ({ status:"in_flight", eventId:i.eventId,subscriptionId:i.subscriptionId,generation:i.generation,
  ordinal:i.ordinal,leaseToken:i.leaseToken,firstAttemptAt:i.firstAttemptAt,leaseDeadline:i.leaseDeadline });
function adapter(db) { return { exec: (query,...bindings) => { const rows=db.prepare(query).all(...bindings); return {toArray:()=>rows}; } }; }
function setup() {
  const db = new DatabaseSync(":memory:");
  for(const statement of relayAttemptLedgerSchema.componentStatements.table) db.exec(statement);
  return {db,sql:adapter(db)};
}
test("exact identity is idempotent but cannot extend timestamp, expiry, digest or generation",()=>{
  const {db,sql}=setup();try {
    const i=identity();assert.equal(prepareRelayAttempt(sql,i,100000).ok,true);
    assert.equal(prepareRelayAttempt(sql,i,200000).ok,true); // readback only, not send
    for(const change of [{issuedAt:100001},{acceptanceExpiresAt:159999},{operationDigest:"b".repeat(64)},
      {generation:2},{callerId:"synthetic-caller-2"},{audience:"production:synthetic-relay"}])
      assert.equal(prepareRelayAttempt(sql,{...i,...change},100002).ok,false);
    assert.equal(markRelayDispatched(sql,i,200000).reason,"expired");
  }finally{db.close();}
});
test("dispatch reservation is one-time, unknown never resumes or permits next attempt",()=>{
  const {db,sql}=setup();try {
    const i=identity();prepareRelayAttempt(sql,i,100000);
    assert.equal(markRelayDispatched(sql,i,100001).ok,true);
    assert.equal(markRelayDispatched(sql,i,100002).ok,false);
    assert.equal(markRelayUnknown(sql,i).ok,true);
    assert.equal(markRelayDispatched(sql,i,100003).ok,false);
    const next={...i,requestId:"synthetic-request-2",leaseToken:"synthetic-lease-02",ordinal:2,
      issuedAt:300000,leaseDeadline:330000,acceptanceExpiresAt:360000};
    assert.equal(prepareRelayAttempt(sql,next,300000).reason,"unresolved-predecessor");
    assert.equal(readRelayDisposition(sql,i,current(i),4000000).state,"unknown");
  }finally{db.close();}
});
test("finite resume requires exact definitive receipt; no clock/lease heuristic",()=>{
  const {db,sql}=setup();try {
    const i=identity();prepareRelayAttempt(sql,i,100000);markRelayDispatched(sql,i,100001);markRelayUnknown(sql,i);
    assert.equal(recordRelayReceipt(sql,{...i,operationDigest:"b".repeat(64)},{kind:"http",status:503}).ok,false);
    assert.equal(recordRelayReceipt(sql,i,{kind:"http",status:503}).ok,true);
    assert.deepEqual(readRelayDisposition(sql,i,current(i),140000),{
      ok:true,state:"completed",executionLeaseExpired:true,receipt:{kind:"http",status:503}});
    const next={...i,requestId:"synthetic-request-2",leaseToken:"synthetic-lease-02",ordinal:2,
      issuedAt:150000,leaseDeadline:180000,acceptanceExpiresAt:210000};
    assert.equal(prepareRelayAttempt(sql,next,150000).ok,true);
    assert.equal(next.firstAttemptAt,i.firstAttemptAt);
    assert.equal(recordRelayReceipt(sql,i,{kind:"http",status:204}).reason,"outcome-conflict");
    assert.equal(recordRelayReceipt(sql,i,{kind:"http",status:503}).ok,true);
  }finally{db.close();}
});
test("old generation receipt never applies to refreshed or superseding outbox attempt",()=>{
  const {db,sql}=setup();try{
    const i=identity();prepareRelayAttempt(sql,i,100000);markRelayDispatched(sql,i,100001);
    recordRelayReceipt(sql,i,{kind:"http",status:204});
    for(const changed of [{status:"cancelled"},{status:"accepted"},{generation:2},{leaseToken:"synthetic-lease-02"},{ordinal:2},
      {eventId:"synthetic-event-02"},{subscriptionId:"synthetic-subscribe-2"},{firstAttemptAt:100001}])
      assert.equal(readRelayDisposition(sql,i,{...current(i),...changed},110000).reason,"stale-target");
    assert.equal(readRelayDisposition(sql,i,current(i),3700000).reason,"retry-horizon-ended");
  }finally{db.close();}
});
test("prepared is not success; only explicit no-send proof can complete it",()=>{
  const {db,sql}=setup();try{
    const i=identity();prepareRelayAttempt(sql,i,100000);
    assert.equal(recordRelayReceipt(sql,i,{kind:"http",status:204}).reason,"not-dispatched");
    assert.equal(recordRelayReceipt(sql,i,{kind:"not-sent"}).ok,true);
    assert.equal(markRelayUnknown(sql,i).reason,"already-completed");
    assert.equal(recordRelayReceipt(sql,i,{kind:"not-sent",payload:"private"}).ok,false);
  }finally{db.close();}
});
test("SQL guards immutable identity and outcome; global first-attempt budget retained",()=>{
  const {db,sql}=setup();try{
    const i=identity();prepareRelayAttempt(sql,i,100000);
    assert.throws(()=>db.prepare("UPDATE table_event_relay_attempts SET acceptance_expires_at=?").run(999999),/immutable/);
    recordRelayReceipt(sql,i,{kind:"not-sent"});
    assert.throws(()=>db.exec("UPDATE table_event_relay_attempts SET state='unknown'"),/immutable/);
    const next={...i,requestId:"synthetic-request-2",leaseToken:"synthetic-lease-02",ordinal:2,firstAttemptAt:100001,issuedAt:100001,acceptanceExpiresAt:160001};
    assert.equal(prepareRelayAttempt(sql,next,100001).reason,"attempt-conflict");
    assert.equal(prepareRelayAttempt(sql,{...next,ordinal:9},100001).reason,"invalid");
  }finally{db.close();}
});
test("retained SQLite unknown survives process-like close/reopen with exact original identity",()=>{
  const dir=mkdtempSync(join(tmpdir(),"relay-attempt-ledger-"));let db;
  try{
    const path=join(dir,"ledger.sqlite");db=new DatabaseSync(path);
    for(const s of relayAttemptLedgerSchema.componentStatements.table) db.exec(s);
    const i=identity();prepareRelayAttempt(adapter(db),i,100000);markRelayDispatched(adapter(db),i,100001);db.close();
    db=new DatabaseSync(path);const sql=adapter(db);
    assert.equal(readRelayDisposition(sql,i,current(i),200000).state,"unknown");
    assert.equal(markRelayDispatched(sql,i,200000).reason,"already-reserved");
    assert.equal(recordRelayReceipt(sql,i,{kind:"http",status:204}).ok,true);
    assert.equal(readRelayDisposition(sql,i,current(i),200000).receipt.status,204);
  }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
test("candidate migration leaves runtime version untouched and rollback preserves existing rows",()=>{
  const {db,sql}=setup();try{
    db.exec("CREATE TABLE prior_data(value TEXT); INSERT INTO prior_data VALUES ('retain')");
    db.exec("BEGIN");
    prepareRelayAttempt(sql,identity(),100000);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM table_event_relay_attempts").get().n,0);
    assert.equal(db.prepare("SELECT value FROM prior_data").get().value,"retain");
    assert.equal(db.prepare("PRAGMA user_version").get().user_version,0);
  }finally{db.close();}
});

test("unknown before dispatch cannot be upgraded into an HTTP success",()=>{
  const {db,sql}=setup();try{
    const i=identity();prepareRelayAttempt(sql,i,100000);markRelayUnknown(sql,i);
    assert.equal(recordRelayReceipt(sql,i,{kind:"http",status:204}).reason,"not-dispatched");
    assert.equal(readRelayDisposition(sql,i,current(i),110000).state,"unknown");
  }finally{db.close();}
});

test("producer expiry is exactly the current signed wire timestamp plus 60 seconds",()=>{
  const {db,sql}=setup();try{
    const i=identity();
    for(const delta of [-60000,-1,1])
      assert.equal(prepareRelayAttempt(sql,{...i,acceptanceExpiresAt:i.issuedAt+60000+delta},100000).reason,"invalid");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM table_event_relay_attempts").get().n,0);
    assert.equal(prepareRelayAttempt(sql,i,100000).ok,true);
    assert.equal(db.prepare("SELECT acceptance_expires_at-issued_at lifetime FROM table_event_relay_attempts").get().lifetime,60000);
  }finally{db.close();}
});
