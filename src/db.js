// Postgres (Bun.SQL) connection, schema + migration, settings, events, tenant/grant lookups.
import { env, SERVICE_NAME } from "./config.js";
import { newId } from "./util.js";
import { enqueueOutbox } from "./outbox.js";
import { busArmed, busEnvelope } from "./busout.js";

var { SQL: BunSQL } = globalThis.Bun;
var DB_CONNECTION_URL = env.DATABASE_URL || env.POSTGRES_URL || "";
if (!DB_CONNECTION_URL)
  (console.error("FATAL: DATABASE_URL is required (Railway: ${{Postgres.DATABASE_URL}})"), process.exit(1));
export var sql = new BunSQL(DB_CONNECTION_URL);
var SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  stripe_customer TEXT, stripe_subscription TEXT, period_start TIMESTAMPTZ DEFAULT now(),
  deploys_period INT NOT NULL DEFAULT 0, allowed_targets JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), parent TEXT REFERENCES grants(id),
  depth INT NOT NULL DEFAULT 0, sub TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  caps JSONB NOT NULL, scope JSONB NOT NULL, budget JSONB NOT NULL, constraints JSONB NOT NULL,
  reserved JSONB NOT NULL DEFAULT '{"usd_cents":0,"calls":0,"deploys":0}'::jsonb,
  settled  JSONB NOT NULL DEFAULT '{"usd_cents":0,"calls":0,"deploys":0}'::jsonb,
  payload TEXT NOT NULL, policy_version TEXT, issued_by TEXT, iat BIGINT NOT NULL, exp BIGINT NOT NULL,
  revoked_at TIMESTAMPTZ, revoke_reason TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS tenants_stripe_customer ON tenants(stripe_customer);
CREATE INDEX IF NOT EXISTS grants_parent ON grants(parent);
CREATE INDEX IF NOT EXISTS grants_tenant ON grants(tenant);
CREATE INDEX IF NOT EXISTS grants_escrow_id ON grants((scope->'escrow'->>'escrow_id'));
CREATE TABLE IF NOT EXISTS ledger (
  id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), tenant TEXT NOT NULL, grant_id TEXT, parent TEXT,
  kind TEXT NOT NULL, usd_cents INT NOT NULL DEFAULT 0, calls INT NOT NULL DEFAULT 0, deploys INT NOT NULL DEFAULT 0,
  ref TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS deploys (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, grant_id TEXT, name TEXT NOT NULL, template TEXT, intent JSONB NOT NULL,
  plan JSONB, status TEXT NOT NULL, executed BOOLEAN NOT NULL DEFAULT false, railway_service_id TEXT,
  railway_deployment_id TEXT, target JSONB, result JSONB,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT,
  received_at TIMESTAMPTZ DEFAULT now(), handled BOOLEAN NOT NULL DEFAULT false, result JSONB, payload JSONB,
  UNIQUE(source, event_id));
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), tenant TEXT, type TEXT NOT NULL, actor TEXT, data JSONB);
-- Tool invocation receipts are separate from monetary settlement rows. Arguments,
-- results, tokens, paths and client-supplied identities are never stored here.
CREATE TABLE IF NOT EXISTS tool_receipts (
  id TEXT PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  tenant TEXT, grant_id TEXT, tool TEXT NOT NULL,
  authority_kind TEXT NOT NULL DEFAULT 'unverified', record_kind TEXT NOT NULL DEFAULT 'invocation', attempts BIGINT NOT NULL DEFAULT 1,
  auth_decision TEXT NOT NULL DEFAULT 'unverified', outcome TEXT NOT NULL DEFAULT 'started',
  http_status INT, reason TEXT);
CREATE INDEX IF NOT EXISTS tool_receipts_grant_started ON tool_receipts(grant_id, started_at DESC);
CREATE TABLE IF NOT EXISTS vault (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, provider TEXT NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL,
  tag TEXT NOT NULL, meta JSONB, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(tenant, provider));
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY, tenant TEXT NOT NULL, verifier TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, tenant TEXT NOT NULL, root_id TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS oauth_refresh (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, tenant TEXT NOT NULL, root_id TEXT NOT NULL, grant_id TEXT NOT NULL, consent_until BIGINT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS docs (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, partition TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb, version BIGINT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT false, actor TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(), created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(tenant, partition, key));
CREATE INDEX IF NOT EXISTS memories_version ON memories(version);
CREATE INDEX IF NOT EXISTS memories_fts ON memories USING gin (to_tsvector('english', content));
CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, payload JSONB NOT NULL, attempts INT NOT NULL DEFAULT 0, next_at TIMESTAMPTZ DEFAULT now(),
  done BOOLEAN NOT NULL DEFAULT false, last_error TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS breakglass (
  id BIGSERIAL PRIMARY KEY, tenant TEXT NOT NULL, until TIMESTAMPTZ NOT NULL, reason TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS rate_limits (
  grant_id TEXT NOT NULL, window_start BIGINT NOT NULL, count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (grant_id, window_start));
CREATE TABLE IF NOT EXISTS guest_fingerprints (
  fp TEXT PRIMARY KEY, grant_id TEXT, grant_exp BIGINT NOT NULL DEFAULT 0,
  window_start BIGINT NOT NULL, count INT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL DEFAULT 0);
-- The autonomy dial (autonomy.js). Every ledger row can say how much autonomy the
-- actor had, what the gate decided, and which human approved it. Additive and
-- nullable: rows written before the dial read as NULL, i.e. unrecorded.
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS autonomy INT;
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS decision TEXT;
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS approver TEXT;
-- Receipt-before-run (0.3.5). plan_hash binds a dry run to the exact plan a live deploy will run;
-- plan_consumed_at spends that dry run once, so one sim buys at most one live action.
-- live_actions counts live Railway mutations taken under a grant, against constraints.maxLiveActions
-- (absent = unlimited, 1 = a one-use grant). Additive: older rows read as no hash or zero actions.
ALTER TABLE deploys ADD COLUMN IF NOT EXISTS plan_hash TEXT;
ALTER TABLE deploys ADD COLUMN IF NOT EXISTS plan_consumed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS deploys_tenant_plan ON deploys(tenant, plan_hash);
ALTER TABLE grants ADD COLUMN IF NOT EXISTS live_actions INT NOT NULL DEFAULT 0;
-- A value action an agent at autonomy "ask" requested: it waits here until the
-- tenant root grant (the owner credential) approves or denies it.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, grant_id TEXT NOT NULL, action TEXT NOT NULL, intent JSONB NOT NULL,
  autonomy INT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT, approver TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), decided_at TIMESTAMPTZ, result JSONB);
CREATE INDEX IF NOT EXISTS approvals_tenant_status ON approvals(tenant, status);
-- Plan cheques (0.3.6). A deploy that stops at "ask" now carries the exact plan it would run and that
-- plan's hash. Signing runs that plan once, and only if it still hashes the same. A cheque expires.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS plan JSONB;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS plan_hash TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
-- Tours (tours.js): the record that lets one named agent keep renewing a 24-hour key until its end date.
-- grant_id is the holding grant (never a credential). current_key is a NOTE of the key the tour handed out
-- last. The keys themselves are found by parent (every active grant under the holding grant), never by this note.
-- gen is the TURN number: every step that will issue a key adds one to it first, in a statement that only
-- succeeds if the row is still as it was read (tours.js, rule 2).
CREATE TABLE IF NOT EXISTS tours (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES grants(id), agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', current_key TEXT, renewals INT NOT NULL DEFAULT 0,
  opened_at BIGINT NOT NULL, until BIGINT NOT NULL, last_renewed_at BIGINT NOT NULL, opened_by TEXT, frozen_reason TEXT,
  ended_reason TEXT, gen BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
-- (for a database that made the table from an earlier build of this branch)
ALTER TABLE tours ADD COLUMN IF NOT EXISTS ended_reason TEXT;
ALTER TABLE tours ADD COLUMN IF NOT EXISTS gen BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS tours_tenant ON tours(tenant);
CREATE INDEX IF NOT EXISTS tours_current_key ON tours(current_key);
CREATE INDEX IF NOT EXISTS tours_grant ON tours(grant_id);
-- One tour per agent name per tenant while it is live. This index, not a look before the insert, is what keeps
-- two opens at the same moment from both winning.
CREATE UNIQUE INDEX IF NOT EXISTS tours_one_live_per_agent ON tours(tenant, agent) WHERE status IN ('active', 'frozen');
-- Agent identity (identity.js). A blueprint is a family of agents. Freezing it stops every agent
-- built from it, and everything those agents delegated to. An agent row is the SEAT behind a grant
-- subject: who sponsors it (accountable for why it exists), who owns it (keeps it running), what
-- it is for, and an attestation the sponsor must renew every attest_every_days or the seat lapses.
CREATE TABLE IF NOT EXISTS blueprints (
  tenant TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL, purpose TEXT, status TEXT NOT NULL DEFAULT 'active',
  frozen_reason TEXT, frozen_by TEXT, frozen_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant, id));
CREATE TABLE IF NOT EXISTS agents (
  tenant TEXT NOT NULL REFERENCES tenants(id), sub TEXT NOT NULL, blueprint TEXT, sponsor TEXT, owner TEXT, purpose TEXT,
  status TEXT NOT NULL DEFAULT 'active', frozen_reason TEXT, frozen_by TEXT, frozen_at TIMESTAMPTZ,
  attest_every_days INT NOT NULL DEFAULT 30, attested_at TIMESTAMPTZ, attested_by TEXT, expires_at TIMESTAMPTZ,
  strikes INT NOT NULL DEFAULT 0, strikes_window_start BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant, sub));
CREATE INDEX IF NOT EXISTS agents_blueprint ON agents(tenant, blueprint);
CREATE INDEX IF NOT EXISTS grants_tenant_sub ON grants(tenant, sub);
-- Seat mints (seats.js). One row per mint attempt of a paid (or house) seat. The partial unique index is
-- what makes a retried payment webhook safe: one (tenant, rail, payment_ref) makes one seat, ever.
-- status: minting -> minted | failed (a failed one may be tried again with the same payment).
CREATE TABLE IF NOT EXISTS seat_mints (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), agent TEXT NOT NULL, rail TEXT NOT NULL,
  payment_ref TEXT, paid_cents INT, status TEXT NOT NULL DEFAULT 'minting', tour_id TEXT, error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS seat_mints_payment ON seat_mints(tenant, rail, payment_ref) WHERE payment_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS seat_mints_tenant ON seat_mints(tenant, created_at);
-- Signed receipts (receipts.js): the public trust ledger. body is the canonical JSON that was signed;
-- hash = sha256(body), prev = the hash of seq-1 (null for #1): editing or deleting history breaks the chain.
CREATE TABLE IF NOT EXISTS signed_receipts (
  id TEXT PRIMARY KEY, seq BIGINT NOT NULL UNIQUE, kind TEXT NOT NULL, tenant TEXT, public BOOLEAN NOT NULL DEFAULT false,
  body TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prev TEXT, sig TEXT NOT NULL, kid TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS signed_receipts_kind ON signed_receipts(kind, seq DESC);
`;
export async function migrateSchema() {
  for (let e of SCHEMA_SQL.split(";")
    .map((t) => t.trim())
    .filter(Boolean))
    await sql.unsafe(e);
}
export async function getSetting(e) {
  let t = await sql`SELECT value FROM settings WHERE key = ${e}`;
  return t.length ? t[0].value : null;
}
export async function setSetting(e, t) {
  await sql`INSERT INTO settings (key, value, updated_at) VALUES (${e}, ${t}, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
export async function recordEvent(e, t, a = null, n = null) {
  let [row] = await sql`INSERT INTO events (tenant, type, actor, data) VALUES (${a}, ${e}, ${n}, ${t}::jsonb) RETURNING id, ts`;
  if (!e.startsWith("brain."))
    await enqueueOutbox("brain.event", {
      id: newId("ev"),
      type: e,
      tenant: a,
      actor: n,
      data: t,
      ts: new Date().toISOString(),
      source: SERVICE_NAME,
    });
  // The one events bus. Off (no row, no call) unless BUS_EVENTS_URL and BUS_EVENTS_KEY are both set.
  if (busArmed()) {
    let ev = busEnvelope({ id: row?.id, type: e, ts: row?.ts, data: t, tenant: a, actor: n }, SERVICE_NAME);
    if (ev) await enqueueOutbox("bus.publish", ev);
  }
}
export async function isKillSwitchOn() {
  return (await getSetting("kill_switch")) === "on";
}
export async function isOperatorLspCapsEnabled() {
  return (await getSetting("operator_lsp_caps")) === "on";
}
export async function getTenant(e) {
  return (await sql`SELECT * FROM tenants WHERE id = ${e}`)[0] || null;
}
export async function getGrant(e) {
  return (await sql`SELECT * FROM grants WHERE id = ${e}`)[0] || null;
}
