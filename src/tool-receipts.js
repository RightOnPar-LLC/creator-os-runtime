// Runtime-observed MCP invocations. A start commits BEFORE the handler runs;
// completion is awaited before a successful response is returned. An interrupted
// process leaves "started", never an invented success. These are not client claims.
import { sql } from "./db.js";
import { HttpError, newId } from "./util.js";
import { checkNamedRateLimit } from "./grants.js";

const DENIALS = new Set(["missing_grant", "bad_grant", "grant_expired", "grant_revoked",
  "tenant_suspended", "runtime_paused", "missing_cap", "out_of_scope", "rate_limited",
  "verification_error", "gatehouse_denied", "autonomy_observe", "owner_approval_required"]);
// Persist only a closed vocabulary: an upstream error string can contain a secret.
export function receiptOutcome(status, body, toolErrorStatus = status) {
  let failure = body?.error != null || body?.result?.isError === true || status >= 400;
  let code = typeof body?.error === "string" ? body.error : null;
  if (body?.result?.isError) {
    try { code = JSON.parse(body.result.content?.[0]?.text).error; } catch {}
  }
  if (failure) return { outcome: [401, 402, 403, 429].includes(toolErrorStatus) || DENIALS.has(code) ? "denied" : "failed",
    reason: DENIALS.has(code) ? code : "tool_error" };
  const result = body?.result?.structuredContent ?? body;
  if (result?.pendingApproval || result?.approval || result?.status === "pending")
    return { outcome: "pending_approval", reason: null };
  if (result?.executed === false || result?.status === "approved_not_run" || result?.result?.executed === false) return { outcome: "not_run", reason: null };
  return { outcome: "succeeded", reason: null };
}

export async function bindToolReceipt(c, auth, authorized = false, kind = "grant") {
  const id = c.get("toolReceiptId");
  if (!id) return;
  const decision = authorized ? "authorized" : "verified_identity";
  try {
    if (!c.get("toolReceiptStarted")) {
      const saved = await sql`INSERT INTO tool_receipts (id, tool, tenant, grant_id, authority_kind, auth_decision)
        VALUES (${id}, ${c.get("toolReceiptOperation")}, ${auth?.tenant.id ?? null}, ${auth?.row.id ?? null}, ${kind}, ${decision}) RETURNING id`;
      if (saved.length !== 1) throw new Error("receipt start not saved");
      c.set("toolReceiptStarted", true);
    } else {
      const saved = await sql`UPDATE tool_receipts SET tenant = ${auth?.tenant.id ?? null}, grant_id = ${auth?.row.id ?? null},
        authority_kind = ${kind}, auth_decision = ${decision} WHERE id = ${id} AND outcome = 'started' RETURNING id`;
      if (saved.length !== 1) throw new Error("receipt authority not saved");
    }
  } catch {
    c.set("toolReceiptStorageFailed", true);
    throw new HttpError(503, "receipt_unavailable");
  }
  c.set("toolReceiptAuth", auth);
  c.set("toolReceiptAuthorized", authorized);
}

// The guest bootstrap is the one public tool execution. Bound its receipt starts
// across replicas BEFORE it can mint; floods cannot bypass the meter with fake IPs.
export async function bindPublicToolReceipt(c) {
  if (!(await checkNamedRateLimit("tool-receipts:public-guest", 120)))
    throw new HttpError(429, "rate_limited");
  await bindToolReceipt(c, null, true, "public_guest_policy");
}

// The shared boundary is also used by authenticated HTTP tool routes. The
// operation name comes from registered route templates, never the raw URL.
export function apiReceiptMiddleware(routes) {
  return async (c, next) => {
    if (c.req.path === "/api/tool-receipts" || c.req.path === "/api/admin/tool-receipts") return next();
    const dispatchedMethod = c.req.method === "HEAD" ? "GET" : c.req.method;
    const route = routes().find((r) => r.method === dispatchedMethod && (r.path.startsWith("/api/") || r.path === "/auth/railway/start") &&
      (r.handler?.auth === "admin" || r.handler?.auth?.startsWith("grant")) &&
      new RegExp("^" + r.path.split("/").map((p) => p.startsWith(":") ? "[^/]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "$").test(c.req.path));
    if (!route) return next();
    return recordInvocation(c, next, `${c.req.method} ${route.path}`);
  };
}

export function toolReceiptMiddleware(knownTools) {
  const known = new Set(knownTools);
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    let request;
    try { request = await c.req.json(); } catch { return next(); }
    if (request?.method !== "tools/call") return next();
    return recordInvocation(c, next, known.has(request.params?.name) ? request.params.name : "unknown");
  };
}

async function recordInvocation(c, next, tool) {
    const id = newId("tr");
    c.set("toolReceiptId", id);
    c.set("toolReceiptOperation", tool);
    // Authentication creates the start via bindToolReceipt before its handler
    // runs. Rejected credentials never get a per-request row: the global minute
    // summary below is bounded independently of attacker-supplied identities/IPs.
    await next();
    if (c.get("toolReceiptStorageFailed")) {
      c.res = c.json({ error: "receipt_unavailable", executed: false }, 503);
      return;
    }
    if (!c.get("toolReceiptStarted")) {
      const summaryId = `tr_rejected_${Math.floor(Date.now() / 60000)}`;
      try {
        await sql`INSERT INTO tool_receipts (id, tool, record_kind, auth_decision, outcome, finished_at, reason)
          VALUES (${summaryId}, 'authentication_rejected', 'rejection_summary', 'denied', 'denied', now(), 'authentication_rejected')
          ON CONFLICT (id) DO UPDATE SET attempts = tool_receipts.attempts + 1, finished_at = now()`;
        c.header("X-Runtime-Receipt", summaryId);
      } catch { /* original denial remains a denial; no handler ran */ }
      return;
    }
    let body;
    try { body = await c.res.clone().json(); } catch {}
    const result = receiptOutcome(c.res.status, body, c.get("toolReceiptErrorStatus") ?? c.res.status);
    const authorization = result.outcome !== "denied" && c.get("toolReceiptAuthorized") === true ? "authorized" : "denied";
    try {
      const saved = await sql`UPDATE tool_receipts SET finished_at = now(), auth_decision = ${authorization}, outcome = ${result.outcome},
        http_status = ${c.res.status}, reason = ${result.reason} WHERE id = ${id} AND outcome = 'started' RETURNING id`;
      if (saved.length !== 1) throw new Error("receipt completion not saved");
    } catch {
      c.res = c.json({ error: "receipt_completion_unavailable", receipt_id: id, execution: "unknown", retry_safe: false }, 503);
    }
    c.header("X-Runtime-Receipt", id);
}

export async function readToolReceipts(auth, limit = 50) {
  const n = Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 50));
  return sql`WITH RECURSIVE sub AS (
    SELECT id FROM grants WHERE id = ${auth.row.id}
    UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
    SELECT * FROM tool_receipts WHERE tenant = ${auth.tenant.id} AND grant_id IN (SELECT id FROM sub)
    ORDER BY started_at DESC, id DESC LIMIT ${n}`;
}
