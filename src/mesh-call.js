// Runtime is the forwarding boundary. No external POST occurs before the transaction commits.
import { sql } from './db.js';
import { HttpError, parseJson, sha256Hex, nowSec } from './util.js';
import { remainingBudget, addUsage, normalizeUsage } from './policy.js';
import { autonomyOf, decide } from './autonomy.js';
import { validMeshScope } from './mesh-policy.js';

const MARKET = 'https://market.meshtool.ai';
const callIdOK = id => typeof id === 'string' && /^call_[a-f0-9]{32,64}$/.test(id);
export const meshLinks = row => ({
  runtime: '/#/receipts?toolReceipt=' + encodeURIComponent(row.receipt_id),
  market: row.state === 'settled' && callIdOK(row.market_call_id) ? MARKET + '/receipts/' + row.market_call_id : null,
});
export function meshPermission(row, body) {
  const scope = parseJson(row.scope)?.mesh;
  if (!validMeshScope(scope) || !scope.capabilities.includes(body.capability)) throw new HttpError(403, 'out_of_scope');
  if (typeof body.market_key !== 'string' || body.market_key.length > 512 || sha256Hex(body.market_key) !== scope.key_sha256)
    throw new HttpError(403, 'market_key_mismatch');
  if (!Number.isSafeInteger(body.max_mesh) || body.max_mesh < 0 || body.max_mesh > scope.max_mesh_per_call)
    throw new HttpError(403, 'market_limit_exceeded');
  const decision = decide(autonomyOf(parseJson(row.constraints)), 'escrow.open');
  if (decision.decision !== 'act') throw new HttpError(403, 'owner_approval_required');
}

export async function callMesh(auth, body, receiptId) {
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(body.request_id || '')) throw new HttpError(400, 'request_id_required');
  if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input) || JSON.stringify(body.input).length > 16000)
    throw new HttpError(400, 'invalid_tool_input');
  meshPermission(auth.row, body);
  // An operation handle is single-use. A retry returns its record, never forwards again,
  // even if the response was lost or the tool reported a refundable failure.
  const requestHash = sha256Hex(JSON.stringify([body.capability, body.max_mesh, body.input]));
  let prior;
  await sql.begin(async tx => {
    const row = (await tx`SELECT * FROM grants WHERE id = ${auth.row.id} FOR UPDATE`)[0];
    const chain = await tx`WITH RECURSIVE up AS (
      SELECT id, parent, status, exp FROM grants WHERE id = ${auth.row.id}
      UNION ALL SELECT g.id, g.parent, g.status, g.exp FROM grants g JOIN up ON g.id = up.parent)
      SELECT * FROM up WHERE status <> 'active' OR exp <= ${nowSec()}`;
    if (!row || row.tenant !== auth.tenant.id || chain.length) throw new HttpError(401, 'grant_revoked');
    meshPermission(row, body);
    prior = (await tx`SELECT * FROM mesh_invocations WHERE grant_id = ${row.id} AND request_id = ${body.request_id}`)[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw new HttpError(409, 'request_id_reused');
      return;
    }
    if (remainingBudget(row).calls < 1) throw new HttpError(402, 'budget_exhausted');
    const started = await tx`SELECT id FROM tool_receipts WHERE id = ${receiptId} AND grant_id = ${row.id}
      AND tenant = ${row.tenant} AND auth_decision = 'authorized' AND outcome = 'started'`;
    if (started.length !== 1) throw new HttpError(503, 'receipt_unavailable');
    await tx`INSERT INTO mesh_invocations (receipt_id, tenant, grant_id, request_id, request_hash, capability, max_mesh)
      VALUES (${receiptId}, ${row.tenant}, ${row.id}, ${body.request_id}, ${requestHash}, ${body.capability}, ${body.max_mesh})`;
    await tx`UPDATE grants SET settled = ${addUsage(normalizeUsage(parseJson(row.settled)), {calls:1,usd_cents:0,deploys:0})}::jsonb WHERE id = ${row.id}`;
    await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, calls, ref, note)
      VALUES (${row.tenant}, ${row.id}, ${row.parent}, 'mesh-attempt', 1, ${receiptId}, 'Market invocation admitted; no monetary debit in Runtime')`;
  });
  if (prior) return { replayed: true, executed: false, execution: prior.state, retry_safe: false, receipt_id: prior.receipt_id, links: meshLinks(prior) };

  let forwarded = false;
  let state = 'unknown', callId = null, charged = null, output;
  try {
    // Account keys only for this first adapter. Call-only delegates cannot read private receipts.
    const account = await fetch(MARKET + '/api/account', {redirect:'error',signal:AbortSignal.timeout(10000),headers:{'x-agent-key':body.market_key}});
    if (!account.ok) throw new Error('account key required');
    forwarded = true;
    const response = await fetch(MARKET + '/api/call/' + body.capability, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(75000),
      headers: { 'content-type': 'application/json', 'x-agent-key': body.market_key,
        'x-max-price': String(body.max_mesh), 'idempotency-key': receiptId },
      body: JSON.stringify({ input: body.input, max_price: body.max_mesh }),
    });
    const result = await response.json();
    if (callIdOK(result.call_id)) callId = result.call_id;
    if (response.ok && result.ok === true && result.held === true) state = 'held';
    else if (response.ok && result.ok === true && callId && result.capability === body.capability &&
      Number.isSafeInteger(result.charged) && result.charged >= 0 && result.charged <= body.max_mesh) {
      // A link is offered only after the actual public settlement receipt reconciles.
      const check = await fetch(MARKET + '/api/receipts/' + callId, {redirect:'error',signal:AbortSignal.timeout(10000),headers:{'x-agent-key':body.market_key}});
      const proof = await check.json();
      if (check.ok && proof.call_id === callId && proof.capability === body.capability && proof.status === 'settled' &&
        proof.currency === 'MESH' && proof.ledger_verified === true && proof.charged === result.charged &&
        proof.caller_debit === proof.charged && proof.provider_credit + proof.fee === proof.charged) {
        state = 'settled'; charged = proof.charged; output = result.result;
      }
    }
  } catch { state = forwarded ? 'unknown' : 'not_run'; /* Never replay. */ }
  try {
    const saved = await sql`UPDATE mesh_invocations SET state = ${state}, market_call_id = ${callId}, charged = ${charged}, finished_at = now()
      WHERE receipt_id = ${receiptId} AND state = 'started' RETURNING *`;
    if (saved.length !== 1) throw new Error('completion missing');
    return { execution: state, retry_safe: false, receipt_id: receiptId, links: meshLinks(saved[0]), ...(state === 'settled' ? { result: output } : {}) };
  } catch { throw new HttpError(503, 'receipt_completion_unavailable', {execution:'unknown',retry_safe:false,receipt_id:receiptId}); }
}

export async function readMeshReceipt(id, auth = null) {
  const rows = auth ? await sql`WITH RECURSIVE sub AS (
    SELECT id FROM grants WHERE id = ${auth.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
    SELECT receipt_id, capability, max_mesh, state, market_call_id, charged, started_at, finished_at
    FROM mesh_invocations WHERE receipt_id = ${id} AND tenant = ${auth.tenant.id} AND grant_id IN (SELECT id FROM sub)` :
    await sql`SELECT receipt_id, capability, max_mesh, state, market_call_id, charged, started_at, finished_at FROM mesh_invocations WHERE receipt_id = ${id}`;
  if (!rows.length) throw new HttpError(404, 'receipt_not_found');
  return {...rows[0], links:meshLinks(rows[0])};
}
