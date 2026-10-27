// Routes: two-sided market MVP.
import { HttpError } from "../util.js";
import { app, readJsonBody, requireGrant } from "../http.js";
import { listCapability, discoverCapabilities, callCapability } from "../market.js";

// List a capability (provider advertises)
app.post("/api/market/list", requireGrant(null), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let r = await listCapability(t.row, a);
  return e.json(r, 201);
});

// Discover capabilities (no auth needed — public registry)
app.get("/api/market/discover", async (e) => {
  let q = { limit: e.req.query("limit"), search: e.req.query("q") };
  let results = await discoverCapabilities(q);
  return e.json({ capabilities: results });
});

// Call a capability (open escrow to provider)
app.post("/api/market/call", requireGrant("escrow.hold"), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let r = await callCapability(t.row, a);
  return e.json({ escrow: r }, 201);
});
