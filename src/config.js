// Service identity, env (secrets trimmed at load), armed-integration flags, secret fingerprints.
import { createHash } from "crypto";

export var VERSION = "0.3.3";
export var SERVICE_NAME = "creator-os-runtime";
export var POLICY_VERSION = "p1";
export var env = Bun.env;
var TRIMMED_SECRET_ENV_KEYS = [
  "RUNTIME_ADMIN_KEY",
  "VAULT_KEY",
  "ANTHROPIC_API_KEY",
  "RAILWAY_API_TOKEN",
  "RAILWAY_OAUTH_CLIENT_ID",
  "RAILWAY_OAUTH_CLIENT_SECRET",
  "STRIPE_WEBHOOK_SECRET",
  "RAILWAY_WEBHOOK_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "BRAIN_WEBHOOK_SECRET",
  "MESH_RECEIPT_SECRET",
  "COG_BRIDGE_TOKEN",
  "COG_SYNC_TOKEN",
  "GRANT_SIGNING_KEY",
];
for (let e of TRIMMED_SECRET_ENV_KEYS) {
  let t = env[e];
  if (typeof t === "string" && t !== t.trim()) env[e] = t.trim();
}
var fingerprintSecret = (e) => (e ? createHash("sha256").update(e, "utf8").digest("hex").slice(0, 8) : null);
export var secretFingerprints = () => ({
  admin: fingerprintSecret(env.RUNTIME_ADMIN_KEY),
  vault: fingerprintSecret(env.VAULT_KEY),
  anthropic: fingerprintSecret(env.ANTHROPIC_API_KEY),
  railway: fingerprintSecret(env.RAILWAY_API_TOKEN),
  stripe: fingerprintSecret(env.STRIPE_WEBHOOK_SECRET),
  railwayWebhook: fingerprintSecret(env.RAILWAY_WEBHOOK_TOKEN),
  github: fingerprintSecret(env.GITHUB_WEBHOOK_SECRET),
  brain: fingerprintSecret(env.BRAIN_WEBHOOK_SECRET),
  mesh: fingerprintSecret(env.MESH_RECEIPT_SECRET),
  cognitiveBridge: fingerprintSecret(env.COG_BRIDGE_TOKEN),
  sync: fingerprintSecret(env.COG_SYNC_TOKEN),
});
export var armedIntegrations = () => ({
  admin: !!env.RUNTIME_ADMIN_KEY,
  vault: /^[0-9a-f]{64}$/i.test(env.VAULT_KEY || ""),
  railway: !!env.RAILWAY_API_TOKEN,
  railwayOAuth: !!(env.RAILWAY_OAUTH_CLIENT_ID && env.RAILWAY_OAUTH_CLIENT_SECRET),
  stripe: !!env.STRIPE_WEBHOOK_SECRET,
  railwayWebhook: !!env.RAILWAY_WEBHOOK_TOKEN,
  github: !!env.GITHUB_WEBHOOK_SECRET,
  brain: !!env.BRAIN_WEBHOOK_SECRET,
  mesh: !!env.MESH_RECEIPT_SECRET,
  anthropic: !!env.ANTHROPIC_API_KEY,
  brainOut: !!env.BRAIN_URL,
  cognitiveBridge: !!(env.COG_BRIDGE_URL && env.COG_BRIDGE_TOKEN),
  sync: !!env.COG_SYNC_TOKEN,
  lspMcp: !!env.LSP_MCP_URL,
});
export var RATE_LIMIT_MAX_PER_MIN = Number(env.RATE_LIMIT_PER_MIN || 120);
