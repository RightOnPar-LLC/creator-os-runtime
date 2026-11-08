// Routes: cockpit, status page, docs. Registration order is significant.
import { escapeHtml, HttpError } from "../util.js";
import { sql } from "../db.js";
import { app, requireAdmin } from "../http.js";
import { buildStatusReport, getDoc, listDocNames, markdownToHtml, renderPage } from "../cockpit.js";
import { PAGE_HEADERS, PAGES } from "../ui/pages.js";

// The human pages ship in the bundle (src/ui). The old cockpit was a database doc (`_cockpit`) that drifted from
// the repo; "/" no longer reads it (DW, 2026-10-30: out with the old, in with the new).
const page = (name) => (e) => {
  for (const [k, v] of Object.entries(PAGE_HEADERS)) e.header(k, v);
  return e.html(PAGES[name]);
};
app.get("/", page("runtime"));
app.get("/loop", page("loop"));
app.get("/card", page("card"));
app.get("/invite", page("invite"));
// Old cockpit links (/cockpit/grants, /#/tenants …) still land: the Runtime Browser maps the old page names.
app.get("/cockpit/:page", (e) => e.redirect(`/#/${encodeURIComponent(e.req.param("page"))}`));
app.get("/status.json", async (e) => e.json(await buildStatusReport()));
const CONNECTION_STATUS = {
  not_required: ["No account link needed", "The gateway health check is separate from individual agent sign-in."],
  unknown: ["Connection unverified", "Runtime could not read saved approvals."],
  consent_saved: ["Approval saved", "Runtime found a current consent record. This page does not run a test action."],
  needs_consent: ["Approval needed", "Connect opens the owner approval flow."],
  entry_unreachable: ["Connection page unavailable", "Runtime could not reach the connection flow."],
  setup_unavailable: ["Connect flow unavailable", "No current approval is recorded and there is no Connect button for this product."],
};
const CHECK_DETAIL = {
  db: "Stores workspaces, access grants and activity.",
  kill: "The emergency stop blocks agent actions when it is on.",
  admin: "Protects the owner dashboard and approval controls.",
  vault: "Encrypts credentials stored by Runtime.",
  railway: "Lets Runtime request deployments through Railway.",
  github: "Accepts signed events from GitHub.",
  railwayWebhook: "Accepts signed deployment events from Railway.",
  mesh: "Accepts signed receipts. This is separate from linking a MeshMarket account.",
  brain: "Accepts signed events from the planning service.",
  sync: "Lets Cognitive-MCP pull permitted memory changes.",
  stripe: "Accepts signed payment events when enabled.",
  railwayOAuth: "Lets owners authorize Railway access.",
  brainOut: "Sends events to the planning service when enabled.",
  cognitiveBridge: "Pushes permitted memory changes to Cognitive-MCP when enabled.",
};
function statusCheck(check, paused) {
  let state = check.ok ? "Configured" : check.kind === "parked" ? "Optional · off" : "Needs setup";
  let detail = CHECK_DETAIL[check.key];
  let action = "";
  if (check.key === "mesh" && check.ok) {
    state = check.deliverySeen ? "Delivery recorded" : "Configured";
    if (check.deliverySeen === false) detail += " Runtime has no handled receipt on record.";
    if (check.deliverySeen === null) detail += " Runtime could not check receipt history.";
  }
  if (check.key === "db") state = check.ok ? "Responding" : "Unavailable";
  if (check.key === "kill") {
    state = paused === null ? "Could not check" : paused ? "Paused" : "Emergency stop is off";
    if (paused) action = '<br><a href="/#/guardrails">Review the emergency stop</a>';
  }
  if (check.key === "cogPlanner") {
    state = check.providers.length ? "AI providers configured" : "Built-in planning available";
    detail = check.providers.length
      ? `${check.providers.join(" → ")}. Runtime tries these in order and can fall back to its built-in planner. This page does not make a model call.`
      : "Runtime uses its built-in planner. An AI provider can be added for model-assisted plans.";
  }
  return `<tr><th scope="row">${escapeHtml(check.label)}</th><td><b>${escapeHtml(state)}</b><br>${escapeHtml(detail)}${action}</td></tr>`;
}
function statusProduct(body) {
  const [state, detail] = CONNECTION_STATUS[body.connection];
  const action = body.connection === "needs_consent" && body.connect
    ? ` <a class="btn" href="${escapeHtml(body.connect)}">Connect ${escapeHtml(body.name)}</a>` : "";
  return `<tr><th scope="row">${escapeHtml(body.profile === null ? "AI app gateway" : body.name)}</th>
    <td><b>${body.up ? "Responding" : "Could not reach service"}</b>${body.up ? ` · ${body.ms} ms` : ""}</td>
    <td><b>${escapeHtml(state)}</b><br>${escapeHtml(detail)}${action}</td></tr>`;
}
app.get("/status", async (e) => {
  const report = await buildStatusReport();
  const headline = !report.available ? "Runtime has a database problem" : report.paused === true ? "Runtime is paused" :
    report.paused === null ? "Runtime is responding · agent activity unverified" : "Runtime is responding";
  const checks = (kind) => report.checks.filter((check) => check.kind === kind).map((check) => statusCheck(check, report.paused)).join("");
  const unreachable = report.bodies.filter((body) => !body.up).length;
  const connections = report.bodies.filter((body) => body.profile && body.connected !== true).length;
  const setup = report.checks.filter((check) => !["db", "kill"].includes(check.key) && check.kind !== "parked" && !check.ok).length;
  const summary = [
    unreachable ? `${unreachable} linked service${unreachable === 1 ? "" : "s"} could not be reached` : "",
    connections ? `${connections} account connection${connections === 1 ? "" : "s"} to review` : "",
    setup ? `${setup} Runtime setup item${setup === 1 ? "" : "s"} to review` : "",
  ].filter(Boolean);
  return e.html(renderPage("Runtime status", `
    <h1>Runtime status</h1>
    <p>See what is responding, what has permission to connect, and what needs setup.</p>
    <section class="card" aria-labelledby="runtime-summary">
      <h2 id="runtime-summary">${headline}</h2>
      <p>${summary.length ? summary.join(" · ") : "These checks found no linked-service or setup issues."}</p>
      <p class="dim">Checked <time datetime="${escapeHtml(report.time)}">${escapeHtml(report.time.slice(0, 16).replace("T", " "))} UTC</time>. Checks refresh about once a minute.</p>
      <a href="/#/grants">Who has access?</a> · <a href="/#/receipts">See recorded activity</a>
    </section>
    <section class="card" aria-labelledby="runtime-products"><h2 id="runtime-products">Linked services</h2>
      <p>Service health tells you whether a product answers. Account connection tells you whether Runtime has a saved approval.</p>
      <table><thead><tr><th scope="col">Service</th><th scope="col">Service health</th><th scope="col">Account connection</th></tr></thead>
      <tbody>${report.bodies.map(statusProduct).join("")}</tbody></table></section>
    <section class="card" aria-labelledby="runtime-core"><h2 id="runtime-core">What Runtime can do</h2><table><tbody>${checks("core")}</tbody></table></section>
    <section class="card" aria-labelledby="runtime-events"><h2 id="runtime-events">Activity and memory connections</h2>
      <p>Configured means the connection is set up. Review receipts to confirm individual deliveries.</p>
      <table><tbody>${checks("hook")}</tbody></table></section>
    <details class="card"><summary>Optional features</summary><table><tbody>${checks("parked")}</tbody></table></details>
    <details class="card"><summary>Technical details</summary><p>Version ${escapeHtml(report.version)} · Build ${escapeHtml(String(report.source.sha256).slice(0, 12))} · <a href="/status.json">Status data (JSON)</a></p></details>
  `));
});
app.get("/docs", async (e) => {
  let t = (await listDocNames()).filter((a) => !a.startsWith("_"));
  return e.html(
    renderPage(
      "Docs",
      `<a href="/">← Back to the runtime</a><h1>Docs</h1><p>Served by the running instance. The deployed instance is the spec.</p><div class="card">${t.map((a) => `<div><a href="/docs/${a}">${a}</a></div>`).join("") || "No docs uploaded yet (PUT /api/admin/docs/:name)."}</div>`,
    ),
  );
});
app.get("/docs/:name", async (e) => {
  let t = e.req.param("name"),
    a = t.startsWith("_") ? null : await getDoc(t);
  if (a === null) return e.notFound();
  if ((e.req.header("accept") || "").includes("text/markdown") || e.req.query("raw") !== void 0)
    return e.text(a);
  return e.html(
    renderPage(t, `<a href="/docs">← Back to docs</a><div class="card">${markdownToHtml(a)}</div>`),
  );
});
app.put("/api/admin/docs/:name", requireAdmin, async (e) => {
  let t = e.req.param("name");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(t)) throw new HttpError(400, "bad_doc_name");
  let a = await e.req.text();
  if (!a.trim()) throw new HttpError(400, "empty_doc");
  return (
    await sql`INSERT INTO docs (name, content, updated_at) VALUES (${t}, ${a}, now()) ON CONFLICT (name) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
    e.json({
      ok: !0,
      name: t,
      bytes: Buffer.byteLength(a),
    })
  );
});
