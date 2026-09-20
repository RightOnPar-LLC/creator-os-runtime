// creator-os-runtime — single-file Bun runtime (Railway Function). One process. One command. One source of truth.

import { Hono } from "hono";
import { SQL } from "bun";
import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from "node:crypto";

export const VERSION = "0.1.1";
const ISS = "creator-os-runtime";
const POLICY_VERSION = "p1";

// == [0] env + db ==
const env = Bun.env;
// v0.1.1 — secrets compare byte-exact, so strip whitespace a paste may have carried in; and expose an 8-hex fingerprint per secret so "is the right key armed?" is answerable without seeing it
const SECRET_ENV = ["RUNTIME_ADMIN_KEY","VAULT_KEY","ANTHROPIC_API_KEY","RAILWAY_API_TOKEN","RAILWAY_OAUTH_CLIENT_ID","RAILWAY_OAUTH_CLIENT_SECRET","STRIPE_WEBHOOK_SECRET","RAILWAY_WEBHOOK_TOKEN","GITHUB_WEBHOOK_SECRET","BRAIN_WEBHOOK_SECRET","MESH_RECEIPT_SECRET","COG_BRIDGE_TOKEN","COG_SYNC_TOKEN","GRANT_SIGNING_KEY"] as const;
for (const k of SECRET_ENV) { const v = env[k]; if (typeof v === "string" && v !== v.trim()) env[k] = v.trim(); }
const FP = (v?: string) => v ? createHash("sha256").update(v, "utf8").digest("hex").slice(0, 8) : null;
const FINGERPRINTS = () => ({ admin: FP(env.RUNTIME_ADMIN_KEY), vault: FP(env.VAULT_KEY), anthropic: FP(env.ANTHROPIC_API_KEY), railway: FP(env.RAILWAY_API_TOKEN), stripe: FP(env.STRIPE_WEBHOOK_SECRET), railwayWebhook: FP(env.RAILWAY_WEBHOOK_TOKEN), github: FP(env.GITHUB_WEBHOOK_SECRET), brain: FP(env.BRAIN_WEBHOOK_SECRET), mesh: FP(env.MESH_RECEIPT_SECRET), cognitiveBridge: FP(env.COG_BRIDGE_TOKEN), sync: FP(env.COG_SYNC_TOKEN) });
const DATABASE_URL = env.DATABASE_URL || env.POSTGRES_URL || "";
if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is required (Railway: ${{Postgres.DATABASE_URL}})");
  process.exit(1);
}
const db = new SQL(DATABASE_URL);

const ARMED = () => ({
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
});

const SCHEMA = `
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

async function migrate() {
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.unsafe(stmt);
}
const J = (x: any) => (typeof x === "string" ? JSON.parse(x) : x);
const nowSec = () => Math.floor(Date.now() / 1000);
const rid = (p: string) => `${p}_${randomBytes(9).toString("base64url")}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function getSetting(key: string): Promise<string | null> {
  const r = await db`SELECT value FROM settings WHERE key = ${key}`;
  return r.length ? r[0].value : null;
}
async function setSetting(key: string, value: string) {
  await db`INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${value}, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
async function emit(type: string, data: any, tenant: string | null = null, actor: string | null = null) {
  await db`INSERT INTO events (tenant, type, actor, data) VALUES (${tenant}, ${type}, ${actor}, ${(data)}::jsonb)`;
  if (!type.startsWith("brain.")) await outboxPush("brain.event", { id: rid("ev"), type, tenant, actor, data, ts: new Date().toISOString(), source: ISS }); // never echo Brain's own events back
}

// == [1] crypto ==
let SIGNING_KEY: Buffer;
async function loadSigningKey() {
  if (env.GRANT_SIGNING_KEY) { SIGNING_KEY = Buffer.from(env.GRANT_SIGNING_KEY, "utf8"); return "env"; }
  let k = await getSetting("grant_signing_key");
  if (!k) { k = randomBytes(32).toString("hex"); await setSetting("grant_signing_key", k); }
  SIGNING_KEY = Buffer.from(k, "hex");
  return "db";
}
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const hmac = (key: Buffer | string, msg: string, enc: "hex" | "base64url" = "hex") =>
  createHmac("sha256", key).update(msg).digest(enc as any) as string;
function safeEq(a: string, b: string) {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}
function signPayload(payloadJson: string) { return `cog1.${b64u(payloadJson)}.${hmac(SIGNING_KEY, payloadJson, "base64url")}`; }
function parseToken(token: string): { payload: any; json: string } | null {
  try {
    const [pre, p, s] = token.trim().split(".");
    if (pre !== "cog1" || !p || !s) return null;
    const json = Buffer.from(p, "base64url").toString("utf8");
    if (!safeEq(hmac(SIGNING_KEY, json, "base64url"), s)) return null;
    const payload = JSON.parse(json);
    if (payload.iss !== ISS || payload.v !== 1) return null;
    return { payload, json };
  } catch { return null; }
}
// vault (AES-256-GCM)
function vaultKey(): Buffer | null { return /^[0-9a-f]{64}$/i.test(env.VAULT_KEY || "") ? Buffer.from(env.VAULT_KEY!, "hex") : null; }
function vaultSeal(plain: string) {
  const k = vaultKey(); if (!k) throw new Error("vault_unarmed");
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
function vaultOpen(row: { ciphertext: string; iv: string; tag: string }) {
  const k = vaultKey(); if (!k) throw new Error("vault_unarmed");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(row.iv, "base64"));
  d.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(row.ciphertext, "base64")), d.final()]).toString("utf8");
}

// == [2] policy (deterministic, fail-closed) ==
export const CAPS = [
  "grant.issue", "grant.read", "cog.plan", "cog.execute", "deploy.worker", "worker.status",
  "worker.logs.read", "worker.restart", "worker.delete", "ledger.read", "tenant.read", "webhook.emit", "memory.read", "memory.write",
] as const;
type Cap = (typeof CAPS)[number];
const CAP_SET = new Set<string>(CAPS);

export const TIERS: Record<string, { maxWorkers: number; deploysPerPeriod: number; usdCents: number; maxTtlSec: number; maxDepth: number; maxReplicas: number }> = {
  starter: { maxWorkers: 2,   deploysPerPeriod: 20,     usdCents: 500,       maxTtlSec: 3600,        maxDepth: 2, maxReplicas: 1 },
  pro:     { maxWorkers: 10,  deploysPerPeriod: 200,    usdCents: 5000,      maxTtlSec: 86400,       maxDepth: 3, maxReplicas: 2 },
  studio:  { maxWorkers: 40,  deploysPerPeriod: 1000,   usdCents: 25000,     maxTtlSec: 7 * 86400,   maxDepth: 4, maxReplicas: 3 },
  house:   { maxWorkers: 500, deploysPerPeriod: 100000, usdCents: 10000000,  maxTtlSec: 30 * 86400,  maxDepth: 6, maxReplicas: 5 },
};
type Budget = { usd_cents: number; calls: number; deploys: number };
const B0 = (): Budget => ({ usd_cents: 0, calls: 0, deploys: 0 });
const bnorm = (b: any): Budget => ({ usd_cents: Math.max(0, Math.floor(+b?.usd_cents || 0)), calls: Math.max(0, Math.floor(+b?.calls || 0)), deploys: Math.max(0, Math.floor(+b?.deploys || 0)) });
const bsub = (a: Budget, b: Budget): Budget => ({ usd_cents: a.usd_cents - b.usd_cents, calls: a.calls - b.calls, deploys: a.deploys - b.deploys });
const badd = (a: Budget, b: Budget): Budget => ({ usd_cents: a.usd_cents + b.usd_cents, calls: a.calls + b.calls, deploys: a.deploys + b.deploys });
const ble = (a: Budget, b: Budget) => a.usd_cents <= b.usd_cents && a.calls <= b.calls && a.deploys <= b.deploys;
const remaining = (g: any): Budget => bsub(bsub(bnorm(J(g.budget)), bnorm(J(g.reserved))), bnorm(J(g.settled)));

type Scope = { railway?: { projects?: string[]; environments?: string[] }; workers?: { namePrefix?: string }; memory?: { partitions?: string[] } };
const memParts = (s: Scope) => s.memory?.partitions ?? [""]; // memory partition prefixes; "" = every partition of the tenant
type Constraints = { maxWorkers: number; maxReplicas: number; allowDelete: boolean; requireDryRun: boolean };
const num = (v: any, dflt: number) => (v === undefined || v === null || v === "" || Number.isNaN(+v) ? dflt : +v);
const cnorm = (c: any, d: Constraints): Constraints => ({
  maxWorkers: Math.min(d.maxWorkers, Math.max(0, Math.floor(num(c?.maxWorkers, d.maxWorkers)))),
  maxReplicas: Math.min(d.maxReplicas, Math.max(1, Math.floor(num(c?.maxReplicas, d.maxReplicas)))),
  allowDelete: d.allowDelete && c?.allowDelete === true,
  requireDryRun: c?.requireDryRun === false ? d.requireDryRun && false : true,
});
const subset = (a: string[] | undefined, b: string[] | undefined) => (a || []).every((x) => (b || []).includes(x));

// attenuation check: child ⊆ parent → list of violations (empty = ok); never throws
export function attenuationViolations(parent: any, child: { caps: string[]; scope: Scope; budget: Budget; exp: number; constraints: Constraints; depth: number }, tier: string): string[] {
  const v: string[] = [];
  try {
    const t = TIERS[tier]; if (!t) return ["unknown_tier"];
    const pcaps: string[] = J(parent.caps), pscope: Scope = J(parent.scope), pcons: Constraints = J(parent.constraints);
    for (const c of child.caps) { if (!CAP_SET.has(c)) v.push(`unknown_cap:${c}`); else if (!pcaps.includes(c)) v.push(`cap_not_in_parent:${c}`); }
    if (child.caps.length === 0) v.push("no_caps");
    if (child.exp > Number(parent.exp)) v.push("exp_exceeds_parent");
    if (child.exp - nowSec() > t.maxTtlSec) v.push("ttl_exceeds_tier");
    if (child.exp <= nowSec()) v.push("already_expired");
    if (!subset(child.scope.railway?.projects, pscope.railway?.projects)) v.push("scope_projects_widened");
    if (!subset(child.scope.railway?.environments, pscope.railway?.environments)) v.push("scope_environments_widened");
    const pp = pscope.workers?.namePrefix || "", cp = child.scope.workers?.namePrefix || "";
    if (!cp.startsWith(pp)) v.push("scope_prefix_widened");
    if (!memParts(child.scope).every((c) => memParts(pscope).some((p) => c.startsWith(p)))) v.push("scope_memory_widened");
    if (!ble(child.budget, remaining(parent))) v.push("budget_exceeds_parent_remaining");
    if (child.constraints.maxWorkers > pcons.maxWorkers) v.push("maxWorkers_widened");
    if (child.constraints.maxReplicas > pcons.maxReplicas) v.push("maxReplicas_widened");
    if (child.constraints.allowDelete && !pcons.allowDelete) v.push("allowDelete_widened");
    if (child.constraints.requireDryRun === false && pcons.requireDryRun) v.push("requireDryRun_loosened");
    if (child.depth !== Number(parent.depth) + 1) v.push("bad_depth");
    if (child.depth > t.maxDepth) v.push("depth_exceeds_tier");
    if (parent.status !== "active") v.push("parent_not_active");
    if (Number(parent.exp) <= nowSec()) v.push("parent_expired");
  } catch (e: any) { v.push("policy_evaluation_error"); }
  return v;
}

// gatehouse: hard rules on a whole proposal before any minting; deny on any error
export function gatehouseEvaluate(tenant: any, parent: any, proposal: any): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  try {
    if (!tenant || tenant.status !== "active") reasons.push("tenant_not_active");
    const t = TIERS[tenant?.tier]; if (!t) reasons.push("unknown_tier");
    const grants = Array.isArray(proposal?.grants) ? proposal.grants : null;
    const deploys = Array.isArray(proposal?.deploys) ? proposal.deploys : null;
    if (!grants || !deploys) reasons.push("malformed_proposal");
    if (grants && grants.length > 8) reasons.push("too_many_grants");
    if (deploys && deploys.length > 8) reasons.push("too_many_deploys");
    const allowed = J(tenant?.allowed_targets || {});
    for (const g of grants || []) {
      for (const c of g.caps || []) if (!CAP_SET.has(c)) reasons.push(`unknown_cap:${c}`);
      if (/money|wallet|trade|secret/i.test(JSON.stringify(g.caps || []))) reasons.push("forbidden_cap_family");
      if (+g.ttlSec > (t?.maxTtlSec ?? 0)) reasons.push("ttl_exceeds_tier");
      const b = bnorm(g.budget);
      if (b.usd_cents > (t?.usdCents ?? 0)) reasons.push("budget_exceeds_tier");
      for (const p of g.scope?.railway?.projects || []) if (!(allowed.railway?.projects || []).includes(p)) reasons.push(`target_not_allowed:${p}`);
    }
    for (const d of deploys || []) {
      if (!d.name || !/^[a-z0-9-]{3,48}$/.test(d.name)) reasons.push("bad_worker_name");
      if (d.name && !d.name.startsWith(tenantPrefix(String(tenant?.id || "")))) reasons.push("worker_name_missing_tenant_prefix");
      if ((+d.replicas || 1) > (t?.maxReplicas ?? 1)) reasons.push("replicas_exceed_tier");
      if (!d.template || !TEMPLATES[d.template]) reasons.push(`unknown_template:${d.template}`);
    }
    if (parent && parent.status !== "active") reasons.push("caller_grant_not_active");
  } catch { reasons.push("policy_evaluation_error"); }
  return { ok: reasons.length === 0, reasons };
}

// == [3] grants ==
async function killSwitch() { return (await getSetting("kill_switch")) === "on"; }
async function tenantById(id: string) { const r = await db`SELECT * FROM tenants WHERE id = ${id}`; return r[0] || null; }
async function grantById(id: string) { const r = await db`SELECT * FROM grants WHERE id = ${id}`; return r[0] || null; }
function tokenFor(row: any) { return signPayload(row.payload); }

function tenantPrefix(tenantId: string) { return `t-${sha(tenantId).slice(0, 6)}-`; }

// root grant for a tenant (admin path): ceiling = tier
async function mintRoot(tenant: any, sub = "tenant:root") {
  const t = TIERS[tenant.tier];
  const iat = nowSec(), exp = iat + t.maxTtlSec * 4; // root lives 4× the max child TTL; re-mintable by admin
  const id = rid("gr");
  const allowed = J(tenant.allowed_targets || {});
  const payload = {
    v: 1, id, tenant: tenant.id, parent: null, depth: 0, sub, iss: ISS, iat, exp,
    caps: [...CAPS], scope: { railway: { projects: allowed.railway?.projects || [], environments: allowed.railway?.environments || ["production"] }, workers: { namePrefix: tenantPrefix(tenant.id) }, memory: { partitions: [""] } },
    budget: { usd_cents: t.usdCents, calls: t.deploysPerPeriod * 50, deploys: t.deploysPerPeriod },
    constraints: { maxWorkers: t.maxWorkers, maxReplicas: t.maxReplicas, allowDelete: true, requireDryRun: true },
    nonce: randomBytes(8).toString("hex"),
  };
  const json = JSON.stringify(payload);
  await db`INSERT INTO grants (id, tenant, parent, depth, sub, caps, scope, budget, constraints, payload, policy_version, issued_by, iat, exp)
    VALUES (${id}, ${tenant.id}, ${null}, 0, ${sub}, ${(payload.caps)}::jsonb, ${(payload.scope)}::jsonb,
            ${(payload.budget)}::jsonb, ${(payload.constraints)}::jsonb, ${json}, ${POLICY_VERSION}, ${"admin"}, ${iat}, ${exp})`;
  await db`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
    VALUES (${tenant.id}, ${id}, ${null}, 'root', ${payload.budget.usd_cents}, ${payload.budget.calls}, ${payload.budget.deploys}, ${id}, 'root grant minted')`;
  await emit("grant.issued", { id, sub, depth: 0 }, tenant.id, "admin");
  return { row: await grantById(id), token: signPayload(json) };
}

// attenuated child under parent; transactional (reserves budget from parent)
async function mintChild(parent: any, spec: { sub: string; caps: string[]; scope?: Scope; budget?: Budget; ttlSec?: number; constraints?: Partial<Constraints> }, issuedBy: string) {
  const tenant = await tenantById(parent.tenant);
  if (!tenant) throw Object.assign(new Error("tenant_missing"), { status: 403 });
  const tier = TIERS[tenant.tier];
  const pscope: Scope = J(parent.scope), pcons: Constraints = J(parent.constraints);
  const ttl = Math.min(Math.max(60, Math.floor(spec.ttlSec ?? 3600)), tier.maxTtlSec);
  const iat = nowSec(), exp = Math.min(iat + ttl, Number(parent.exp));
  const scope: Scope = {
    railway: { projects: spec.scope?.railway?.projects ?? pscope.railway?.projects ?? [], environments: spec.scope?.railway?.environments ?? pscope.railway?.environments ?? [] },
    workers: { namePrefix: spec.scope?.workers?.namePrefix ?? pscope.workers?.namePrefix ?? "" },
    memory: { partitions: spec.scope?.memory?.partitions ?? memParts(pscope) },
  };
  const budget = bnorm(spec.budget ?? B0());
  const constraints = cnorm(spec.constraints ?? {}, pcons);
  const child = { caps: [...new Set(spec.caps || [])], scope, budget, exp, constraints, depth: Number(parent.depth) + 1 };
  const viol = attenuationViolations(parent, child, tenant.tier);
  if (viol.length) throw Object.assign(new Error("attenuation_violation"), { status: 403, detail: viol });
  const id = rid("gr");
  const payload = { v: 1, id, tenant: tenant.id, parent: parent.id, depth: child.depth, sub: String(spec.sub || "agent:anon").slice(0, 80), iss: ISS, iat, exp,
    caps: child.caps, scope, budget, constraints, nonce: randomBytes(8).toString("hex") };
  const json = JSON.stringify(payload);
  await db.begin(async (tx: any) => {
    // re-check remaining inside the tx (row lock) to prevent parallel over-reservation
    const p = (await tx`SELECT * FROM grants WHERE id = ${parent.id} FOR UPDATE`)[0];
    if (!p || p.status !== "active") throw Object.assign(new Error("parent_not_active"), { status: 403 });
    if (!ble(budget, remaining(p))) throw Object.assign(new Error("budget_exceeds_parent_remaining"), { status: 402 });
    const nres = badd(bnorm(J(p.reserved)), budget);
    await tx`UPDATE grants SET reserved = ${(nres)}::jsonb WHERE id = ${parent.id}`;
    await tx`INSERT INTO grants (id, tenant, parent, depth, sub, caps, scope, budget, constraints, payload, policy_version, issued_by, iat, exp)
      VALUES (${id}, ${tenant.id}, ${parent.id}, ${child.depth}, ${payload.sub}, ${(child.caps)}::jsonb, ${(scope)}::jsonb,
              ${(budget)}::jsonb, ${(constraints)}::jsonb, ${json}, ${POLICY_VERSION}, ${issuedBy}, ${iat}, ${exp})`;
    await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${tenant.id}, ${id}, ${parent.id}, 'reserve', ${budget.usd_cents}, ${budget.calls}, ${budget.deploys}, ${id}, ${"reserved for " + payload.sub})`;
  });
  await emit("grant.issued", { id, parent: parent.id, sub: payload.sub, depth: child.depth, caps: child.caps }, tenant.id, issuedBy);
  return { row: await grantById(id), token: signPayload(json) };
}

// revoke + cascade to descendants; release unspent reservations up the chain
async function revokeCascade(rootId: string, reason: string, actor: string) {
  const revoked: string[] = [];
  await db.begin(async (tx: any) => {
    const rows = await tx`WITH RECURSIVE sub AS (SELECT * FROM grants WHERE id = ${rootId}
      UNION ALL SELECT g.* FROM grants g JOIN sub ON g.parent = sub.id) SELECT * FROM sub ORDER BY depth DESC FOR UPDATE`;
    for (const g of rows) {
      if (g.status !== "active") continue;
      await tx`UPDATE grants SET status = 'revoked', revoked_at = now(), revoke_reason = ${reason} WHERE id = ${g.id}`;
      const unspent = bsub(bnorm(J(g.budget)), bnorm(J(g.settled)));
      if (g.parent) {
        const p = (await tx`SELECT reserved FROM grants WHERE id = ${g.parent} FOR UPDATE`)[0];
        const nres = bsub(bnorm(J(p.reserved)), unspent);
        await tx`UPDATE grants SET reserved = ${({ usd_cents: Math.max(0, nres.usd_cents), calls: Math.max(0, nres.calls), deploys: Math.max(0, nres.deploys) })}::jsonb WHERE id = ${g.parent}`;
        await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
          VALUES (${g.tenant}, ${g.id}, ${g.parent}, 'release', ${unspent.usd_cents}, ${unspent.calls}, ${unspent.deploys}, ${g.id}, ${reason})`;
      }
      revoked.push(g.id);
    }
  });
  if (revoked.length) { const g = await grantById(rootId); await emit("grant.revoked", { ids: revoked, reason }, g?.tenant || null, actor); }
  return revoked;
}

// settle cost against a grant (controlled exit, after a real action)
async function settle(grantId: string, cost: Budget, ref: string, note: string) {
  await db.begin(async (tx: any) => {
    const g = (await tx`SELECT * FROM grants WHERE id = ${grantId} FOR UPDATE`)[0];
    if (!g || g.status !== "active") throw Object.assign(new Error("grant_not_active"), { status: 401 });
    if (!ble(cost, remaining(g))) throw Object.assign(new Error("budget_exhausted"), { status: 402 });
    await tx`UPDATE grants SET settled = ${(badd(bnorm(J(g.settled)), cost))}::jsonb WHERE id = ${grantId}`;
    await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${g.tenant}, ${grantId}, ${g.parent}, 'settle', ${cost.usd_cents}, ${cost.calls}, ${cost.deploys}, ${ref}, ${note})`;
  });
}

// rate limit (per grant, in-memory, single instance)
const RL = new Map<string, { n: number; t: number }>();
const RL_MAX = Number(env.RATE_LIMIT_PER_MIN || 120);
function rateOk(id: string) {
  const now = Date.now(); const e = RL.get(id);
  if (!e || now - e.t > 60_000) { RL.set(id, { n: 1, t: now }); return true; }
  e.n++; return e.n <= RL_MAX;
}

class HttpError extends Error { constructor(public status: number, public code: string, public detail?: any) { super(code); } }

// full verification chain (GRANTS.md §Verification); throws HttpError
async function verifyGrant(token: string | undefined, cap: Cap | null, target?: { project?: string; environment?: string; workerName?: string }) {
  try {
    if (!token) throw new HttpError(401, "missing_grant");
    const parsed = parseToken(token); if (!parsed) throw new HttpError(401, "bad_grant");
    const p = parsed.payload;
    if (Number(p.exp) <= nowSec()) { await db`UPDATE grants SET status='expired' WHERE id=${p.id} AND status='active'`; throw new HttpError(401, "grant_expired"); }
    const row = await grantById(p.id);
    if (!row || row.status !== "active") throw new HttpError(401, "grant_revoked");
    const tenant = await tenantById(row.tenant);
    if (!tenant || tenant.status !== "active") throw new HttpError(403, "tenant_suspended");
    if (await killSwitch()) throw new HttpError(503, "runtime_paused");
    const caps: string[] = J(row.caps);
    if (cap && !caps.includes(cap)) throw new HttpError(403, "missing_cap", { need: cap });
    if (target) {
      const s: Scope = J(row.scope);
      if (target.project && !(s.railway?.projects || []).includes(target.project)) throw new HttpError(403, "out_of_scope", { project: target.project });
      if (target.environment && !(s.railway?.environments || []).includes(target.environment)) throw new HttpError(403, "out_of_scope", { environment: target.environment });
      if (target.workerName && !target.workerName.startsWith(s.workers?.namePrefix || "\u0000")) throw new HttpError(403, "out_of_scope", { workerName: target.workerName });
    }
    if (!rateOk(row.id)) throw new HttpError(429, "rate_limited");
    return { row, tenant, payload: p };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(403, "verification_error"); // fail closed
  }
}

// == [4b] memory (REMEMBER) + outbox (Brain / bridge) ==
const memOut = (r: any) => ({ id: r.id, tenant: r.tenant, partition: r.partition, key: r.key, content: r.content, tags: J(r.tags), version: Number(r.version), deleted: !!r.deleted, actor: r.actor, updated_at: r.updated_at });
const syncOut = (r: any) => ({ partition: `${r.tenant}/${r.partition}`, key: r.key, content: r.content, tags: J(r.tags), version: Number(r.version), deleted: !!r.deleted, updated_at: r.updated_at });
async function memoryWrite(tenant: string, partition: string, key: string | null, content: string, tags: string[], actor: string | null) {
  const r = await db`INSERT INTO memories (id, tenant, partition, key, content, tags, version, deleted, actor, updated_at)
    VALUES (${rid("m")}, ${tenant}, ${partition}, ${key || sha(content).slice(0, 16)}, ${content}, ${(tags)}::jsonb, ${Date.now()}, false, ${actor}, now())
    ON CONFLICT (tenant, partition, key) DO UPDATE SET content = EXCLUDED.content, tags = EXCLUDED.tags, version = EXCLUDED.version, deleted = false, actor = EXCLUDED.actor, updated_at = now() RETURNING *`;
  const rec = memOut(r[0]); await outboxPush("memory.sync", syncOut(r[0])); return rec;
}
async function memorySearch(tenant: string, q: string, prefix: string, limit: number) {
  const lim = Math.min(50, Math.max(1, Math.floor(limit || 10))), like = prefix + "%";
  const rows = q.trim()
    ? await db`SELECT * FROM memories WHERE tenant = ${tenant} AND deleted = false AND partition LIKE ${like} AND (to_tsvector('english', content) @@ plainto_tsquery('english', ${q}) OR content ILIKE ${"%" + q + "%"})
        ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', ${q})) DESC, updated_at DESC LIMIT ${lim}`
    : await db`SELECT * FROM memories WHERE tenant = ${tenant} AND deleted = false AND partition LIKE ${like} ORDER BY updated_at DESC LIMIT ${lim}`;
  return rows.map(memOut);
}
async function memoryForget(tenant: string, id: string) {
  const r = await db`UPDATE memories SET deleted = true, version = ${Date.now()}, updated_at = now() WHERE id = ${id} AND tenant = ${tenant} RETURNING *`;
  if (!r.length) throw new HttpError(404, "memory_not_found");
  await outboxPush("memory.sync", syncOut(r[0])); return memOut(r[0]);
}
// LWW merge of records from a sync peer (bridge / cognitive-memory). partition is "<tenant>/<partition>"; newer version wins; tombstones honored.
async function memoryApply(recs: any[]) {
  let applied = 0, skipped = 0;
  for (const x of recs) {
    const full = String(x?.partition || ""), i = full.indexOf("/"); const tenant = i > 0 ? full.slice(0, i) : "", partition = i > 0 ? full.slice(i + 1) : "";
    const ver = Number(x?.version) || 0; if (!tenant || !partition || !x?.key || !ver) { skipped++; continue; }
    const r = await db`INSERT INTO memories (id, tenant, partition, key, content, tags, version, deleted, actor, updated_at)
      VALUES (${rid("m")}, ${tenant}, ${partition}, ${String(x.key)}, ${String(x.content ?? "")}, ${(Array.isArray(x.tags) ? x.tags : [])}::jsonb, ${ver}, ${!!x.deleted}, 'sync', now())
      ON CONFLICT (tenant, partition, key) DO UPDATE SET content = EXCLUDED.content, tags = EXCLUDED.tags, version = EXCLUDED.version, deleted = EXCLUDED.deleted, actor = 'sync', updated_at = now()
      WHERE memories.version < EXCLUDED.version RETURNING id`;
    if (r.length) applied++; else skipped++;
  }
  return { applied, skipped };
}
// outbox: durable fan-out with retries; a no-op unless the destination is armed
const bridgeUrl = () => (env.COG_BRIDGE_URL || "").replace(/\/$/, "");
async function outboxPush(kind: string, payload: any) {
  const armed = kind === "brain.event" ? !!env.BRAIN_URL : !!(bridgeUrl() && env.COG_BRIDGE_TOKEN);
  if (!armed) return;
  await db`INSERT INTO outbox (kind, payload) VALUES (${kind}, ${(payload)}::jsonb)`;
  if (!draining) { draining = true; setTimeout(() => drainOutbox(25).catch(() => {}).finally(() => { draining = false; }), 30); }
}
let draining = false;
async function deliver(kind: string, p: any) {
  if (kind === "brain.event") { const body = JSON.stringify(p); const r = await fetch(env.BRAIN_URL!, { method: "POST", headers: { "content-type": "application/json", "x-brain-signature": hmac(env.BRAIN_WEBHOOK_SECRET || "", body), "x-runtime": ISS }, body }); if (!r.ok) throw new Error("brain " + r.status); return; }
  if (kind === "memory.sync") { const r = await fetch(bridgeUrl() + "/sync/apply", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.COG_BRIDGE_TOKEN}` }, body: JSON.stringify({ records: [p] }) }); if (!r.ok) throw new Error("bridge " + r.status); return; }
  throw new Error("unknown_kind");
}
async function drainOutbox(max: number) {
  const rows = await db`SELECT * FROM outbox WHERE done = false AND next_at <= now() ORDER BY id LIMIT ${max}`; let ok = 0, failed = 0;
  for (const o of rows) {
    try { await deliver(o.kind, J(o.payload)); await db`UPDATE outbox SET done = true WHERE id = ${o.id}`; ok++; }
    catch (e: any) { const a = o.attempts + 1; await db`UPDATE outbox SET attempts = ${a}, next_at = ${new Date(Date.now() + Math.min(300, 2 ** a) * 1000)}, last_error = ${String(e?.message || e).slice(0, 300)}, done = ${a >= 10} WHERE id = ${o.id}`; failed++; }
  }
  return { ok, failed, more: rows.length === max };
}
async function memoryPull() { // pull the bridge's changes since our cursor (LWW apply)
  if (!bridgeUrl() || !env.COG_BRIDGE_TOKEN) throw new HttpError(503, "unarmed", { needs: "COG_BRIDGE_URL+COG_BRIDGE_TOKEN" });
  const since = Number((await getSetting("memory_pull_cursor")) || 0);
  const r = await fetch(`${bridgeUrl()}/sync/changes?since=${since}`, { headers: { authorization: `Bearer ${env.COG_BRIDGE_TOKEN}` } });
  if (!r.ok) throw new HttpError(502, "bridge_error", r.status);
  const j: any = await r.json(); const res = await memoryApply(Array.isArray(j.records) ? j.records : []);
  const next = Number(j.next) || since; if (next > since) await setSetting("memory_pull_cursor", String(next));
  return { ...res, since, next };
}

// == [5] controlled exit (Railway) ==
export const TEMPLATES: Record<string, { image: string; desc: string; env: Record<string, string>; needs: string[]; estCents: number; kind: string }> = {
  probe:              { image: "traefik/whoami:latest",                     kind: "probe",     desc: "Tiny HTTP responder that proves the deploy path", env: {}, needs: [], estCents: 25 },
  "tip-alert-bot":    { image: "ghcr.io/think-zone/creator-worker:latest", kind: "tip-alert", desc: "Tip events → Discord / OBS alerts", env: { WORKER_KIND: "tip-alert" }, needs: ["DISCORD_WEBHOOK_URL"], estCents: 60 },
  "paywall-link":     { image: "ghcr.io/think-zone/creator-worker:latest", kind: "paywall",   desc: "Checkout link → content unlock, with receipts", env: { WORKER_KIND: "paywall" }, needs: ["STRIPE_SECRET_KEY"], estCents: 60 },
  "clip-poster":      { image: "ghcr.io/think-zone/creator-worker:latest", kind: "clips",     desc: "Schedules and posts clips across platforms", env: { WORKER_KIND: "clips" }, needs: ["POSTIZ_API_KEY"], estCents: 80 },
  "dm-autoresponder": { image: "ghcr.io/think-zone/creator-worker:latest", kind: "dm",        desc: "Answers DMs from a persona, escalates to you", env: { WORKER_KIND: "dm" }, needs: ["ANTHROPIC_API_KEY"], estCents: 90 },
  "webhook-relay":    { image: "ghcr.io/think-zone/creator-worker:latest", kind: "relay",     desc: "Relays platform webhooks to the Brain bus", env: { WORKER_KIND: "relay" }, needs: [], estCents: 30 },
};

const RAILWAY_GQL = "https://backboard.railway.com/graphql/v2";
async function railwayGql(token: string, query: string, variables: any) {
  const r = await fetch(RAILWAY_GQL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new HttpError(502, "railway_api_error", j.errors?.map((e: any) => e.message) || r.status);
  return j.data;
}
async function railwayTokenFor(tenantId: string): Promise<{ token: string; source: string } | null> {
  const v = (await db`SELECT * FROM vault WHERE tenant = ${tenantId} AND provider = 'railway'`)[0];
  if (v && vaultKey()) { try { return { token: JSON.parse(vaultOpen(v)).access_token, source: "tenant-oauth" }; } catch { /* fall through */ } }
  if (env.RAILWAY_API_TOKEN) return { token: env.RAILWAY_API_TOKEN, source: "house" };
  return null;
}

// deploy.worker — the one door out of the box
async function exitDeploy(ctx: { row: any; tenant: any }, intent: { name: string; template: string; env?: Record<string, string>; replicas?: number; target?: { project?: string; environment?: string } }, confirm: boolean, actor: string) {
  const tpl = TEMPLATES[intent.template]; if (!tpl) throw new HttpError(400, "unknown_template");
  const cons: Constraints = J(ctx.row.constraints), scope: Scope = J(ctx.row.scope);
  const project = intent.target?.project || scope.railway?.projects?.[0] || null;
  const environment = intent.target?.environment || scope.railway?.environments?.[0] || "production";
  const name = String(intent.name || "").toLowerCase();
  if (!/^[a-z0-9-]{3,48}$/.test(name)) throw new HttpError(400, "bad_worker_name");
  if (!name.startsWith(scope.workers?.namePrefix || "\u0000")) throw new HttpError(403, "out_of_scope", { workerName: name });
  if (project && !(scope.railway?.projects || []).includes(project)) throw new HttpError(403, "out_of_scope", { project });
  const replicas = Math.min(Math.max(1, Math.floor(+intent.replicas || 1)), cons.maxReplicas);
  const active = await db`SELECT count(*)::int AS n FROM deploys WHERE tenant = ${ctx.tenant.id} AND status NOT IN ('deleted','failed','dry_run')`;
  if (active[0].n >= cons.maxWorkers) throw new HttpError(403, "max_workers_reached", { maxWorkers: cons.maxWorkers });
  const tier = TIERS[ctx.tenant.tier];
  if (ctx.tenant.deploys_period >= tier.deploysPerPeriod) throw new HttpError(402, "tier_deploys_exhausted");
  const cost: Budget = { usd_cents: tpl.estCents, calls: 1, deploys: 1 };
  if (!ble(cost, remaining(ctx.row))) throw new HttpError(402, "budget_exhausted", { need: cost, remaining: remaining(ctx.row) });
  const envVars = { ...tpl.env, ...(intent.env || {}), COS_TENANT: ctx.tenant.id, COS_WORKER: name, COS_GRANT: ctx.row.id };
  const missing = tpl.needs.filter((k) => !(k in envVars));
  const plan = { action: "railway.serviceCreate", project, environment, name, image: tpl.image, replicas, env: Object.keys(envVars), missingEnv: missing, estCents: tpl.estCents, policy: POLICY_VERSION };
  const id = rid("dp");
  const prior = await db`SELECT 1 FROM deploys WHERE tenant = ${ctx.tenant.id} AND name = ${name} AND executed = true LIMIT 1`;
  const needDry = cons.requireDryRun && prior.length === 0 && !confirm;
  const armed = await railwayTokenFor(ctx.tenant.id);
  let status = "dry_run", executed = false, result: any = null, reason: string | null = null, serviceId: string | null = null;
  if (needDry) reason = "dry_run";
  else if (!armed) reason = "unarmed:RAILWAY_API_TOKEN";
  else if (!project) reason = "no_target_project";
  else if (missing.length) reason = "missing_env:" + missing.join(",");
  else {
    await settle(ctx.row.id, cost, id, `deploy ${name}`);
    const data = await railwayGql(armed.token,
      `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
      { input: { projectId: project, name, source: { image: tpl.image }, variables: envVars } });
    serviceId = data?.serviceCreate?.id || null; status = "deploying"; executed = true;
    result = { serviceId, via: armed.source };
    await db`UPDATE tenants SET deploys_period = deploys_period + 1, updated_at = now() WHERE id = ${ctx.tenant.id}`;
  }
  await db`INSERT INTO deploys (id, tenant, grant_id, name, template, intent, plan, status, executed, railway_service_id, target, result)
    VALUES (${id}, ${ctx.tenant.id}, ${ctx.row.id}, ${name}, ${intent.template}, ${(intent)}::jsonb, ${(plan)}::jsonb, ${status}, ${executed}, ${serviceId},
            ${({ project, environment })}::jsonb, ${(result)}::jsonb)`;
  await emit(executed ? "deploy.requested" : "deploy.planned", { id, name, template: intent.template, reason, executed }, ctx.tenant.id, actor);
  return { id, executed, status, reason, plan, result };
}
async function exitStatus(ctx: { row: any; tenant: any }, deployId: string) {
  const d = (await db`SELECT * FROM deploys WHERE id = ${deployId} AND tenant = ${ctx.tenant.id}`)[0];
  if (!d) throw new HttpError(404, "deploy_not_found");
  const armed = await railwayTokenFor(ctx.tenant.id);
  if (d.railway_service_id && armed) {
    try {
      const t = J(d.target);
      const data = await railwayGql(armed.token, `query($i: DeploymentListInput!) { deployments(input: $i, first: 1) { edges { node { id status createdAt } } } }`,
        { i: { projectId: t.project, serviceId: d.railway_service_id } });
      const node = data?.deployments?.edges?.[0]?.node;
      if (node) { await db`UPDATE deploys SET status = ${String(node.status).toLowerCase()}, railway_deployment_id = ${node.id}, updated_at = now() WHERE id = ${d.id}`; d.status = String(node.status).toLowerCase(); }
      await settle(ctx.row.id, { usd_cents: 0, calls: 1, deploys: 0 }, d.id, "status");
    } catch (e) { /* status read is best-effort */ }
  }
  return d;
}
async function breakglassLive(tenantId: string) { const r = await db`SELECT 1 FROM breakglass WHERE tenant = ${tenantId} AND until > now() LIMIT 1`; return r.length > 0; }
async function exitDelete(ctx: { row: any; tenant: any }, deployId: string, actor: string) {
  const d = (await db`SELECT * FROM deploys WHERE id = ${deployId} AND tenant = ${ctx.tenant.id}`)[0];
  if (!d) throw new HttpError(404, "deploy_not_found");
  const cons: Constraints = J(ctx.row.constraints); if (!cons.allowDelete) throw new HttpError(403, "delete_not_allowed_by_grant");
  const t = J(d.target || {});
  if ((t.environment || "production") === "production" && !(await breakglassLive(ctx.tenant.id))) throw new HttpError(403, "breakglass_required");
  const armed = await railwayTokenFor(ctx.tenant.id);
  if (d.railway_service_id) {
    if (!armed) throw new HttpError(503, "unarmed", { needs: "RAILWAY_API_TOKEN" });
    await railwayGql(armed.token, `mutation($id: String!) { serviceDelete(id: $id) }`, { id: d.railway_service_id });
    await settle(ctx.row.id, { usd_cents: 0, calls: 1, deploys: 0 }, d.id, "delete");
  }
  await db`UPDATE deploys SET status = 'deleted', updated_at = now() WHERE id = ${d.id}`;
  await emit("deploy.deleted", { id: d.id, name: d.name }, ctx.tenant.id, actor);
  return { id: d.id, status: "deleted" };
}
async function exitRestart(ctx: { row: any; tenant: any }, deployId: string, actor: string) {
  const d = (await db`SELECT * FROM deploys WHERE id = ${deployId} AND tenant = ${ctx.tenant.id}`)[0];
  if (!d) throw new HttpError(404, "deploy_not_found");
  if (!d.railway_deployment_id) throw new HttpError(409, "no_live_deployment");
  const armed = await railwayTokenFor(ctx.tenant.id); if (!armed) throw new HttpError(503, "unarmed", { needs: "RAILWAY_API_TOKEN" });
  await railwayGql(armed.token, `mutation($id: String!) { deploymentRestart(id: $id) }`, { id: d.railway_deployment_id });
  await settle(ctx.row.id, { usd_cents: 0, calls: 1, deploys: 0 }, d.id, "restart");
  await emit("deploy.restarted", { id: d.id }, ctx.tenant.id, actor);
  return { id: d.id, restarted: true };
}

// == [6] COG (agentic helper) ==
function pickTemplate(intent: string): string | null {
  const s = intent.toLowerCase();
  if (/\bprobe|smoke|hello|whoami\b/.test(s)) return "probe";
  if (/\btip|alert|donat/.test(s)) return "tip-alert-bot";
  if (/\bpaywall|unlock|checkout|ppv\b/.test(s)) return "paywall-link";
  if (/\bclip|post|schedul/.test(s)) return "clip-poster";
  if (/\bdm\b|message|respond|inbox/.test(s)) return "dm-autoresponder";
  if (/\brelay|webhook|bridge\b/.test(s)) return "webhook-relay";
  return null;
}
// deterministic planner; output is re-checked by the gatehouse, nothing here is trusted
async function cogEvidence(tenant: string, intent: string, template: string | null) { // REMEMBER: prior memory + prior failures on this template
  const mem = await memorySearch(tenant, template ? `${template} ${intent}` : intent, "", 5);
  const fails = template ? await db`SELECT 1 FROM events WHERE tenant = ${tenant} AND type = 'worker.failed' AND data->>'template' = ${template} LIMIT 3` : [];
  return { evidence: mem.map((m) => ({ id: m.id, partition: m.partition, key: m.key, snippet: m.content.slice(0, 200) })), priorFailures: fails.length };
}
function planDeterministic(tenant: any, callerGrant: any, intent: string, hints: any = {}, ev: { evidence: any[]; priorFailures: number } = { evidence: [], priorFailures: 0 }) {
  const template = hints.template && TEMPLATES[hints.template] ? hints.template : pickTemplate(intent);
  if (!template) return { needsClarification: true, options: Object.keys(TEMPLATES), question: "Which worker? (probe, tip-alert-bot, paywall-link, clip-poster, dm-autoresponder, webhook-relay)", evidence: ev.evidence };
  const tpl = TEMPLATES[template]; const tier = TIERS[tenant.tier]; const scope: Scope = J(callerGrant.scope);
  const prefix = scope.workers?.namePrefix || tenantPrefix(tenant.id);
  const name = `${prefix}${template}-${randomBytes(2).toString("hex")}`.slice(0, 48);
  const ttlSec = Math.min(3600, tier.maxTtlSec);
  const budget = { usd_cents: Math.min(tpl.estCents * 2, remaining(callerGrant).usd_cents), calls: Math.min(20, remaining(callerGrant).calls), deploys: Math.min(1, remaining(callerGrant).deploys) };
  return {
    intent, template,
    grants: [{ key: "deployer", sub: `agent:deployer:${template}`, caps: ["deploy.worker", "worker.status", "memory.read", "memory.write"], ttlSec, budget,
      scope: { railway: { projects: scope.railway?.projects || [], environments: scope.railway?.environments || ["production"] }, workers: { namePrefix: prefix }, memory: { partitions: [`worker:${name}`, `agent:deployer:${template}`] } },
      constraints: { maxWorkers: 1, maxReplicas: 1, allowDelete: false, requireDryRun: true } }],
    deploys: [{ grant: "deployer", name, template, env: hints.env || {}, replicas: 1, target: { project: scope.railway?.projects?.[0] || null, environment: scope.railway?.environments?.[0] || "production" } }],
    estimate: { usd_cents: tpl.estCents, deploys: 1, missingEnv: tpl.needs.filter((k) => !(hints.env || {})[k]) },
    rationale: `Template "${template}" (${tpl.desc}). One sub-agent grant, one worker, dry-run first.${ev.priorFailures ? ` ${ev.priorFailures} prior failure(s) on this template — check evidence.` : ""}`,
    evidence: ev.evidence, warnings: ev.priorFailures ? [`prior_failures:${template}:${ev.priorFailures}`] : [],
    planner: "deterministic",
  };
}
// optional LLM refinement: picks template + env only; re-validated by the deterministic planner
async function planWithLLM(tenant: any, callerGrant: any, intent: string, hints: any, ev: { evidence: any[]; priorFailures: number }) {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.COG_MODEL || "claude-sonnet-4-5", max_tokens: 300,
        system: `You are the COG planner. Choose exactly one template from: ${Object.keys(TEMPLATES).join(", ")}. Reply ONLY with JSON {"template": string, "env": object, "why": string}. Never invent secrets.`,
        messages: [{ role: "user", content: `Creator intent: ${intent}\nHints: ${JSON.stringify(hints)}\nEvidence (prior memory): ${JSON.stringify(ev.evidence.map((e) => e.snippet))}` }] }) });
    const j: any = await r.json(); const text = j?.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/); if (!m) return null;
    const out = JSON.parse(m[0]);
    if (!TEMPLATES[out.template]) return null;
    const p: any = planDeterministic(tenant, callerGrant, intent, { ...hints, template: out.template, env: { ...(hints.env || {}), ...(out.env || {}) } }, ev);
    p.planner = "llm+deterministic"; p.rationale = `${out.why || ""} — ${p.rationale}`;
    return p;
  } catch { return null; }
}
async function cogPlan(ctx: { row: any; tenant: any }, intent: string, hints: any) {
  const ev = await cogEvidence(ctx.tenant.id, intent, hints.template && TEMPLATES[hints.template] ? hints.template : pickTemplate(intent));
  const p = (await planWithLLM(ctx.tenant, ctx.row, intent, hints, ev)) || planDeterministic(ctx.tenant, ctx.row, intent, hints, ev);
  await emit("cog.planned", { template: (p as any).template || null, planner: (p as any).planner || "n/a" }, ctx.tenant.id, ctx.row.sub);
  return p;
}
async function cogExecute(ctx: { row: any; tenant: any }, proposal: any, confirm: boolean) {
  const gate = gatehouseEvaluate(ctx.tenant, ctx.row, proposal);
  if (!gate.ok) { await emit("cog.denied", { reasons: gate.reasons }, ctx.tenant.id, ctx.row.sub); throw new HttpError(403, "gatehouse_denied", gate.reasons); }
  const minted: Record<string, { id: string; token: string; row: any }> = {};
  for (const g of proposal.grants) {
    if (!J(ctx.row.caps).includes("grant.issue")) throw new HttpError(403, "missing_cap", { need: "grant.issue" });
    const m = await mintChild(ctx.row, g, ctx.row.sub);
    minted[g.key || m.row.id] = { id: m.row.id, token: m.token, row: m.row };
  }
  const deploys: any[] = [];
  for (const d of proposal.deploys) {
    const g = minted[d.grant]; if (!g) throw new HttpError(400, "deploy_references_unknown_grant");
    const target = d.target || {};
    const res = await exitDeploy({ row: g.row, tenant: ctx.tenant }, { name: d.name, template: d.template, env: d.env, replicas: d.replicas, target }, !!confirm, g.row.sub);
    deploys.push(res);
    await memoryWrite(ctx.tenant.id, "agent:cog", `deploy:${d.name}`, `${d.template} → ${res.status}${res.reason ? ` (${res.reason})` : ""} via ${g.row.sub}; image ${res.plan.image}; deploy ${res.id}`, ["cog", d.template, res.status], ctx.row.sub);
  }
  await emit("cog.executed", { grants: Object.values(minted).map((m) => m.id), deploys: deploys.map((d) => d.id), confirm: !!confirm }, ctx.tenant.id, ctx.row.sub);
  return { grants: Object.fromEntries(Object.entries(minted).map(([k, v]) => [k, { id: v.id, token: v.token, sub: v.row.sub, exp: Number(v.row.exp) }])), deploys };
}

// == [7] webhooks ==
function verifyStripeSig(raw: string, header: string | undefined, secret: string, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=").map((s) => s.trim())));
  const t = parts.t, v1 = parts.v1; if (!t || !v1) return false;
  if (Math.abs(nowSec() - Number(t)) > toleranceSec) return false;
  return safeEq(hmac(secret, `${t}.${raw}`), v1);
}
async function intake(source: string, eventId: string, type: string | null, payload: any) {
  const r = await db`INSERT INTO webhook_events (source, event_id, type, payload) VALUES (${source}, ${eventId}, ${type}, ${(payload)}::jsonb)
    ON CONFLICT (source, event_id) DO NOTHING RETURNING id`;
  return r.length ? r[0].id : null; // null = replay
}
async function handled(id: number, result: any) { await db`UPDATE webhook_events SET handled = true, result = ${(result)}::jsonb WHERE id = ${id}`; }

async function handleStripe(evt: any) {
  const type = evt.type as string; const obj = evt.data?.object || {};
  const priceMap = (() => { try { return JSON.parse(env.STRIPE_PRICE_MAP || "{}"); } catch { return {}; } })();
  const tierFromPrice = (pid?: string) => (pid && priceMap[pid]) || null;
  const byCustomer = async (c?: string) => (c ? (await db`SELECT * FROM tenants WHERE stripe_customer = ${c}`)[0] : null);
  if (type === "checkout.session.completed") {
    const tenantId = obj.client_reference_id || obj.metadata?.tenant; const t = tenantId ? await tenantById(tenantId) : null;
    if (!t) return { ignored: "no_tenant" };
    await db`UPDATE tenants SET stripe_customer = ${obj.customer || null}, stripe_subscription = ${obj.subscription || null}, status = 'active', period_start = now(), deploys_period = 0, updated_at = now() WHERE id = ${t.id}`;
    await emit("billing.activated", { customer: obj.customer }, t.id, "stripe"); return { activated: t.id };
  }
  if (type === "customer.subscription.updated" || type === "customer.subscription.created") {
    const t = await byCustomer(obj.customer); if (!t) return { ignored: "unknown_customer" };
    const tier = tierFromPrice(obj.items?.data?.[0]?.price?.id); const status = ["active", "trialing"].includes(obj.status) ? "active" : "suspended";
    if (tier) await db`UPDATE tenants SET tier = ${tier}, status = ${status}, stripe_subscription = ${obj.id}, updated_at = now() WHERE id = ${t.id}`;
    else await db`UPDATE tenants SET status = ${status}, stripe_subscription = ${obj.id}, updated_at = now() WHERE id = ${t.id}`;
    await emit("billing.updated", { tier, status }, t.id, "stripe"); return { tenant: t.id, tier, status };
  }
  if (type === "customer.subscription.deleted" || type === "invoice.payment_failed") {
    const t = await byCustomer(obj.customer); if (!t) return { ignored: "unknown_customer" };
    await db`UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = ${t.id}`;
    await emit("billing.suspended", { reason: type }, t.id, "stripe"); return { suspended: t.id };
  }
  if (type === "invoice.paid") {
    const t = await byCustomer(obj.customer); if (!t) return { ignored: "unknown_customer" };
    await db`UPDATE tenants SET status = 'active', period_start = now(), deploys_period = 0, updated_at = now() WHERE id = ${t.id}`;
    await emit("billing.period_reset", {}, t.id, "stripe"); return { period_reset: t.id };
  }
  return { ignored: type };
}
async function handleRailway(evt: any) {
  const svc = evt.resource?.service?.id, dep = evt.resource?.deployment?.id, status = String(evt.details?.status || evt.type || "").toLowerCase().replace("deployment.", "");
  if (!svc) return { ignored: "no_service" };
  const rows = await db`UPDATE deploys SET status = ${status}, railway_deployment_id = ${dep || null}, updated_at = now() WHERE railway_service_id = ${svc} RETURNING id, tenant, name, template`;
  for (const r of rows) {
    await emit("deploy.status", { id: r.id, name: r.name, status }, r.tenant, "railway");
    if (/fail|crash/.test(status)) { await emit("worker.failed", { id: r.id, name: r.name, template: r.template, status, repairHint: "COG may propose a bounded repair grant" }, r.tenant, "railway");
      await memoryWrite(r.tenant, `worker:${r.name}`, `status:${status}`, `worker ${r.name} (${r.template}) ${status} at ${new Date().toISOString()}`, ["railway", r.template, status], "railway"); }
  }
  return { matched: rows.length, status };
}

// == [8] app + api ==
let SOURCE_SHA = "unknown", SOURCE_BYTES = 0, SOURCE_TEXT = "";
type Auth = { row: any; tenant: any; payload: any };
export const app = new Hono<{ Variables: { auth: Auth } }>();

const bearer = (c: any) => { const h = c.req.header("authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7).trim() : c.req.header("x-grant") || undefined; };
const isAdmin = (c: any) => !!env.RUNTIME_ADMIN_KEY && !!bearer(c) && safeEq(bearer(c)!, env.RUNTIME_ADMIN_KEY);
const tag = (f: any, auth: string) => Object.assign(f, { auth });
const adminOnly = tag(async (c: any, next: any) => {
  if (!env.RUNTIME_ADMIN_KEY) throw new HttpError(503, "unarmed", { needs: "RUNTIME_ADMIN_KEY" });
  if (!isAdmin(c)) throw new HttpError(401, "admin_required");
  await next();
}, "admin");
const withGrant = (cap: Cap | null) => tag(async (c: any, next: any) => { c.set("auth", await verifyGrant(bearer(c), cap)); await next(); }, cap ? `grant:${cap}` : "grant");
const body = async (c: any) => { try { return await c.req.json(); } catch { return {}; } };

app.onError((e: any, c) => {
  if (e instanceof HttpError) return c.json({ error: e.code, detail: e.detail ?? null }, e.status as any);
  const status = e?.status && Number.isInteger(e.status) ? e.status : 500;
  const code = e?.message && status < 500 ? e.message : "internal_error";
  if (status >= 500) console.error("ERR", e?.stack || e);
  return c.json({ error: code, detail: e?.detail ?? (env.RUNTIME_MODE === "dev" ? String(e?.message) : null) }, status);
});
app.notFound((c) => c.json({ error: "not_found", hint: "GET /routes" }, 404));

// public
app.get("/health", async (c) => {
  let dbOk = false; try { await db`SELECT 1`; dbOk = true; } catch {}
  return c.json({ ok: dbOk, service: ISS, version: VERSION, policy: POLICY_VERSION, db: dbOk, killSwitch: await killSwitch(), armed: ARMED(), fingerprints: FINGERPRINTS(), source: { sha256: SOURCE_SHA, bytes: SOURCE_BYTES, chunks: c.req.query("chunks") ? Array.from({ length: Math.ceil(SOURCE_TEXT.length / 4096) }, (_, i) => sha(SOURCE_TEXT.slice(i * 4096, (i + 1) * 4096)).slice(0, 8)) : undefined }, time: new Date().toISOString() }, dbOk ? 200 : 503);
});
app.get("/.well-known/creator-os.json", (c) => c.json({ name: ISS, version: VERSION, policy: POLICY_VERSION, surfaces: { api: "/api", mcp: "/mcp", docs: "/docs", routes: "/routes", cockpit: "/" }, caps: CAPS, tiers: TIERS, templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, { desc: v.desc, needs: v.needs, estCents: v.estCents }])), armed: ARMED() }));

// admin: tenants + control
app.post("/api/tenants", adminOnly, async (c) => {
  const b = await body(c); const tier = TIERS[b.tier] ? b.tier : "starter";
  const id = rid("t"); const allowed = { railway: { projects: Array.isArray(b.railwayProjects) ? b.railwayProjects : [], environments: Array.isArray(b.environments) ? b.environments : ["production"] } };
  await db`INSERT INTO tenants (id, name, tier, allowed_targets) VALUES (${id}, ${String(b.name || "creator").slice(0, 80)}, ${tier}, ${(allowed)}::jsonb)`;
  const t = await tenantById(id); const root = await mintRoot(t);
  await emit("tenant.created", { tier }, id, "admin");
  return c.json({ tenant: t, rootGrant: { id: root.row.id, token: root.token, exp: Number(root.row.exp) } }, 201);
});
app.get("/api/tenants", adminOnly, async (c) => c.json({ tenants: await db`SELECT id, name, tier, status, deploys_period, period_start, allowed_targets, created_at FROM tenants ORDER BY created_at DESC LIMIT 200` }));
app.get("/api/tenants/:id", adminOnly, async (c) => { const t = await tenantById(c.req.param("id")); if (!t) throw new HttpError(404, "tenant_not_found"); return c.json({ tenant: t }); });
app.post("/api/tenants/:id/tier", adminOnly, async (c) => { const b = await body(c); if (!TIERS[b.tier]) throw new HttpError(400, "unknown_tier"); await db`UPDATE tenants SET tier = ${b.tier}, updated_at = now() WHERE id = ${c.req.param("id")}`; await emit("tenant.tier", { tier: b.tier }, c.req.param("id"), "admin"); return c.json({ ok: true }); });
app.post("/api/tenants/:id/suspend", adminOnly, async (c) => { await db`UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = ${c.req.param("id")}`; await emit("tenant.suspended", {}, c.req.param("id"), "admin"); return c.json({ ok: true }); });
app.post("/api/tenants/:id/resume", adminOnly, async (c) => { await db`UPDATE tenants SET status = 'active', updated_at = now() WHERE id = ${c.req.param("id")}`; await emit("tenant.resumed", {}, c.req.param("id"), "admin"); return c.json({ ok: true }); });
app.post("/api/tenants/:id/targets", adminOnly, async (c) => { const b = await body(c); const allowed = { railway: { projects: b.railwayProjects || [], environments: b.environments || ["production"] } }; await db`UPDATE tenants SET allowed_targets = ${(allowed)}::jsonb, updated_at = now() WHERE id = ${c.req.param("id")}`; return c.json({ ok: true, allowed }); });
app.post("/api/tenants/:id/root-grant", adminOnly, async (c) => { const t = await tenantById(c.req.param("id")); if (!t) throw new HttpError(404, "tenant_not_found"); const r = await mintRoot(t, String((await body(c)).sub || "tenant:root")); return c.json({ id: r.row.id, token: r.token, exp: Number(r.row.exp) }, 201); });
app.post("/api/admin/kill", adminOnly, async (c) => { await setSetting("kill_switch", "on"); await emit("runtime.paused", {}, null, "admin"); return c.json({ killSwitch: true }); });
app.post("/api/admin/resume", adminOnly, async (c) => { await setSetting("kill_switch", "off"); await emit("runtime.resumed", {}, null, "admin"); return c.json({ killSwitch: false }); });
app.get("/api/admin/policy", adminOnly, (c) => c.json({ policy: POLICY_VERSION, caps: CAPS, tiers: TIERS, templates: TEMPLATES, rateLimitPerMin: RL_MAX }));
app.post("/api/admin/breakglass", adminOnly, async (c) => { const b = await body(c); const min = Math.min(25, Math.max(1, Math.floor(+b.minutes || 5))); if (!b.tenant || !(await tenantById(b.tenant))) throw new HttpError(404, "tenant_not_found"); const until = new Date(Date.now() + min * 60_000); await db`INSERT INTO breakglass (tenant, until, reason) VALUES (${b.tenant}, ${until}, ${String(b.reason || "").slice(0, 200)})`; await emit("breakglass.armed", { minutes: min, until }, b.tenant, "admin"); return c.json({ tenant: b.tenant, until }); });
app.post("/api/admin/grants/:id/revoke", adminOnly, async (c) => c.json({ revoked: await revokeCascade(c.req.param("id"), String((await body(c)).reason || "admin"), "admin") }));
app.post("/api/admin/grants/:id/token", adminOnly, async (c) => { const g = await grantById(c.req.param("id")); if (!g || g.status !== "active") throw new HttpError(404, "grant_not_active"); return c.json({ id: g.id, token: tokenFor(g) }); });
app.get("/api/admin/overview", adminOnly, async (c) => {
  const [t, g, d, w, l] = await Promise.all([
    db`SELECT status, count(*)::int n FROM tenants GROUP BY status`, db`SELECT status, count(*)::int n FROM grants GROUP BY status`,
    db`SELECT status, count(*)::int n FROM deploys GROUP BY status`, db`SELECT source, count(*)::int n FROM webhook_events GROUP BY source`,
    db`SELECT kind, sum(usd_cents)::int usd_cents, sum(deploys)::int deploys FROM ledger GROUP BY kind`]);
  return c.json({ tenants: t, grants: g, deploys: d, webhooks: w, ledger: l, killSwitch: await killSwitch(), armed: ARMED() });
});
app.get("/api/admin/grants", adminOnly, async (c) => c.json({ grants: (await db`SELECT id, tenant, parent, depth, sub, status, caps, budget, reserved, settled, exp, created_at FROM grants ORDER BY created_at DESC LIMIT 200`).map((g: any) => ({ ...g, exp: Number(g.exp), remaining: remaining(g) })) }));
app.get("/api/admin/deploys", adminOnly, async (c) => c.json({ deploys: await db`SELECT id, tenant, grant_id, name, template, status, executed, railway_service_id, target, created_at FROM deploys ORDER BY created_at DESC LIMIT 200` }));
app.get("/api/admin/ledger", adminOnly, async (c) => c.json({ ledger: await db`SELECT * FROM ledger ORDER BY id DESC LIMIT 300` }));
app.get("/api/admin/webhooks", adminOnly, async (c) => c.json({ webhooks: await db`SELECT id, source, event_id, type, received_at, handled, result FROM webhook_events ORDER BY id DESC LIMIT 200` }));
app.get("/api/admin/events", adminOnly, async (c) => c.json({ events: await db`SELECT * FROM events ORDER BY id DESC LIMIT 300` }));

// grant-bearing: grants
app.get("/api/grants/verify", withGrant(null), (c) => { const a: Auth = c.get("auth"); return c.json({ id: a.row.id, tenant: a.tenant.id, tier: a.tenant.tier, sub: a.row.sub, depth: a.row.depth, caps: J(a.row.caps), scope: J(a.row.scope), constraints: J(a.row.constraints), budget: J(a.row.budget), remaining: remaining(a.row), exp: Number(a.row.exp) }); });
app.post("/api/grants", withGrant("grant.issue"), async (c) => { const a: Auth = c.get("auth"); const b = await body(c); const m = await mintChild(a.row, b, a.row.sub); return c.json({ id: m.row.id, token: m.token, sub: m.row.sub, caps: J(m.row.caps), budget: J(m.row.budget), exp: Number(m.row.exp), parent: a.row.id }, 201); });
app.get("/api/grants", withGrant("grant.read"), async (c) => { const a: Auth = c.get("auth"); const rows = await db`WITH RECURSIVE sub AS (SELECT * FROM grants WHERE id = ${a.row.id} UNION ALL SELECT g.* FROM grants g JOIN sub ON g.parent = sub.id) SELECT id, parent, depth, sub, status, caps, budget, reserved, settled, exp, created_at FROM sub ORDER BY depth, created_at`; return c.json({ grants: rows.map((g: any) => ({ ...g, exp: Number(g.exp), remaining: remaining(g) })) }); });
app.get("/api/grants/:id", withGrant("grant.read"), async (c) => { const a: Auth = c.get("auth"); const g = await grantById(c.req.param("id")); if (!g || g.tenant !== a.tenant.id) throw new HttpError(404, "grant_not_found"); const { payload, ...rest } = g; return c.json({ grant: { ...rest, exp: Number(rest.exp), remaining: remaining(g) } }); });
app.post("/api/grants/:id/revoke", withGrant("grant.issue"), async (c) => {
  const a: Auth = c.get("auth"); const id = c.req.param("id");
  const inTree = await db`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${a.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id) SELECT 1 FROM sub WHERE id = ${id}`;
  if (!inTree.length) throw new HttpError(403, "not_in_subtree");
  return c.json({ revoked: await revokeCascade(id, String((await body(c)).reason || "revoked by " + a.row.sub), a.row.sub) });
});

// grant-bearing: COG
app.post("/api/cog/plan", withGrant("cog.plan"), async (c) => { const a: Auth = c.get("auth"); const b = await body(c); if (!b.intent || typeof b.intent !== "string") throw new HttpError(400, "intent_required"); return c.json({ proposal: await cogPlan(a, b.intent.slice(0, 2000), b.hints || {}) }); });
app.post("/api/cog/execute", withGrant("cog.execute"), async (c) => { const a: Auth = c.get("auth"); const b = await body(c); if (!b.proposal) throw new HttpError(400, "proposal_required"); return c.json(await cogExecute(a, b.proposal, !!b.confirm)); });
app.get("/api/cog/templates", withGrant("cog.plan"), (c) => c.json({ templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, { desc: v.desc, needs: v.needs, estCents: v.estCents, image: v.image }])) }));

// grant-bearing: deploys (direct sub-agent path)
app.post("/api/deploys", withGrant("deploy.worker"), async (c) => { const a: Auth = c.get("auth"); const b = await body(c); return c.json(await exitDeploy(a, b, !!b.confirm, a.row.sub), 201); });
app.get("/api/deploys", withGrant("worker.status"), async (c) => { const a: Auth = c.get("auth"); return c.json({ deploys: await db`SELECT id, grant_id, name, template, status, executed, target, created_at, updated_at FROM deploys WHERE tenant = ${a.tenant.id} ORDER BY created_at DESC LIMIT 100` }); });
app.get("/api/deploys/:id", withGrant("worker.status"), async (c) => { const a: Auth = c.get("auth"); return c.json({ deploy: await exitStatus(a, c.req.param("id")) }); });
app.post("/api/deploys/:id/restart", withGrant("worker.restart"), async (c) => { const a: Auth = c.get("auth"); return c.json(await exitRestart(a, c.req.param("id"), a.row.sub)); });
app.delete("/api/deploys/:id", withGrant("worker.delete"), async (c) => { const a: Auth = c.get("auth"); return c.json(await exitDelete(a, c.req.param("id"), a.row.sub)); });

// grant-bearing: ledger + events + tenant
app.get("/api/ledger", withGrant("ledger.read"), async (c) => { const a: Auth = c.get("auth"); return c.json({ ledger: await db`SELECT * FROM ledger WHERE tenant = ${a.tenant.id} ORDER BY id DESC LIMIT 200` }); });
app.get("/api/events", withGrant("tenant.read"), async (c) => { const a: Auth = c.get("auth"); return c.json({ events: await db`SELECT * FROM events WHERE tenant = ${a.tenant.id} ORDER BY id DESC LIMIT 200` }); });
app.post("/api/events", withGrant("webhook.emit"), async (c) => { const a: Auth = c.get("auth"); const b = await body(c); if (!b.type) throw new HttpError(400, "type_required"); await emit(`agent.${String(b.type).slice(0, 60)}`, b.data ?? {}, a.tenant.id, a.row.sub); return c.json({ ok: true }, 201); });
app.get("/api/tenant", withGrant("tenant.read"), (c) => { const a: Auth = c.get("auth"); const { stripe_customer, stripe_subscription, ...t } = a.tenant; return c.json({ tenant: t, tier: TIERS[t.tier] }); });

// grant-bearing: memory (per-tenant, partitioned; partition must be inside the grant's memory scope)
const memScope = (a: Auth, partition: string) => { if (!memParts(J(a.row.scope)).some((p) => partition.startsWith(p))) throw new HttpError(403, "out_of_scope", { partition }); return partition; };
app.post("/api/memory", withGrant("memory.write"), async (c) => { const a: Auth = c.get("auth"); const b = await body(c); if (!b.content || typeof b.content !== "string") throw new HttpError(400, "content_required"); const part = memScope(a, String(b.partition || "tenant").slice(0, 80)); return c.json({ memory: await memoryWrite(a.tenant.id, part, b.key ? String(b.key).slice(0, 120) : null, b.content.slice(0, 20000), Array.isArray(b.tags) ? b.tags.slice(0, 20).map(String) : [], a.row.sub) }, 201); });
app.get("/api/memory", withGrant("memory.read"), async (c) => { const a: Auth = c.get("auth"); const q = c.req.query("partition"); const prefix = q ? memScope(a, q) : memParts(J(a.row.scope))[0]; return c.json({ memories: await memorySearch(a.tenant.id, c.req.query("q") || "", prefix, +(c.req.query("limit") || 10)) }); });
app.get("/api/memory/:id", withGrant("memory.read"), async (c) => { const a: Auth = c.get("auth"); const r = await db`SELECT * FROM memories WHERE id = ${c.req.param("id")} AND tenant = ${a.tenant.id}`; if (!r.length) throw new HttpError(404, "memory_not_found"); memScope(a, r[0].partition); return c.json({ memory: memOut(r[0]) }); });
app.delete("/api/memory/:id", withGrant("memory.write"), async (c) => { const a: Auth = c.get("auth"); const r = await db`SELECT partition FROM memories WHERE id = ${c.req.param("id")} AND tenant = ${a.tenant.id}`; if (!r.length) throw new HttpError(404, "memory_not_found"); memScope(a, r[0].partition); return c.json({ memory: await memoryForget(a.tenant.id, c.req.param("id")) }); });

// sync seams (peer protocol shared with cognitive-mcp-bridge): bearer COG_SYNC_TOKEN
const syncOnly = tag(async (c: any, next: any) => { if (!env.COG_SYNC_TOKEN) throw new HttpError(503, "unarmed", { needs: "COG_SYNC_TOKEN" }); const t = bearer(c); if (!t || !safeEq(t, env.COG_SYNC_TOKEN)) throw new HttpError(401, "sync_token_required"); await next(); }, "sync-token");
app.get("/sync/changes", syncOnly, async (c) => { const since = Number(c.req.query("since") || 0); const rows = await db`SELECT * FROM memories WHERE version > ${since} ORDER BY version ASC LIMIT 500`; return c.json({ records: rows.map(syncOut), next: rows.length ? Number(rows[rows.length - 1].version) : since, more: rows.length === 500 }); });
app.post("/sync/apply", syncOnly, async (c) => { const b = await body(c); if (!Array.isArray(b.records)) throw new HttpError(400, "records_required"); return c.json(await memoryApply(b.records.slice(0, 500))); });
app.get("/api/admin/outbox", adminOnly, async (c) => c.json({ outbox: await db`SELECT id, kind, attempts, next_at, done, last_error, created_at FROM outbox ORDER BY id DESC LIMIT 200` }));
app.post("/api/admin/outbox/drain", adminOnly, async (c) => c.json(await drainOutbox(200)));
app.post("/api/admin/memory/pull", adminOnly, async (c) => c.json(await memoryPull()));
app.get("/api/admin/memory", adminOnly, async (c) => c.json({ memories: (await db`SELECT * FROM memories ORDER BY updated_at DESC LIMIT 200`).map(memOut) }));

// Railway OAuth (per-tenant "Login with Railway") — PKCE + state
app.get("/auth/railway/start", withGrant("tenant.read"), async (c) => {
  const a: Auth = c.get("auth");
  if (!env.RAILWAY_OAUTH_CLIENT_ID || !env.RAILWAY_OAUTH_CLIENT_SECRET) throw new HttpError(503, "unarmed", { needs: "RAILWAY_OAUTH_CLIENT_ID+SECRET" });
  if (!vaultKey()) throw new HttpError(503, "unarmed", { needs: "VAULT_KEY" });
  const verifier = randomBytes(32).toString("base64url"); const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  await db`INSERT INTO oauth_states (state, tenant, verifier) VALUES (${state}, ${a.tenant.id}, ${verifier})`;
  const redirect = `${env.PUBLIC_URL || new URL(c.req.url).origin}/auth/railway/callback`;
  const u = new URL("https://backboard.railway.com/oauth/auth");
  u.search = new URLSearchParams({ response_type: "code", client_id: env.RAILWAY_OAUTH_CLIENT_ID, redirect_uri: redirect, scope: "openid", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return c.json({ authorizeUrl: u.toString(), redirect_uri: redirect, state });
});
app.get("/auth/railway/callback", async (c) => {
  if (!env.RAILWAY_OAUTH_CLIENT_ID || !env.RAILWAY_OAUTH_CLIENT_SECRET) throw new HttpError(503, "unarmed", { needs: "RAILWAY_OAUTH_CLIENT_ID+SECRET" });
  const { code, state, error } = c.req.query(); if (error) throw new HttpError(400, "oauth_denied", error);
  const st = state ? (await db`DELETE FROM oauth_states WHERE state = ${state} AND created_at > now() - interval '10 minutes' RETURNING *`)[0] : null;
  if (!st || !code) throw new HttpError(400, "bad_state");
  const redirect = `${env.PUBLIC_URL || new URL(c.req.url).origin}/auth/railway/callback`;
  const r = await fetch("https://backboard.railway.com/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(`${env.RAILWAY_OAUTH_CLIENT_ID}:${env.RAILWAY_OAUTH_CLIENT_SECRET}`).toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: st.verifier }) });
  const tok: any = await r.json().catch(() => ({})); if (!r.ok || !tok.access_token) throw new HttpError(502, "token_exchange_failed");
  const sealed = vaultSeal(JSON.stringify(tok));
  await db`INSERT INTO vault (id, tenant, provider, ciphertext, iv, tag, meta) VALUES (${rid("v")}, ${st.tenant}, 'railway', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${({ scope: tok.scope || null, obtained: new Date().toISOString() })}::jsonb)
    ON CONFLICT (tenant, provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, meta = EXCLUDED.meta, created_at = now()`;
  await emit("vault.stored", { provider: "railway" }, st.tenant, "oauth");
  return c.html(`<!doctype html><meta charset=utf-8><title>Connected</title><body style="font-family:system-ui;padding:40px"><h2>Railway connected.</h2><p>You can close this tab.</p><a href="/">Back to hub</a>`);
});

// webhooks (raw body first, then verify, then idempotent intake)
app.post("/webhooks/stripe", async (c) => {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, "unarmed", { needs: "STRIPE_WEBHOOK_SECRET" });
  const raw = await c.req.text();
  if (!verifyStripeSig(raw, c.req.header("stripe-signature"), env.STRIPE_WEBHOOK_SECRET)) throw new HttpError(401, "bad_signature");
  const evt = JSON.parse(raw); const id = await intake("stripe", String(evt.id), evt.type, evt);
  if (id === null) return c.json({ received: true, replay: true });
  const result = await handleStripe(evt); await handled(id, result); return c.json({ received: true, result });
});
app.post("/webhooks/railway", async (c) => {
  if (!env.RAILWAY_WEBHOOK_TOKEN) throw new HttpError(503, "unarmed", { needs: "RAILWAY_WEBHOOK_TOKEN" });
  const tok = c.req.query("token") || c.req.header("x-runtime-token") || "";
  if (!safeEq(tok, env.RAILWAY_WEBHOOK_TOKEN)) throw new HttpError(401, "bad_token");
  const evt = await body(c); const eid = `${evt.resource?.deployment?.id || evt.resource?.service?.id || "na"}:${evt.type}:${evt.timestamp || ""}`;
  const id = await intake("railway", eid, evt.type || null, evt); if (id === null) return c.json({ received: true, replay: true });
  const result = await handleRailway(evt); await handled(id, result); return c.json({ received: true, result });
});
app.post("/webhooks/github", async (c) => {
  if (!env.GITHUB_WEBHOOK_SECRET) throw new HttpError(503, "unarmed", { needs: "GITHUB_WEBHOOK_SECRET" });
  const raw = await c.req.text(); const sig = c.req.header("x-hub-signature-256") || "";
  if (!safeEq(sig, "sha256=" + hmac(env.GITHUB_WEBHOOK_SECRET, raw))) throw new HttpError(401, "bad_signature");
  const evt = JSON.parse(raw || "{}"); const eid = c.req.header("x-github-delivery") || sha(raw); const type = c.req.header("x-github-event") || "unknown";
  const id = await intake("github", eid, type, { repo: evt.repository?.full_name, ref: evt.ref, after: evt.after }); if (id === null) return c.json({ received: true, replay: true });
  await emit("repo." + type, { repo: evt.repository?.full_name, ref: evt.ref, after: evt.after }, null, "github"); await handled(id, { emitted: true });
  return c.json({ received: true });
});
app.post("/webhooks/brain", async (c) => {
  if (!env.BRAIN_WEBHOOK_SECRET) throw new HttpError(503, "unarmed", { needs: "BRAIN_WEBHOOK_SECRET" });
  const raw = await c.req.text(); if (!safeEq(c.req.header("x-brain-signature") || "", hmac(env.BRAIN_WEBHOOK_SECRET, raw))) throw new HttpError(401, "bad_signature");
  const evt = JSON.parse(raw || "{}"); const id = await intake("brain", String(evt.id || sha(raw)), evt.type || null, evt); if (id === null) return c.json({ received: true, replay: true });
  await emit("brain." + String(evt.type || "event").slice(0, 60), evt.data ?? evt, evt.tenant || null, "brain"); await handled(id, { emitted: true });
  return c.json({ received: true });
});
app.post("/webhooks/mesh", async (c) => {
  if (!env.MESH_RECEIPT_SECRET) throw new HttpError(503, "unarmed", { needs: "MESH_RECEIPT_SECRET" });
  const raw = await c.req.text(); if (!safeEq(c.req.header("x-mesh-signature") || "", hmac(env.MESH_RECEIPT_SECRET, raw))) throw new HttpError(401, "bad_signature");
  const rcpt = JSON.parse(raw || "{}"); const id = await intake("mesh", String(rcpt.receipt_id || sha(raw)), "receipt", rcpt); if (id === null) return c.json({ received: true, replay: true });
  const receiptGrants = (await getSetting("receipt_grants")) === "on"; // over-the-top lane, off by default
  await emit("mesh.receipt", { amount: rcpt.amount, capability: rcpt.capability, minted: receiptGrants }, rcpt.tenant || null, "mesh"); await handled(id, { stored: true, minted: false, receiptGrants });
  return c.json({ received: true, stored: true, minted: false, note: receiptGrants ? "receipt→grant lane armed but minting not yet implemented" : "receipt stored; receipt→grant lane is off" }, 202);
});

// == [9] MCP (streamable HTTP, JSON responses) ==
const MCP_TOOLS = [
  { name: "runtime_health", description: "Health + armed integrations", inputSchema: { type: "object", properties: {} } },
  { name: "grant_verify", description: "Introspect the presented grant", inputSchema: { type: "object", properties: {} } },
  { name: "grant_issue", description: "Mint an attenuated child grant (needs grant.issue)", inputSchema: { type: "object", properties: { sub: { type: "string" }, caps: { type: "array", items: { type: "string" } }, ttlSec: { type: "number" }, budget: { type: "object" }, scope: { type: "object" }, constraints: { type: "object" } }, required: ["sub", "caps"] } },
  { name: "cog_plan", description: "Ask the COG for a proposal from a natural-language intent", inputSchema: { type: "object", properties: { intent: { type: "string" }, hints: { type: "object" } }, required: ["intent"] } },
  { name: "cog_execute", description: "Proposal → gatehouse → grants + deploys (dry-run unless confirm)", inputSchema: { type: "object", properties: { proposal: { type: "object" }, confirm: { type: "boolean" } }, required: ["proposal"] } },
  { name: "deploy_worker", description: "Direct deploy intent (needs deploy.worker)", inputSchema: { type: "object", properties: { name: { type: "string" }, template: { type: "string" }, env: { type: "object" }, confirm: { type: "boolean" } }, required: ["name", "template"] } },
  { name: "deploy_status", description: "Status of a deploy (needs worker.status)", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ledger_query", description: "Tenant ledger tail (needs ledger.read)", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "memory_search", description: "Search tenant memory (needs memory.read)", inputSchema: { type: "object", properties: { q: { type: "string" }, partition: { type: "string" }, limit: { type: "number" } } } },
  { name: "memory_write", description: "Remember something (needs memory.write)", inputSchema: { type: "object", properties: { partition: { type: "string" }, key: { type: "string" }, content: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["content"] } },
  { name: "memory_forget", description: "Tombstone a memory (needs memory.write)", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];
const rpc = (id: any, result?: any, error?: { code: number; message: string; data?: any }) => (error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
app.get("/mcp", (c) => c.json({ transport: "streamable-http", methods: ["initialize", "tools/list", "tools/call", "ping"], tools: MCP_TOOLS.map((t) => t.name), auth: "Bearer <grant>" }));
app.post("/mcp", async (c) => {
  const msg: any = await body(c); const id = msg.id ?? null;
  if (msg.method === "notifications/initialized") return c.body(null, 202);
  if (msg.method === "initialize") return c.json(rpc(id, { protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: ISS, version: VERSION } }));
  if (msg.method === "ping") return c.json(rpc(id, {}));
  if (msg.method === "tools/list") return c.json(rpc(id, { tools: MCP_TOOLS }));
  if (msg.method !== "tools/call") return c.json(rpc(id, undefined, { code: -32601, message: "method_not_found" }));
  const name = msg.params?.name, args = msg.params?.arguments || {};
  const wrap = (v: any) => rpc(id, { content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v });
  try {
    if (name === "runtime_health") { let dbOk = false; try { await db`SELECT 1`; dbOk = true; } catch {} return c.json(wrap({ ok: dbOk, version: VERSION, armed: ARMED(), killSwitch: await killSwitch() })); }
    const capFor: Record<string, Cap | null> = { grant_verify: null, grant_issue: "grant.issue", cog_plan: "cog.plan", cog_execute: "cog.execute", deploy_worker: "deploy.worker", deploy_status: "worker.status", ledger_query: "ledger.read", memory_search: "memory.read", memory_write: "memory.write", memory_forget: "memory.write" };
    if (!(name in capFor)) return c.json(rpc(id, undefined, { code: -32602, message: "unknown_tool" }));
    const a = await verifyGrant(bearer(c), capFor[name]);
    switch (name) {
      case "grant_verify": return c.json(wrap({ id: a.row.id, tenant: a.tenant.id, sub: a.row.sub, caps: J(a.row.caps), scope: J(a.row.scope), remaining: remaining(a.row), exp: Number(a.row.exp) }));
      case "grant_issue": { const m = await mintChild(a.row, args, a.row.sub); return c.json(wrap({ id: m.row.id, token: m.token, exp: Number(m.row.exp) })); }
      case "cog_plan": return c.json(wrap({ proposal: await cogPlan(a, String(args.intent || ""), args.hints || {}) }));
      case "cog_execute": return c.json(wrap(await cogExecute(a, args.proposal, !!args.confirm)));
      case "deploy_worker": return c.json(wrap(await exitDeploy(a, args, !!args.confirm, a.row.sub)));
      case "deploy_status": return c.json(wrap({ deploy: await exitStatus(a, String(args.id)) }));
      case "ledger_query": return c.json(wrap({ ledger: await db`SELECT * FROM ledger WHERE tenant = ${a.tenant.id} ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, +args.limit || 50))}` }));
      case "memory_search": { const prefix = args.partition ? memScope(a, String(args.partition)) : memParts(J(a.row.scope))[0]; return c.json(wrap({ memories: await memorySearch(a.tenant.id, String(args.q || ""), prefix, +args.limit || 10) })); }
      case "memory_write": { if (!args.content) throw new HttpError(400, "content_required"); const part = memScope(a, String(args.partition || "tenant").slice(0, 80)); return c.json(wrap({ memory: await memoryWrite(a.tenant.id, part, args.key ? String(args.key).slice(0, 120) : null, String(args.content).slice(0, 20000), Array.isArray(args.tags) ? args.tags.map(String) : [], a.row.sub) })); }
      case "memory_forget": { const r = await db`SELECT partition FROM memories WHERE id = ${String(args.id)} AND tenant = ${a.tenant.id}`; if (!r.length) throw new HttpError(404, "memory_not_found"); memScope(a, r[0].partition); return c.json(wrap({ memory: await memoryForget(a.tenant.id, String(args.id)) })); }
    }
  } catch (e: any) {
    if (e instanceof HttpError) return c.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e.code, detail: e.detail ?? null }) }] } });
    throw e;
  }
  return c.json(rpc(id, undefined, { code: -32603, message: "unhandled" }));
});

// == [10] cockpit (human surface) == served from the docs table as "_cockpit" (uploaded from cockpit.html); tiny fallback until then
const CSS = `body{margin:0;background:#0f1115;color:#e8eaf0;font:15px/1.5 system-ui,sans-serif;padding:16px}main{max-width:1100px;margin:0 auto}a{color:#7cc4ff;text-decoration:none}.card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:16px;margin:12px 0}table{border-collapse:collapse}td{padding:4px 8px;border-bottom:1px solid #262b36}`;
const shell = (title: string, inner: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body><main>${inner}</main></body></html>`;
app.get("/", async (c) => { const html = await docGet("_cockpit"); return c.html(html || shell("creator-os-runtime", `<h1>creator-os-runtime</h1><div class="card">Cockpit not uploaded yet — <code>PUT /api/admin/docs/_cockpit</code> with cockpit.html. Machine surface: <a href="/health">/health</a> · <a href="/routes">/routes</a> · <a href="/mcp">/mcp</a> · <a href="/docs">/docs</a></div>`)); });
app.get("/cockpit/:page", (c) => c.redirect(`/#/${c.req.param("page")}`));

// == [11] docs + routes + selftest ==
// docs are data: uploaded once with PUT /api/admin/docs/:name (markdown body), served from Postgres — updatable without a redeploy
async function docNames() { return (await db`SELECT name FROM docs ORDER BY name`).map((r: any) => r.name as string); }
async function docGet(name: string) { const r = await db`SELECT content FROM docs WHERE name = ${name}`; return r.length ? (r[0].content as string) : null; }
function md2html(md: string) {
  const esc = (s: string) => s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]!));
  const lines = md.split("\n"); let out = "", inCode = false, inTable = false;
  for (const raw of lines) {
    if (raw.startsWith("```")) { out += inCode ? "</code></pre>" : "<pre><code>"; inCode = !inCode; continue; }
    if (inCode) { out += esc(raw) + "\n"; continue; }
    const l = raw.replace(/`([^`]+)`/g, (_, x) => `<code>${esc(x)}</code>`).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    if (/^\|/.test(raw)) { if (/^\|\s*-/.test(raw)) continue; if (!inTable) { out += "<table>"; inTable = true; } out += "<tr>" + raw.split("|").slice(1, -1).map((x) => `<td>${x.trim()}</td>`).join("") + "</tr>"; continue; }
    else if (inTable) { out += "</table>"; inTable = false; }
    const h = raw.match(/^(#{1,3})\s+(.*)/); if (h) { out += `<h${h[1].length}>${h[2]}</h${h[1].length}>`; continue; }
    if (/^\s*[-*]\s+/.test(raw)) { out += `<div>• ${l.replace(/^\s*[-*]\s+/, "")}</div>`; continue; }
    if (/^\s*\d+\.\s+/.test(raw)) { out += `<div>${l}</div>`; continue; }
    out += raw.trim() ? `<p>${l}</p>` : "";
  }
  if (inTable) out += "</table>";
  return out;
}
app.get("/docs", async (c) => { const names = (await docNames()).filter((n) => !n.startsWith("_")); return c.html(shell("Docs", `<a href="/">← Back to hub</a><h1>Docs</h1><p>Served by the running instance. The deployed instance is the spec.</p><div class="card">${names.map((k) => `<div><a href="/docs/${k}">${k}</a></div>`).join("") || "No docs uploaded yet (PUT /api/admin/docs/:name)."}</div>`)); });
app.get("/docs/:name", async (c) => { const n = c.req.param("name"); const md = n.startsWith("_") ? null : await docGet(n); if (md === null) return c.notFound(); if ((c.req.header("accept") || "").includes("text/markdown") || c.req.query("raw") !== undefined) return c.text(md); return c.html(shell(n, `<a href="/docs">← Back to docs</a><div class="card">${md2html(md)}</div>`)); });
app.put("/api/admin/docs/:name", adminOnly, async (c) => { const n = c.req.param("name"); if (!/^[A-Za-z0-9_-]{1,40}$/.test(n)) throw new HttpError(400, "bad_doc_name"); const md = await c.req.text(); if (!md.trim()) throw new HttpError(400, "empty_doc"); await db`INSERT INTO docs (name, content, updated_at) VALUES (${n}, ${md}, now()) ON CONFLICT (name) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`; return c.json({ ok: true, name: n, bytes: Buffer.byteLength(md) }); });

// Route inventory is derived from the live Hono registrations (auth from tagged middleware) — no second list to drift.
const AUTH_NOTES: Record<string, string> = { "GET /cockpit/:page": "public(page)+admin(data)", "GET /auth/railway/callback": "public(state)", "POST /webhooks/stripe": "webhook:stripe-signature", "POST /webhooks/railway": "webhook:?token=", "POST /webhooks/github": "webhook:x-hub-signature-256", "POST /webhooks/brain": "webhook:x-brain-signature", "POST /webhooks/mesh": "webhook:x-mesh-signature", "POST /mcp": "grant (per tool)", "DELETE /api/deploys/:id": "grant:worker.delete (+breakglass in production)", "GET /sync/changes": "sync-token", "POST /sync/apply": "sync-token" };
function routeInventory() {
  const seen = new Map<string, string>();
  for (const r of (app as any).routes) {
    if (r.method === "ALL") continue;
    const k = `${r.method} ${r.path}`; const a = (r.handler as any)?.auth as string | undefined;
    seen.set(k, AUTH_NOTES[k] || a || seen.get(k) || "public");
  }
  return [...seen].map(([k, auth]) => { const i = k.indexOf(" "); return { method: k.slice(0, i), path: k.slice(i + 1), auth }; });
}
app.get("/routes", (c) => { const routes = routeInventory(); return c.json({ routes, count: routes.length }); });

app.get("/selftest", async (c) => {
  const results: { name: string; pass: boolean; info?: any }[] = [];
  const t = (name: string, fn: () => any) => { try { const r = fn(); results.push({ name, pass: r === true, info: r === true ? undefined : r }); } catch (e: any) { results.push({ name, pass: false, info: String(e?.message || e) }); } };
  const fake = { id: "gr_p", tenant: "t_x", status: "active", depth: 0, exp: nowSec() + 3600, caps: ["deploy.worker", "worker.status", "grant.issue"], scope: { railway: { projects: ["p1"], environments: ["production"] }, workers: { namePrefix: "t-abc-" } }, budget: { usd_cents: 100, calls: 10, deploys: 2 }, reserved: B0(), settled: { usd_cents: 40, calls: 1, deploys: 1 }, constraints: { maxWorkers: 2, maxReplicas: 1, allowDelete: false, requireDryRun: true } };
  const okChild = { caps: ["deploy.worker"], scope: { railway: { projects: ["p1"], environments: ["production"] }, workers: { namePrefix: "t-abc-x-" } }, budget: { usd_cents: 60, calls: 5, deploys: 1 }, exp: nowSec() + 600, constraints: { maxWorkers: 1, maxReplicas: 1, allowDelete: false, requireDryRun: true }, depth: 1 };
  t("sign/verify roundtrip", () => { const j = JSON.stringify({ v: 1, iss: ISS, id: "x" }); return parseToken(signPayload(j))?.payload?.id === "x"; });
  t("tampered token rejected", () => { const tok = signPayload(JSON.stringify({ v: 1, iss: ISS, id: "x" })); const [a, p, s] = tok.split("."); const bad = `${a}.${Buffer.from(JSON.stringify({ v: 1, iss: ISS, id: "y" })).toString("base64url")}.${s}`; return parseToken(bad) === null; });
  t("attenuation ok child accepted", () => { const v = attenuationViolations(fake, okChild, "starter"); return v.length === 0 || v; });
  t("cap widening rejected", () => attenuationViolations(fake, { ...okChild, caps: ["worker.delete"] }, "starter").includes("cap_not_in_parent:worker.delete"));
  t("unknown cap rejected", () => attenuationViolations(fake, { ...okChild, caps: ["money.send"] }, "starter").includes("unknown_cap:money.send"));
  t("budget over parent remaining rejected", () => attenuationViolations(fake, { ...okChild, budget: { usd_cents: 61, calls: 1, deploys: 1 } }, "starter").includes("budget_exceeds_parent_remaining"));
  t("allowDelete widening rejected", () => attenuationViolations(fake, { ...okChild, constraints: { ...okChild.constraints, allowDelete: true } }, "starter").includes("allowDelete_widened"));
  t("policy fail-closed on garbage", () => attenuationViolations(null, okChild, "starter").includes("policy_evaluation_error"));
  t("gatehouse denies malformed proposal", () => { const g = gatehouseEvaluate({ id: "t_abcdef", tier: "starter", status: "active", allowed_targets: {} }, null, { nope: 1 }); return !g.ok && g.reasons.includes("malformed_proposal"); });
  t("gatehouse denies forbidden cap family", () => { const g = gatehouseEvaluate({ id: "t_abcdef", tier: "starter", status: "active", allowed_targets: {} }, null, { grants: [{ caps: ["wallet.spend"], ttlSec: 10, budget: {} }], deploys: [] }); return !g.ok && g.reasons.includes("forbidden_cap_family"); });
  t("stripe signature verifies", () => { const raw = '{"id":"evt_1"}', ts = nowSec(); const sig = `t=${ts},v1=${hmac("whsec_test", `${ts}.${raw}`)}`; return verifyStripeSig(raw, sig, "whsec_test") && !verifyStripeSig(raw + " ", sig, "whsec_test") && !verifyStripeSig(raw, `t=${ts - 1000},v1=${hmac("whsec_test", `${ts - 1000}.${raw}`)}`, "whsec_test"); });
  t("vault seal/open roundtrip (when armed)", () => { if (!vaultKey()) return "skipped:unarmed"; const s = vaultSeal("secret"); return vaultOpen(s) === "secret"; });
  t("route inventory derives from app (≥45 routes, all tagged)", () => { const inv = routeInventory(); return (inv.length >= 45 && inv.every((r) => !!r.auth)) || { count: inv.length }; });
  t("memory scope widening rejected", () => attenuationViolations({ ...fake, scope: { ...fake.scope, memory: { partitions: ["worker:a"] } } }, { ...okChild, scope: { ...okChild.scope, memory: { partitions: ["worker:"] } } }, "starter").includes("scope_memory_widened") && attenuationViolations({ ...fake, scope: { ...fake.scope, memory: { partitions: ["worker:a"] } } }, { ...okChild, scope: { ...okChild.scope, memory: { partitions: ["worker:a-1"] } } }, "starter").length === 0);
  const pass = results.every((r) => r.pass || String(r.info || "").startsWith("skipped"));
  return c.json({ pass, count: results.length, results }, pass ? 200 : 500);
});

// == [12] boot ==
try { SOURCE_TEXT = await Bun.file(import.meta.path).text(); SOURCE_SHA = sha(SOURCE_TEXT); SOURCE_BYTES = Buffer.byteLength(SOURCE_TEXT, "utf8"); } catch {}
await migrate();
const keySrc = await loadSigningKey();
if (!(await getSetting("kill_switch"))) await setSetting("kill_switch", "off");
console.log(`[${ISS} v${VERSION}] policy=${POLICY_VERSION} signingKey=${keySrc} armed=${JSON.stringify(ARMED())}`);
const PORT = Number(env.PORT || 3000);
export default { port: PORT, fetch: app.fetch };
