// creator-os-runtime entry point. Imports every module, registers the routes in their
// original order (one module per segment, imported in sequence below), then boots:
// source hash, schema migration, grant signing key, kill-switch default, banner.
// Production runs the single bundled file built from here (see src/README.md).
import { armedIntegrations, env, POLICY_VERSION, SERVICE_NAME, VERSION } from "./config.js";
import { getSetting, migrateSchema, setSetting } from "./db.js";
import { loadGrantSigningKey } from "./tokens.js";
import { reapExpiredGrants } from "./grants.js";
import { attenuationViolations, CAPS, gatehouseEvaluate, TIERS } from "./policy.js";
import { TEMPLATES } from "./railway.js";
import { app, recordSource } from "./http.js";
import "./routes/core.js";
import "./routes/admin.js";
import "./routes/grants.js";
import "./routes/escrow.js";
import "./routes/guest.js";
import "./routes/memory.js";
import "./routes/railway-auth.js";
import "./routes/webhooks.js";
import "./routes/mcp.js";
import "./routes/oauth.js";
import "./routes/a2a.js";
import "./routes/cockpit.js";
import "./routes/meta.js";

try {
  recordSource(await Bun.file(import.meta.path).text());
} catch {}
await migrateSchema();
var signingKeySource = await loadGrantSigningKey();
if (!(await getSetting("kill_switch"))) await setSetting("kill_switch", "off");
if (!(await getSetting("operator_lsp_caps"))) await setSetting("operator_lsp_caps", "off");
console.log(
  `[${SERVICE_NAME} v${VERSION}] policy=${POLICY_VERSION} signingKey=${signingKeySource} armed=${JSON.stringify(armedIntegrations())}`,
);
// The reservation reaper: releases the unspent reservation of any EXPIRED grant
// back to its parent (grants.js), so a pooling parent's budget stops draining to a
// permanent 402. Default-on (no config needed); "0" disables. unref'd so it never
// keeps the process alive; the manual trigger is POST /api/admin/grants/reap.
var REAP_INTERVAL_MS = Number(env.REAP_INTERVAL_MS ?? 60000);
if (REAP_INTERVAL_MS > 0) {
  var reapTimer = setInterval(
    () => reapExpiredGrants().catch((e) => console.error("[reaper]", e?.message || e)),
    REAP_INTERVAL_MS,
  );
  reapTimer.unref?.();
  console.log(`[${SERVICE_NAME}] reaper: every ${REAP_INTERVAL_MS}ms`);
} else console.log(`[${SERVICE_NAME}] reaper: disabled (REAP_INTERVAL_MS=0)`);
var LISTEN_PORT = Number(env.PORT || 3000);
var serverConfig = {
  port: LISTEN_PORT,
  fetch: app.fetch,
  // 0.3.2: a gated cog.execute waits on lsp-mcp (a Rust cargo check can take a
  // while); Bun's default 10 s idle timeout would drop the socket mid-request.
  idleTimeout: 255,
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
