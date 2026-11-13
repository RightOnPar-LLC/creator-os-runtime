// Routes: seat mint (src/seats.js holds the steps). Registered right after the identity routes.
//
//   POST /api/admin/seats/mint   one call: claim the payment, open the seat's tour, seat the agent,
//                                write SOUL.md / MEMORY.md / MATRIX.md, receipt. {dryRun: true} writes nothing.
//                                Body: {tenant, name, sponsor, owner?, purpose?, blueprint?, attestEveryDays?,
//                                expiresAt?, days, caps, budget, scope?, constraints?, soul?,
//                                payment: {rail, ref, usd_cents}}  (rail "house" needs no ref or amount)
//   GET  /api/admin/seats/mints  the mint record, newest first (?tenant= to narrow)
//
// Admin-only for now: the owner (or the owner's payment hook, through the owner) mints. A paid
// self-serve mint from PayRail rides behind a plan cheque in a later change, not here.
import { app, readJsonBody, requireAdmin } from "../http.js";
import { listMints, mintSeat } from "../seats.js";

app.post("/api/admin/seats/mint", requireAdmin, async (e) => {
  let r = await mintSeat(await readJsonBody(e));
  return e.json(r.body, r.status);
});
app.get("/api/admin/seats/mints", requireAdmin, async (e) => e.json({ mints: await listMints(e.req.query("tenant") || null) }));
