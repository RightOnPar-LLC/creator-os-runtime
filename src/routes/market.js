// Routes: two-sided market MVP.
import { HttpError, newId, parseJson } from "../util.js";
import { recordEvent, sql } from "../db.js";
import { app, readJsonBody, requireGrant } from "../http.js";
import { listCapability, discoverCapabilities, resolveCall } from "../market.js";
import { buildEscrow, openEscrow, serializeEscrow } from "../escrow.js";
import { recordAutonomyRow } from "../grants.js";
import { autonomyOf, decide } from "../autonomy.js";

// List a capability (provider advertises)
app.post("/api/market/list", requireGrant(null), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  let r = await listCapability(t.row, a);
  return e.json(r, 201);
});

// Discover capabilities (no auth needed — public registry)
app.get("/api/market/discover", async (e) => {
  let q = { limit: e.req.query("limit"), search: e.req.query("q") };
  let results = await discoverCapabilities(q);
  return e.json({ capabilities: results });
});

// Call a capability = open an escrow to its provider, on the listing's terms. The same door as
// POST /api/escrow: the dial decides (refuse / ask / act) BEFORE any value is held, and an "ask"
// files an approval carrying the resolved terms for the owner, who opens it with POST
// /api/approvals/:id exactly as for a direct escrow.
app.post("/api/market/call", requireGrant("escrow.hold"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  let terms = await resolveCall(t.row, a);
  buildEscrow(t.row, terms, t.tenant.tier); // validate first: never ask a human about a request that would be refused
  let dial = decide(autonomyOf(parseJson(t.row.constraints)), "escrow.open");
  if (dial.decision === "refuse") {
    await recordAutonomyRow(t.row, "autonomy-refused", "escrow", `market call refused at autonomy ${dial.levelName}`, {
      autonomy: dial.level,
      decision: "refuse",
    });
    throw new HttpError(403, dial.reason, { autonomy: dial.levelName });
  }
  if (dial.decision === "ask") {
    let ap = newId("ap");
    await sql`INSERT INTO approvals (id, tenant, grant_id, action, intent, autonomy, requested_by)
      VALUES (${ap}, ${t.tenant.id}, ${t.row.id}, 'escrow.open', ${terms}::jsonb, ${dial.level}, ${t.row.sub})`;
    await recordAutonomyRow(t.row, "autonomy-ask", ap, "market call awaits the owner's approval", {
      autonomy: dial.level,
      decision: "ask",
    });
    await recordEvent("autonomy.ask", { action: "escrow.open", approval: ap, level: dial.levelName, market: terms.payee_ref }, t.tenant.id, t.row.sub);
    return e.json({ status: "awaiting_approval", approval: { id: ap, action: "escrow.open", approve: `POST /api/approvals/${ap}` } }, 202);
  }
  let r = await openEscrow(t.row, terms, t.row.sub);
  return e.json({ escrow: serializeEscrow(r.row), token: r.token }, 201);
});
