// creator-os-runtime entry point. Imports every module, registers the routes in their
// original order (one module per segment, imported in sequence below), then boots:
// source hash, schema migration, grant signing key, kill-switch default, banner.
// Production runs the single bundled file built from here (see src/README.md).
import { armedIntegrations, env, POLICY_VERSION, SERVICE_NAME, VERSION } from "./config.js";
import { getSetting, migrateSchema, setSetting } from "./db.js";
import { loadGrantSigningKey } from "./tokens.js";
import { attenuationViolations, CAPS, gatehouseEvaluate, TIERS } from "./policy.js";
import { TEMPLATES } from "./railway.js";
import { app, recordSource } from "./http.js";
import "./routes/core.js";
import "./routes/admin.js";
import "./routes/grants.js";
import "./routes/memory.js";
import "./routes/railway-auth.js";
import "./routes/webhooks.js";
import "./routes/mcp.js";
import "./routes/oauth.js";
import "./routes/cockpit.js";
import "./routes/meta.js";

try {
  recordSource(await Bun.file(import.meta.path).text());
} catch {}
await migrateSchema();
var signingKeySource = await loadGrantSigningKey();
if (!(await getSetting("kill_switch"))) await setSetting("kill_switch", "off");
console.log(
  `[${SERVICE_NAME} v${VERSION}] policy=${POLICY_VERSION} signingKey=${signingKeySource} armed=${JSON.stringify(armedIntegrations())}`,
);
var LISTEN_PORT = Number(env.PORT || 3000);
var serverConfig = {
  port: LISTEN_PORT,
  fetch: app.fetch,
};
export {
  gatehouseEvaluate,
  serverConfig as default,
  attenuationViolations,
  app,
  VERSION,
  TIERS,
  TEMPLATES,
  CAPS,
};
