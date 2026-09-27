// Routes: A2A discovery. GET /.well-known/agent.json — PUBLIC, no auth: a stranger agent with
// zero credentials must be able to discover and reason about the network. Registration order is
// significant. The card is generated (src/a2a.js) from the MCP tool registry, never hand-kept.
import { app } from "../http.js";
import { publicBaseUrl } from "../oauth.js";
import { buildAgentCard } from "../a2a.js";

app.get("/.well-known/agent.json", (e) => {
  let card = buildAgentCard(publicBaseUrl(e));
  // Short TTL: the card changes as capabilities ship, so a stale cache would misdescribe the
  // network. application/json per the A2A spec.
  e.header("cache-control", "public, max-age=300");
  return e.json(card);
});
