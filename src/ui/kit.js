"use strict";
// Shared by /loop and /card: read-only helpers. Signed out, these pages only show what is public.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const now = () => Date.now();
const ago = (v) => { const t = new Date(v).getTime(); if (!t) return ""; const s = Math.max(0, (now() - t) / 1000); return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d"; };
const NAMES = { cog: "COG", chatgpt: "ChatGPT", codex: "Codex", claude: "Claude", cline: "Cline", frank: "Frank", grok: "Grok", muse: "Muse" };
const cap = (s) => { s = String(s || ""); return NAMES[s.toLowerCase()] || (s ? s[0].toUpperCase() + s.slice(1) : "—"); };
const isCog = (sub) => /^agent:cog(\/|$)/.test(String(sub || ""));
const actionLabel = (a) => ({ deploy: "Deploy a worker?", escrow: "Hold money in escrow?", "market.call": "Pay for a market call?" })[a] || cap(String(a).replace(/[._]/g, " ")) + "?";
// One plain sentence per hallmark; the raw type stays one click away on the runtime's Receipts page.
function say(e) {
  const d = e.data && typeof e.data === "object" ? e.data : {}, t = String(e.type), n = who(e.actor)[0];
  if (t === "cog.plan") return `${n} planned ${d.template ? "a " + d.template : "the next step"}`;
  if (t === "grant.issued") return `${n} handed a warrant${d.sub ? " to " + who(d.sub)[0] : ""}`;
  if (t === "grant.settled") return `${n} settled ${d.calls ? d.calls + " calls" : "its usage"}`;
  if (t === "grant.revoked") return `A warrant was pulled`;
  if (t.startsWith("autonomy.")) return `${n} asked for your OK${d.action ? ": " + d.action : ""}`;
  if (t === "agent.message") return `${n} sent a message`;
  if (t.startsWith("deploy.")) return `${d.name || "A worker"} ${t.slice(7)}`;
  if (t === "runtime.paused") return "The Crown was pulled";
  if (t === "runtime.resumed") return "The movement resumed";
  return `${t} · ${n}`;
}
const live = (g) => g.status === "active" && +g.exp * 1000 > now();
function who(sub) {
  const s = String(sub || "");
  if (s === "tenant:root") return ["World root", "the owner's key"];
  if (s.startsWith("connector:")) return [cap(s.slice(10)), "connector"];
  if (s.startsWith("agent:")) { const [host, role] = s.slice(6).split("/"); return [cap(host), role || "agent"]; }
  if (s.startsWith("guest:")) return ["Guest", "guest door"];
  if (s.startsWith("worker:")) return [cap(s.slice(7)), "worker"];
  const i = s.indexOf(":");
  return i > 0 ? [cap(s.slice(i + 1)), s.slice(0, i)] : [cap(s), ""];
}
const kindOf = (t) => { t = String(t); return /fail|denied|revok|crash|paused/.test(t) ? ["FAILED", "var(--bad)"] : /settle|captur|deployed|done|success|complete|approved|resumed/.test(t) ? ["DONE", "var(--accent)"] : /ask|question|approval|autonomy/.test(t) ? ["QUESTION", "var(--blue)"] : /^cog\.|plan/.test(t) ? ["THOUGHT", "var(--muted)"] : ["HALLMARK", "var(--dim)"]; };
async function readMesh() {
  const pub = (p) => fetch(p, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const get = (p) => fetch(p, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
  const D = { signed: false, health: await pub("/health"), tenants: [], grants: [], approvals: [], events: [] };
  try { await get("/api/admin/overview"); D.signed = true; } catch { return D; }
  const [t, g, a, e] = await Promise.all([get("/api/tenants").catch(() => ({})), get("/api/admin/grants?status=active&limit=1000").catch(() => ({})), get("/api/admin/approvals").catch(() => ({})), get("/api/admin/events").catch(() => ({}))]);
  D.tenants = t.tenants || []; D.grants = (g.grants || []).filter(live); D.approvals = a.approvals || []; D.events = e.events || [];
  return D;
}
