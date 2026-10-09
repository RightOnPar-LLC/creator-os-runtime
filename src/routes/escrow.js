// Routes: escrow keystone (stage 1). POST /api/escrow opens a custodian hold (reserve on the
// payer); GET /api/escrow/:id reads its state. Refund-on-deadline is the reaper's job — no route.
// Capture is stage 2 and is condition-driven, never a party-callable free action. Registration
// order is significant.
import { HttpError, newId, parseJson } from "../util.js";
import { getGrant, recordEvent, sql } from "../db.js";
import { app, readJsonBody, requireGrant } from "../http.js";
import { buildEscrow, escrowBlock, openEscrow, serializeEscrow } from "../escrow.js";
import { recordAutonomyRow } from "../grants.js";
import { autonomyOf, decide } from "../autonomy.js";

// escrow.hold is the capability to open an escrow (and the custodian's only, no-op, cap). A
// grant without it is refused by requireGrant with 403 — the payer must hold escrow.hold.
app.post("/api/escrow", requireGrant("escrow.hold"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  // The autonomy dial: validate first (buildEscrow throws on a bad escrow), so a human is
  // never asked about a request buildEscrow refuses. Limits that belong to the key itself
  // (depth, budget left) are still only checked when the hold is issued.
  buildEscrow(t.row, a, t.tenant.tier);
  let dial = decide(autonomyOf(parseJson(t.row.constraints)), "escrow.open");
  if (dial.decision === "refuse") {
    await recordAutonomyRow(t.row, "autonomy-refused", "escrow", `escrow open refused at autonomy ${dial.levelName}`, {
      autonomy: dial.level,
      decision: "refuse",
    });
    throw new HttpError(403, dial.reason, { autonomy: dial.levelName });
  }
  if (dial.decision === "ask") {
    let ap = newId("ap");
    await sql`INSERT INTO approvals (id, tenant, grant_id, action, intent, autonomy, requested_by)
      VALUES (${ap}, ${t.tenant.id}, ${t.row.id}, 'escrow.open', ${a}::jsonb, ${dial.level}, ${t.row.sub})`;
    await recordAutonomyRow(t.row, "autonomy-ask", ap, "escrow open awaits the owner's approval", {
      autonomy: dial.level,
      decision: "ask",
    });
    await recordEvent("autonomy.ask", { action: "escrow.open", approval: ap, level: dial.levelName }, t.tenant.id, t.row.sub);
    return e.json({ status: "awaiting_approval", approval: { id: ap, action: "escrow.open", approve: `POST /api/approvals/${ap}` } }, 202);
  }
  let r = await openEscrow(t.row, a, t.row.sub);
  return e.json({ escrow: serializeEscrow(r.row), token: r.token }, 201);
});

app.get("/api/escrow/:id", requireGrant("grant.read"), async (e) => {
  let t = e.get("auth"),
    g = await getGrant(e.req.param("id"));
  if (!g || g.tenant !== t.tenant.id) throw new HttpError(404, "escrow_not_found");
  if (!escrowBlock(g)) throw new HttpError(404, "not_escrow"); // a plain grant is not an escrow
  return e.json({ escrow: serializeEscrow(g) });
});
