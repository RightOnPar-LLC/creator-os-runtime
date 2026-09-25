// @bun
import { Hono } from "hono";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "crypto";
var { SQL: BunSQL } = globalThis.Bun,
  VERSION = "0.3.0",
  SERVICE_NAME = "creator-os-runtime",
  POLICY_VERSION = "p1",
  env = Bun.env,
  TRIMMED_SECRET_ENV_KEYS = [
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
var fingerprintSecret = (e) => (e ? createHash("sha256").update(e, "utf8").digest("hex").slice(0, 8) : null),
  secretFingerprints = () => ({
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
  }),
  DB_CONNECTION_URL = env.DATABASE_URL || env.POSTGRES_URL || "";
if (!DB_CONNECTION_URL)
  (console.error("FATAL: DATABASE_URL is required (Railway: ${{Postgres.DATABASE_URL}})"), process.exit(1));
var sql = new BunSQL(DB_CONNECTION_URL),
  armedIntegrations = () => ({
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
  }),
  SCHEMA_SQL = `
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
`;
async function migrateSchema() {
  for (let e of SCHEMA_SQL.split(";")
    .map((t) => t.trim())
    .filter(Boolean))
    await sql.unsafe(e);
}
var parseJson = (e) => (typeof e === "string" ? JSON.parse(e) : e),
  nowSec = () => Math.floor(Date.now() / 1000),
  newId = (e) => `${e}_${randomBytes(9).toString("base64url")}`,
  sha256Hex = (e) => createHash("sha256").update(e).digest("hex");
async function getSetting(e) {
  let t = await sql`SELECT value FROM settings WHERE key = ${e}`;
  return t.length ? t[0].value : null;
}
async function setSetting(e, t) {
  await sql`INSERT INTO settings (key, value, updated_at) VALUES (${e}, ${t}, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
async function recordEvent(e, t, a = null, n = null) {
  if (
    (await sql`INSERT INTO events (tenant, type, actor, data) VALUES (${a}, ${e}, ${n}, ${t}::jsonb)`,
    !e.startsWith("brain."))
  )
    await enqueueOutbox("brain.event", {
      id: newId("ev"),
      type: e,
      tenant: a,
      actor: n,
      data: t,
      ts: new Date().toISOString(),
      source: SERVICE_NAME,
    });
}
var grantSigningKey;
async function loadGrantSigningKey() {
  if (env.GRANT_SIGNING_KEY) return ((grantSigningKey = Buffer.from(env.GRANT_SIGNING_KEY, "utf8")), "env");
  let e = await getSetting("grant_signing_key");
  if (!e) ((e = randomBytes(32).toString("hex")), await setSetting("grant_signing_key", e));
  return ((grantSigningKey = Buffer.from(e, "hex")), "db");
}
var toBase64Url = (e) => Buffer.from(e).toString("base64url"),
  hmacSha256 = (e, t, a = "hex") => createHmac("sha256", e).update(t).digest(a);
function safeEqual(e, t) {
  let a = Buffer.from(e),
    n = Buffer.from(t);
  return a.length === n.length && timingSafeEqual(a, n);
}
function signGrantToken(e) {
  return `cog1.${toBase64Url(e)}.${hmacSha256(grantSigningKey, e, "base64url")}`;
}
function parseGrantToken(e) {
  try {
    let [t, a, n] = e.trim().split(".");
    if (t !== "cog1" || !a || !n) return null;
    let r = Buffer.from(a, "base64url").toString("utf8");
    if (!safeEqual(hmacSha256(grantSigningKey, r, "base64url"), n)) return null;
    let s = JSON.parse(r);
    if (s.iss !== SERVICE_NAME || s.v !== 1) return null;
    return {
      payload: s,
      json: r,
    };
  } catch {
    return null;
  }
}
function vaultKey() {
  return /^[0-9a-f]{64}$/i.test(env.VAULT_KEY || "") ? Buffer.from(env.VAULT_KEY, "hex") : null;
}
function vaultEncrypt(e) {
  let t = vaultKey();
  if (!t) throw Error("vault_unarmed");
  let a = randomBytes(12),
    n = createCipheriv("aes-256-gcm", t, a);
  return {
    ciphertext: Buffer.concat([n.update(e, "utf8"), n.final()]).toString("base64"),
    iv: a.toString("base64"),
    tag: n.getAuthTag().toString("base64"),
  };
}
function vaultDecrypt(e) {
  let t = vaultKey();
  if (!t) throw Error("vault_unarmed");
  let a = createDecipheriv("aes-256-gcm", t, Buffer.from(e.iv, "base64"));
  return (
    a.setAuthTag(Buffer.from(e.tag, "base64")),
    Buffer.concat([a.update(Buffer.from(e.ciphertext, "base64")), a.final()]).toString("utf8")
  );
}
var CAPS = [
    "grant.issue",
    "grant.read",
    "cog.plan",
    "cog.execute",
    "deploy.worker",
    "worker.status",
    "worker.logs.read",
    "worker.restart",
    "worker.delete",
    "ledger.read",
    "tenant.read",
    "webhook.emit",
    "memory.read",
    "memory.write",
    "store.clips.read",
    "store.clips.link",
    "store.clips.edit",
    "store.clips.price",
    "store.ingest",
    "store.clips.publish",
  ],
  CAP_SET = new Set(CAPS),
  TIERS = {
    starter: {
      maxWorkers: 2,
      deploysPerPeriod: 20,
      usdCents: 500,
      maxTtlSec: 3600,
      maxDepth: 2,
      maxReplicas: 1,
    },
    pro: {
      maxWorkers: 10,
      deploysPerPeriod: 200,
      usdCents: 5000,
      maxTtlSec: 86400,
      maxDepth: 3,
      maxReplicas: 2,
    },
    studio: {
      maxWorkers: 40,
      deploysPerPeriod: 1000,
      usdCents: 25000,
      maxTtlSec: 604800,
      maxDepth: 4,
      maxReplicas: 3,
    },
    house: {
      maxWorkers: 500,
      deploysPerPeriod: 1e5,
      usdCents: 1e7,
      maxTtlSec: 2592000,
      maxDepth: 6,
      maxReplicas: 5,
    },
  },
  zeroUsage = () => ({
    usd_cents: 0,
    calls: 0,
    deploys: 0,
  }),
  normalizeUsage = (e) => ({
    usd_cents: Math.max(0, Math.floor(+e?.usd_cents || 0)),
    calls: Math.max(0, Math.floor(+e?.calls || 0)),
    deploys: Math.max(0, Math.floor(+e?.deploys || 0)),
  }),
  subtractUsage = (e, t) => ({
    usd_cents: e.usd_cents - t.usd_cents,
    calls: e.calls - t.calls,
    deploys: e.deploys - t.deploys,
  }),
  addUsage = (e, t) => ({
    usd_cents: e.usd_cents + t.usd_cents,
    calls: e.calls + t.calls,
    deploys: e.deploys + t.deploys,
  }),
  usageWithin = (e, t) => e.usd_cents <= t.usd_cents && e.calls <= t.calls && e.deploys <= t.deploys,
  remainingBudget = (e) =>
    subtractUsage(
      subtractUsage(normalizeUsage(parseJson(e.budget)), normalizeUsage(parseJson(e.reserved))),
      normalizeUsage(parseJson(e.settled)),
    ),
  memoryPartitions = (e) => e.memory?.partitions ?? [""],
  numberOr = (e, t) => (e === void 0 || e === null || e === "" || Number.isNaN(+e) ? t : +e),
  clampConstraints = (e, t) => ({
    maxWorkers: Math.min(t.maxWorkers, Math.max(0, Math.floor(numberOr(e?.maxWorkers, t.maxWorkers)))),
    maxReplicas: Math.min(t.maxReplicas, Math.max(1, Math.floor(numberOr(e?.maxReplicas, t.maxReplicas)))),
    allowDelete: t.allowDelete && e?.allowDelete === !0,
    requireDryRun: e?.requireDryRun === !1 ? t.requireDryRun && !1 : !0,
  }),
  isSubset = (e, t) => (e || []).every((a) => (t || []).includes(a));
function attenuationViolations(e, t, a) {
  let n = [];
  try {
    let r = TIERS[a];
    if (!r) return ["unknown_tier"];
    let s = parseJson(e.caps),
      i = parseJson(e.scope),
      o = parseJson(e.constraints);
    for (let c of t.caps)
      if (!CAP_SET.has(c)) n.push(`unknown_cap:${c}`);
      else if (!s.includes(c)) n.push(`cap_not_in_parent:${c}`);
    if (t.caps.length === 0) n.push("no_caps");
    if (t.exp > Number(e.exp)) n.push("exp_exceeds_parent");
    if (t.exp - nowSec() > r.maxTtlSec) n.push("ttl_exceeds_tier");
    if (t.exp <= nowSec()) n.push("already_expired");
    if (!isSubset(t.scope.railway?.projects, i.railway?.projects)) n.push("scope_projects_widened");
    if (!isSubset(t.scope.railway?.environments, i.railway?.environments))
      n.push("scope_environments_widened");
    let l = i.workers?.namePrefix || "";
    if (!(t.scope.workers?.namePrefix || "").startsWith(l)) n.push("scope_prefix_widened");
    if (!memoryPartitions(t.scope).every((c) => memoryPartitions(i).some((E) => c.startsWith(E))))
      n.push("scope_memory_widened");
    if (!usageWithin(t.budget, remainingBudget(e))) n.push("budget_exceeds_parent_remaining");
    if (t.constraints.maxWorkers > o.maxWorkers) n.push("maxWorkers_widened");
    if (t.constraints.maxReplicas > o.maxReplicas) n.push("maxReplicas_widened");
    if (t.constraints.allowDelete && !o.allowDelete) n.push("allowDelete_widened");
    if (t.constraints.requireDryRun === !1 && o.requireDryRun) n.push("requireDryRun_loosened");
    if (t.depth !== Number(e.depth) + 1) n.push("bad_depth");
    if (t.depth > r.maxDepth) n.push("depth_exceeds_tier");
    if (e.status !== "active") n.push("parent_not_active");
    if (Number(e.exp) <= nowSec()) n.push("parent_expired");
  } catch (r) {
    n.push("policy_evaluation_error");
  }
  return n;
}
function gatehouseEvaluate(e, t, a) {
  let n = [];
  try {
    if (!e || e.status !== "active") n.push("tenant_not_active");
    let r = TIERS[e?.tier];
    if (!r) n.push("unknown_tier");
    let s = Array.isArray(a?.grants) ? a.grants : null,
      i = Array.isArray(a?.deploys) ? a.deploys : null;
    if (!s || !i) n.push("malformed_proposal");
    if (s && s.length > 8) n.push("too_many_grants");
    if (i && i.length > 8) n.push("too_many_deploys");
    let o = parseJson(e?.allowed_targets || {});
    for (let l of s || []) {
      for (let c of l.caps || []) if (!CAP_SET.has(c)) n.push(`unknown_cap:${c}`);
      if (/money|wallet|trade|secret/i.test(JSON.stringify(l.caps || []))) n.push("forbidden_cap_family");
      if (+l.ttlSec > (r?.maxTtlSec ?? 0)) n.push("ttl_exceeds_tier");
      if (normalizeUsage(l.budget).usd_cents > (r?.usdCents ?? 0)) n.push("budget_exceeds_tier");
      for (let c of l.scope?.railway?.projects || [])
        if (!(o.railway?.projects || []).includes(c)) n.push(`target_not_allowed:${c}`);
    }
    for (let l of i || []) {
      if (!l.name || !/^[a-z0-9-]{3,48}$/.test(l.name)) n.push("bad_worker_name");
      if (l.name && !l.name.startsWith(tenantWorkerPrefix(String(e?.id || ""))))
        n.push("worker_name_missing_tenant_prefix");
      if ((+l.replicas || 1) > (r?.maxReplicas ?? 1)) n.push("replicas_exceed_tier");
      if (!l.template || !TEMPLATES[l.template]) n.push(`unknown_template:${l.template}`);
    }
    if (t && t.status !== "active") n.push("caller_grant_not_active");
  } catch {
    n.push("policy_evaluation_error");
  }
  return {
    ok: n.length === 0,
    reasons: n,
  };
}
async function isKillSwitchOn() {
  return (await getSetting("kill_switch")) === "on";
}
async function getTenant(e) {
  return (await sql`SELECT * FROM tenants WHERE id = ${e}`)[0] || null;
}
async function getGrant(e) {
  return (await sql`SELECT * FROM grants WHERE id = ${e}`)[0] || null;
}
function reissueGrantToken(e) {
  return signGrantToken(e.payload);
}
function tenantWorkerPrefix(e) {
  return `t-${sha256Hex(e).slice(0, 6)}-`;
}
async function mintRootGrant(e, t = "tenant:root") {
  let a = TIERS[e.tier],
    n = nowSec(),
    r = n + a.maxTtlSec * 4,
    s = newId("gr"),
    i = parseJson(e.allowed_targets || {}),
    o = {
      v: 1,
      id: s,
      tenant: e.id,
      parent: null,
      depth: 0,
      sub: t,
      iss: SERVICE_NAME,
      iat: n,
      exp: r,
      caps: [...CAPS],
      scope: {
        railway: {
          projects: i.railway?.projects || [],
          environments: i.railway?.environments || ["production"],
        },
        workers: {
          namePrefix: tenantWorkerPrefix(e.id),
        },
        memory: {
          partitions: [""],
        },
      },
      budget: {
        usd_cents: a.usdCents,
        calls: a.deploysPerPeriod * 50,
        deploys: a.deploysPerPeriod,
      },
      constraints: {
        maxWorkers: a.maxWorkers,
        maxReplicas: a.maxReplicas,
        allowDelete: !0,
        requireDryRun: !0,
      },
      nonce: randomBytes(8).toString("hex"),
    },
    l = JSON.stringify(o);
  return (
    await sql`INSERT INTO grants (id, tenant, parent, depth, sub, caps, scope, budget, constraints, payload, policy_version, issued_by, iat, exp)
    VALUES (${s}, ${e.id}, ${null}, 0, ${t}, ${o.caps}::jsonb, ${o.scope}::jsonb,
            ${o.budget}::jsonb, ${o.constraints}::jsonb, ${l}, ${POLICY_VERSION}, ${"admin"}, ${n}, ${r})`,
    await sql`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
    VALUES (${e.id}, ${s}, ${null}, 'root', ${o.budget.usd_cents}, ${o.budget.calls}, ${o.budget.deploys}, ${s}, 'root grant minted')`,
    await recordEvent(
      "grant.issued",
      {
        id: s,
        sub: t,
        depth: 0,
      },
      e.id,
      "admin",
    ),
    {
      row: await getGrant(s),
      token: signGrantToken(l),
    }
  );
}
async function issueChildGrant(e, t, a) {
  let n = await getTenant(e.tenant);
  if (!n)
    throw Object.assign(Error("tenant_missing"), {
      status: 403,
    });
  let r = TIERS[n.tier],
    s = parseJson(e.scope),
    i = parseJson(e.constraints),
    o = Math.min(Math.max(60, Math.floor(t.ttlSec ?? 3600)), r.maxTtlSec),
    l = nowSec(),
    c = Math.min(l + o, Number(e.exp)),
    E = {
      railway: {
        projects: t.scope?.railway?.projects ?? s.railway?.projects ?? [],
        environments: t.scope?.railway?.environments ?? s.railway?.environments ?? [],
      },
      workers: {
        namePrefix: t.scope?.workers?.namePrefix ?? s.workers?.namePrefix ?? "",
      },
      memory: {
        partitions: t.scope?.memory?.partitions ?? memoryPartitions(s),
      },
    },
    T = normalizeUsage(t.budget ?? zeroUsage()),
    R = clampConstraints(t.constraints ?? {}, i),
    S = {
      caps: [...new Set(t.caps || [])],
      scope: E,
      budget: T,
      exp: c,
      constraints: R,
      depth: Number(e.depth) + 1,
    },
    B = attenuationViolations(e, S, n.tier);
  if (B.length)
    throw Object.assign(Error("attenuation_violation"), {
      status: 403,
      detail: B,
    });
  let $ = newId("gr"),
    C = {
      v: 1,
      id: $,
      tenant: n.id,
      parent: e.id,
      depth: S.depth,
      sub: String(t.sub || "agent:anon").slice(0, 80),
      iss: SERVICE_NAME,
      iat: l,
      exp: c,
      caps: S.caps,
      scope: E,
      budget: T,
      constraints: R,
      nonce: randomBytes(8).toString("hex"),
    },
    pe = JSON.stringify(C);
  return (
    await sql.begin(async (H) => {
      let P = (await H`SELECT * FROM grants WHERE id = ${e.id} FOR UPDATE`)[0];
      if (!P || P.status !== "active")
        throw Object.assign(Error("parent_not_active"), {
          status: 403,
        });
      if (!usageWithin(T, remainingBudget(P)))
        throw Object.assign(Error("budget_exceeds_parent_remaining"), {
          status: 402,
        });
      let ee = addUsage(normalizeUsage(parseJson(P.reserved)), T);
      (await H`UPDATE grants SET reserved = ${ee}::jsonb WHERE id = ${e.id}`,
        await H`INSERT INTO grants (id, tenant, parent, depth, sub, caps, scope, budget, constraints, payload, policy_version, issued_by, iat, exp)
      VALUES (${$}, ${n.id}, ${e.id}, ${S.depth}, ${C.sub}, ${S.caps}::jsonb, ${E}::jsonb,
              ${T}::jsonb, ${R}::jsonb, ${pe}, ${POLICY_VERSION}, ${a}, ${l}, ${c})`,
        await H`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${n.id}, ${$}, ${e.id}, 'reserve', ${T.usd_cents}, ${T.calls}, ${T.deploys}, ${$}, ${"reserved for " + C.sub})`);
    }),
    await recordEvent(
      "grant.issued",
      {
        id: $,
        parent: e.id,
        sub: C.sub,
        depth: S.depth,
        caps: S.caps,
      },
      n.id,
      a,
    ),
    {
      row: await getGrant($),
      token: signGrantToken(pe),
    }
  );
}
async function revokeGrantTree(e, t, a) {
  let n = [];
  if (
    (await sql.begin(async (r) => {
      let s = await r`WITH RECURSIVE sub AS (SELECT * FROM grants WHERE id = ${e}
      UNION ALL SELECT g.* FROM grants g JOIN sub ON g.parent = sub.id) SELECT * FROM sub ORDER BY depth DESC FOR UPDATE`;
      for (let i of s) {
        if (i.status !== "active") continue;
        await r`UPDATE grants SET status = 'revoked', revoked_at = now(), revoke_reason = ${t} WHERE id = ${i.id}`;
        let o = subtractUsage(normalizeUsage(parseJson(i.budget)), normalizeUsage(parseJson(i.settled)));
        if (i.parent) {
          let l = (await r`SELECT reserved FROM grants WHERE id = ${i.parent} FOR UPDATE`)[0],
            c = subtractUsage(normalizeUsage(parseJson(l.reserved)), o);
          (await r`UPDATE grants SET reserved = ${{
            usd_cents: Math.max(0, c.usd_cents),
            calls: Math.max(0, c.calls),
            deploys: Math.max(0, c.deploys),
          }}::jsonb WHERE id = ${i.parent}`,
            await r`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
          VALUES (${i.tenant}, ${i.id}, ${i.parent}, 'release', ${o.usd_cents}, ${o.calls}, ${o.deploys}, ${i.id}, ${t})`);
        }
        n.push(i.id);
      }
    }),
    n.length)
  ) {
    let r = await getGrant(e);
    await recordEvent(
      "grant.revoked",
      {
        ids: n,
        reason: t,
      },
      r?.tenant || null,
      a,
    );
  }
  return n;
}
async function settleGrantUsage(e, t, a, n) {
  await sql.begin(async (r) => {
    let s = (await r`SELECT * FROM grants WHERE id = ${e} FOR UPDATE`)[0];
    if (!s || s.status !== "active")
      throw Object.assign(Error("grant_not_active"), {
        status: 401,
      });
    if (!usageWithin(t, remainingBudget(s)))
      throw Object.assign(Error("budget_exhausted"), {
        status: 402,
      });
    (await r`UPDATE grants SET settled = ${addUsage(normalizeUsage(parseJson(s.settled)), t)}::jsonb WHERE id = ${e}`,
      await r`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${s.tenant}, ${e}, ${s.parent}, 'settle', ${t.usd_cents}, ${t.calls}, ${t.deploys}, ${a}, ${n})`);
  });
}
var rateLimitBuckets = new Map(),
  RATE_LIMIT_MAX_PER_MIN = Number(env.RATE_LIMIT_PER_MIN || 120);
function checkRateLimit(e) {
  let t = Date.now(),
    a = rateLimitBuckets.get(e);
  if (!a || t - a.t > 60000)
    return (
      rateLimitBuckets.set(e, {
        n: 1,
        t,
      }),
      !0
    );
  return (a.n++, a.n <= RATE_LIMIT_MAX_PER_MIN);
}
class HttpError extends Error {
  status;
  code;
  detail;
  constructor(e, t, a) {
    super(t);
    ((this.status = e), (this.code = t), (this.detail = a));
  }
}
async function verifyGrant(e, t, a) {
  try {
    if (!e) throw new HttpError(401, "missing_grant");
    let n = parseGrantToken(e);
    if (!n) throw new HttpError(401, "bad_grant");
    let r = n.payload;
    if (Number(r.exp) <= nowSec())
      throw (
        await sql`UPDATE grants SET status='expired' WHERE id=${r.id} AND status='active'`,
        new HttpError(401, "grant_expired")
      );
    let s = await getGrant(r.id);
    if (!s || s.status !== "active") throw new HttpError(401, "grant_revoked");
    let i = await getTenant(s.tenant);
    if (!i || i.status !== "active") throw new HttpError(403, "tenant_suspended");
    if (await isKillSwitchOn()) throw new HttpError(503, "runtime_paused");
    let o = parseJson(s.caps);
    if (t && !o.includes(t))
      throw new HttpError(403, "missing_cap", {
        need: t,
      });
    if (a) {
      let l = parseJson(s.scope);
      if (a.project && !(l.railway?.projects || []).includes(a.project))
        throw new HttpError(403, "out_of_scope", {
          project: a.project,
        });
      if (a.environment && !(l.railway?.environments || []).includes(a.environment))
        throw new HttpError(403, "out_of_scope", {
          environment: a.environment,
        });
      if (a.workerName && !a.workerName.startsWith(l.workers?.namePrefix || "\x00"))
        throw new HttpError(403, "out_of_scope", {
          workerName: a.workerName,
        });
    }
    if (!checkRateLimit(s.id)) throw new HttpError(429, "rate_limited");
    return {
      row: s,
      tenant: i,
      payload: r,
    };
  } catch (n) {
    if (n instanceof HttpError) throw n;
    throw new HttpError(403, "verification_error");
  }
}
var serializeMemory = (e) => ({
    id: e.id,
    tenant: e.tenant,
    partition: e.partition,
    key: e.key,
    content: e.content,
    tags: parseJson(e.tags),
    version: Number(e.version),
    deleted: !!e.deleted,
    actor: e.actor,
    updated_at: e.updated_at,
  }),
  toSyncRecord = (e) => ({
    partition: `${e.tenant}/${e.partition}`,
    key: e.key,
    content: e.content,
    tags: parseJson(e.tags),
    version: Number(e.version),
    deleted: !!e.deleted,
    updated_at: e.updated_at,
  });
async function writeMemory(e, t, a, n, r, s) {
  let i =
      await sql`INSERT INTO memories (id, tenant, partition, key, content, tags, version, deleted, actor, updated_at)
    VALUES (${newId("m")}, ${e}, ${t}, ${a || sha256Hex(n).slice(0, 16)}, ${n}, ${r}::jsonb, ${Date.now()}, false, ${s}, now())
    ON CONFLICT (tenant, partition, key) DO UPDATE SET content = EXCLUDED.content, tags = EXCLUDED.tags, version = EXCLUDED.version, deleted = false, actor = EXCLUDED.actor, updated_at = now() RETURNING *`,
    o = serializeMemory(i[0]);
  return (await enqueueOutbox("memory.sync", toSyncRecord(i[0])), o);
}
async function searchMemories(e, t, a, n) {
  let r = Math.min(50, Math.max(1, Math.floor(n || 10))),
    s = a + "%";
  return (
    t.trim()
      ? await sql`SELECT * FROM memories WHERE tenant = ${e} AND deleted = false AND partition LIKE ${s} AND (to_tsvector('english', content) @@ plainto_tsquery('english', ${t}) OR content ILIKE ${"%" + t + "%"})
        ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', ${t})) DESC, updated_at DESC LIMIT ${r}`
      : await sql`SELECT * FROM memories WHERE tenant = ${e} AND deleted = false AND partition LIKE ${s} ORDER BY updated_at DESC LIMIT ${r}`
  ).map(serializeMemory);
}
async function forgetMemory(e, t) {
  let a =
    await sql`UPDATE memories SET deleted = true, version = ${Date.now()}, updated_at = now() WHERE id = ${t} AND tenant = ${e} RETURNING *`;
  if (!a.length) throw new HttpError(404, "memory_not_found");
  return (await enqueueOutbox("memory.sync", toSyncRecord(a[0])), serializeMemory(a[0]));
}
async function applySyncRecords(e) {
  let t = 0,
    a = 0;
  for (let n of e) {
    let r = String(n?.partition || ""),
      s = r.indexOf("/"),
      i = s > 0 ? r.slice(0, s) : "",
      o = s > 0 ? r.slice(s + 1) : "",
      l = Number(n?.version) || 0;
    if (!i || !o || !n?.key || !l) {
      a++;
      continue;
    }
    if (
      (
        await sql`INSERT INTO memories (id, tenant, partition, key, content, tags, version, deleted, actor, updated_at)
      VALUES (${newId("m")}, ${i}, ${o}, ${String(n.key)}, ${String(n.content ?? "")}, ${Array.isArray(n.tags) ? n.tags : []}::jsonb, ${l}, ${!!n.deleted}, 'sync', now())
      ON CONFLICT (tenant, partition, key) DO UPDATE SET content = EXCLUDED.content, tags = EXCLUDED.tags, version = EXCLUDED.version, deleted = EXCLUDED.deleted, actor = 'sync', updated_at = now()
      WHERE memories.version < EXCLUDED.version RETURNING id`
      ).length
    )
      t++;
    else a++;
  }
  return {
    applied: t,
    skipped: a,
  };
}
var cogBridgeUrl = () => (env.COG_BRIDGE_URL || "").replace(/\/$/, "");
async function enqueueOutbox(e, t) {
  if (!(e === "brain.event" ? !!env.BRAIN_URL : !!(cogBridgeUrl() && env.COG_BRIDGE_TOKEN))) return;
  if ((await sql`INSERT INTO outbox (kind, payload) VALUES (${e}, ${t}::jsonb)`, !outboxDrainScheduled))
    ((outboxDrainScheduled = !0),
      setTimeout(
        () =>
          drainOutbox(25)
            .catch(() => {})
            .finally(() => {
              outboxDrainScheduled = !1;
            }),
        30,
      ));
}
var outboxDrainScheduled = !1;
async function deliverOutboxItem(e, t) {
  if (e === "brain.event") {
    let a = JSON.stringify(t),
      n = await fetch(env.BRAIN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-brain-signature": hmacSha256(env.BRAIN_WEBHOOK_SECRET || "", a),
          "x-runtime": SERVICE_NAME,
        },
        body: a,
      });
    if (!n.ok) throw Error("brain " + n.status);
    return;
  }
  if (e === "memory.sync") {
    let a = await fetch(cogBridgeUrl() + "/sync/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.COG_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({
        records: [t],
      }),
    });
    if (!a.ok) throw Error("bridge " + a.status);
    return;
  }
  throw Error("unknown_kind");
}
async function drainOutbox(e) {
  let t = await sql`SELECT * FROM outbox WHERE done = false AND next_at <= now() ORDER BY id LIMIT ${e}`,
    a = 0,
    n = 0;
  for (let r of t)
    try {
      (await deliverOutboxItem(r.kind, parseJson(r.payload)),
        await sql`UPDATE outbox SET done = true WHERE id = ${r.id}`,
        a++);
    } catch (s) {
      let i = r.attempts + 1;
      (await sql`UPDATE outbox SET attempts = ${i}, next_at = ${new Date(Date.now() + Math.min(300, 2 ** i) * 1000)}, last_error = ${String(s?.message || s).slice(0, 300)}, done = ${i >= 10} WHERE id = ${r.id}`,
        n++);
    }
  return {
    ok: a,
    failed: n,
    more: t.length === e,
  };
}
async function pullMemoryFromBridge() {
  if (!cogBridgeUrl() || !env.COG_BRIDGE_TOKEN)
    throw new HttpError(503, "unarmed", {
      needs: "COG_BRIDGE_URL+COG_BRIDGE_TOKEN",
    });
  let e = Number((await getSetting("memory_pull_cursor")) || 0),
    t = await fetch(`${cogBridgeUrl()}/sync/changes?since=${e}`, {
      headers: {
        authorization: `Bearer ${env.COG_BRIDGE_TOKEN}`,
      },
    });
  if (!t.ok) throw new HttpError(502, "bridge_error", t.status);
  let a = await t.json(),
    n = await applySyncRecords(Array.isArray(a.records) ? a.records : []),
    r = Number(a.next) || e;
  if (r > e) await setSetting("memory_pull_cursor", String(r));
  return {
    ...n,
    since: e,
    next: r,
  };
}
var TEMPLATES = {
    probe: {
      image: "traefik/whoami:latest",
      kind: "probe",
      desc: "Tiny HTTP responder that proves the deploy path",
      env: {},
      needs: [],
      estCents: 25,
    },
    "tip-alert-bot": {
      image: "ghcr.io/think-zone/creator-worker:latest",
      kind: "tip-alert",
      desc: "Tip events \u2192 Discord / OBS alerts",
      env: {
        WORKER_KIND: "tip-alert",
      },
      needs: ["DISCORD_WEBHOOK_URL"],
      estCents: 60,
    },
    "paywall-link": {
      image: "ghcr.io/think-zone/creator-worker:latest",
      kind: "paywall",
      desc: "Checkout link \u2192 content unlock, with receipts",
      env: {
        WORKER_KIND: "paywall",
      },
      needs: ["STRIPE_SECRET_KEY"],
      estCents: 60,
    },
    "clip-poster": {
      image: "ghcr.io/think-zone/creator-worker:latest",
      kind: "clips",
      desc: "Schedules and posts clips across platforms",
      env: {
        WORKER_KIND: "clips",
      },
      needs: ["POSTIZ_API_KEY"],
      estCents: 80,
    },
    "dm-autoresponder": {
      image: "ghcr.io/think-zone/creator-worker:latest",
      kind: "dm",
      desc: "Answers DMs from a persona, escalates to you",
      env: {
        WORKER_KIND: "dm",
      },
      needs: ["ANTHROPIC_API_KEY"],
      estCents: 90,
    },
    "webhook-relay": {
      image: "ghcr.io/think-zone/creator-worker:latest",
      kind: "relay",
      desc: "Relays platform webhooks to the Brain bus",
      env: {
        WORKER_KIND: "relay",
      },
      needs: [],
      estCents: 30,
    },
  },
  RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
async function railwayGraphql(e, t, a) {
  let n = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${e}`,
      },
      body: JSON.stringify({
        query: t,
        variables: a,
      }),
    }),
    r = await n.json().catch(() => ({}));
  if (!n.ok || r.errors)
    throw new HttpError(502, "railway_api_error", r.errors?.map((s) => s.message) || n.status);
  return r.data;
}
async function resolveRailwayToken(e) {
  let t = (await sql`SELECT * FROM vault WHERE tenant = ${e} AND provider = 'railway'`)[0];
  if (t && vaultKey())
    try {
      return {
        token: JSON.parse(vaultDecrypt(t)).access_token,
        source: "tenant-oauth",
      };
    } catch {}
  if (env.RAILWAY_API_TOKEN)
    return {
      token: env.RAILWAY_API_TOKEN,
      source: "house",
    };
  return null;
}
async function deployWorker(e, t, a, n) {
  let r = TEMPLATES[t.template];
  if (!r) throw new HttpError(400, "unknown_template");
  let s = parseJson(e.row.constraints),
    i = parseJson(e.row.scope),
    o = t.target?.project || i.railway?.projects?.[0] || null,
    l = t.target?.environment || i.railway?.environments?.[0] || "production",
    c = String(t.name || "").toLowerCase();
  if (!/^[a-z0-9-]{3,48}$/.test(c)) throw new HttpError(400, "bad_worker_name");
  if (!c.startsWith(i.workers?.namePrefix || "\x00"))
    throw new HttpError(403, "out_of_scope", {
      workerName: c,
    });
  if (o && !(i.railway?.projects || []).includes(o))
    throw new HttpError(403, "out_of_scope", {
      project: o,
    });
  let E = Math.min(Math.max(1, Math.floor(+t.replicas || 1)), s.maxReplicas);
  if (
    (
      await sql`SELECT count(*)::int AS n FROM deploys WHERE tenant = ${e.tenant.id} AND status NOT IN ('deleted','failed','dry_run')`
    )[0].n >= s.maxWorkers
  )
    throw new HttpError(403, "max_workers_reached", {
      maxWorkers: s.maxWorkers,
    });
  let T = TIERS[e.tenant.tier];
  if (e.tenant.deploys_period >= T.deploysPerPeriod) throw new HttpError(402, "tier_deploys_exhausted");
  let R = {
    usd_cents: r.estCents,
    calls: 1,
    deploys: 1,
  };
  if (!usageWithin(R, remainingBudget(e.row)))
    throw new HttpError(402, "budget_exhausted", {
      need: R,
      remaining: remainingBudget(e.row),
    });
  let S = {
      ...r.env,
      ...(t.env || {}),
      COS_TENANT: e.tenant.id,
      COS_WORKER: c,
      COS_GRANT: e.row.id,
    },
    B = r.needs.filter((ft) => !(ft in S)),
    $ = {
      action: "railway.serviceCreate",
      project: o,
      environment: l,
      name: c,
      image: r.image,
      replicas: E,
      env: Object.keys(S),
      missingEnv: B,
      estCents: r.estCents,
      policy: POLICY_VERSION,
    },
    C = newId("dp"),
    pe =
      await sql`SELECT 1 FROM deploys WHERE tenant = ${e.tenant.id} AND name = ${c} AND executed = true LIMIT 1`,
    H = s.requireDryRun && pe.length === 0 && !a,
    P = await resolveRailwayToken(e.tenant.id),
    ee = "dry_run",
    te = !1,
    ke = null,
    J = null,
    Le = null;
  if (H) J = "dry_run";
  else if (!P) J = "unarmed:RAILWAY_API_TOKEN";
  else if (!o) J = "no_target_project";
  else if (B.length) J = "missing_env:" + B.join(",");
  else
    (await settleGrantUsage(e.row.id, R, C, `deploy ${c}`),
      (Le =
        (
          await railwayGraphql(
            P.token,
            "mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }",
            {
              input: {
                projectId: o,
                name: c,
                source: {
                  image: r.image,
                },
                variables: S,
              },
            },
          )
        )?.serviceCreate?.id || null),
      (ee = "deploying"),
      (te = !0),
      (ke = {
        serviceId: Le,
        via: P.source,
      }),
      await sql`UPDATE tenants SET deploys_period = deploys_period + 1, updated_at = now() WHERE id = ${e.tenant.id}`);
  return (
    await sql`INSERT INTO deploys (id, tenant, grant_id, name, template, intent, plan, status, executed, railway_service_id, target, result)
    VALUES (${C}, ${e.tenant.id}, ${e.row.id}, ${c}, ${t.template}, ${t}::jsonb, ${$}::jsonb, ${ee}, ${te}, ${Le},
            ${{
              project: o,
              environment: l,
            }}::jsonb, ${ke}::jsonb)`,
    await recordEvent(
      te ? "deploy.requested" : "deploy.planned",
      {
        id: C,
        name: c,
        template: t.template,
        reason: J,
        executed: te,
      },
      e.tenant.id,
      n,
    ),
    {
      id: C,
      executed: te,
      status: ee,
      reason: J,
      plan: $,
      result: ke,
    }
  );
}
async function refreshDeployStatus(e, t) {
  let a = (await sql`SELECT * FROM deploys WHERE id = ${t} AND tenant = ${e.tenant.id}`)[0];
  if (!a) throw new HttpError(404, "deploy_not_found");
  let n = await resolveRailwayToken(e.tenant.id);
  if (a.railway_service_id && n)
    try {
      let r = parseJson(a.target),
        s = (
          await railwayGraphql(
            n.token,
            "query($i: DeploymentListInput!) { deployments(input: $i, first: 1) { edges { node { id status createdAt } } } }",
            {
              i: {
                projectId: r.project,
                serviceId: a.railway_service_id,
              },
            },
          )
        )?.deployments?.edges?.[0]?.node;
      if (s)
        (await sql`UPDATE deploys SET status = ${String(s.status).toLowerCase()}, railway_deployment_id = ${s.id}, updated_at = now() WHERE id = ${a.id}`,
          (a.status = String(s.status).toLowerCase()));
      await settleGrantUsage(
        e.row.id,
        {
          usd_cents: 0,
          calls: 1,
          deploys: 0,
        },
        a.id,
        "status",
      );
    } catch (r) {}
  return a;
}
async function hasActiveBreakglass(e) {
  return (await sql`SELECT 1 FROM breakglass WHERE tenant = ${e} AND until > now() LIMIT 1`).length > 0;
}
async function deleteDeploy(e, t, a) {
  let n = (await sql`SELECT * FROM deploys WHERE id = ${t} AND tenant = ${e.tenant.id}`)[0];
  if (!n) throw new HttpError(404, "deploy_not_found");
  if (!parseJson(e.row.constraints).allowDelete) throw new HttpError(403, "delete_not_allowed_by_grant");
  if (
    (parseJson(n.target || {}).environment || "production") === "production" &&
    !(await hasActiveBreakglass(e.tenant.id))
  )
    throw new HttpError(403, "breakglass_required");
  let r = await resolveRailwayToken(e.tenant.id);
  if (n.railway_service_id) {
    if (!r)
      throw new HttpError(503, "unarmed", {
        needs: "RAILWAY_API_TOKEN",
      });
    (await railwayGraphql(r.token, "mutation($id: String!) { serviceDelete(id: $id) }", {
      id: n.railway_service_id,
    }),
      await settleGrantUsage(
        e.row.id,
        {
          usd_cents: 0,
          calls: 1,
          deploys: 0,
        },
        n.id,
        "delete",
      ));
  }
  return (
    await sql`UPDATE deploys SET status = 'deleted', updated_at = now() WHERE id = ${n.id}`,
    await recordEvent(
      "deploy.deleted",
      {
        id: n.id,
        name: n.name,
      },
      e.tenant.id,
      a,
    ),
    {
      id: n.id,
      status: "deleted",
    }
  );
}
async function restartDeploy(e, t, a) {
  let n = (await sql`SELECT * FROM deploys WHERE id = ${t} AND tenant = ${e.tenant.id}`)[0];
  if (!n) throw new HttpError(404, "deploy_not_found");
  if (!n.railway_deployment_id) throw new HttpError(409, "no_live_deployment");
  let r = await resolveRailwayToken(e.tenant.id);
  if (!r)
    throw new HttpError(503, "unarmed", {
      needs: "RAILWAY_API_TOKEN",
    });
  return (
    await railwayGraphql(r.token, "mutation($id: String!) { deploymentRestart(id: $id) }", {
      id: n.railway_deployment_id,
    }),
    await settleGrantUsage(
      e.row.id,
      {
        usd_cents: 0,
        calls: 1,
        deploys: 0,
      },
      n.id,
      "restart",
    ),
    await recordEvent(
      "deploy.restarted",
      {
        id: n.id,
      },
      e.tenant.id,
      a,
    ),
    {
      id: n.id,
      restarted: !0,
    }
  );
}
function guessTemplateFromIntent(e) {
  let t = e.toLowerCase();
  if (/\bprobe|smoke|hello|whoami\b/.test(t)) return "probe";
  if (/\btip|alert|donat/.test(t)) return "tip-alert-bot";
  if (/\bpaywall|unlock|checkout|ppv\b/.test(t)) return "paywall-link";
  if (/\bclip|post|schedul/.test(t)) return "clip-poster";
  if (/\bdm\b|message|respond|inbox/.test(t)) return "dm-autoresponder";
  if (/\brelay|webhook|bridge\b/.test(t)) return "webhook-relay";
  return null;
}
async function gatherPlanEvidence(e, t, a) {
  let n = await searchMemories(e, a ? `${a} ${t}` : t, "", 5),
    r = a
      ? await sql`SELECT 1 FROM events WHERE tenant = ${e} AND type = 'worker.failed' AND data->>'template' = ${a} LIMIT 3`
      : [];
  return {
    evidence: n.map((s) => ({
      id: s.id,
      partition: s.partition,
      key: s.key,
      snippet: s.content.slice(0, 200),
    })),
    priorFailures: r.length,
  };
}
function buildDeterministicPlan(
  e,
  t,
  a,
  n = {},
  r = {
    evidence: [],
    priorFailures: 0,
  },
) {
  let s = n.template && TEMPLATES[n.template] ? n.template : guessTemplateFromIntent(a);
  if (!s)
    return {
      needsClarification: !0,
      options: Object.keys(TEMPLATES),
      question:
        "Which worker? (probe, tip-alert-bot, paywall-link, clip-poster, dm-autoresponder, webhook-relay)",
      evidence: r.evidence,
    };
  let i = TEMPLATES[s],
    o = TIERS[e.tier],
    l = parseJson(t.scope),
    c = l.workers?.namePrefix || tenantWorkerPrefix(e.id),
    E = `${c}${s}-${randomBytes(2).toString("hex")}`.slice(0, 48),
    T = Math.min(3600, o.maxTtlSec),
    R = {
      usd_cents: Math.min(i.estCents * 2, remainingBudget(t).usd_cents),
      calls: Math.min(20, remainingBudget(t).calls),
      deploys: Math.min(1, remainingBudget(t).deploys),
    };
  return {
    intent: a,
    template: s,
    grants: [
      {
        key: "deployer",
        sub: `agent:deployer:${s}`,
        caps: ["deploy.worker", "worker.status", "memory.read", "memory.write"],
        ttlSec: T,
        budget: R,
        scope: {
          railway: {
            projects: l.railway?.projects || [],
            environments: l.railway?.environments || ["production"],
          },
          workers: {
            namePrefix: c,
          },
          memory: {
            partitions: [`worker:${E}`, `agent:deployer:${s}`],
          },
        },
        constraints: {
          maxWorkers: 1,
          maxReplicas: 1,
          allowDelete: !1,
          requireDryRun: !0,
        },
      },
    ],
    deploys: [
      {
        grant: "deployer",
        name: E,
        template: s,
        env: n.env || {},
        replicas: 1,
        target: {
          project: l.railway?.projects?.[0] || null,
          environment: l.railway?.environments?.[0] || "production",
        },
      },
    ],
    estimate: {
      usd_cents: i.estCents,
      deploys: 1,
      missingEnv: i.needs.filter((S) => !(n.env || {})[S]),
    },
    rationale: `Template "${s}" (${i.desc}). One sub-agent grant, one worker, dry-run first.${r.priorFailures ? ` ${r.priorFailures} prior failure(s) on this template \u2014 check evidence.` : ""}`,
    evidence: r.evidence,
    warnings: r.priorFailures ? [`prior_failures:${s}:${r.priorFailures}`] : [],
    planner: "deterministic",
  };
}
async function planWithLlm(e, t, a, n, r) {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    let s = (
      (
        await (
          await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: env.COG_MODEL || "claude-sonnet-4-5",
              max_tokens: 300,
              system: `You are the COG planner. Choose exactly one template from: ${Object.keys(TEMPLATES).join(", ")}. Reply ONLY with JSON {"template": string, "env": object, "why": string}. Never invent secrets.`,
              messages: [
                {
                  role: "user",
                  content: `Creator intent: ${a}
Hints: ${JSON.stringify(n)}
Evidence (prior memory): ${JSON.stringify(r.evidence.map((l) => l.snippet))}`,
                },
              ],
            }),
          })
        ).json()
      )?.content?.[0]?.text || ""
    ).match(/\{[\s\S]*\}/);
    if (!s) return null;
    let i = JSON.parse(s[0]);
    if (!TEMPLATES[i.template]) return null;
    let o = buildDeterministicPlan(
      e,
      t,
      a,
      {
        ...n,
        template: i.template,
        env: {
          ...(n.env || {}),
          ...(i.env || {}),
        },
      },
      r,
    );
    return ((o.planner = "llm+deterministic"), (o.rationale = `${i.why || ""} \u2014 ${o.rationale}`), o);
  } catch {
    return null;
  }
}
async function cogPlan(e, t, a) {
  let n = await gatherPlanEvidence(
      e.tenant.id,
      t,
      a.template && TEMPLATES[a.template] ? a.template : guessTemplateFromIntent(t),
    ),
    r = (await planWithLlm(e.tenant, e.row, t, a, n)) || buildDeterministicPlan(e.tenant, e.row, t, a, n);
  return (
    await recordEvent(
      "cog.planned",
      {
        template: r.template || null,
        planner: r.planner || "n/a",
      },
      e.tenant.id,
      e.row.sub,
    ),
    r
  );
}
async function cogExecute(e, t, a) {
  let n = gatehouseEvaluate(e.tenant, e.row, t);
  if (!n.ok)
    throw (
      await recordEvent(
        "cog.denied",
        {
          reasons: n.reasons,
        },
        e.tenant.id,
        e.row.sub,
      ),
      new HttpError(403, "gatehouse_denied", n.reasons)
    );
  let r = {};
  for (let i of t.grants) {
    if (!parseJson(e.row.caps).includes("grant.issue"))
      throw new HttpError(403, "missing_cap", {
        need: "grant.issue",
      });
    let o = await issueChildGrant(e.row, i, e.row.sub);
    r[i.key || o.row.id] = {
      id: o.row.id,
      token: o.token,
      row: o.row,
    };
  }
  let s = [];
  for (let i of t.deploys) {
    let o = r[i.grant];
    if (!o) throw new HttpError(400, "deploy_references_unknown_grant");
    let l = i.target || {},
      c = await deployWorker(
        {
          row: o.row,
          tenant: e.tenant,
        },
        {
          name: i.name,
          template: i.template,
          env: i.env,
          replicas: i.replicas,
          target: l,
        },
        !!a,
        o.row.sub,
      );
    (s.push(c),
      await writeMemory(
        e.tenant.id,
        "agent:cog",
        `deploy:${i.name}`,
        `${i.template} \u2192 ${c.status}${c.reason ? ` (${c.reason})` : ""} via ${o.row.sub}; image ${c.plan.image}; deploy ${c.id}`,
        ["cog", i.template, c.status],
        e.row.sub,
      ));
  }
  return (
    await recordEvent(
      "cog.executed",
      {
        grants: Object.values(r).map((i) => i.id),
        deploys: s.map((i) => i.id),
        confirm: !!a,
      },
      e.tenant.id,
      e.row.sub,
    ),
    {
      grants: Object.fromEntries(
        Object.entries(r).map(([i, o]) => [
          i,
          {
            id: o.id,
            token: o.token,
            sub: o.row.sub,
            exp: Number(o.row.exp),
          },
        ]),
      ),
      deploys: s,
    }
  );
}
function verifyTimestampedSignature(e, t, a, n = 300) {
  if (!t) return !1;
  let r = Object.fromEntries(t.split(",").map((o) => o.split("=").map((l) => l.trim()))),
    s = r.t,
    i = r.v1;
  if (!s || !i) return !1;
  if (Math.abs(nowSec() - Number(s)) > n) return !1;
  return safeEqual(hmacSha256(a, `${s}.${e}`), i);
}
async function recordWebhookEvent(e, t, a, n) {
  let r =
    await sql`INSERT INTO webhook_events (source, event_id, type, payload) VALUES (${e}, ${t}, ${a}, ${n}::jsonb)
    ON CONFLICT (source, event_id) DO NOTHING RETURNING id`;
  return r.length ? r[0].id : null;
}
async function markWebhookHandled(e, t) {
  await sql`UPDATE webhook_events SET handled = true, result = ${t}::jsonb WHERE id = ${e}`;
}
async function handleStripeEvent(e) {
  let t = e.type,
    a = e.data?.object || {},
    n = (() => {
      try {
        return JSON.parse(env.STRIPE_PRICE_MAP || "{}");
      } catch {
        return {};
      }
    })(),
    r = (i) => (i && n[i]) || null,
    s = async (i) => (i ? (await sql`SELECT * FROM tenants WHERE stripe_customer = ${i}`)[0] : null);
  if (t === "checkout.session.completed") {
    let i = a.client_reference_id || a.metadata?.tenant,
      o = i ? await getTenant(i) : null;
    if (!o)
      return {
        ignored: "no_tenant",
      };
    return (
      await sql`UPDATE tenants SET stripe_customer = ${a.customer || null}, stripe_subscription = ${a.subscription || null}, status = 'active', period_start = now(), deploys_period = 0, updated_at = now() WHERE id = ${o.id}`,
      await recordEvent(
        "billing.activated",
        {
          customer: a.customer,
        },
        o.id,
        "stripe",
      ),
      {
        activated: o.id,
      }
    );
  }
  if (t === "customer.subscription.updated" || t === "customer.subscription.created") {
    let i = await s(a.customer);
    if (!i)
      return {
        ignored: "unknown_customer",
      };
    let o = r(a.items?.data?.[0]?.price?.id),
      l = ["active", "trialing"].includes(a.status) ? "active" : "suspended";
    if (o)
      await sql`UPDATE tenants SET tier = ${o}, status = ${l}, stripe_subscription = ${a.id}, updated_at = now() WHERE id = ${i.id}`;
    else
      await sql`UPDATE tenants SET status = ${l}, stripe_subscription = ${a.id}, updated_at = now() WHERE id = ${i.id}`;
    return (
      await recordEvent(
        "billing.updated",
        {
          tier: o,
          status: l,
        },
        i.id,
        "stripe",
      ),
      {
        tenant: i.id,
        tier: o,
        status: l,
      }
    );
  }
  if (t === "customer.subscription.deleted" || t === "invoice.payment_failed") {
    let i = await s(a.customer);
    if (!i)
      return {
        ignored: "unknown_customer",
      };
    return (
      await sql`UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = ${i.id}`,
      await recordEvent(
        "billing.suspended",
        {
          reason: t,
        },
        i.id,
        "stripe",
      ),
      {
        suspended: i.id,
      }
    );
  }
  if (t === "invoice.paid") {
    let i = await s(a.customer);
    if (!i)
      return {
        ignored: "unknown_customer",
      };
    return (
      await sql`UPDATE tenants SET status = 'active', period_start = now(), deploys_period = 0, updated_at = now() WHERE id = ${i.id}`,
      await recordEvent("billing.period_reset", {}, i.id, "stripe"),
      {
        period_reset: i.id,
      }
    );
  }
  return {
    ignored: t,
  };
}
async function handleRailwayEvent(e) {
  let t = e.resource?.service?.id,
    a = e.resource?.deployment?.id,
    n = String(e.details?.status || e.type || "")
      .toLowerCase()
      .replace("deployment.", "");
  if (!t)
    return {
      ignored: "no_service",
    };
  let r =
    await sql`UPDATE deploys SET status = ${n}, railway_deployment_id = ${a || null}, updated_at = now() WHERE railway_service_id = ${t} RETURNING id, tenant, name, template`;
  for (let s of r)
    if (
      (await recordEvent(
        "deploy.status",
        {
          id: s.id,
          name: s.name,
          status: n,
        },
        s.tenant,
        "railway",
      ),
      /fail|crash/.test(n))
    )
      (await recordEvent(
        "worker.failed",
        {
          id: s.id,
          name: s.name,
          template: s.template,
          status: n,
          repairHint: "COG may propose a bounded repair grant",
        },
        s.tenant,
        "railway",
      ),
        await writeMemory(
          s.tenant,
          `worker:${s.name}`,
          `status:${n}`,
          `worker ${s.name} (${s.template}) ${n} at ${new Date().toISOString()}`,
          ["railway", s.template, n],
          "railway",
        ));
  return {
    matched: r.length,
    status: n,
  };
}
var sourceSha256 = "unknown",
  sourceBytes = 0,
  sourceText = "",
  app = new Hono(),
  bearerToken = (e) => {
    let t = e.req.header("authorization") || "";
    return t.startsWith("Bearer ") ? t.slice(7).trim() : e.req.header("x-grant") || void 0;
  },
  isAdminRequest = (e) =>
    !!env.RUNTIME_ADMIN_KEY && !!bearerToken(e) && safeEqual(bearerToken(e), env.RUNTIME_ADMIN_KEY),
  tagAuth = (e, t) =>
    Object.assign(e, {
      auth: t,
    }),
  requireAdmin = tagAuth(async (e, t) => {
    if (!env.RUNTIME_ADMIN_KEY)
      throw new HttpError(503, "unarmed", {
        needs: "RUNTIME_ADMIN_KEY",
      });
    if (!isAdminRequest(e)) throw new HttpError(401, "admin_required");
    await t();
  }, "admin"),
  requireGrant = (e) =>
    tagAuth(
      async (t, a) => {
        (t.set("auth", await verifyGrant(bearerToken(t), e)), await a());
      },
      e ? `grant:${e}` : "grant",
    ),
  readJsonBody = async (e) => {
    try {
      return await e.req.json();
    } catch {
      return {};
    }
  };
app.onError((e, t) => {
  if (e instanceof HttpError)
    return t.json(
      {
        error: e.code,
        detail: e.detail ?? null,
      },
      e.status,
    );
  let a = e?.status && Number.isInteger(e.status) ? e.status : 500,
    n = e?.message && a < 500 ? e.message : "internal_error";
  if (a >= 500) console.error("ERR", e?.stack || e);
  return t.json(
    {
      error: n,
      detail: e?.detail ?? (env.RUNTIME_MODE === "dev" ? String(e?.message) : null),
    },
    a,
  );
});
app.notFound((e) =>
  e.json(
    {
      error: "not_found",
      hint: "GET /routes",
    },
    404,
  ),
);
app.get("/health", async (e) => {
  let t = !1;
  try {
    (await sql`SELECT 1`, (t = !0));
  } catch {}
  return e.json(
    {
      ok: t,
      service: SERVICE_NAME,
      version: VERSION,
      policy: POLICY_VERSION,
      db: t,
      killSwitch: await isKillSwitchOn(),
      armed: armedIntegrations(),
      fingerprints: secretFingerprints(),
      source: {
        sha256: sourceSha256,
        bytes: sourceBytes,
        chunks: e.req.query("chunks")
          ? Array.from(
              {
                length: Math.ceil(sourceText.length / 4096),
              },
              (a, n) => sha256Hex(sourceText.slice(n * 4096, (n + 1) * 4096)).slice(0, 8),
            )
          : void 0,
      },
      time: new Date().toISOString(),
    },
    t ? 200 : 503,
  );
});
app.get("/.well-known/creator-os.json", (e) =>
  e.json({
    name: SERVICE_NAME,
    version: VERSION,
    policy: POLICY_VERSION,
    surfaces: {
      api: "/api",
      mcp: "/mcp",
      docs: "/docs",
      routes: "/routes",
      cockpit: "/",
    },
    caps: CAPS,
    tiers: TIERS,
    templates: Object.fromEntries(
      Object.entries(TEMPLATES).map(([t, a]) => [
        t,
        {
          desc: a.desc,
          needs: a.needs,
          estCents: a.estCents,
        },
      ]),
    ),
    armed: armedIntegrations(),
  }),
);
app.post("/api/tenants", requireAdmin, async (e) => {
  let t = await readJsonBody(e),
    a = TIERS[t.tier] ? t.tier : "starter",
    n = newId("t"),
    r = {
      railway: {
        projects: Array.isArray(t.railwayProjects) ? t.railwayProjects : [],
        environments: Array.isArray(t.environments) ? t.environments : ["production"],
      },
    };
  await sql`INSERT INTO tenants (id, name, tier, allowed_targets) VALUES (${n}, ${String(t.name || "creator").slice(0, 80)}, ${a}, ${r}::jsonb)`;
  let s = await getTenant(n),
    i = await mintRootGrant(s);
  return (
    await recordEvent(
      "tenant.created",
      {
        tier: a,
      },
      n,
      "admin",
    ),
    e.json(
      {
        tenant: s,
        rootGrant: {
          id: i.row.id,
          token: i.token,
          exp: Number(i.row.exp),
        },
      },
      201,
    )
  );
});
app.get("/api/tenants", requireAdmin, async (e) =>
  e.json({
    tenants:
      await sql`SELECT id, name, tier, status, deploys_period, period_start, allowed_targets, created_at FROM tenants ORDER BY created_at DESC LIMIT 200`,
  }),
);
app.get("/api/tenants/:id", requireAdmin, async (e) => {
  let t = await getTenant(e.req.param("id"));
  if (!t) throw new HttpError(404, "tenant_not_found");
  return e.json({
    tenant: t,
  });
});
app.post("/api/tenants/:id/tier", requireAdmin, async (e) => {
  let t = await readJsonBody(e);
  if (!TIERS[t.tier]) throw new HttpError(400, "unknown_tier");
  return (
    await sql`UPDATE tenants SET tier = ${t.tier}, updated_at = now() WHERE id = ${e.req.param("id")}`,
    await recordEvent(
      "tenant.tier",
      {
        tier: t.tier,
      },
      e.req.param("id"),
      "admin",
    ),
    e.json({
      ok: !0,
    })
  );
});
app.post("/api/tenants/:id/suspend", requireAdmin, async (e) => {
  return (
    await sql`UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = ${e.req.param("id")}`,
    await recordEvent("tenant.suspended", {}, e.req.param("id"), "admin"),
    e.json({
      ok: !0,
    })
  );
});
app.post("/api/tenants/:id/resume", requireAdmin, async (e) => {
  return (
    await sql`UPDATE tenants SET status = 'active', updated_at = now() WHERE id = ${e.req.param("id")}`,
    await recordEvent("tenant.resumed", {}, e.req.param("id"), "admin"),
    e.json({
      ok: !0,
    })
  );
});
app.post("/api/tenants/:id/targets", requireAdmin, async (e) => {
  let t = await readJsonBody(e),
    a = {
      railway: {
        projects: t.railwayProjects || [],
        environments: t.environments || ["production"],
      },
    };
  return (
    await sql`UPDATE tenants SET allowed_targets = ${a}::jsonb, updated_at = now() WHERE id = ${e.req.param("id")}`,
    e.json({
      ok: !0,
      allowed: a,
    })
  );
});
app.post("/api/tenants/:id/root-grant", requireAdmin, async (e) => {
  let t = await getTenant(e.req.param("id"));
  if (!t) throw new HttpError(404, "tenant_not_found");
  let a = await mintRootGrant(t, String((await readJsonBody(e)).sub || "tenant:root"));
  return e.json(
    {
      id: a.row.id,
      token: a.token,
      exp: Number(a.row.exp),
    },
    201,
  );
});
app.post("/api/admin/kill", requireAdmin, async (e) => {
  return (
    await setSetting("kill_switch", "on"),
    await recordEvent("runtime.paused", {}, null, "admin"),
    e.json({
      killSwitch: !0,
    })
  );
});
app.post("/api/admin/resume", requireAdmin, async (e) => {
  return (
    await setSetting("kill_switch", "off"),
    await recordEvent("runtime.resumed", {}, null, "admin"),
    e.json({
      killSwitch: !1,
    })
  );
});
app.get("/api/admin/policy", requireAdmin, (e) =>
  e.json({
    policy: POLICY_VERSION,
    caps: CAPS,
    tiers: TIERS,
    templates: TEMPLATES,
    rateLimitPerMin: RATE_LIMIT_MAX_PER_MIN,
  }),
);
app.post("/api/admin/breakglass", requireAdmin, async (e) => {
  let t = await readJsonBody(e),
    a = Math.min(25, Math.max(1, Math.floor(+t.minutes || 5)));
  if (!t.tenant || !(await getTenant(t.tenant))) throw new HttpError(404, "tenant_not_found");
  let n = new Date(Date.now() + a * 60000);
  return (
    await sql`INSERT INTO breakglass (tenant, until, reason) VALUES (${t.tenant}, ${n}, ${String(t.reason || "").slice(0, 200)})`,
    await recordEvent(
      "breakglass.armed",
      {
        minutes: a,
        until: n,
      },
      t.tenant,
      "admin",
    ),
    e.json({
      tenant: t.tenant,
      until: n,
    })
  );
});
app.post("/api/admin/grants/:id/revoke", requireAdmin, async (e) =>
  e.json({
    revoked: await revokeGrantTree(
      e.req.param("id"),
      String((await readJsonBody(e)).reason || "admin"),
      "admin",
    ),
  }),
);
app.post("/api/admin/grants/:id/token", requireAdmin, async (e) => {
  let t = await getGrant(e.req.param("id"));
  if (!t || t.status !== "active") throw new HttpError(404, "grant_not_active");
  return e.json({
    id: t.id,
    token: reissueGrantToken(t),
  });
});
app.get("/api/admin/overview", requireAdmin, async (e) => {
  let [t, a, n, r, s] = await Promise.all([
    sql`SELECT status, count(*)::int n FROM tenants GROUP BY status`,
    sql`SELECT status, count(*)::int n FROM grants GROUP BY status`,
    sql`SELECT status, count(*)::int n FROM deploys GROUP BY status`,
    sql`SELECT source, count(*)::int n FROM webhook_events GROUP BY source`,
    sql`SELECT kind, sum(usd_cents)::int usd_cents, sum(deploys)::int deploys FROM ledger GROUP BY kind`,
  ]);
  return e.json({
    tenants: t,
    grants: a,
    deploys: n,
    webhooks: r,
    ledger: s,
    killSwitch: await isKillSwitchOn(),
    armed: armedIntegrations(),
  });
});
app.get("/api/admin/grants", requireAdmin, async (e) =>
  e.json({
    grants: (
      await sql`SELECT id, tenant, parent, depth, sub, status, caps, budget, reserved, settled, exp, created_at FROM grants ORDER BY created_at DESC LIMIT 200`
    ).map((t) => ({
      ...t,
      exp: Number(t.exp),
      remaining: remainingBudget(t),
    })),
  }),
);
app.get("/api/admin/deploys", requireAdmin, async (e) =>
  e.json({
    deploys:
      await sql`SELECT id, tenant, grant_id, name, template, status, executed, railway_service_id, target, created_at FROM deploys ORDER BY created_at DESC LIMIT 200`,
  }),
);
app.get("/api/admin/ledger", requireAdmin, async (e) =>
  e.json({
    ledger: await sql`SELECT * FROM ledger ORDER BY id DESC LIMIT 300`,
  }),
);
app.get("/api/admin/webhooks", requireAdmin, async (e) =>
  e.json({
    webhooks:
      await sql`SELECT id, source, event_id, type, received_at, handled, result FROM webhook_events ORDER BY id DESC LIMIT 200`,
  }),
);
app.get("/api/admin/events", requireAdmin, async (e) =>
  e.json({
    events: await sql`SELECT * FROM events ORDER BY id DESC LIMIT 300`,
  }),
);
app.get("/api/grants/verify", requireGrant(null), (e) => {
  let t = e.get("auth");
  return e.json({
    id: t.row.id,
    tenant: t.tenant.id,
    tier: t.tenant.tier,
    sub: t.row.sub,
    depth: t.row.depth,
    caps: parseJson(t.row.caps),
    scope: parseJson(t.row.scope),
    constraints: parseJson(t.row.constraints),
    budget: parseJson(t.row.budget),
    remaining: remainingBudget(t.row),
    exp: Number(t.row.exp),
  });
});
app.post("/api/grants", requireGrant("grant.issue"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e),
    n = await issueChildGrant(t.row, a, t.row.sub);
  return e.json(
    {
      id: n.row.id,
      token: n.token,
      sub: n.row.sub,
      caps: parseJson(n.row.caps),
      budget: parseJson(n.row.budget),
      exp: Number(n.row.exp),
      parent: t.row.id,
    },
    201,
  );
});
app.get("/api/grants", requireGrant("grant.read"), async (e) => {
  let t = e.get("auth"),
    a =
      await sql`WITH RECURSIVE sub AS (SELECT * FROM grants WHERE id = ${t.row.id} UNION ALL SELECT g.* FROM grants g JOIN sub ON g.parent = sub.id) SELECT id, parent, depth, sub, status, caps, budget, reserved, settled, exp, created_at FROM sub ORDER BY depth, created_at`;
  return e.json({
    grants: a.map((n) => ({
      ...n,
      exp: Number(n.exp),
      remaining: remainingBudget(n),
    })),
  });
});
app.get("/api/grants/:id", requireGrant("grant.read"), async (e) => {
  let t = e.get("auth"),
    a = await getGrant(e.req.param("id"));
  if (!a || a.tenant !== t.tenant.id) throw new HttpError(404, "grant_not_found");
  let { payload: n, ...r } = a;
  return e.json({
    grant: {
      ...r,
      exp: Number(r.exp),
      remaining: remainingBudget(a),
    },
  });
});
app.post("/api/grants/:id/revoke", requireGrant("grant.issue"), async (e) => {
  let t = e.get("auth"),
    a = e.req.param("id");
  if (
    !(
      await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${t.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id) SELECT 1 FROM sub WHERE id = ${a}`
    ).length
  )
    throw new HttpError(403, "not_in_subtree");
  return e.json({
    revoked: await revokeGrantTree(
      a,
      String((await readJsonBody(e)).reason || "revoked by " + t.row.sub),
      t.row.sub,
    ),
  });
});
app.post("/api/cog/plan", requireGrant("cog.plan"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  if (!a.intent || typeof a.intent !== "string") throw new HttpError(400, "intent_required");
  return e.json({
    proposal: await cogPlan(t, a.intent.slice(0, 2000), a.hints || {}),
  });
});
app.post("/api/cog/execute", requireGrant("cog.execute"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  if (!a.proposal) throw new HttpError(400, "proposal_required");
  return e.json(await cogExecute(t, a.proposal, !!a.confirm));
});
app.get("/api/cog/templates", requireGrant("cog.plan"), (e) =>
  e.json({
    templates: Object.fromEntries(
      Object.entries(TEMPLATES).map(([t, a]) => [
        t,
        {
          desc: a.desc,
          needs: a.needs,
          estCents: a.estCents,
          image: a.image,
        },
      ]),
    ),
  }),
);
app.post("/api/deploys", requireGrant("deploy.worker"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  return e.json(await deployWorker(t, a, !!a.confirm, t.row.sub), 201);
});
app.get("/api/deploys", requireGrant("worker.status"), async (e) => {
  let t = e.get("auth");
  return e.json({
    deploys:
      await sql`SELECT id, grant_id, name, template, status, executed, target, created_at, updated_at FROM deploys WHERE tenant = ${t.tenant.id} ORDER BY created_at DESC LIMIT 100`,
  });
});
app.get("/api/deploys/:id", requireGrant("worker.status"), async (e) => {
  let t = e.get("auth");
  return e.json({
    deploy: await refreshDeployStatus(t, e.req.param("id")),
  });
});
app.post("/api/deploys/:id/restart", requireGrant("worker.restart"), async (e) => {
  let t = e.get("auth");
  return e.json(await restartDeploy(t, e.req.param("id"), t.row.sub));
});
app.delete("/api/deploys/:id", requireGrant("worker.delete"), async (e) => {
  let t = e.get("auth");
  return e.json(await deleteDeploy(t, e.req.param("id"), t.row.sub));
});
app.get("/api/ledger", requireGrant("ledger.read"), async (e) => {
  let t = e.get("auth");
  return e.json({
    ledger: await sql`SELECT * FROM ledger WHERE tenant = ${t.tenant.id} ORDER BY id DESC LIMIT 200`,
  });
});
app.get("/api/events", requireGrant("tenant.read"), async (e) => {
  let t = e.get("auth");
  return e.json({
    events: await sql`SELECT * FROM events WHERE tenant = ${t.tenant.id} ORDER BY id DESC LIMIT 200`,
  });
});
app.post("/api/events", requireGrant("webhook.emit"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  if (!a.type) throw new HttpError(400, "type_required");
  return (
    await recordEvent(`agent.${String(a.type).slice(0, 60)}`, a.data ?? {}, t.tenant.id, t.row.sub),
    e.json(
      {
        ok: !0,
      },
      201,
    )
  );
});
app.get("/api/tenant", requireGrant("tenant.read"), (e) => {
  let t = e.get("auth"),
    { stripe_customer: a, stripe_subscription: n, ...r } = t.tenant;
  return e.json({
    tenant: r,
    tier: TIERS[r.tier],
  });
});
var assertMemoryScope = (e, t) => {
  if (!memoryPartitions(parseJson(e.row.scope)).some((a) => t.startsWith(a)))
    throw new HttpError(403, "out_of_scope", {
      partition: t,
    });
  return t;
};
app.post("/api/memory", requireGrant("memory.write"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  if (!a.content || typeof a.content !== "string") throw new HttpError(400, "content_required");
  let n = assertMemoryScope(t, String(a.partition || "tenant").slice(0, 80));
  return e.json(
    {
      memory: await writeMemory(
        t.tenant.id,
        n,
        a.key ? String(a.key).slice(0, 120) : null,
        a.content.slice(0, 20000),
        Array.isArray(a.tags) ? a.tags.slice(0, 20).map(String) : [],
        t.row.sub,
      ),
    },
    201,
  );
});
app.get("/api/memory", requireGrant("memory.read"), async (e) => {
  let t = e.get("auth"),
    a = e.req.query("partition"),
    n = a ? assertMemoryScope(t, a) : memoryPartitions(parseJson(t.row.scope))[0];
  return e.json({
    memories: await searchMemories(t.tenant.id, e.req.query("q") || "", n, +(e.req.query("limit") || 10)),
  });
});
app.get("/api/memory/:id", requireGrant("memory.read"), async (e) => {
  let t = e.get("auth"),
    a = await sql`SELECT * FROM memories WHERE id = ${e.req.param("id")} AND tenant = ${t.tenant.id}`;
  if (!a.length) throw new HttpError(404, "memory_not_found");
  return (
    assertMemoryScope(t, a[0].partition),
    e.json({
      memory: serializeMemory(a[0]),
    })
  );
});
app.delete("/api/memory/:id", requireGrant("memory.write"), async (e) => {
  let t = e.get("auth"),
    a = await sql`SELECT partition FROM memories WHERE id = ${e.req.param("id")} AND tenant = ${t.tenant.id}`;
  if (!a.length) throw new HttpError(404, "memory_not_found");
  return (
    assertMemoryScope(t, a[0].partition),
    e.json({
      memory: await forgetMemory(t.tenant.id, e.req.param("id")),
    })
  );
});
var requireSyncToken = tagAuth(async (e, t) => {
  if (!env.COG_SYNC_TOKEN)
    throw new HttpError(503, "unarmed", {
      needs: "COG_SYNC_TOKEN",
    });
  let a = bearerToken(e);
  if (!a || !safeEqual(a, env.COG_SYNC_TOKEN)) throw new HttpError(401, "sync_token_required");
  await t();
}, "sync-token");
app.get("/sync/changes", requireSyncToken, async (e) => {
  let t = Number(e.req.query("since") || 0),
    a = await sql`SELECT * FROM memories WHERE version > ${t} ORDER BY version ASC LIMIT 500`;
  return e.json({
    records: a.map(toSyncRecord),
    next: a.length ? Number(a[a.length - 1].version) : t,
    more: a.length === 500,
  });
});
app.post("/sync/apply", requireSyncToken, async (e) => {
  let t = await readJsonBody(e);
  if (!Array.isArray(t.records)) throw new HttpError(400, "records_required");
  return e.json(await applySyncRecords(t.records.slice(0, 500)));
});
app.get("/api/admin/outbox", requireAdmin, async (e) =>
  e.json({
    outbox:
      await sql`SELECT id, kind, attempts, next_at, done, last_error, created_at FROM outbox ORDER BY id DESC LIMIT 200`,
  }),
);
app.post("/api/admin/outbox/drain", requireAdmin, async (e) => e.json(await drainOutbox(200)));
app.post("/api/admin/memory/pull", requireAdmin, async (e) => e.json(await pullMemoryFromBridge()));
app.get("/api/admin/memory", requireAdmin, async (e) =>
  e.json({
    memories: (await sql`SELECT * FROM memories ORDER BY updated_at DESC LIMIT 200`).map(serializeMemory),
  }),
);
app.get("/auth/railway/start", requireGrant("tenant.read"), async (e) => {
  let t = e.get("auth");
  if (!env.RAILWAY_OAUTH_CLIENT_ID || !env.RAILWAY_OAUTH_CLIENT_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "RAILWAY_OAUTH_CLIENT_ID+SECRET",
    });
  if (!vaultKey())
    throw new HttpError(503, "unarmed", {
      needs: "VAULT_KEY",
    });
  let a = randomBytes(32).toString("base64url"),
    n = createHash("sha256").update(a).digest("base64url"),
    r = randomBytes(16).toString("base64url");
  await sql`INSERT INTO oauth_states (state, tenant, verifier) VALUES (${r}, ${t.tenant.id}, ${a})`;
  let s = `${env.PUBLIC_URL || new URL(e.req.url).origin}/auth/railway/callback`,
    i = new URL("https://backboard.railway.com/oauth/auth");
  return (
    (i.search = new URLSearchParams({
      response_type: "code",
      client_id: env.RAILWAY_OAUTH_CLIENT_ID,
      redirect_uri: s,
      scope: "openid",
      state: r,
      code_challenge: n,
      code_challenge_method: "S256",
    }).toString()),
    e.json({
      authorizeUrl: i.toString(),
      redirect_uri: s,
      state: r,
    })
  );
});
app.get("/auth/railway/callback", async (e) => {
  if (!env.RAILWAY_OAUTH_CLIENT_ID || !env.RAILWAY_OAUTH_CLIENT_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "RAILWAY_OAUTH_CLIENT_ID+SECRET",
    });
  let { code: t, state: a, error: n } = e.req.query();
  if (n) throw new HttpError(400, "oauth_denied", n);
  let r = a
    ? (
        await sql`DELETE FROM oauth_states WHERE state = ${a} AND created_at > now() - interval '10 minutes' RETURNING *`
      )[0]
    : null;
  if (!r || !t) throw new HttpError(400, "bad_state");
  let s = `${env.PUBLIC_URL || new URL(e.req.url).origin}/auth/railway/callback`,
    i = await fetch("https://backboard.railway.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization:
          "Basic " +
          Buffer.from(`${env.RAILWAY_OAUTH_CLIENT_ID}:${env.RAILWAY_OAUTH_CLIENT_SECRET}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: t,
        redirect_uri: s,
        code_verifier: r.verifier,
      }),
    }),
    o = await i.json().catch(() => ({}));
  if (!i.ok || !o.access_token) throw new HttpError(502, "token_exchange_failed");
  let l = vaultEncrypt(JSON.stringify(o));
  return (
    await sql`INSERT INTO vault (id, tenant, provider, ciphertext, iv, tag, meta) VALUES (${newId("v")}, ${r.tenant}, 'railway', ${l.ciphertext}, ${l.iv}, ${l.tag}, ${{
      scope: o.scope || null,
      obtained: new Date().toISOString(),
    }}::jsonb)
    ON CONFLICT (tenant, provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, meta = EXCLUDED.meta, created_at = now()`,
    await recordEvent(
      "vault.stored",
      {
        provider: "railway",
      },
      r.tenant,
      "oauth",
    ),
    e.html(
      '<!doctype html><meta charset=utf-8><title>Connected</title><body style="font-family:system-ui;padding:40px"><h2>Railway connected.</h2><p>You can close this tab.</p><a href="/">Back to hub</a>',
    )
  );
});
app.post("/webhooks/stripe", async (e) => {
  if (!env.STRIPE_WEBHOOK_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "STRIPE_WEBHOOK_SECRET",
    });
  let t = await e.req.text();
  if (!verifyTimestampedSignature(t, e.req.header("stripe-signature"), env.STRIPE_WEBHOOK_SECRET))
    throw new HttpError(401, "bad_signature");
  let a = JSON.parse(t),
    n = await recordWebhookEvent("stripe", String(a.id), a.type, a);
  if (n === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  let r = await handleStripeEvent(a);
  return (
    await markWebhookHandled(n, r),
    e.json({
      received: !0,
      result: r,
    })
  );
});
app.post("/webhooks/railway", async (e) => {
  if (!env.RAILWAY_WEBHOOK_TOKEN)
    throw new HttpError(503, "unarmed", {
      needs: "RAILWAY_WEBHOOK_TOKEN",
    });
  let t = e.req.query("token") || e.req.header("x-runtime-token") || "";
  if (!safeEqual(t, env.RAILWAY_WEBHOOK_TOKEN)) throw new HttpError(401, "bad_token");
  let a = await readJsonBody(e),
    n = `${a.resource?.deployment?.id || a.resource?.service?.id || "na"}:${a.type}:${a.timestamp || ""}`,
    r = await recordWebhookEvent("railway", n, a.type || null, a);
  if (r === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  let s = await handleRailwayEvent(a);
  return (
    await markWebhookHandled(r, s),
    e.json({
      received: !0,
      result: s,
    })
  );
});
app.post("/webhooks/github", async (e) => {
  if (!env.GITHUB_WEBHOOK_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "GITHUB_WEBHOOK_SECRET",
    });
  let t = await e.req.text(),
    a = e.req.header("x-hub-signature-256") || "";
  if (!safeEqual(a, "sha256=" + hmacSha256(env.GITHUB_WEBHOOK_SECRET, t)))
    throw new HttpError(401, "bad_signature");
  let n = JSON.parse(t || "{}"),
    r = e.req.header("x-github-delivery") || sha256Hex(t),
    s = e.req.header("x-github-event") || "unknown",
    i = await recordWebhookEvent("github", r, s, {
      repo: n.repository?.full_name,
      ref: n.ref,
      after: n.after,
    });
  if (i === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  return (
    await recordEvent(
      "repo." + s,
      {
        repo: n.repository?.full_name,
        ref: n.ref,
        after: n.after,
      },
      null,
      "github",
    ),
    await markWebhookHandled(i, {
      emitted: !0,
    }),
    e.json({
      received: !0,
    })
  );
});
app.post("/webhooks/brain", async (e) => {
  if (!env.BRAIN_WEBHOOK_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "BRAIN_WEBHOOK_SECRET",
    });
  let t = await e.req.text();
  if (!safeEqual(e.req.header("x-brain-signature") || "", hmacSha256(env.BRAIN_WEBHOOK_SECRET, t)))
    throw new HttpError(401, "bad_signature");
  let a = JSON.parse(t || "{}"),
    n = await recordWebhookEvent("brain", String(a.id || sha256Hex(t)), a.type || null, a);
  if (n === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  return (
    await recordEvent(
      "brain." + String(a.type || "event").slice(0, 60),
      a.data ?? a,
      a.tenant || null,
      "brain",
    ),
    await markWebhookHandled(n, {
      emitted: !0,
    }),
    e.json({
      received: !0,
    })
  );
});
app.post("/webhooks/mesh", async (e) => {
  if (!env.MESH_RECEIPT_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "MESH_RECEIPT_SECRET",
    });
  let t = await e.req.text();
  if (!safeEqual(e.req.header("x-mesh-signature") || "", hmacSha256(env.MESH_RECEIPT_SECRET, t)))
    throw new HttpError(401, "bad_signature");
  let a = JSON.parse(t || "{}"),
    n = await recordWebhookEvent("mesh", String(a.receipt_id || sha256Hex(t)), "receipt", a);
  if (n === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  let r = (await getSetting("receipt_grants")) === "on";
  return (
    await recordEvent(
      "mesh.receipt",
      {
        amount: a.amount,
        capability: a.capability,
        minted: r,
      },
      a.tenant || null,
      "mesh",
    ),
    await markWebhookHandled(n, {
      stored: !0,
      minted: !1,
      receiptGrants: r,
    }),
    e.json(
      {
        received: !0,
        stored: !0,
        minted: !1,
        note: r
          ? "receipt\u2192grant lane armed but minting not yet implemented"
          : "receipt stored; receipt\u2192grant lane is off",
      },
      202,
    )
  );
});
var MCP_TOOLS = [
    {
      name: "runtime_health",
      description: "Health + armed integrations",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "grant_verify",
      description: "Introspect the presented grant",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "grant_issue",
      description: "Mint an attenuated child grant (needs grant.issue)",
      inputSchema: {
        type: "object",
        properties: {
          sub: {
            type: "string",
          },
          caps: {
            type: "array",
            items: {
              type: "string",
            },
          },
          ttlSec: {
            type: "number",
          },
          budget: {
            type: "object",
          },
          scope: {
            type: "object",
          },
          constraints: {
            type: "object",
          },
        },
        required: ["sub", "caps"],
      },
    },
    {
      name: "grant_list",
      description: "List the presented grant and every grant under it (needs grant.read)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "grant_revoke",
      description: "Revoke a grant in your own subtree, cascading (needs grant.issue)",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
          },
          reason: {
            type: "string",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "cog_plan",
      description: "Ask the COG for a proposal from a natural-language intent",
      inputSchema: {
        type: "object",
        properties: {
          intent: {
            type: "string",
          },
          hints: {
            type: "object",
          },
        },
        required: ["intent"],
      },
    },
    {
      name: "cog_execute",
      description: "Proposal \u2192 gatehouse \u2192 grants + deploys (dry-run unless confirm)",
      inputSchema: {
        type: "object",
        properties: {
          proposal: {
            type: "object",
          },
          confirm: {
            type: "boolean",
          },
        },
        required: ["proposal"],
      },
    },
    {
      name: "deploy_worker",
      description: "Direct deploy intent (needs deploy.worker)",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
          },
          template: {
            type: "string",
          },
          env: {
            type: "object",
          },
          confirm: {
            type: "boolean",
          },
        },
        required: ["name", "template"],
      },
    },
    {
      name: "deploy_status",
      description: "Status of a deploy (needs worker.status)",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "ledger_query",
      description: "Tenant ledger tail (needs ledger.read)",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
          },
        },
      },
    },
    {
      name: "memory_search",
      description: "Search tenant memory (needs memory.read)",
      inputSchema: {
        type: "object",
        properties: {
          q: {
            type: "string",
          },
          partition: {
            type: "string",
          },
          limit: {
            type: "number",
          },
        },
      },
    },
    {
      name: "memory_write",
      description: "Remember something (needs memory.write)",
      inputSchema: {
        type: "object",
        properties: {
          partition: {
            type: "string",
          },
          key: {
            type: "string",
          },
          content: {
            type: "string",
          },
          tags: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
        required: ["content"],
      },
    },
    {
      name: "memory_forget",
      description: "Tombstone a memory (needs memory.write)",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
          },
        },
        required: ["id"],
      },
    },
  ],
  jsonRpcResponse = (e, t, a) =>
    a
      ? {
          jsonrpc: "2.0",
          id: e,
          error: a,
        }
      : {
          jsonrpc: "2.0",
          id: e,
          result: t,
        };
app.get("/mcp", (e) =>
  e.json({
    transport: "streamable-http",
    methods: ["initialize", "tools/list", "tools/call", "ping"],
    tools: MCP_TOOLS.map((t) => t.name),
    auth: "Bearer <grant>",
  }),
);
app.post("/mcp", async (e) => {
  let t = bearerToken(e),
    a = (l) =>
      e.json(
        {
          error: l,
        },
        401,
        {
          "WWW-Authenticate": `Bearer resource_metadata="${publicBaseUrl(e)}/.well-known/oauth-protected-resource"`,
        },
      );
  if (!t) return a("missing_grant");
  try {
    await verifyGrant(t, null);
  } catch (l) {
    if (l instanceof HttpError && l.status === 401) return a(l.code);
  }
  let n = await readJsonBody(e),
    r = n.id ?? null;
  if (n.method === "notifications/initialized") return e.body(null, 202);
  if (n.method === "initialize")
    return e.json(
      jsonRpcResponse(r, {
        protocolVersion: n.params?.protocolVersion || "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVICE_NAME,
          version: VERSION,
        },
      }),
    );
  if (n.method === "ping") return e.json(jsonRpcResponse(r, {}));
  if (n.method === "tools/list")
    return e.json(
      jsonRpcResponse(r, {
        tools: MCP_TOOLS,
      }),
    );
  if (n.method !== "tools/call")
    return e.json(
      jsonRpcResponse(r, void 0, {
        code: -32601,
        message: "method_not_found",
      }),
    );
  let s = n.params?.name,
    i = n.params?.arguments || {},
    o = (l) =>
      jsonRpcResponse(r, {
        content: [
          {
            type: "text",
            text: JSON.stringify(l),
          },
        ],
        structuredContent: l,
      });
  try {
    if (s === "runtime_health") {
      let E = !1;
      try {
        (await sql`SELECT 1`, (E = !0));
      } catch {}
      return e.json(
        o({
          ok: E,
          version: VERSION,
          armed: armedIntegrations(),
          killSwitch: await isKillSwitchOn(),
        }),
      );
    }
    let l = {
      grant_verify: null,
      grant_issue: "grant.issue",
      grant_list: "grant.read",
      grant_revoke: "grant.issue",
      cog_plan: "cog.plan",
      cog_execute: "cog.execute",
      deploy_worker: "deploy.worker",
      deploy_status: "worker.status",
      ledger_query: "ledger.read",
      memory_search: "memory.read",
      memory_write: "memory.write",
      memory_forget: "memory.write",
    };
    if (!(s in l))
      return e.json(
        jsonRpcResponse(r, void 0, {
          code: -32602,
          message: "unknown_tool",
        }),
      );
    let c = await verifyGrant(bearerToken(e), l[s]);
    switch (s) {
      case "grant_verify":
        return e.json(
          o({
            id: c.row.id,
            tenant: c.tenant.id,
            sub: c.row.sub,
            caps: parseJson(c.row.caps),
            scope: parseJson(c.row.scope),
            remaining: remainingBudget(c.row),
            exp: Number(c.row.exp),
          }),
        );
      case "grant_issue": {
        let E = await issueChildGrant(c.row, i, c.row.sub);
        return e.json(
          o({
            id: E.row.id,
            token: E.token,
            exp: Number(E.row.exp),
          }),
        );
      }
      case "grant_list": {
        let E =
          await sql`WITH RECURSIVE sub AS (SELECT * FROM grants WHERE id = ${c.row.id} UNION ALL SELECT g.* FROM grants g JOIN sub ON g.parent = sub.id) SELECT id, parent, depth, sub, status, caps, budget, reserved, settled, exp FROM sub ORDER BY depth, created_at`;
        return e.json(
          o({
            grants: E.map((T) => ({
              id: T.id,
              parent: T.parent,
              depth: T.depth,
              sub: T.sub,
              status: T.status,
              caps: parseJson(T.caps),
              exp: Number(T.exp),
              remaining: remainingBudget(T),
            })),
          }),
        );
      }
      case "grant_revoke": {
        let E = String(i.id || "");
        if (
          !(
            await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${c.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id) SELECT 1 FROM sub WHERE id = ${E}`
          ).length
        )
          throw new HttpError(403, "not_in_subtree");
        return e.json(
          o({
            revoked: await revokeGrantTree(
              E,
              String(i.reason || "revoked by " + c.row.sub).slice(0, 200),
              c.row.sub,
            ),
          }),
        );
      }
      case "cog_plan":
        return e.json(
          o({
            proposal: await cogPlan(c, String(i.intent || ""), i.hints || {}),
          }),
        );
      case "cog_execute":
        return e.json(o(await cogExecute(c, i.proposal, !!i.confirm)));
      case "deploy_worker":
        return e.json(o(await deployWorker(c, i, !!i.confirm, c.row.sub)));
      case "deploy_status":
        return e.json(
          o({
            deploy: await refreshDeployStatus(c, String(i.id)),
          }),
        );
      case "ledger_query":
        return e.json(
          o({
            ledger:
              await sql`SELECT * FROM ledger WHERE tenant = ${c.tenant.id} ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, +i.limit || 50))}`,
          }),
        );
      case "memory_search": {
        let E = i.partition
          ? assertMemoryScope(c, String(i.partition))
          : memoryPartitions(parseJson(c.row.scope))[0];
        return e.json(
          o({
            memories: await searchMemories(c.tenant.id, String(i.q || ""), E, +i.limit || 10),
          }),
        );
      }
      case "memory_write": {
        if (!i.content) throw new HttpError(400, "content_required");
        let E = assertMemoryScope(c, String(i.partition || "tenant").slice(0, 80));
        return e.json(
          o({
            memory: await writeMemory(
              c.tenant.id,
              E,
              i.key ? String(i.key).slice(0, 120) : null,
              String(i.content).slice(0, 20000),
              Array.isArray(i.tags) ? i.tags.map(String) : [],
              c.row.sub,
            ),
          }),
        );
      }
      case "memory_forget": {
        let E =
          await sql`SELECT partition FROM memories WHERE id = ${String(i.id)} AND tenant = ${c.tenant.id}`;
        if (!E.length) throw new HttpError(404, "memory_not_found");
        return (
          assertMemoryScope(c, E[0].partition),
          e.json(
            o({
              memory: await forgetMemory(c.tenant.id, String(i.id)),
            }),
          )
        );
      }
    }
  } catch (l) {
    if (l instanceof HttpError)
      return e.json({
        jsonrpc: "2.0",
        id: r,
        result: {
          isError: !0,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: l.code,
                detail: l.detail ?? null,
              }),
            },
          ],
        },
      });
    throw l;
  }
  return e.json(
    jsonRpcResponse(r, void 0, {
      code: -32603,
      message: "unhandled",
    }),
  );
});
var OPERATOR_PROFILE = {
    sub: "agent:claude-operator",
    caps: ["grant.issue", "grant.read", "cog.plan", "ledger.read"],
    usd: 5000,
    calls: 500,
    ttl: 604800,
    consent: 604800,
  },
  OAUTH_PROFILES = {
    operator: OPERATOR_PROFILE,
    devdesk: {
      sub: "product:devdesk",
      label: "DevDesk",
      caps: ["memory.read", "memory.write", "ledger.read", "tenant.read"],
      parts: ["agent:", "product:devdesk"],
      usd: 500,
      calls: 20000,
      ttl: 86400,
      consent: 31536000,
    },
    meshtool: {
      sub: "product:meshtool",
      label: "MeshTool",
      caps: ["memory.read", "memory.write", "ledger.read", "webhook.emit"],
      parts: ["agent:", "product:meshtool"],
      usd: 500,
      calls: 20000,
      ttl: 86400,
      consent: 31536000,
    },
  },
  PROFILE_BY_HOST = {
    "devdesk.meshtool.ai": "devdesk",
    "market.meshtool.ai": "meshtool",
  },
  profileForRedirect = (e) => {
    try {
      return OAUTH_PROFILES[PROFILE_BY_HOST[new URL(e).hostname]] || OPERATOR_PROFILE;
    } catch {
      return OPERATOR_PROFILE;
    }
  },
  ALLOWED_REDIRECT_HOSTS = new Set([
    "claude.ai",
    "claude.com",
    ...Object.keys(PROFILE_BY_HOST),
    ...String(env.OAUTH_REDIRECT_HOSTS || "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean),
  ]),
  publicBaseUrl = (e) =>
    env.PUBLIC_URL || `https://${e.req.header("x-forwarded-host") || e.req.header("host")}`,
  isAllowedRedirectUri = (e) => {
    try {
      let t = new URL(e);
      return (
        (t.protocol === "https:" && ALLOWED_REDIRECT_HOSTS.has(t.hostname)) ||
        (t.protocol === "http:" && t.hostname === "localhost")
      );
    } catch {
      return !1;
    }
  },
  sha256Base64Url = (e) => createHash("sha256").update(e).digest("base64url"),
  oauthError = (e, t, a, n = 400) =>
    e.json(
      {
        error: t,
        error_description: a,
      },
      n,
    );
async function ensureRootGrant(e) {
  return (
    (
      await sql`SELECT * FROM grants WHERE tenant = ${e.id} AND depth = 0 AND status = 'active' AND exp > ${nowSec() + 3600} ORDER BY exp DESC LIMIT 1`
    )[0] || (await mintRootGrant(e)).row
  );
}
async function profileForClient(e) {
  let t = (await sql`SELECT redirect_uris FROM oauth_clients WHERE id = ${e}`)[0];
  return profileForRedirect(t ? parseJson(t.redirect_uris)[0] : "");
}
async function issueOAuthGrant(e, t, a = OPERATOR_PROFILE) {
  let n = await getGrant(e),
    r = n && (await getTenant(n.tenant));
  if (!n || n.status !== "active" || Number(n.exp) <= nowSec() || !r)
    throw new HttpError(400, "root_inactive");
  let s = remainingBudget(n),
    i = Math.min(a.ttl, TIERS[r.tier].maxTtlSec, Number(n.exp) - nowSec(), t - nowSec());
  return issueChildGrant(
    n,
    {
      sub: a.sub,
      caps: a.caps,
      ...(a.parts
        ? {
            scope: {
              memory: {
                partitions: a.parts,
              },
            },
          }
        : {}),
      ttlSec: i,
      budget: {
        usd_cents: Math.min(a.usd, s.usd_cents),
        calls: Math.min(a.calls, s.calls),
        deploys: 0,
      },
      constraints: {
        allowDelete: !1,
        requireDryRun: !0,
      },
    },
    "oauth",
  );
}
var tokenResponse = (e, t, a = OPERATOR_PROFILE) => ({
  access_token: e.token,
  token_type: "Bearer",
  expires_in: Math.max(0, Number(e.row.exp) - nowSec()),
  refresh_token: t,
  scope: a.caps.join(" "),
});
async function mintRefreshToken(e, t, a, n, r) {
  let s = randomBytes(32).toString("base64url");
  return (
    await sql`INSERT INTO oauth_refresh (hash, client_id, tenant, root_id, grant_id, consent_until) VALUES (${sha256Hex(s)}, ${e}, ${t}, ${a}, ${n}, ${r})`,
    s
  );
}
var protectedResourceMetadata = (e) =>
  e.json({
    resource: publicBaseUrl(e) + "/mcp",
    authorization_servers: [publicBaseUrl(e)],
    scopes_supported: OPERATOR_PROFILE.caps,
    bearer_methods_supported: ["header"],
  });
app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
app.get("/.well-known/oauth-authorization-server", (e) => {
  let t = publicBaseUrl(e);
  return e.json({
    issuer: t,
    authorization_endpoint: t + "/oauth/authorize",
    token_endpoint: t + "/oauth/token",
    registration_endpoint: t + "/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: OPERATOR_PROFILE.caps,
  });
});
app.post("/oauth/register", async (e) => {
  let t = await readJsonBody(e),
    a = Array.isArray(t.redirect_uris) ? t.redirect_uris.map(String) : [];
  if (!a.length || !a.every(isAllowedRedirectUri))
    return oauthError(e, "invalid_redirect_uri", "redirect_uris must be https on an allowed host");
  if (Number((await sql`SELECT count(*)::int AS n FROM oauth_clients`)[0].n) > 500)
    return oauthError(e, "temporarily_unavailable", "client table full", 503);
  let n = newId("oc"),
    r = String(t.client_name || "mcp client").slice(0, 80);
  return (
    await sql`INSERT INTO oauth_clients (id, name, redirect_uris) VALUES (${n}, ${r}, ${a}::jsonb)`,
    await recordEvent(
      "oauth.client_registered",
      {
        id: n,
        name: r,
      },
      null,
      "oauth",
    ),
    e.json(
      {
        client_id: n,
        client_name: r,
        redirect_uris: a,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    )
  );
});
async function validateAuthorizeRequest(e) {
  let t = (await sql`SELECT * FROM oauth_clients WHERE id = ${String(e.client_id || "")}`)[0];
  if (!t) throw new HttpError(400, "unknown_client");
  if (!parseJson(t.redirect_uris).includes(String(e.redirect_uri || "")))
    throw new HttpError(400, "redirect_uri_mismatch");
  if (e.response_type && e.response_type !== "code") throw new HttpError(400, "unsupported_response_type");
  if (!e.code_challenge || (e.code_challenge_method || "S256") !== "S256")
    throw new HttpError(400, "pkce_s256_required");
  return t;
}
var escapeHtml = (e) => String(e).replace(/[&<>"']/g, (t) => `&#${t.charCodeAt(0)};`);
app.get("/oauth/authorize", async (e) => {
  let t = e.req.query(),
    a = await validateAuthorizeRequest(t),
    n = profileForRedirect(t.redirect_uri),
    r = JSON.stringify({
      client_id: t.client_id,
      redirect_uri: t.redirect_uri,
      code_challenge: t.code_challenge,
      state: t.state || "",
    }).replace(/</g, "\\u003c");
  return e.html(
    renderPage(
      "Approve connector",
      `<h1>Approve connector</h1><div class="card"><p><b>${escapeHtml(a.name)}</b> wants to act on this runtime as <code>${n.sub}</code>.</p>
<p>It gets a <b>grant</b> (never the admin key): <code>${n.caps.join(", ")}</code>${n.parts ? `<br>Memory only in <code>${n.parts.join(", ")}</code>` : ""}<br>Budget up to \xA2${n.usd} \xB7 ${n.calls} calls \xB7 0 deploys \xB7 no delete<br>${n === OPERATOR_PROFILE ? "Lifetime \u2264 7 days (capped by tier), then you approve again." : "Stays connected (auto-renews) until you revoke it."} Revoke anytime in Grants.</p>
<p>Redirects to <code>${escapeHtml(new URL(t.redirect_uri).host)}</code></p></div>
<div class="card" id="unlock" hidden><p>Unlock with the admin key (stays in this tab).</p><input id="k" type="password" style="width:100%"><button id="u">Unlock</button></div>
<div class="card" id="go" hidden><label>Tenant <select id="t"></select></label><p><button id="ok">Approve</button> <button id="no">Deny</button></p><p id="msg"></p></div>
<script>const C=${r};const $=i=>document.getElementById(i);let K=sessionStorage.getItem("cos_admin");
async function api(p,o={}){const r=await fetch(p,{...o,headers:{"content-type":"application/json",authorization:"Bearer "+K}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
async function load(){try{const j=await api("/api/tenants");$("t").innerHTML=j.tenants.filter(t=>t.status==="active").map(t=>'<option value="'+t.id+'">'+t.name.replace(/</g,"")+" \xB7 "+t.tier+" \xB7 "+t.id+"</option>").join("");$("unlock").hidden=true;$("go").hidden=false}catch(e){$("unlock").hidden=false;$("go").hidden=true}}
$("u").onclick=()=>{K=$("k").value.trim();$("k").value="";sessionStorage.setItem("cos_admin",K);load()};
$("no").onclick=()=>{const u=new URL(C.redirect_uri);u.searchParams.set("error","access_denied");if(C.state)u.searchParams.set("state",C.state);location=u};
$("ok").onclick=async()=>{$("ok").disabled=true;try{const j=await api("/oauth/approve",{method:"POST",body:JSON.stringify({...C,tenant:$("t").value})});location=j.redirect}catch(e){$("msg").textContent="Failed: "+e.message;$("ok").disabled=false}};
K?load():$("unlock").hidden=false;</script>`,
    ),
  );
});
app.post("/oauth/approve", requireAdmin, async (e) => {
  let t = await readJsonBody(e);
  await validateAuthorizeRequest(t);
  let a = await getTenant(String(t.tenant || ""));
  if (!a || a.status !== "active") throw new HttpError(404, "tenant_not_found");
  let n = await ensureRootGrant(a),
    r = randomBytes(24).toString("base64url");
  (await sql`INSERT INTO oauth_codes (hash, client_id, redirect_uri, challenge, tenant, root_id) VALUES (${sha256Hex(r)}, ${t.client_id}, ${t.redirect_uri}, ${t.code_challenge}, ${a.id}, ${n.id})`,
    await recordEvent(
      "oauth.approved",
      {
        client: t.client_id,
        root: n.id,
      },
      a.id,
      "admin",
    ));
  let s = new URL(t.redirect_uri);
  if ((s.searchParams.set("code", r), t.state)) s.searchParams.set("state", t.state);
  return e.json({
    redirect: s.toString(),
  });
});
app.post("/oauth/token", async (e) => {
  let t = (e.req.header("content-type") || "").includes("json")
    ? await readJsonBody(e)
    : Object.fromEntries(new URLSearchParams(await e.req.text()));
  if (t.grant_type === "authorization_code") {
    let a = (
      await sql`DELETE FROM oauth_codes WHERE hash = ${sha256Hex(String(t.code || ""))} AND created_at > now() - interval '10 minutes' RETURNING *`
    )[0];
    if (!a || a.client_id !== t.client_id || a.redirect_uri !== t.redirect_uri)
      return oauthError(e, "invalid_grant", "code invalid, expired, or mismatched");
    if (sha256Base64Url(String(t.code_verifier || "")) !== a.challenge)
      return oauthError(e, "invalid_grant", "pkce verification failed");
    let n = profileForRedirect(a.redirect_uri),
      r = nowSec() + n.consent,
      s = await issueOAuthGrant(a.root_id, r, n);
    return e.json(tokenResponse(s, await mintRefreshToken(a.client_id, a.tenant, a.root_id, s.row.id, r), n));
  }
  if (t.grant_type === "refresh_token") {
    let a = (
      await sql`UPDATE oauth_refresh SET revoked = true WHERE hash = ${sha256Hex(String(t.refresh_token || ""))} AND revoked = false RETURNING *`
    )[0];
    if (!a || (t.client_id && a.client_id !== t.client_id))
      return oauthError(e, "invalid_grant", "refresh token invalid");
    if (Number(a.consent_until) <= nowSec())
      return oauthError(e, "invalid_grant", "consent window ended; approve again");
    let n = await getGrant(a.grant_id),
      r = await profileForClient(a.client_id);
    if (!n || n.status === "revoked") return oauthError(e, "invalid_grant", "operator grant was revoked");
    let s =
      n.status === "active" && Number(n.exp) - nowSec() > 3600
        ? {
            row: n,
            token: reissueGrantToken(n),
          }
        : await issueOAuthGrant(a.root_id, Number(a.consent_until), r).catch(() => null);
    if (!s) return oauthError(e, "invalid_grant", "root grant inactive; approve again");
    return e.json(
      tokenResponse(
        s,
        await mintRefreshToken(a.client_id, a.tenant, a.root_id, s.row.id, Number(a.consent_until)),
        r,
      ),
    );
  }
  return oauthError(e, "unsupported_grant_type", "use authorization_code or refresh_token");
});
var PAGE_CSS =
    "body{margin:0;background:#050506;color:#f6f1e4;font:15px/1.5 Geist,system-ui,sans-serif;padding:16px}main{max-width:980px;margin:0 auto}h1{letter-spacing:-.02em}a{color:#f5c542;text-decoration:none}code{font-family:'Geist Mono',ui-monospace,monospace;color:#19f0d8;word-break:break-all}.card{background:rgba(20,19,24,.72);border:1px solid rgba(245,197,66,.16);border-radius:14px;padding:16px;margin:12px 0}button{background:#f5c542;color:#050506;border:0;border-radius:10px;padding:8px 14px;font-weight:600;cursor:pointer}input,select{background:#09090b;color:#f6f1e4;border:1px solid rgba(245,197,66,.3);border-radius:8px;padding:8px}table{border-collapse:collapse;width:100%}td{padding:8px;border-bottom:1px solid rgba(245,197,66,.1);vertical-align:top}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}.g{background:#19f0d8;box-shadow:0 0 8px #19f0d8}.r{background:#ff3d7f;box-shadow:0 0 8px #ff3d7f}.p{background:#5a5566}.dim{color:#9a927f;font-size:13px}.btn{display:inline-block;background:#f5c542;color:#050506;border-radius:10px;padding:6px 12px;font-weight:600}",
  renderPage = (e, t) =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono&display=swap"><style>${PAGE_CSS}</style></head><body><main>${t}</main></body></html>`;
app.get("/", async (e) => {
  let t = await getDoc("_cockpit");
  return e.html(
    t ||
      renderPage(
        "creator-os-runtime",
        '<h1>creator-os-runtime</h1><div class="card">Cockpit not uploaded yet \u2014 <code>PUT /api/admin/docs/_cockpit</code> with cockpit.html. Machine surface: <a href="/health">/health</a> \xB7 <a href="/routes">/routes</a> \xB7 <a href="/mcp">/mcp</a> \xB7 <a href="/docs">/docs</a></div>',
      ),
  );
});
app.get("/cockpit/:page", (e) => e.redirect(`/#/${e.req.param("page")}`));
var RAILWAY_VARS_PATH = "Railway \u2192 creator-os-runtime \u2192 runtime \u2192 Variables",
  STATUS_CHECKS = [
    ["admin", "core", "Admin key (cockpit unlock + approvals)", "RUNTIME_ADMIN_KEY"],
    ["vault", "core", "Vault (encrypts stored secrets)", "VAULT_KEY (64 hex chars)"],
    ["anthropic", "core", "COG brain (plans work)", "ANTHROPIC_API_KEY"],
    ["railway", "core", "Deploys to Railway", "RAILWAY_API_TOKEN"],
    ["github", "hook", "GitHub webhook", "GITHUB_WEBHOOK_SECRET"],
    ["railwayWebhook", "hook", "Railway webhook", "RAILWAY_WEBHOOK_TOKEN"],
    ["mesh", "hook", "MeshMarket receipts", "MESH_RECEIPT_SECRET"],
    ["brain", "hook", "Brain webhook", "BRAIN_WEBHOOK_SECRET"],
    ["sync", "hook", "Memory sync (cognitive-mcp pulls)", "COG_SYNC_TOKEN"],
    ["stripe", "parked", "Stripe payments", "STRIPE_WEBHOOK_SECRET"],
    ["railwayOAuth", "parked", "Railway sign-in", "RAILWAY_OAUTH_CLIENT_ID + _SECRET"],
    ["brainOut", "parked", "Brain fan-out", "BRAIN_URL"],
    ["cognitiveBridge", "parked", "cognitive-mcp bridge push", "COG_BRIDGE_URL + COG_BRIDGE_TOKEN"],
  ],
  PRODUCT_PROBES = [
    [
      "DevDesk",
      "https://devdesk.meshtool.ai/health",
      "devdesk",
      "https://devdesk.meshtool.ai/runtime/connect",
    ],
    ["MeshMarket", "https://market.meshtool.ai/api/health", "meshtool", null],
    ["MCP gate (Claude sign-in)", "https://mcp-gate-production.up.railway.app/health", null, null],
  ];
async function probeUrl(e) {
  let t = Date.now();
  try {
    let a = await fetch(e, {
      signal: AbortSignal.timeout(4000),
    });
    return {
      ok: a.ok,
      code: a.status,
      ms: Date.now() - t,
    };
  } catch (a) {
    return {
      ok: !1,
      code: 0,
      ms: Date.now() - t,
      why: String(a?.name || a),
    };
  }
}
async function buildStatusReport() {
  let e = !1,
    t = [];
  try {
    (await sql`SELECT 1`,
      (e = !0),
      (t =
        await sql`SELECT DISTINCT ON (c.id) c.id, c.name, c.redirect_uris, r.consent_until, r.created_at, g.status AS gstatus, g.exp AS gexp
      FROM oauth_refresh r JOIN oauth_clients c ON c.id = r.client_id LEFT JOIN grants g ON g.id = r.grant_id
      WHERE r.revoked = false AND r.consent_until > ${nowSec()} ORDER BY c.id, r.created_at DESC`));
  } catch {}
  let a = armedIntegrations(),
    n = await isKillSwitchOn().catch(() => !1),
    r = await Promise.all(
      PRODUCT_PROBES.map(async ([o, l, c, E]) => {
        let T = await probeUrl(l),
          R = c && t.find((B) => profileForRedirect(parseJson(B.redirect_uris)[0]) === OAUTH_PROFILES[c]),
          S = E && !R ? (await probeUrl(new URL("/runtime/status", E).href)).ok : !!E;
        return {
          name: o,
          url: l,
          up: T.ok,
          code: T.code,
          ms: T.ms,
          profile: c,
          connected: c ? !!R : null,
          since: R?.created_at || null,
          connect: S ? E : null,
        };
      }),
    ),
    s = STATUS_CHECKS.map(([o, l, c, E]) => ({
      key: o,
      kind: l,
      label: c,
      ok: !!a[o],
      fix: a[o] ? null : `Set ${E} in ${RAILWAY_VARS_PATH}`,
    }));
  s.unshift(
    {
      key: "db",
      kind: "core",
      label: "Database",
      ok: e,
      fix: e ? null : "Check the Postgres service in Railway",
    },
    {
      key: "kill",
      kind: "core",
      label: "Kill switch off",
      ok: !n,
      fix: n ? "Cockpit \u2192 Resume (runtime is paused)" : null,
    },
  );
  let i =
    s.filter((o) => !o.ok && o.kind !== "parked").length +
    r.filter((o) => !o.up || o.connected === !1).length;
  return {
    ok: i === 0,
    red: i,
    version: VERSION,
    source: {
      sha256: sourceSha256,
      bytes: sourceBytes,
    },
    checks: s,
    bodies: r,
    time: new Date().toISOString(),
  };
}
app.get("/status.json", async (e) => e.json(await buildStatusReport()));
app.get("/status", async (e) => {
  let t = await buildStatusReport(),
    a = (r, s) => `<span class="dot ${r ? "g" : s ? "p" : "r"}"></span>`,
    n = (r) =>
      `<tr><td>${a(r.ok, r.kind === "parked")}${escapeHtml(r.label)}</td><td class="dim">${r.ok ? "ready" : r.kind === "parked" ? "parked \u2014 not needed yet" : escapeHtml(r.fix)}</td></tr>`;
  return e.html(
    renderPage(
      "Runtime status",
      `<h1>Runtime status</h1><div class="card"><b style="font-size:20px">${t.ok ? a(!0) + "All green" : a(!1) + t.red + " thing" + (t.red > 1 ? "s" : "") + " need you"}</b><div class="dim">v${t.version} \xB7 source ${String(t.source.sha256).slice(0, 12)} \xB7 ${escapeHtml(t.time)} \xB7 <a href="/status.json">json</a> \xB7 <a href="/">cockpit</a></div></div>
<div class="card"><h3>Products</h3><table>${t.bodies.map((r) => `<tr><td>${a(r.up && r.connected !== !1)}<b>${escapeHtml(r.name)}</b><div class="dim">${r.up ? "up \xB7 " + r.ms + " ms" : "down (" + r.code + ")"}</div></td><td>${r.connected === null ? '<span class="dim">no link needed</span>' : r.connected ? "Connected \u2713 <span class=dim>since " + escapeHtml(new Date(r.since).toISOString().slice(0, 10)) + "</span>" : r.connect ? `<a class="btn" href="${r.connect}">Connect ${escapeHtml(r.name)}</a>` : '<span class="dim">Connect button ships with its next deploy</span>'}</td></tr>`).join("")}</table></div>
<div class="card"><h3>Core</h3><table>${t.checks
        .filter((r) => r.kind === "core")
        .map(n)
        .join("")}</table></div>
<div class="card"><h3>Webhooks &amp; sync</h3><table>${t.checks
        .filter((r) => r.kind === "hook")
        .map(n)
        .join("")}</table></div>
<div class="card"><h3>Parked</h3><table>${t.checks
        .filter((r) => r.kind === "parked")
        .map(n)
        .join("")}</table></div>
<p class="dim">No secret values are shown here. Fingerprints for matching keys are on <a href="/health">/health</a>.</p>`,
    ),
  );
});
async function listDocNames() {
  return (await sql`SELECT name FROM docs ORDER BY name`).map((e) => e.name);
}
async function getDoc(e) {
  let t = await sql`SELECT content FROM docs WHERE name = ${e}`;
  return t.length ? t[0].content : null;
}
function markdownToHtml(e) {
  let t = (i) =>
      i.replace(
        /[&<>]/g,
        (o) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
          })[o],
      ),
    a = e.split(`
`),
    n = "",
    r = !1,
    s = !1;
  for (let i of a) {
    if (i.startsWith("```")) {
      ((n += r ? "</code></pre>" : "<pre><code>"), (r = !r));
      continue;
    }
    if (r) {
      n +=
        t(i) +
        `
`;
      continue;
    }
    let o = i
      .replace(/`([^`]+)`/g, (c, E) => `<code>${t(E)}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    if (/^\|/.test(i)) {
      if (/^\|\s*-/.test(i)) continue;
      if (!s) ((n += "<table>"), (s = !0));
      n +=
        "<tr>" +
        i
          .split("|")
          .slice(1, -1)
          .map((c) => `<td>${c.trim()}</td>`)
          .join("") +
        "</tr>";
      continue;
    } else if (s) ((n += "</table>"), (s = !1));
    let l = i.match(/^(#{1,3})\s+(.*)/);
    if (l) {
      n += `<h${l[1].length}>${l[2]}</h${l[1].length}>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(i)) {
      n += `<div>\u2022 ${o.replace(/^\s*[-*]\s+/, "")}</div>`;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(i)) {
      n += `<div>${o}</div>`;
      continue;
    }
    n += i.trim() ? `<p>${o}</p>` : "";
  }
  if (s) n += "</table>";
  return n;
}
app.get("/docs", async (e) => {
  let t = (await listDocNames()).filter((a) => !a.startsWith("_"));
  return e.html(
    renderPage(
      "Docs",
      `<a href="/">\u2190 Back to hub</a><h1>Docs</h1><p>Served by the running instance. The deployed instance is the spec.</p><div class="card">${t.map((a) => `<div><a href="/docs/${a}">${a}</a></div>`).join("") || "No docs uploaded yet (PUT /api/admin/docs/:name)."}</div>`,
    ),
  );
});
app.get("/docs/:name", async (e) => {
  let t = e.req.param("name"),
    a = t.startsWith("_") ? null : await getDoc(t);
  if (a === null) return e.notFound();
  if ((e.req.header("accept") || "").includes("text/markdown") || e.req.query("raw") !== void 0)
    return e.text(a);
  return e.html(
    renderPage(t, `<a href="/docs">\u2190 Back to docs</a><div class="card">${markdownToHtml(a)}</div>`),
  );
});
app.put("/api/admin/docs/:name", requireAdmin, async (e) => {
  let t = e.req.param("name");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(t)) throw new HttpError(400, "bad_doc_name");
  let a = await e.req.text();
  if (!a.trim()) throw new HttpError(400, "empty_doc");
  return (
    await sql`INSERT INTO docs (name, content, updated_at) VALUES (${t}, ${a}, now()) ON CONFLICT (name) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
    e.json({
      ok: !0,
      name: t,
      bytes: Buffer.byteLength(a),
    })
  );
});
var ROUTE_AUTH_OVERRIDES = {
  "GET /cockpit/:page": "public(page)+admin(data)",
  "GET /auth/railway/callback": "public(state)",
  "POST /webhooks/stripe": "webhook:stripe-signature",
  "POST /webhooks/railway": "webhook:?token=",
  "POST /webhooks/github": "webhook:x-hub-signature-256",
  "POST /webhooks/brain": "webhook:x-brain-signature",
  "POST /webhooks/mesh": "webhook:x-mesh-signature",
  "POST /mcp": "grant (per tool; 401 -> OAuth)",
  "GET /oauth/authorize": "public(consent page)",
  "POST /oauth/register": "public(dcr, redirect allowlist)",
  "POST /oauth/token": "public(pkce/refresh)",
  "DELETE /api/deploys/:id": "grant:worker.delete (+breakglass in production)",
  "GET /sync/changes": "sync-token",
  "POST /sync/apply": "sync-token",
};
function routeInventory() {
  let e = new Map();
  for (let t of app.routes) {
    if (t.method === "ALL") continue;
    let a = `${t.method} ${t.path}`,
      n = t.handler?.auth;
    e.set(a, ROUTE_AUTH_OVERRIDES[a] || n || e.get(a) || "public");
  }
  return [...e].map(([t, a]) => {
    let n = t.indexOf(" ");
    return {
      method: t.slice(0, n),
      path: t.slice(n + 1),
      auth: a,
    };
  });
}
app.get("/routes", (e) => {
  let t = routeInventory();
  return e.json({
    routes: t,
    count: t.length,
  });
});
app.get("/selftest", async (e) => {
  let t = [],
    a = (i, o) => {
      try {
        let l = o();
        t.push({
          name: i,
          pass: l === !0,
          info: l === !0 ? void 0 : l,
        });
      } catch (l) {
        t.push({
          name: i,
          pass: !1,
          info: String(l?.message || l),
        });
      }
    },
    n = {
      id: "gr_p",
      tenant: "t_x",
      status: "active",
      depth: 0,
      exp: nowSec() + 3600,
      caps: ["deploy.worker", "worker.status", "grant.issue"],
      scope: {
        railway: {
          projects: ["p1"],
          environments: ["production"],
        },
        workers: {
          namePrefix: "t-abc-",
        },
      },
      budget: {
        usd_cents: 100,
        calls: 10,
        deploys: 2,
      },
      reserved: zeroUsage(),
      settled: {
        usd_cents: 40,
        calls: 1,
        deploys: 1,
      },
      constraints: {
        maxWorkers: 2,
        maxReplicas: 1,
        allowDelete: !1,
        requireDryRun: !0,
      },
    },
    r = {
      caps: ["deploy.worker"],
      scope: {
        railway: {
          projects: ["p1"],
          environments: ["production"],
        },
        workers: {
          namePrefix: "t-abc-x-",
        },
      },
      budget: {
        usd_cents: 60,
        calls: 5,
        deploys: 1,
      },
      exp: nowSec() + 600,
      constraints: {
        maxWorkers: 1,
        maxReplicas: 1,
        allowDelete: !1,
        requireDryRun: !0,
      },
      depth: 1,
    };
  (a("sign/verify roundtrip", () => {
    let i = JSON.stringify({
      v: 1,
      iss: SERVICE_NAME,
      id: "x",
    });
    return parseGrantToken(signGrantToken(i))?.payload?.id === "x";
  }),
    a("tampered token rejected", () => {
      let i = signGrantToken(
          JSON.stringify({
            v: 1,
            iss: SERVICE_NAME,
            id: "x",
          }),
        ),
        [o, l, c] = i.split("."),
        E = `${o}.${Buffer.from(
          JSON.stringify({
            v: 1,
            iss: SERVICE_NAME,
            id: "y",
          }),
        ).toString("base64url")}.${c}`;
      return parseGrantToken(E) === null;
    }),
    a("attenuation ok child accepted", () => {
      let i = attenuationViolations(n, r, "starter");
      return i.length === 0 || i;
    }),
    a("cap widening rejected", () =>
      attenuationViolations(
        n,
        {
          ...r,
          caps: ["worker.delete"],
        },
        "starter",
      ).includes("cap_not_in_parent:worker.delete"),
    ),
    a("unknown cap rejected", () =>
      attenuationViolations(
        n,
        {
          ...r,
          caps: ["money.send"],
        },
        "starter",
      ).includes("unknown_cap:money.send"),
    ),
    a("budget over parent remaining rejected", () =>
      attenuationViolations(
        n,
        {
          ...r,
          budget: {
            usd_cents: 61,
            calls: 1,
            deploys: 1,
          },
        },
        "starter",
      ).includes("budget_exceeds_parent_remaining"),
    ),
    a("allowDelete widening rejected", () =>
      attenuationViolations(
        n,
        {
          ...r,
          constraints: {
            ...r.constraints,
            allowDelete: !0,
          },
        },
        "starter",
      ).includes("allowDelete_widened"),
    ),
    a("policy fail-closed on garbage", () =>
      attenuationViolations(null, r, "starter").includes("policy_evaluation_error"),
    ),
    a("gatehouse denies malformed proposal", () => {
      let i = gatehouseEvaluate(
        {
          id: "t_abcdef",
          tier: "starter",
          status: "active",
          allowed_targets: {},
        },
        null,
        {
          nope: 1,
        },
      );
      return !i.ok && i.reasons.includes("malformed_proposal");
    }),
    a("gatehouse denies forbidden cap family", () => {
      let i = gatehouseEvaluate(
        {
          id: "t_abcdef",
          tier: "starter",
          status: "active",
          allowed_targets: {},
        },
        null,
        {
          grants: [
            {
              caps: ["wallet.spend"],
              ttlSec: 10,
              budget: {},
            },
          ],
          deploys: [],
        },
      );
      return !i.ok && i.reasons.includes("forbidden_cap_family");
    }),
    a("stripe signature verifies", () => {
      let i = nowSec(),
        o = `t=${i},v1=${hmacSha256("whsec_test", `${i}.{"id":"evt_1"}`)}`;
      return (
        verifyTimestampedSignature('{"id":"evt_1"}', o, "whsec_test") &&
        !verifyTimestampedSignature('{"id":"evt_1"} ', o, "whsec_test") &&
        !verifyTimestampedSignature(
          '{"id":"evt_1"}',
          `t=${i - 1000},v1=${hmacSha256("whsec_test", `${i - 1000}.{"id":"evt_1"}`)}`,
          "whsec_test",
        )
      );
    }),
    a("vault seal/open roundtrip (when armed)", () => {
      if (!vaultKey()) return "skipped:unarmed";
      let i = vaultEncrypt("secret");
      return vaultDecrypt(i) === "secret";
    }),
    a("route inventory derives from app (\u226545 routes, all tagged)", () => {
      let i = routeInventory();
      return (
        (i.length >= 45 && i.every((o) => !!o.auth)) || {
          count: i.length,
        }
      );
    }),
    a(
      "memory scope widening rejected",
      () =>
        attenuationViolations(
          {
            ...n,
            scope: {
              ...n.scope,
              memory: {
                partitions: ["worker:a"],
              },
            },
          },
          {
            ...r,
            scope: {
              ...r.scope,
              memory: {
                partitions: ["worker:"],
              },
            },
          },
          "starter",
        ).includes("scope_memory_widened") &&
        attenuationViolations(
          {
            ...n,
            scope: {
              ...n.scope,
              memory: {
                partitions: ["worker:a"],
              },
            },
          },
          {
            ...r,
            scope: {
              ...r.scope,
              memory: {
                partitions: ["worker:a-1"],
              },
            },
          },
          "starter",
        ).length === 0,
    ));
  let s = t.every((i) => i.pass || String(i.info || "").startsWith("skipped"));
  return e.json(
    {
      pass: s,
      count: t.length,
      results: t,
    },
    s ? 200 : 500,
  );
});
try {
  ((sourceText = await Bun.file(import.meta.path).text()),
    (sourceSha256 = sha256Hex(sourceText)),
    (sourceBytes = Buffer.byteLength(sourceText, "utf8")));
} catch {}
await migrateSchema();
var signingKeySource = await loadGrantSigningKey();
if (!(await getSetting("kill_switch"))) await setSetting("kill_switch", "off");
console.log(
  `[${SERVICE_NAME} v${VERSION}] policy=${POLICY_VERSION} signingKey=${signingKeySource} armed=${JSON.stringify(armedIntegrations())}`,
);
var LISTEN_PORT = Number(env.PORT || 3000),
  serverConfig = {
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
