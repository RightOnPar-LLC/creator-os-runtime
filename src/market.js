// Two-sided market MVP — list + discover + call + deliver.
// No new value engine: the market is the escrow keystone with a registry in front.
// Providers list capabilities; callers discover and invoke them via escrow.
import { HttpError, newId, nowSec, parseJson } from "./util.js";
import { getGrant, recordEvent, sql } from "./db.js";
import { openEscrow, captureEscrow, escrowBlock, serializeEscrow } from "./escrow.js";

// List a capability: the provider advertises what they offer and the price.
export async function listCapability(providerRow, params) {
  let name = String(params?.name || "").slice(0, 120);
  if (!name) throw new HttpError(400, "capability_name_required");
  let price = Math.floor(Number(params?.price ?? 0));
  if (!Number.isFinite(price) || price <= 0) throw new HttpError(400, "capability_price_required");
  let desc = String(params?.description || "").slice(0, 500);
  let condition = String(params?.condition || "attestation:self-settle");
  let id = newId("cap");
  await sql`INSERT INTO events (tenant, type, actor, data)
    VALUES (${providerRow.tenant}, 'market.listed', ${providerRow.sub},
      ${{ capability_id: id, name, price, desc, condition }}::jsonb)`;
  return { id, name, price, desc, condition, provider: providerRow.sub };
}

// Discover: search listed capabilities (reads from events for now; a real
// registry would be a dedicated table).
export async function discoverCapabilities(query = {}) {
  let limit = Math.min(Math.max(1, Number(query.limit || 20)), 100);
  let rows = await sql`SELECT data FROM events WHERE type = 'market.listed' ORDER BY ts DESC LIMIT ${limit}`;
  return rows.map(r => parseJson(r.data)).filter(Boolean);
}

// Call: open an escrow to a provider (the caller pays, the provider delivers).
export async function callCapability(callerRow, params) {
  let capabilityId = String(params?.capability_id || "");
  if (!capabilityId) throw new HttpError(400, "capability_id_required");
  let payeeTenant = String(params?.provider_tenant || "");
  if (!payeeTenant) throw new HttpError(400, "provider_tenant_required");
  let amount = Math.floor(Number(params?.amount ?? 0));
  if (!amount) throw new HttpError(400, "amount_required");
  let condition = String(params?.condition || "attestation:self-settle");
  // Reuse the escrow keystone — the market IS escrow with a registry
  return openEscrow(callerRow, {
    amount, payee_tenant: payeeTenant,
    condition: { kind: condition },
    payee_ref: capabilityId,
  }, callerRow.sub);
}
