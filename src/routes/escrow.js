// Routes: escrow keystone (stage 1). POST /api/escrow opens a custodian hold (reserve on the
// payer); GET /api/escrow/:id reads its state. Refund-on-deadline is the reaper's job — no route.
// Capture is stage 2 and is condition-driven, never a party-callable free action. Registration
// order is significant.
import { HttpError } from "../util.js";
import { getGrant } from "../db.js";
import { app, readJsonBody, requireGrant } from "../http.js";
import { escrowBlock, openEscrow, serializeEscrow } from "../escrow.js";

// escrow.hold is the capability to open an escrow (and the custodian's only, no-op, cap). A
// grant without it is refused by requireGrant with 403 — the payer must hold escrow.hold.
app.post("/api/escrow", requireGrant("escrow.hold"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e),
    r = await openEscrow(t.row, a, t.row.sub);
  return e.json({ escrow: serializeEscrow(r.row), token: r.token }, 201);
});

app.get("/api/escrow/:id", requireGrant("grant.read"), async (e) => {
  let t = e.get("auth"),
    g = await getGrant(e.req.param("id"));
  if (!g || g.tenant !== t.tenant.id) throw new HttpError(404, "escrow_not_found");
  if (!escrowBlock(g)) throw new HttpError(404, "not_escrow"); // a plain grant is not an escrow
  return e.json({ escrow: serializeEscrow(g) });
});
