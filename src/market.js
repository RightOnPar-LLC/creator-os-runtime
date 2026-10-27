// Two-sided market MVP — list + discover + call + deliver.
// No new value engine: the market is the escrow keystone with a registry in front.
// Providers list capabilities; callers discover and invoke them via escrow.
import { HttpError, newId, parseJson } from "./util.js";
import { sql } from "./db.js";

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
// registry would be a dedicated table). Each entry names the tenant that would be paid.
export async function discoverCapabilities(query = {}) {
  let limit = Math.min(Math.max(1, Number(query.limit || 20)), 100);
  let rows = await sql`SELECT tenant, data FROM events WHERE type = 'market.listed' ORDER BY ts DESC LIMIT ${limit}`;
  return rows
    .map((r) => {
      let d = parseJson(r.data);
      return d ? { ...d, provider_tenant: r.tenant } : null;
    })
    .filter(Boolean);
}

// The listing for a capability id, or null. The listing is the only source of who is paid
// and how much: the caller never gets to say.
export async function findListing(capabilityId) {
  let rows = await sql`SELECT tenant, data FROM events
    WHERE type = 'market.listed' AND data->>'capability_id' = ${String(capabilityId)}
    ORDER BY ts DESC LIMIT 1`;
  if (!rows.length) return null;
  let d = parseJson(rows[0].data);
  return d ? { ...d, provider_tenant: rows[0].tenant } : null;
}

// Call, step one: turn the caller's request into the exact escrow terms the listing allows.
// What comes back is what gets validated, shown to the owner for approval, and opened: the
// payee, price, condition and ref all come from the listing. A caller-supplied provider_tenant
// or amount is only checked against it, never trusted.
export async function resolveCall(callerRow, params) {
  let capabilityId = String(params?.capability_id || "");
  if (!capabilityId) throw new HttpError(400, "capability_id_required");
  let listing = await findListing(capabilityId);
  if (!listing) throw new HttpError(404, "capability_not_found");
  if (params?.provider_tenant != null && String(params.provider_tenant) !== listing.provider_tenant)
    throw new HttpError(400, "provider_mismatch", { provider_tenant: listing.provider_tenant });
  if (params?.amount != null && Math.floor(Number(params.amount)) !== listing.price)
    throw new HttpError(400, "amount_mismatch", { price: listing.price });
  if (listing.provider_tenant === callerRow.tenant) throw new HttpError(400, "cannot_buy_own_listing");
  let terms = {
    amount: listing.price,
    payee_tenant: listing.provider_tenant,
    payee_ref: capabilityId,
    condition: { kind: listing.condition },
  };
  if (params?.ttlSec != null) terms.ttlSec = params.ttlSec;
  if (params?.deadline != null) terms.deadline = params.deadline;
  return terms;
}
