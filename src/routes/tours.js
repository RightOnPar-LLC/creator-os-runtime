// Routes: tours (src/tours.js, docs/specs/tours.md). The owner opens, reissues, extends and
// ends a tour with the tenant's root grant; the agent renews with the tour's current key.
// `renew` is registered before the `:id` routes on purpose, though no pattern here overlaps.
import { app, readJsonBody, requireGrant } from "../http.js";
import { endTour, extendTour, listTours, openTour, reissueTour, renewTour } from "../tours.js";

app.post("/api/tours", requireGrant("grant.issue"), async (e) => e.json(await openTour(e.get("auth"), await readJsonBody(e)), 201));
app.get("/api/tours", requireGrant("grant.read"), async (e) => e.json({ tours: await listTours(e.get("auth")) }));
// No capability is asked for: holding the tour's current key IS the right to renew it.
app.post("/api/tours/renew", requireGrant(null), async (e) => e.json(await renewTour(e.get("auth")), 201));
app.post("/api/tours/:id/reissue", requireGrant("grant.issue"), async (e) => e.json(await reissueTour(e.get("auth"), e.req.param("id")), 201));
app.post("/api/tours/:id/extend", requireGrant("grant.issue"), async (e) => e.json(await extendTour(e.get("auth"), e.req.param("id"), await readJsonBody(e))));
app.post("/api/tours/:id/end", requireGrant("grant.issue"), async (e) => e.json(await endTour(e.get("auth"), e.req.param("id"))));
