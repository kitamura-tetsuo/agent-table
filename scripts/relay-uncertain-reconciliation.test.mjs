import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {openRelayAdmissionStore} from "./relay-admission-store.mjs";
import {planUncertainRecovery,applyUncertainRecovery,readUncertainRecovery} from "./relay-uncertain-reconciliation.mjs";
const policy={planFreshnessMs:300000,receiptRetentionMs:604800000,maxReceipts:1000};
const identity={environment:"test",serviceId:"operator-test"};
function fixture(t, opts={}) {
 const dir=mkdtempSync(join(tmpdir(),"relay-operator-"));let now=100000;
 const path=join(dir,"store.sqlite");
 const config={...identity,operatorRecoveryPolicy:policy,clock:()=>now,...opts};
 let store=openRelayAdmissionStore(path,config);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 return {path,config,get store(){return store;},time:v=>now=v,reopen(){store.close();store=openRelayAdmissionStore(path,config);}};
}
function acquire(f,id="request-00000001") {
 return f.store.acquire({callerId:"caller-000000001",requestId:id,operationDigest:"a".repeat(64),expiresAt:160000});
}
function approved(f,id) {
 const result=planUncertainRecovery(f.store);assert.equal(result.ok,true);
 return {operationId:id ?? ("opr_"+result.plan.createdAt+"_"+"b".repeat(32)),plan:result.plan,ownerRecord:{ownerId:"owner-reviewed",processGeneration:"old-process-1",
   observedAt:result.plan.createdAt,planSha256:result.planSha256,evidenceSha256:"e".repeat(64),admissionsPaused:true,transportState:"stopped"}};
}
test("atomic unknown receipt survives response loss/reopen; identity and capacity preserved",t=>{
 const f=fixture(t);const a=acquire(f);assert.equal(a.ok,true);f.time(120000);
 const req=approved(f);const before=readFileSync(f.path);planUncertainRecovery(f.store);assert.deepEqual(readFileSync(f.path),before);
 const result=applyUncertainRecovery(f.store,req);assert.equal(result.ok,true);f.reopen();
 assert.deepEqual(readUncertainRecovery(f.store,req.operationId),{ok:true,state:"committed",receipt:result.receipt});
 assert.deepEqual(applyUncertainRecovery(f.store,req),result);
 assert.equal(result.receipt.machineVerifiedTransportStop,false);assert.equal(result.receipt.outcome,"unknown");
 const sql=new DatabaseSync(f.path);t.after(()=>sql.close());
 const row=sql.prepare("SELECT * FROM relay_admissions").get();
 assert.equal(row.id,a.leaseId);assert.equal(row.operation_digest,"a".repeat(64));assert.equal(row.state,"finished");assert.equal(row.outcome_kind,"unknown");
 assert.equal(row.admitted_ms,100000);assert.equal(row.replay_expires_ms,160000);
 assert.equal(f.store.acquire({callerId:"caller-000000001",requestId:"request-00000001",expiresAt:160000}).reason,"duplicate");
 assert.equal(acquire(f,"request-00000002").ok,true);
 assert.equal(applyUncertainRecovery(f.store,{...req,ownerRecord:{...req.ownerRecord,evidenceSha256:"f".repeat(64)}}).reason,"conflict");
});
test("expiry alone, unavailable evidence, wrong binding and changed set refuse",t=>{
 const f=fixture(t);acquire(f);f.time(120000);const req=approved(f);
 for(const patch of [{transportState:"running"},{admissionsPaused:false},{evidenceSha256:""},{observedAt:99999},{planSha256:"f".repeat(64)}])
   assert.equal(applyUncertainRecovery(f.store,{...req,ownerRecord:{...req.ownerRecord,...patch}}).ok,false);
 assert.equal(applyUncertainRecovery(f.store,{...req,plan:{...req.plan,serviceId:"foreign-service"}}).ok,false);
 acquire(f,"request-00000002");
 assert.equal(applyUncertainRecovery(f.store,req).reason,"stale-plan");
 assert.equal(f.store.listUncertainLeases().leases.length,1);
});
test("known completion race refuses whole batch and leaves definite receipt unchanged",t=>{
 const f=fixture(t);const a=acquire(f);f.time(120000);const req=approved(f);
 assert.equal(f.store.finish(a.leaseId,{kind:"http",status:410,retryAfterState:"absent"}).ok,true);
 assert.equal(applyUncertainRecovery(f.store,req).reason,"stale-plan");
 assert.equal(f.store.readOutcome({callerId:"caller-000000001",requestId:"request-00000001",operationDigest:"a".repeat(64)}).outcome.status,410);
 assert.equal(readUncertainRecovery(f.store,req.operationId).state,"unknown");
});
test("policy required; fresh plan cannot target nonexpired transport; stale operations never replay after retention",t=>{
 const f=fixture(t);acquire(f);
 assert.equal(applyUncertainRecovery(f.store,approved(f)).reason,"stale-plan");
 f.time(120000);const req=approved(f);assert.equal(applyUncertainRecovery(f.store,req).ok,true);
 f.time(800000000);
 // Even missing receipt after bounded authorized cleanup is NOT a retry permit.
 const sql=new DatabaseSync(f.path);sql.exec("DELETE FROM relay_operator_receipts");sql.close();
 assert.equal(readUncertainRecovery(f.store,req.operationId).state,"unknown");
 assert.equal(applyUncertainRecovery(f.store,req).reason,"stale-plan");
 const other=fixture(t,{operatorRecoveryPolicy:undefined});assert.equal(planUncertainRecovery(other.store).reason,"operator-policy-required");
});
test("transaction failure rolls back both release and receipt; same request can be read back then retried",t=>{
 const f=fixture(t);acquire(f);f.time(120000);const req=approved(f);
 const sql=new DatabaseSync(f.path);
 sql.exec("CREATE TRIGGER test_abort BEFORE INSERT ON relay_operator_receipts BEGIN SELECT RAISE(ABORT,'synthetic-failure'); END");
 assert.equal(applyUncertainRecovery(f.store,req).reason,"unavailable");
 assert.equal(readUncertainRecovery(f.store,req.operationId).state,"unknown");
 assert.equal(sql.prepare("SELECT state FROM relay_admissions").get().state,"active");
 sql.exec("DROP TRIGGER test_abort");sql.close();
 assert.equal(applyUncertainRecovery(f.store,req).ok,true);
});
test("same operation across two connections produces one immutable receipt",t=>{
 const f=fixture(t);acquire(f);f.time(120000);const req=approved(f);
 const other=openRelayAdmissionStore(f.path,f.config);t.after(()=>other.close());
 const a=applyUncertainRecovery(f.store,req),b=applyUncertainRecovery(other,req);
 assert.deepEqual(a,b);
 const sql=new DatabaseSync(f.path);assert.equal(sql.prepare("SELECT COUNT(*) n FROM relay_operator_receipts").get().n,1);
 assert.throws(()=>sql.exec("UPDATE relay_operator_receipts SET committed_ms=0"),/immutable/);sql.close();
});
test("v4 migration retains unknown and known evidence; explicit policy persists",t=>{
 const f=fixture(t);const a=acquire(f);f.store.finish(a.leaseId,{kind:"http",status:204,retryAfterState:"absent"});
 acquire(f,"request-00000002");f.store.close();
 const db=new DatabaseSync(f.path);const before=db.prepare("SELECT * FROM relay_admissions ORDER BY id").all();
 db.exec("DROP TABLE relay_operator_receipts; DROP TABLE relay_operator_identity; PRAGMA user_version=4");db.close();
 f.reopen();
 const check=new DatabaseSync(f.path);assert.deepEqual(check.prepare("SELECT * FROM relay_admissions ORDER BY id").all(),before);
 assert.equal(check.prepare("PRAGMA user_version").get().user_version,5);check.close();
 f.time(120000);assert.equal(applyUncertainRecovery(f.store,approved(f)).ok,true);
 const foreign=openRelayAdmissionStore(f.path,{...f.config,operatorRecoveryPolicy:{...policy,maxReceipts:3}});
 assert.equal(planUncertainRecovery(foreign).reason,"operator-policy-mismatch");foreign.close();
});
test("bounded receipt capacity fails closed and legitimate retention cleanup never renews old operation",t=>{
 const f=fixture(t,{operatorRecoveryPolicy:{...policy,maxReceipts:1,receiptRetentionMs:86400000}});
 acquire(f);f.time(120000);const first=approved(f);assert.equal(applyUncertainRecovery(f.store,first).ok,true);
 acquire(f,"request-00000002");f.time(140000);const second=approved(f);
 assert.equal(applyUncertainRecovery(f.store,second).reason,"capacity");
 f.time(86600001);
 const fresh=approved(f);assert.equal(applyUncertainRecovery(f.store,fresh).ok,true);
 assert.equal(readUncertainRecovery(f.store,first.operationId).state,"unknown");
 assert.equal(applyUncertainRecovery(f.store,{...fresh,operationId:first.operationId}).ok,false);
 assert.equal(applyUncertainRecovery(f.store,first).ok,false);
});
