// Routes: admin: tenants, kill switch, policy, breakglass, grants, read-only tables. Registration order is significant.
import { armedIntegrations, POLICY_VERSION, RATE_LIMIT_MAX_PER_MIN } from "../config.js";
import { escapeHtml, HttpError, newId, parseJson } from "../util.js";
import { getGrant, getTenant, isKillSwitchOn, recordEvent, setSetting, sql } from "../db.js";
import { reissueGrantToken } from "../tokens.js";
import { CAPS, remainingBudget, TIERS } from "../policy.js";
import { mintRootGrant, revokeGrantTree } from "../grants.js";
import { TEMPLATES } from "../railway.js";
import { app, readJsonBody, requireAdmin } from "../http.js";
import { isOperatorExecOn, OPERATOR_EXEC_CAPS, OPERATOR_EXEC_SETTING, OPERATOR_SUB } from "../operator.js";
import { renderPage } from "../cockpit.js";

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
app.post("/api/admin/grants/:id/revoke", requireAdmin, async (e) =>
  e.json({
    revoked: await revokeGrantTree(
      e.req.param("id"),
      String((await readJsonBody(e)).reason || "admin"),
      "admin",
    ),
  }),
);
app.post("/api/admin/grants/:id/token", requireAdmin, async (e) => {
  let t = await getGrant(e.req.param("id"));
  if (!t || t.status !== "active") throw new HttpError(404, "grant_not_active");
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
  return e.json({
    tenants: t,
    grants: a,
    deploys: n,
    webhooks: r,
    ledger: s,
    killSwitch: await isKillSwitchOn(),
    armed: armedIntegrations(),
  });
});
app.get("/api/admin/grants", requireAdmin, async (e) =>
  e.json({
    grants: (
      await sql`SELECT id, tenant, parent, depth, sub, status, caps, budget, reserved, settled, exp, created_at FROM grants ORDER BY created_at DESC LIMIT 200`
    ).map((t) => ({
      ...t,
      exp: Number(t.exp),
      remaining: remainingBudget(t),
    })),
  }),
);
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
// 0.3.3: operator exec toggle. Default off (setting absent). On: the claude.ai
// connector's operator profile is issued cog.execute + lsp.diagnose on its next
// approval. Off: every active operator grant carrying either cap is revoked (tree),
// so the connector must re-approve and gets the base caps again.
var activeOperatorExecGrants = async () =>
  (await sql`SELECT id, caps FROM grants WHERE sub = ${OPERATOR_SUB} AND status = 'active'`)
    .filter((e) => parseJson(e.caps).some((t) => OPERATOR_EXEC_CAPS.includes(t)))
    .map((e) => e.id);
app.get("/api/admin/operator-exec", requireAdmin, async (e) =>
  e.json({
    on: await isOperatorExecOn(),
    caps: OPERATOR_EXEC_CAPS,
    activeOperatorGrants: (await activeOperatorExecGrants()).length,
  }),
);
app.post("/api/admin/operator-exec", requireAdmin, async (e) => {
  let t = await readJsonBody(e);
  if (!t || typeof t !== "object" || typeof t.on !== "boolean") throw new HttpError(400, "bad_request");
  await setSetting(OPERATOR_EXEC_SETTING, t.on ? "on" : "off");
  if (t.on)
    return (
      await recordEvent("operator_exec.on", { caps: OPERATOR_EXEC_CAPS }, null, "admin"),
      e.json({
        on: !0,
        caps: OPERATOR_EXEC_CAPS,
      })
    );
  let a = [];
  for (let n of await activeOperatorExecGrants())
    for (let r of await revokeGrantTree(n, "operator_exec_off", "admin")) if (!a.includes(r)) a.push(r);
  return (
    await recordEvent("operator_exec.off", { revoked: a }, null, "admin"),
    e.json({
      on: !1,
      revoked: a,
    })
  );
});
// The page is a static shell (no state rendered server-side); its data comes from the
// admin API above with the admin key held in this tab's sessionStorage, as on the
// OAuth approve page.
app.get("/admin/operator", (e) =>
  e.html(
    renderPage(
      "Operator exec",
      `<h1>Operator exec</h1><div class="card"><p>Lets the claude.ai connector (<code>${escapeHtml(OPERATOR_SUB)}</code>) also get <code>${escapeHtml(OPERATOR_EXEC_CAPS.join(", "))}</code> on its next approval. Default off. Turning it off revokes every active operator grant carrying them; the connector then re-approves with the base caps.</p></div>
<div class="card" id="unlock" hidden><p>Unlock with the admin key (stays in this tab).</p><input id="k" type="password" style="width:100%"><button id="u">Unlock</button></div>
<div class="card" id="go" hidden><p><b id="st"></b></p><p class="dim" id="n"></p><p><button id="tg"></button></p><p id="msg"></p></div>
<script>const $=i=>document.getElementById(i);let K=sessionStorage.getItem("cos_admin"),S=null;
async function api(p,o={}){const r=await fetch(p,{...o,headers:{"content-type":"application/json",authorization:"Bearer "+K}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
function show(j){S=j;$("st").textContent=j.on?"ON: operator connector gets "+j.caps.join(", "):"OFF: operator connector gets base caps only";$("n").textContent=j.activeOperatorGrants+" active operator grant(s) carry these caps";$("tg").textContent=j.on?"Turn off":"Turn on";$("unlock").hidden=true;$("go").hidden=false}
async function load(){try{show(await api("/api/admin/operator-exec"))}catch(e){$("unlock").hidden=false;$("go").hidden=true}}
$("u").onclick=()=>{K=$("k").value.trim();$("k").value="";sessionStorage.setItem("cos_admin",K);load()};
$("tg").onclick=async()=>{$("tg").disabled=true;$("msg").textContent="";try{const j=await api("/api/admin/operator-exec",{method:"POST",body:JSON.stringify({on:!S.on})});await load();$("msg").textContent=j.on?"Turned on.":"Turned off; revoked "+j.revoked.length+" grant(s)."}catch(e){$("msg").textContent="Failed: "+e.message}$("tg").disabled=false};
K?load():$("unlock").hidden=false;</script>`,
    ),
  ),
);
