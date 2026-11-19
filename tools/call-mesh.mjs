#!/usr/bin/env node
// Runs ON the VM. Keys are read from the process environment, never command-line args/files.
// Caller supplies an already-issued scoped grant; this program cannot mint authority.
import {readFile} from 'node:fs/promises';
const [requestId, capability, inputFile, ceiling] = process.argv.slice(2);
const base=process.env.RUNTIME_URL || 'https://runtime.meshtool.ai';
const url=new URL(base);
if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw new Error('RUNTIME_URL must be an HTTPS origin');
if(!requestId || !capability || !inputFile || !/^\d+$/.test(ceiling||''))throw new Error('Usage: node tools/call-mesh.mjs <stable-request-id> <capability> <input.json> <max-MESH>');
const grant=process.env.RUNTIME_CALL_GRANT, key=process.env.MESH_CALL_KEY;
if(!grant || !key)throw new Error('Existing scoped RUNTIME_CALL_GRANT and MESH_CALL_KEY required');
const input=JSON.parse(await readFile(inputFile,'utf8'));
const res=await fetch(new URL('/api/mesh/call',base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(95000),headers:{authorization:'Bearer '+grant,'content-type':'application/json'},body:JSON.stringify({request_id:requestId,capability,input,max_mesh:Number(ceiling),market_key:key})});
const data=await res.json();
// No raw provider data or credentials in the transcript. Results remain in the HTTP response to callers.
console.log(JSON.stringify({status:res.status,execution:data.execution||data.detail?.execution||'refused',receipt_id:data.receipt_id||data.detail?.receipt_id,runtime_receipt:data.links?.runtime?new URL(data.links.runtime,base).href:null,market_receipt:data.links?.market||null,replayed:data.replayed===true,retry_safe:false,error:data.error||null},null,2));
if(!res.ok || data.execution!=='settled')process.exitCode=1;
