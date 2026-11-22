// creator-os-runtime entry point. Imports every module, registers the routes in their
// original order (one module per segment, imported in sequence below), then boots:
// source hash, schema migration, grant signing key, kill-switch default, banner.
// Production runs the single bundled file built from here (see src/README.md).
import { armedIntegrations, env, POLICY_VERSION, SERVICE_NAME, VERSION } from "./config.js";
import { getSetting, migrateSchema, setSetting } from "./db.js";
import { loadGrantSigningKey } from "./tokens.js";
import { loadOidcSigningKey } from "./oidc.js";
import { loadReceiptSigningKey } from "./receipts.js";
import { expireDeadApprovals, reapExpiredGrants } from "./grants.js";
import { sweepTours } from "./tours.js";
import { sweepMarketJobs } from "./meshmarket.js";
import { attenuationViolations, CAPS, gatehouseEvaluate, TIERS } from "./policy.js";
import { TEMPLATES } from "./railway.js";
import { app, recordSource } from "./http.js";
import "./routes/core.js";
import "./routes/admin.js";
import "./routes/grants.js";
import "./routes/escrow.js";
import "./routes/broker.js";
import "./routes/market.js";
import "./routes/tours.js";
import "./routes/guest.js";
import "./routes/memory.js";
import "./routes/railway-auth.js";
import "./routes/webhooks.js";
import "./routes/mcp.js";
import "./routes/oauth.js";
import "./routes/sso.js";
import "./routes/a2a.js";
import "./routes/cockpit.js";
import "./routes/identity.js";
import "./routes/seats.js";
import "./routes/oidc.js";
import "./routes/receipts.js";
import "./routes/payments.js";
import "./routes/meta.js";

try {
  recordSource(await Bun.file(import.meta.path).text());
} catch {}
await migrateSchema();
var signingKeySource = await loadGrantSigningKey();
var oidcKeySource = await loadOidcSigningKey();
var receiptKeySource = await loadReceiptSigningKey();
if (!(await getSetting("kill_switch"))) await setSetting("kill_switch", "off");
if (!(await getSetting("operator_lsp_caps"))) await setSetting("operator_lsp_caps", "off");
console.log(
  `[${SERVICE_NAME} v${VERSION}] policy=${POLICY_VERSION} signingKey=${signingKeySource} oidcKey=${oidcKeySource} receiptKey=${receiptKeySource} armed=${JSON.stringify(armedIntegrations())}`,
);
// The reservation reaper: releases the unspent reservation of any EXPIRED grant
// back to its parent (grants.js), so a pooling parent's budget stops draining to a
// permanent 402. Default-on (no config needed); "0" disables. unref'd so it never
// keeps the process alive; the manual trigger is POST /api/admin/grants/reap.
var REAP_INTERVAL_MS = Number(env.REAP_INTERVAL_MS ?? 60000);
if (REAP_INTERVAL_MS > 0) {
  var reapTimer = setInterval(
    // then the tours that are finished (over, idle, or their holding grant gone) are marked so: tours.js
    () =>
      reapExpiredGrants()
        .then(() => sweepTours())
        // then the asks that can never run (their agent, tenant or cheque has ended) stop waiting on the owner
        .then(() => expireDeadApprovals())
        .catch((e) => console.error("[reaper]", e?.message || e)),
    REAP_INTERVAL_MS,
  );
  reapTimer.unref?.();
  console.log(`[${SERVICE_NAME}] reaper: every ${REAP_INTERVAL_MS}ms`);
} else console.log(`[${SERVICE_NAME}] reaper: disabled (REAP_INTERVAL_MS=0)`);
// The MeshMarket sweep: every open market payment job is reconciled against MeshMarket
// (meshmarket.js) — a held call settles when MeshMarket releases it, its budget comes back
// when MeshMarket refunds it, an unanswered call is re-sent with the same idempotency key.
// Does nothing until the buyer account is enrolled, and nothing while the kill switch is on.
// Default-on; "0" disables; the manual trigger is POST /api/admin/meshmarket/sweep.
var MARKET_SWEEP_MS = Number(env.MESHMARKET_SWEEP_MS ?? 60000);
if (MARKET_SWEEP_MS > 0) {
  var marketTimer = setInterval(() => sweepMarketJobs().catch((e) => console.error("[meshmarket]", e?.message || e)), MARKET_SWEEP_MS);
  marketTimer.unref?.();
  console.log(`[${SERVICE_NAME}] meshmarket sweep: every ${MARKET_SWEEP_MS}ms`);
} else console.log(`[${SERVICE_NAME}] meshmarket sweep: disabled (MESHMARKET_SWEEP_MS=0)`);
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
