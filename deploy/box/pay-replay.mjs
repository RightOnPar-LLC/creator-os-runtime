// PAY daily replay (DevDesk #202): the machine repeats the MeshMarket rail hand-proof once a day.
//
// One real purchase through the rail, the way an agent makes it, and every number checked:
//   a fresh root grant on the proof tenant -> an agent grant with a small budget ->
//   buy SLUG with ceiling MAX -> the job settles -> the agent's budget dropped by exactly what was
//   spent -> the ledger reads reserve / settle / release in cents (MESH at the job's own rate,
//   rounded up) -> MeshMarket's balance dropped by exactly the MESH kept (one charge, never two).
//   Then the day's grants are revoked.
//
// Green is silent. Red (any check fails) pages the owner. A low buyer balance is its own notice.
// Prints statuses and amounts only: never the admin key, the MeshMarket key, or a grant token.
//
// Runs inside the production runtime container (deploy/box/pay-replay.sh), where the runtime's own
// env holds RUNTIME_ADMIN_KEY. `replay()` is exported so test/pay-replay.test.js drives the same code.

export const DEFAULTS = {
  tenantName: "pay-proof-rail", // the proof tenant made by the live hand-proof on 2026-11-22
  slug: "safety-scrub", // 1 MESH, 100% reliable, the exchange's most-called listing
  maxPrice: 3, // ceiling: a price rise above this is refused by MeshMarket, nothing spent, and pages
  budget: 10,
  lowBalance: 30, // under this many MESH left in the buyer account: a top-up notice (about a month)
};

export async function replay({ base, adminKey, fetchImpl = globalThis.fetch, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const checks = [];
  const out = { ok: false, skipped: null, checks, spent: null, credits: null, job: null, notices: [] };
  const check = (name, pass, got) => { checks.push({ name, pass: !!pass, got }); return !!pass; };
  const call = async (method, path, { token = adminKey, body } = {}) => {
    try {
      const r = await fetchImpl(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      let j = null; try { j = await r.json(); } catch {}
      return { status: r.status, json: j || {} };
    } catch (e) { return { status: 0, json: { error: String(e?.message || e) } }; }
  };
  let rootId = null;
  try {
    // 0. the switches: a paused runtime is not a failure of the rail
    const health = await call("GET", "/health");
    if (health.json?.killSwitch === true) { out.skipped = "kill_switch_on"; out.ok = true; return out; }
    const st0 = await call("GET", "/api/admin/meshmarket");
    if (!check("buyer account enrolled and reachable", st0.json?.enrolled && st0.json?.reachable, { http: st0.status, enrolled: st0.json?.enrolled, reachable: st0.json?.reachable })) return out;
    const credits0 = st0.json.credits;

    // 1. the proof tenant and a fresh, short-lived root grant on it
    const ts = await call("GET", "/api/tenants");
    const tenant = (ts.json?.tenants || []).find((t) => t.name === o.tenantName && t.status === "active");
    if (!check("proof tenant exists", tenant, { name: o.tenantName })) return out;
    const root = await call("POST", `/api/tenants/${tenant.id}/root-grant`, { body: { sub: "tenant:pay-replay" } });
    if (!check("root grant minted", root.status === 201, { http: root.status, error: root.json?.error })) return out;
    rootId = root.json.id;
    const g = await call("POST", "/api/grants", { token: root.json.token, body: { sub: "agent:pay-replay", caps: ["payments.meshmarket", "grant.read"], ttlSec: 3600, budget: { usd_cents: o.budget, calls: 5, deploys: 0 } } });
    if (!check("agent grant minted", g.status === 201, { http: g.status, error: g.json?.error, reasons: g.json?.reasons })) return out;
    const agent = g.json.token;
    const left = async () => (await call("GET", "/api/grants/verify", { token: agent })).json?.remaining?.usd_cents;
    const before = await left();

    // 2. the purchase
    const b = await call("POST", "/api/payments/meshmarket/jobs", { token: agent, body: { slug: o.slug, maxPrice: o.maxPrice, input: { text: "PAY daily replay - RightOnPar LLC" } } });
    const job = b.json?.job || null;
    out.job = job ? { id: job.id, status: job.status, call_id: job.tx, error: job.error } : { http: b.status, error: b.json?.error };
    if (!check("job settled", b.status === 201 && job?.status === "settled", out.job)) return out;
    // MESH is what MeshMarket kept; cents is what the agent's budget paid (MESH at the job's rate, rounded up)
    const mesh = job.receipt?.spent_mesh;
    const spent = job.receipt?.spent;
    const reserved = job.amount_usd_cents;
    const rate = job.requirement?.mesh_per_cent;
    out.spent = spent;
    out.spent_mesh = mesh;
    check("MESH kept equals what MeshMarket charged, within the ceiling", Number.isInteger(mesh) && mesh === job.receipt?.charged && mesh >= 1 && mesh <= o.maxPrice, { mesh, charged: job.receipt?.charged, max: o.maxPrice });
    const centsFor = (m) => (rate > 0 ? Math.floor((m * 1e6 + Math.round(rate * 1e6) - 1) / Math.round(rate * 1e6)) : NaN);
    check("cents = MESH at the job's rate, rounded up", spent === centsFor(mesh) && reserved === centsFor(o.maxPrice), { rate, mesh, spent, ceiling: o.maxPrice, reserved });

    // 3. the budget, the ledger, and MeshMarket's own balance agree
    const after = await left();
    check("agent budget dropped by exactly the spend", before - after === spent, { before, after, spent });
    const led = await call("GET", "/api/ledger", { token: root.json.token });
    const rows = (led.json?.ledger || []).filter((r) => r.ref === job.id || r.ref === job.tx).map((r) => `${r.kind}:${r.usd_cents}`).sort();
    const want = [`reserve:${reserved}`, `meshmarket-settle:${spent}`, ...(reserved - spent > 0 ? [`release:${-(reserved - spent)}`] : [])].sort();
    check("ledger reads reserve / settle / release", JSON.stringify(rows) === JSON.stringify(want), { rows, want });
    const st1 = await call("GET", "/api/admin/meshmarket");
    out.credits = st1.json?.credits ?? null;
    out.daily = st1.json?.daily ?? null;
    check("MeshMarket charged once, the same amount", Number.isInteger(credits0) && credits0 - out.credits === mesh, { before: credits0, after: out.credits, mesh });
    if (Number.isInteger(out.credits) && out.credits < o.lowBalance) out.notices.push(`buyer balance low: ${out.credits} MESH left`);
    out.ok = checks.every((c) => c.pass);
    return out;
  } finally {
    // out with the old: the day's grants end with the run (revoking the root ends the agent too)
    if (rootId) await call("POST", `/api/admin/grants/${rootId}/revoke`, { body: { reason: "pay replay finished" } });
  }
}

// CLI: one line of JSON (the receipt), exit 0 green or skipped, 1 red.
if (import.meta.main) {
  const port = process.env.PORT || 3000;
  const adminKey = process.env.RUNTIME_ADMIN_KEY;
  const r = adminKey
    ? await replay({ base: `http://127.0.0.1:${port}`, adminKey })
    : { ok: false, checks: [{ name: "admin key present in the runtime env", pass: false }] };
  console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
  process.exit(r.ok ? 0 : 1);
}
