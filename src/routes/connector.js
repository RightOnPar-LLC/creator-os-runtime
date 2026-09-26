// Routes: the connector exec switch (0.3.3) -- admin API plus a one-switch page.
// Registration order is significant (imported last, after routes/meta.js).
import { HttpError, nowSec, parseJson } from "../util.js";
import { recordEvent, sql } from "../db.js";
import { app, readJsonBody, requireAdmin } from "../http.js";
import { CONNECTOR_EXEC_CAPS, isConnectorExecOn, OPERATOR_SUB, setConnectorExec } from "../connector.js";
import { renderPage } from "../cockpit.js";

// State plus the live connector grants, so the page can say "on, but the current
// connector grant predates it -- reconnect once to pick the caps up".
async function connectorExecState() {
  let on = await isConnectorExecOn(),
    ops =
      await sql`SELECT id, tenant, caps, exp FROM grants WHERE sub = ${OPERATOR_SUB} AND status = 'active' AND exp > ${nowSec()} ORDER BY created_at DESC LIMIT 50`;
  return {
    on,
    caps: CONNECTOR_EXEC_CAPS,
    operatorGrants: ops.map((g) => {
      let c = parseJson(g.caps) || [];
      return {
        id: g.id,
        tenant: g.tenant,
        exp: Number(g.exp),
        carries: CONNECTOR_EXEC_CAPS.filter((x) => c.includes(x)),
      };
    }),
  };
}
app.get("/api/admin/connector-exec", requireAdmin, async (e) => e.json(await connectorExecState()));
app.post("/api/admin/connector-exec", requireAdmin, async (e) => {
  let t = await readJsonBody(e);
  if (typeof t.on !== "boolean") throw new HttpError(400, "on_must_be_boolean");
  await setConnectorExec(t.on);
  await recordEvent(t.on ? "connector_exec.on" : "connector_exec.off", { caps: CONNECTOR_EXEC_CAPS }, null, "admin");
  return e.json(await connectorExecState());
});
// The page is static; every piece of state comes from the admin API above, with the
// admin key held in this tab only (same pattern as the connector approval page).
var PAGE = `<h1>Connector exec</h1>
<div class="card"><p>Lets the claude.ai connector (<code>${OPERATOR_SUB}</code>) use <code>${CONNECTOR_EXEC_CAPS.join("</code> + <code>")}</code>.</p>
<p><b>Off</b> removes both from the connector, and from anything it minted, on the very next call. <b>On</b> puts them on the connector's next sign-in, so reconnect it once after turning on.</p></div>
<div class="card" id="unlock" hidden><p>Unlock with the admin key (stays in this tab).</p><input id="k" type="password" style="width:100%"><button id="u">Unlock</button></div>
<div class="card" id="panel" hidden><p style="font-size:20px"><b id="state">\u2026</b></p><p><button id="flip">\u2026</button></p><p id="msg" class="dim"></p><h3>Connector grants</h3><table id="g"></table></div>
<script>const $=i=>document.getElementById(i);let K=sessionStorage.getItem("cos_admin"),S=null;
async function api(p,o={}){const r=await fetch(p,{...o,headers:{"content-type":"application/json",authorization:"Bearer "+K}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
function show(j){S=j;$("state").textContent=j.on?"ON \\u2014 connector can plan and execute":"OFF \\u2014 connector can plan only";$("flip").textContent=j.on?"Turn off":"Turn on";$("g").innerHTML=j.operatorGrants.map(g=>"<tr><td><code>"+g.id+"</code></td><td>"+g.tenant+"</td><td>"+(g.carries.length?g.carries.join(", "):(j.on?"reconnect to pick up":"\\u2014"))+"</td></tr>").join("")||"<tr><td class=dim>no active connector grants</td></tr>";$("unlock").hidden=true;$("panel").hidden=false}
async function load(){try{show(await api("/api/admin/connector-exec"))}catch(e){$("unlock").hidden=false;$("panel").hidden=true}}
$("u").onclick=()=>{K=$("k").value.trim();$("k").value="";sessionStorage.setItem("cos_admin",K);load()};
$("flip").onclick=async()=>{$("flip").disabled=true;try{show(await api("/api/admin/connector-exec",{method:"POST",body:JSON.stringify({on:!S.on})}));$("msg").textContent="Saved."}catch(e){$("msg").textContent="Failed: "+e.message}$("flip").disabled=false};
K?load():$("unlock").hidden=false;</script>`;
app.get("/admin/connector", (e) => e.html(renderPage("Connector exec", PAGE)));
