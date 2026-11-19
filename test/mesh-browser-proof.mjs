// Isolated real Runtime UI, synthetic Market boundary. Never evidence of live settlement.
import {req,admin,newTenant,shutdown,sha256Hex,BASE,ADMIN_KEY} from './harness.js';
import {writeFileSync} from 'node:fs';
const real=globalThis.fetch;const cid='call_'+'c'.repeat(48);
globalThis.fetch=async(u,i)=>String(u).startsWith('https://market.meshtool.ai/')?Response.json(String(u).endsWith('/api/account')?{handle:'fixture'}:i?.method==='POST'?{ok:true,capability:'safety-scrub',call_id:cid,charged:1,result:{text:'fixture redacted'}}:{call_id:cid,capability:'safety-scrub',status:'settled',currency:'MESH',ledger_verified:true,charged:1,caller_debit:1,provider_credit:1,fee:0}):real(u,i);
const t=await newTenant('Isolated VM receipt proof','studio');const k='fixture-private-market-key';
const g=await req('POST','/api/grants',{token:t.token,body:{sub:'agent:fixture',caps:['mesh.call','ledger.read'],ttlSec:600,budget:{calls:1,usd_cents:0,deploys:0},constraints:{autonomy:'act'},scope:{mesh:{key_sha256:sha256Hex(k),capabilities:['safety-scrub'],max_mesh_per_call:1}}}});
const r=await req('POST','/api/mesh/call',{token:g.json.token,body:{request_id:crypto.randomUUID(),capability:'safety-scrub',market_key:k,max_mesh:1,input:{text:'fixture'}}});
if(r.status!==200)throw new Error('fixture invocation failed');
writeFileSync('/home/meshtool/frank-deck-work/browser-tools/runtime-mesh-browser-state.json',JSON.stringify({base:BASE,receipt:r.json.receipt_id,fixture:true}));
console.log('Isolated Runtime browser fixture ready');
const stop=()=>shutdown().then(()=>process.exit());process.on('SIGTERM',stop);process.on('SIGINT',stop);
await new Promise(()=>{});
