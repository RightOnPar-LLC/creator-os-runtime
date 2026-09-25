// Routes: cockpit, status page, docs. Registration order is significant.
import { escapeHtml, HttpError } from "../util.js";
import { sql } from "../db.js";
import { app, requireAdmin } from "../http.js";
import { buildStatusReport, getDoc, listDocNames, markdownToHtml, renderPage } from "../cockpit.js";

app.get("/", async (e) => {
  let t = await getDoc("_cockpit");
  return e.html(
    t ||
      renderPage(
        "creator-os-runtime",
        '<h1>creator-os-runtime</h1><div class="card">Cockpit not uploaded yet \u2014 <code>PUT /api/admin/docs/_cockpit</code> with cockpit.html. Machine surface: <a href="/health">/health</a> \xB7 <a href="/routes">/routes</a> \xB7 <a href="/mcp">/mcp</a> \xB7 <a href="/docs">/docs</a></div>',
      ),
  );
});
app.get("/cockpit/:page", (e) => e.redirect(`/#/${e.req.param("page")}`));
app.get("/status.json", async (e) => e.json(await buildStatusReport()));
app.get("/status", async (e) => {
  let t = await buildStatusReport(),
    a = (r, s) => `<span class="dot ${r ? "g" : s ? "p" : "r"}"></span>`,
    n = (r) =>
      `<tr><td>${a(r.ok, r.kind === "parked")}${escapeHtml(r.label)}</td><td class="dim">${r.ok ? "ready" : r.kind === "parked" ? "parked \u2014 not needed yet" : escapeHtml(r.fix)}</td></tr>`;
  return e.html(
    renderPage(
      "Runtime status",
      `<h1>Runtime status</h1><div class="card"><b style="font-size:20px">${t.ok ? a(!0) + "All green" : a(!1) + t.red + " thing" + (t.red > 1 ? "s" : "") + " need you"}</b><div class="dim">v${t.version} \xB7 source ${String(t.source.sha256).slice(0, 12)} \xB7 ${escapeHtml(t.time)} \xB7 <a href="/status.json">json</a> \xB7 <a href="/">cockpit</a></div></div>
<div class="card"><h3>Products</h3><table>${t.bodies.map((r) => `<tr><td>${a(r.up && r.connected !== !1)}<b>${escapeHtml(r.name)}</b><div class="dim">${r.up ? "up \xB7 " + r.ms + " ms" : "down (" + r.code + ")"}</div></td><td>${r.connected === null ? '<span class="dim">no link needed</span>' : r.connected ? "Connected \u2713 <span class=dim>since " + escapeHtml(new Date(r.since).toISOString().slice(0, 10)) + "</span>" : r.connect ? `<a class="btn" href="${r.connect}">Connect ${escapeHtml(r.name)}</a>` : '<span class="dim">Connect button ships with its next deploy</span>'}</td></tr>`).join("")}</table></div>
<div class="card"><h3>Core</h3><table>${t.checks
        .filter((r) => r.kind === "core")
        .map(n)
        .join("")}</table></div>
<div class="card"><h3>Webhooks &amp; sync</h3><table>${t.checks
        .filter((r) => r.kind === "hook")
        .map(n)
        .join("")}</table></div>
<div class="card"><h3>Parked</h3><table>${t.checks
        .filter((r) => r.kind === "parked")
        .map(n)
        .join("")}</table></div>
<p class="dim">No secret values are shown here. Fingerprints for matching keys are on <a href="/health">/health</a>.</p>`,
    ),
  );
});
app.get("/docs", async (e) => {
  let t = (await listDocNames()).filter((a) => !a.startsWith("_"));
  return e.html(
    renderPage(
      "Docs",
      `<a href="/">\u2190 Back to hub</a><h1>Docs</h1><p>Served by the running instance. The deployed instance is the spec.</p><div class="card">${t.map((a) => `<div><a href="/docs/${a}">${a}</a></div>`).join("") || "No docs uploaded yet (PUT /api/admin/docs/:name)."}</div>`,
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
    renderPage(t, `<a href="/docs">\u2190 Back to docs</a><div class="card">${markdownToHtml(a)}</div>`),
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
