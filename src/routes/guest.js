// Routes: the keyless guest front door (guest-welcome Phase 1, step 2).
// POST /api/guest is PUBLIC on purpose — a visitor has no grant yet; this is
// where it gets one. It is the HTTP bootstrap for MCP too: /mcp requires a
// grant, so an agent calls this first, then uses the returned token there.
// (The keyless guest_welcome MCP method reorders the /mcp auth gate, so it
// rides with the step-4 senior-gate review, not this step.)
import { HttpError } from "../util.js";
import { isKillSwitchOn } from "../db.js";
import { app, readJsonBody } from "../http.js";
import { publicBaseUrl } from "../oauth.js";
import { directory, issueGuestGrant, welcomePackage } from "../guest.js";

// The public capability shopfront + house rules. No grant needed — this is what
// a guest reads to decide what to buy, and where the welcome package's
// `directory` / `house_rules` URLs point. Read-only.
app.get("/directory", async (e) => e.json(await directory(publicBaseUrl(e))));

app.post("/api/guest", async (e) => {
  if (await isKillSwitchOn()) throw new HttpError(503, "runtime_paused");
  // input is optional (agent_name, home_url); a bodyless POST is valid.
  let a = {};
  try {
    a = (await readJsonBody(e)) || {};
  } catch {
    a = {};
  }
  if (typeof a !== "object" || Array.isArray(a)) throw new HttpError(400, "bad_body");
  let r = await issueGuestGrant({ agentName: a.agent_name, homeUrl: a.home_url });
  return e.json(welcomePackage(r.row, r.token, publicBaseUrl(e)), 201);
});
