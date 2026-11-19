import {test,expect,afterAll} from 'bun:test';
import {req,admin,newTenant,shutdown,dbQuery,sha256Hex} from './harness.js';
afterAll(shutdown);
const key='fixture-market-key';const cid='call_'+'a'.repeat(48);
const original=globalThis.fetch;let forwards=0,mode='ok',observedStart=false;
globalThis.fetch=async(url,init)=>{
 if(!String(url).startsWith('https://market.meshtool.ai/'))return original(url,init);
 if(String(url).endsWith('/api/account'))return Response.json({handle:'fixture-owner'}, {status:mode==='delegate'?403:200});
 if(init?.method==='POST'){
  forwards++;
  const rid=init.headers['idempotency-key'];
  const rows=(await dbQuery('SELECT t.auth_decision,m.state FROM tool_receipts t JOIN mesh_invocations m ON m.receipt_id=t.id WHERE t.id=$1',[rid])).rows;
  observedStart=rows.length===1&&rows[0].auth_decision==='authorized'&&rows[0].state==='started';
  expect(init.redirect).toBe('error');expect(init.headers['x-max-price']).toBe('1');
  if(mode==='lost')throw new Error('connection lost');
  if(mode==='finish-fail'){await dbQuery("CREATE FUNCTION fail_mesh_finish() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture storage failure'; END; $$ LANGUAGE plpgsql"); await dbQuery("CREATE TRIGGER no_mesh_finish BEFORE UPDATE ON mesh_invocations FOR EACH ROW EXECUTE FUNCTION fail_mesh_finish()");}
  return Response.json({ok:true,capability:'safety-scrub',charged:1,call_id:cid,result:{text:'redacted'},...(mode==='held'?{held:true}:{})});
 }
 return Response.json({call_id:cid,capability:'safety-scrub',status:'settled',currency:'MESH',charged:1,caller_debit:1,provider_credit:1,fee:0,ledger_verified:mode!=='bad-proof'});
};
const mint=async({calls=2,autonomy='act',caps=['mesh.call','ledger.read'],scope={}}={})=>{
 const t=await newTenant('mesh-test','studio');
 const r=await req('POST','/api/grants',{token:t.token,body:{sub:'agent:mesh-test',caps,ttlSec:600,budget:{calls,usd_cents:0,deploys:0},constraints:{autonomy},scope:{mesh:{key_sha256:sha256Hex(key),capabilities:['safety-scrub'],max_mesh_per_call:1,...scope}}}});
 expect(r.status).toBe(201);return {...t,child:r.json.token,childId:r.json.grant?.id??r.json.id};
};
const body=()=>({request_id:crypto.randomUUID(),capability:'safety-scrub',market_key:key,max_mesh:1,input:{text:'private test input'}});
const call=(token,b=body())=>req('POST','/api/mesh/call',{token,body:b});

test('real grant boundary commits permission/start before forwarding; two links reconcile; no secrets persisted',async()=>{
 const t=await mint();const r=await call(t.child);expect(r.status).toBe(200);expect(observedStart).toBe(true);expect(r.json.execution).toBe('settled');
 expect(r.json.links.runtime).toContain(r.json.receipt_id);expect(r.json.links.market).toEndWith(cid);
 const read=await req('GET','/api/mesh/receipts/'+r.json.receipt_id,{token:t.child});expect(read.status).toBe(200);
 const stored=await dbQuery('SELECT * FROM mesh_invocations WHERE receipt_id=$1',[r.json.receipt_id]);
 expect(JSON.stringify(stored.rows)).not.toContain(key);expect(JSON.stringify(stored.rows)).not.toContain('private test input');
 const inv=await admin('GET','/api/admin/tool-receipts?id='+r.json.receipt_id);expect(inv.json.receipts[0].outcome).toBe('succeeded');
 const outsider=await mint();expect((await req('GET','/api/mesh/receipts/'+r.json.receipt_id,{token:outsider.child})).status).toBe(404);
 expect((await req('GET','/api/admin/mesh/receipts/'+r.json.receipt_id)).status).toBe(401);
});
test('missing, wrong capability, mismatched key, excessive price, observe and ask all cause zero upstream calls',async()=>{
 const start=forwards;expect((await call()).status).toBe(401);
 const noCap=await mint({caps:['ledger.read']});expect((await call(noCap.child)).status).toBe(403);
 const t=await mint();for(const change of [{capability:'grok-image'},{market_key:'different'},{max_mesh:2}])expect((await call(t.child,{...body(),...change})).status).toBe(403);
 for(const autonomy of ['observe','ask']){const a=await mint({autonomy});expect((await call(a.child)).status).toBe(403);}
 expect(forwards).toBe(start);
});
test('expired/revoked ancestry and exhausted call budget cause zero forwarding',async()=>{
 const before=forwards;const t=await mint({calls:0});expect((await call(t.child)).status).toBe(402);
 const x=await mint();await dbQuery('UPDATE grants SET exp=1 WHERE parent=$1',[x.grantId]);expect((await call(x.child)).status).toBe(401);
 const y=await mint();await dbQuery("UPDATE grants SET status='revoked' WHERE id=$1",[y.grantId]);expect((await call(y.child)).status).toBe(401);expect(forwards).toBe(before);
});
test('one-use operation handle never forwards twice, including changed payload',async()=>{
 const t=await mint();const b=body();const start=forwards;const a=await call(t.child,b);const r=await call(t.child,b);
 expect(a.status).toBe(200);expect(r.json.replayed).toBe(true);expect(r.json.receipt_id).toBe(a.json.receipt_id);expect(forwards).toBe(start+1);
 expect((await call(t.child,{...b,input:{text:'changed'}})).status).toBe(409);expect(forwards).toBe(start+1);
});
test('last call budget is atomic under concurrent distinct requests',async()=>{
 const t=await mint({calls:1});const before=forwards;const rs=await Promise.all([call(t.child),call(t.child)]);expect(rs.map(x=>x.status).sort()).toEqual([200,402]);expect(forwards).toBe(before+1);
});
test('lost response, proof mismatch and proof-held result are never called settled; no retry',async()=>{
 for(const m of ['lost','bad-proof','held']){mode=m;const t=await mint();const b=body();const start=forwards;const r=await call(t.child,b);expect(r.status).toBe(202);expect(r.json.links.market).toBeNull();expect(r.json.retry_safe).toBe(false);
 const inv=await admin('GET','/api/admin/tool-receipts?id='+r.json.receipt_id);expect(inv.json.receipts[0].outcome).toBe(m==='held'?'pending_settlement':'unknown');await call(t.child,b);expect(forwards).toBe(start+1);}
 mode='ok';
});
test('start storage failure prevents forwarding and rolls back call reservation',async()=>{
 const t=await mint();const before=forwards;
 await dbQuery("CREATE FUNCTION fail_mesh_start() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture storage failure'; END; $$ LANGUAGE plpgsql"); await dbQuery("CREATE TRIGGER no_mesh_start BEFORE INSERT ON mesh_invocations FOR EACH ROW EXECUTE FUNCTION fail_mesh_start()");
 try{expect((await call(t.child)).status).toBe(500);expect(forwards).toBe(before);}finally{await dbQuery('DROP TRIGGER no_mesh_start ON mesh_invocations'); await dbQuery('DROP FUNCTION fail_mesh_start()');}
 const v=await req('GET','/api/grants/verify',{token:t.child});expect(v.json.remaining.calls).toBe(2);
});
test('completion failure retains durable started operation; retry cannot repeat effect',async()=>{
 mode='finish-fail';const t=await mint();const b=body();const start=forwards;let r;
 try{r=await call(t.child,b);expect(r.status).toBe(503);expect(r.json.execution).toBe('unknown');}finally{await dbQuery('DROP TRIGGER no_mesh_finish ON mesh_invocations'); await dbQuery('DROP FUNCTION fail_mesh_finish()');mode='ok';}
 const retry=await call(t.child,b);expect(retry.json.execution).toBe('started');expect(forwards).toBe(start+1);
});
test('delegation cannot widen the tool, key digest or price ceiling',async()=>{
 const t=await mint({caps:['mesh.call','grant.issue','ledger.read'],calls:5});
 for(const change of [{capabilities:['grok-image']},{key_sha256:'b'.repeat(64)},{max_mesh_per_call:2}]){
  const r=await req('POST','/api/grants',{token:t.child,body:{sub:'agent:child',caps:['mesh.call'],ttlSec:120,budget:{calls:1,usd_cents:0,deploys:0},scope:{mesh:{key_sha256:sha256Hex(key),capabilities:['safety-scrub'],max_mesh_per_call:1,...change}}}});expect(r.status).toBe(403);
 }
});
test('call-only Market delegate refuses before any tool POST',async()=>{
 mode='delegate';const t=await mint();const before=forwards;
 const r=await call(t.child);expect(r.status).toBe(202);expect(r.json.execution).toBe('not_run');expect(forwards).toBe(before);mode='ok';
});
test('Runtime emergency stop prevents any tool POST',async()=>{
 const t=await mint();const before=forwards;
 await dbQuery("UPDATE settings SET value='on' WHERE key='kill_switch'");
 try{expect((await call(t.child)).status).toBe(503);expect(forwards).toBe(before);}finally{await dbQuery("UPDATE settings SET value='off' WHERE key='kill_switch'");}
});
test('failure to create original Runtime receipt prevents forwarding',async()=>{
 const t=await mint();const before=forwards;
 await dbQuery("CREATE FUNCTION fail_runtime_start() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture storage failure'; END; $$ LANGUAGE plpgsql");
 await dbQuery("CREATE TRIGGER no_runtime_start BEFORE INSERT ON tool_receipts FOR EACH ROW EXECUTE FUNCTION fail_runtime_start()");
 try{const r=await call(t.child);expect(r.status).toBe(503);expect(r.json.executed).toBe(false);expect(forwards).toBe(before);}finally{await dbQuery('DROP TRIGGER no_runtime_start ON tool_receipts');await dbQuery('DROP FUNCTION fail_runtime_start()');}
});
