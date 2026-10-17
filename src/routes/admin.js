// Routes: admin: tenants, kill switch, policy, breakglass, grants, read-only tables. Registration order is significant.
import { armedIntegrations, POLICY_VERSION, RATE_LIMIT_MAX_PER_MIN } from "../config.js";
import { HttpError, newId } from "../util.js";
import { getGrant, getTenant, isKillSwitchOn, isOperatorLspCapsEnabled, recordEvent, setSetting, sql } from "../db.js";
import { reissueGrantToken } from "../tokens.js";
import { CAPS, remainingBudget, TIERS } from "../policy.js";
import { endedAbove, grantsLeftUnderEnded, mintRootGrant, reapExpiredGrants, revokeGrantTree } from "../grants.js";
import { readGuestPool, guestPoolStatus } from "../guest.js";
import { notATourReason, sweepTours } from "../tours.js";
import { TEMPLATES } from "../railway.js";
import { app, readJsonBody, requireAdmin, SESSION_TTL_SEC, sessionCookie, signSession } from "../http.js";

// The operator session (0.3.5). Mint: present the admin key once (requireAdmin,
// and minting deliberately accepts the cookie channel too, so a live session can
// renew itself before it lapses) and get a 30-day signed cookie back; every later
// /api/admin/* call rides on the cookie, so the key is pasted once per 30 days
// per browser instead of once per tab, machine and redeploy.
//
// SECURITY: the cookie is signed WITH RUNTIME_ADMIN_KEY, so rotating that key
// invalidates every outstanding session at once — there is no session store to
// clear and no cookie that can outlive its key. The TTL is inside the signature
// (see signSession in ../http.js), so the holder cannot extend it. Nothing is
// persisted; this route adds no table and does not touch the grant engine.
// SESSION_TTL_SEC and sessionCookie live in ../http.js, which also slides the
// session on use (requireAdmin).
app.post("/api/admin/session", requireAdmin, (e) => {
  let expMs = Date.now() + SESSION_TTL_SEC * 1000;
  return (
    e.header("set-cookie", sessionCookie(signSession(expMs), SESSION_TTL_SEC)),
    e.json({
      ok: !0,
      expires: new Date(expMs).toISOString(),
    })
  );
});
app.delete("/api/admin/session", requireAdmin, (e) => (
  e.header("set-cookie", sessionCookie("", 0)),
  e.json({
    ok: !0,
  })
));

app.post("/api/tenants", requireAdmin, async (e) => {
  let t = await readJsonBody(e),
    a = TIERS[t.tier] ? t.tier : "starter",
    n = newId("t"),
    r = {
      railway: {
        projects: Array.isArray(t.railwayProjects) ? t.railwayProjects : [],
        environments: Array.isArray(t.environments) ? t.environments : ["production"],
      },
    };
  await sql`INSERT INTO tenants (id, name, tier, allowed_targets) VALUES (${n}, ${String(t.name || "creator").slice(0, 80)}, ${a}, ${r}::jsonb)`;
  let s = await getTenant(n),
    i = await mintRootGrant(s);
  return (
    await recordEvent(
      "tenant.created",
      {
        tier: a,
      },
      n,
      "admin",
    ),
    e.json(
      {
        tenant: s,
        rootGrant: {
          id: i.row.id,
          token: i.token,
          exp: Number(i.row.exp),
        },
      },
      201,
    )
  );
});
app.get("/api/tenants", requireAdmin, async (e) =>
  e.json({
    tenants:
      await sql`SELECT id, name, tier, status, deploys_period, period_start, allowed_targets, created_at FROM tenants ORDER BY created_at DESC LIMIT 200`,
  }),
);
app.get("/api/tenants/:id", requireAdmin, async (e) => {
  let t = await getTenant(e.req.param("id"));
  if (!t) throw new HttpError(404, "tenant_not_found");
  return e.json({
    tenant: t,
  });
});
app.post("/api/tenants/:id/tier", requireAdmin, async (e) => {
  let t = await readJsonBody(e);
  if (!TIERS[t.tier]) throw new HttpError(400, "unknown_tier");
  return (
    await sql`UPDATE tenants SET tier = ${t.tier}, updated_at = now() WHERE id = ${e.req.param("id")}`,
    await recordEvent(
      "tenant.tier",
      {
        tier: t.tier,
      },
      e.req.param("id"),
      "admin",
    ),
    e.json({
      ok: !0,
    })
  );
});
app.post("/api/tenants/:id/suspend", requireAdmin, async (e) => {
  return (
    await sql`UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = ${e.req.param("id")}`,
    await recordEvent("tenant.suspended", {}, e.req.param("id"), "admin"),
    e.json({
      ok: !0,
    })
  );
});
app.post("/api/tenants/:id/resume", requireAdmin, async (e) => {
  return (
    await sql`UPDATE tenants SET status = 'active', updated_at = now() WHERE id = ${e.req.param("id")}`,
    await recordEvent("tenant.resumed", {}, e.req.param("id"), "admin"),
    e.json({
      ok: !0,
    })
  );
});
app.post("/api/tenants/:id/targets", requireAdmin, async (e) => {
  let t = await readJsonBody(e),
    a = {
      railway: {
        projects: t.railwayProjects || [],
        environments: t.environments || ["production"],
      },
    };
  return (
    await sql`UPDATE tenants SET allowed_targets = ${a}::jsonb, updated_at = now() WHERE id = ${e.req.param("id")}`,
    e.json({
      ok: !0,
      allowed: a,
    })
  );
});
app.post("/api/tenants/:id/root-grant", requireAdmin, async (e) => {
  let t = await getTenant(e.req.param("id"));
  if (!t) throw new HttpError(404, "tenant_not_found");
  let a = await mintRootGrant(t, String((await readJsonBody(e)).sub || "tenant:root"));
  return e.json(
    {
      id: a.row.id,
      token: a.token,
      exp: Number(a.row.exp),
    },
    201,
  );
});
app.post("/api/admin/kill", requireAdmin, async (e) => {
  return (
    await setSetting("kill_switch", "on"),
    await recordEvent("runtime.paused", {}, null, "admin"),
    e.json({
      killSwitch: !0,
    })
  );
});
app.post("/api/admin/resume", requireAdmin, async (e) => {
  return (
    await setSetting("kill_switch", "off"),
    await recordEvent("runtime.resumed", {}, null, "admin"),
    e.json({
      killSwitch: !1,
    })
  );
});
app.post("/api/admin/operator-lsp-caps/on", requireAdmin, async (e) => {
  return (
    await setSetting("operator_lsp_caps", "on"),
    await recordEvent("operator.lsp_caps_enabled", {}, null, "admin"),
    e.json({
      operatorLspCaps: !0,
    })
  );
});
app.post("/api/admin/operator-lsp-caps/off", requireAdmin, async (e) => {
  return (
    await setSetting("operator_lsp_caps", "off"),
    await recordEvent("operator.lsp_caps_disabled", {}, null, "admin"),
    e.json({
      operatorLspCaps: !1,
    })
  );
});
app.get("/api/admin/policy", requireAdmin, (e) =>
  e.json({
    policy: POLICY_VERSION,
    caps: CAPS,
    tiers: TIERS,
    templates: TEMPLATES,
    rateLimitPerMin: RATE_LIMIT_MAX_PER_MIN,
  }),
);
app.post("/api/admin/breakglass", requireAdmin, async (e) => {
  let t = await readJsonBody(e),
    a = Math.min(25, Math.max(1, Math.floor(+t.minutes || 5)));
  if (!t.tenant || !(await getTenant(t.tenant))) throw new HttpError(404, "tenant_not_found");
  let n = new Date(Date.now() + a * 60000);
  return (
    await sql`INSERT INTO breakglass (tenant, until, reason) VALUES (${t.tenant}, ${n}, ${String(t.reason || "").slice(0, 200)})`,
    await recordEvent(
      "breakglass.armed",
      {
        minutes: a,
        until: n,
      },
      t.tenant,
      "admin",
    ),
    e.json({
      tenant: t.tenant,
      until: n,
    })
  );
});
// Static 4-segment path — distinct from the 5-segment /:id/{revoke,token}, so it
// runs the sweep on demand for ops and for deterministic tests (the background
// timer is disabled under test).
// `failed`: candidates this pass could not release (id and why); they are left for the next pass.
app.post("/api/admin/grants/reap", requireAdmin, async (e) => {
  let failed = [];
  return e.json({ reaped: await reapExpiredGrants({ failed }), failed, tours_ended: await sweepTours() });
});
// READ ONLY. Grants still active under a grant that has ended, and budget still held above an ended grant for a
// key that let go after it had (grantsLeftUnderEnded in grants.js). The whole table, not one page of
// GET /api/admin/grants. `limit` (1 to 5000, 500 if not given) bounds the two lists that are shown, never a count or
// the total. (Unlike that list, a `limit` it cannot read is clamped here, not refused: this answer is a count, and a
// short list never hides a count.)
app.get("/api/admin/grants/orphans", requireAdmin, async (e) => {
  let asked = Math.floor(Number(e.req.query("limit") || NaN));
  return e.json(await grantsLeftUnderEnded({ limit: Number.isFinite(asked) ? Math.min(5000, Math.max(1, asked)) : 500 }));
});
app.post("/api/admin/grants/:id/revoke", requireAdmin, async (e) => {
  let reason = String((await readJsonBody(e)).reason || "admin");
  notATourReason(reason); // "tour: ..." is the runtime's own (tours.js): the alarm reads one of them back
  return e.json({ revoked: await revokeGrantTree(e.req.param("id"), reason, "admin") });
});
app.post("/api/admin/grants/:id/token", requireAdmin, async (e) => {
  let t = await getGrant(e.req.param("id"));
  // (endedAbove: nor is a token signed again for a grant whose grant above has ended; it would answer 401.)
  if (!t || t.status !== "active" || (await endedAbove(sql, t.id))) throw new HttpError(404, "grant_not_active");
  return e.json({
    id: t.id,
    token: reissueGrantToken(t),
  });
});
app.get("/api/admin/overview", requireAdmin, async (e) => {
  let [t, a, n, r, s] = await Promise.all([
    sql`SELECT status, count(*)::int n FROM tenants GROUP BY status`,
    sql`SELECT status, count(*)::int n FROM grants GROUP BY status`,
    sql`SELECT status, count(*)::int n FROM deploys GROUP BY status`,
    sql`SELECT source, count(*)::int n FROM webhook_events GROUP BY source`,
    sql`SELECT kind, sum(usd_cents)::int usd_cents, sum(deploys)::int deploys FROM ledger GROUP BY kind`,
  ]);
  let gp = await readGuestPool();
  return e.json({
    tenants: t,
    grants: a,
    deploys: n,
    webhooks: r,
    ledger: s,
    guest_pool: gp ? guestPoolStatus(gp) : { open: true, remaining_slots: null, note: "not initialized" },
    killSwitch: await isKillSwitchOn(),
    operatorLspCaps: await isOperatorLspCapsEnabled(),
    armed: armedIntegrations(),
  });
});
// READ ONLY. Grants, newest first. Asked with nothing, it is what it always was: the newest 200 of every tenant.
//   ?status=   one of GRANT_STATUSES: only grants in that state (the row's own status; an active row whose end has
//              passed is still "active" until the sweep takes it, and its `exp` says so)
//   ?tenant=   only that tenant's grants
//   ?limit=    how many, 1 to 1000 (200 if not given);  ?offset= how many of the newest to skip, 0 or more
// `total` is how many grants match the filters in all, so a page that is not the whole answer says so. The page and
// `total` are read in ONE snapshot, so they always agree with each other. `status` and `tenant` in the answer are the
// filters that were applied (null: none). Newest first by created_at, then by id: grants written in one statement share
// a created_at, and without the second key a page boundary could fall differently from one read to the next.
// PAGES ARE BY OFFSET. Between two page reads a list can grow or shrink. Growth anywhere only pushes later grants down a
// place, so a grant may show twice but is never missed. Only an ACTIVE list can shrink (the reaper ends grants every
// minute; a cancel or a capture ends one; nothing is ever deleted or made active again), and a shrink can skip a grant at
// the boundary. `total` does not always show it: a grant written by a slow transaction carries that transaction's START
// time, so it can appear below the boundary in the same moment that another one ends above it. The exact check: read
// each next page from one place earlier (offset = previous offset + limit - 1) and see that its first grant is the last
// one already seen; if it is not, read again from the start (created_at and id never change, so if that grant is still
// where it was, nothing after it can have moved above the boundary). For an audit, ask for everything at once
// (?status=active&limit=1000) and check that `total` equals the rows: with one snapshot that is exact while there are
// 1000 or fewer.
// Anything that cannot be read is refused (400), never ignored: a value, a key this route does not know (?tenant_id=,
// ?Tenant=, ?page=), or a key given twice (?tenant=A&tenant=B, of which only A would be read). An ignored filter or
// offset is how this list once answered every question with the same newest 200, and two live keys older than those
// could not be seen.
const GRANT_STATUSES = ["active", "revoked", "expired", "captured"];
const GRANT_LIST_KEYS = ["status", "tenant", "limit", "offset"];
const wholeParam = (raw, name, min, max, unset) => {
  if (raw === undefined) return unset;
  if (!/^[0-9]{1,10}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new HttpError(400, `${name}_invalid`, { min, max });
  return Number(raw);
};
app.get("/api/admin/grants", requireAdmin, async (e) => {
  for (let [key, values] of Object.entries(e.req.queries())) {
    if (!GRANT_LIST_KEYS.includes(key)) throw new HttpError(400, "query_unknown", { allowed: GRANT_LIST_KEYS });
    if (values.length !== 1) throw new HttpError(400, "query_repeated", { allowed: GRANT_LIST_KEYS });
  }
  let status = e.req.query("status"),
    tenant = e.req.query("tenant");
  if (status !== undefined && !GRANT_STATUSES.includes(status)) throw new HttpError(400, "status_invalid", { allowed: GRANT_STATUSES });
  if (tenant !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw new HttpError(400, "tenant_invalid");
  let limit = wholeParam(e.req.query("limit"), "limit", 1, 1000, 200),
    offset = wholeParam(e.req.query("offset"), "offset", 0, 1e9, 0),
    st = status ?? null,
    tn = tenant ?? null;
  // One snapshot for the page and the count (REPEATABLE READ, READ ONLY): read apart, a grant ended between the two
  // could leave the page and the count telling different stories, and the rule above would miss a skip.
  let [rows, total] = await sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    let page = await tx`SELECT id, tenant, parent, depth, sub, status, caps, budget, reserved, settled, exp, created_at FROM grants
      WHERE (${st}::text IS NULL OR status = ${st}) AND (${tn}::text IS NULL OR tenant = ${tn})
      ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`;
    let n = (await tx`SELECT count(*)::int AS n FROM grants WHERE (${st}::text IS NULL OR status = ${st}) AND (${tn}::text IS NULL OR tenant = ${tn})`)[0].n;
    return [page, n];
  });
  return e.json({
    grants: rows.map((t) => ({
      ...t,
      exp: Number(t.exp),
      remaining: remainingBudget(t),
    })),
    total,
    limit,
    offset,
    status: st,
    tenant: tn,
  });
});
app.get("/api/admin/deploys", requireAdmin, async (e) =>
  e.json({
    deploys:
      await sql`SELECT id, tenant, grant_id, name, template, status, executed, railway_service_id, target, created_at FROM deploys ORDER BY created_at DESC LIMIT 200`,
  }),
);
app.get("/api/admin/ledger", requireAdmin, async (e) =>
  e.json({
    ledger: await sql`SELECT * FROM ledger ORDER BY id DESC LIMIT 300`,
  }),
);
app.get("/api/admin/webhooks", requireAdmin, async (e) =>
  e.json({
    webhooks:
      await sql`SELECT id, source, event_id, type, received_at, handled, result FROM webhook_events ORDER BY id DESC LIMIT 200`,
  }),
);
app.get("/api/admin/events", requireAdmin, async (e) =>
  e.json({
    events: await sql`SELECT * FROM events ORDER BY id DESC LIMIT 300`,
  }),
);
