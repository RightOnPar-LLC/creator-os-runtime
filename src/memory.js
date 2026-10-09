// Tenant memory: write, search, forget, sync records, pull from the cognitive bridge, scope checks.
import { env } from "./config.js";
import { HttpError, newId, parseJson, sha256Hex } from "./util.js";
import { getSetting, setSetting, sql } from "./db.js";
import { cogBridgeUrl, enqueueOutbox } from "./outbox.js";
import { memoryPartitions, partitionCovers } from "./policy.js";
import { guestWriteContext } from "./guest.js";
import { checkNamedRateLimit } from "./grants.js";
import { fromBridgeChange } from "./bridgewire.js";

export var serializeMemory = (e) => ({
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
});
export var toSyncRecord = (e) => ({
  partition: `${e.tenant}/${e.partition}`,
  key: e.key,
  content: e.content,
  tags: parseJson(e.tags),
  version: Number(e.version),
  deleted: !!e.deleted,
  updated_at: e.updated_at,
});
// A guest write is bounded (rate + footprint) before it lands, and it enqueues NO
// brain sync: a guest cannot flood or poison shared cognitive memory. `auth` is the
// grant/tenant of the caller (null for internal/system writes, which stay uncapped
// and synced as before).
async function enforceGuestWriteLimits(gx, partition, key, content) {
  // (1) a dedicated write meter, tighter than the generic per-grant limit and on its own key
  if (!(await checkNamedRateLimit(`mw:${gx.grantId}`, gx.ratePerMin)))
    throw new HttpError(429, "memory_write_rate_limited", { limit: gx.ratePerMin });
  // (2) a footprint cap over the guest's own partition subtree — enforced only when the
  // write would create a NEW (partition,key) row; updating an existing key never grows storage.
  let effKey = key || sha256Hex(content).slice(0, 16),
    pat = gx.base.replace(/([\\%_])/g, "\\$1") + "%",
    agg = (
      await sql`SELECT count(*)::int AS n,
        coalesce(sum(octet_length(content)), 0)::bigint AS bytes,
        coalesce(sum(octet_length(content)) FILTER (WHERE partition = ${partition} AND key = ${effKey}), 0)::bigint AS oldbytes,
        bool_or(partition = ${partition} AND key = ${effKey}) AS present
        FROM memories WHERE tenant = ${gx.tenant} AND deleted = false AND partition LIKE ${pat} ESCAPE '\\'`
    )[0];
  // row cap: only a NEW (partition,key) adds a row.
  if (!agg.present && Number(agg.n) >= gx.maxRows)
    throw new HttpError(429, "memory_partition_full", { memories: Number(agg.n), max: gx.maxRows });
  // byte cap in BYTES (octet_length, not char length), enforced on BOTH create AND
  // update — an update REPLACES the row, so the projected total subtracts the old bytes.
  let projected = Number(agg.bytes) - Number(agg.oldbytes) + Buffer.byteLength(content, "utf8");
  if (projected > gx.maxBytes)
    throw new HttpError(413, "memory_partition_bytes", { bytes: Number(agg.bytes), projected, max: gx.maxBytes });
}
export async function writeMemory(e, t, a, n, r, s, auth = null) {
  let gx = guestWriteContext(auth);
  if (gx) await enforceGuestWriteLimits(gx, t, a, n);
  let i =
      await sql`INSERT INTO memories (id, tenant, partition, key, content, tags, version, deleted, actor, updated_at)
    VALUES (${newId("m")}, ${e}, ${t}, ${a || sha256Hex(n).slice(0, 16)}, ${n}, ${r}::jsonb, ${Date.now()}, false, ${s}, now())
    ON CONFLICT (tenant, partition, key) DO UPDATE SET content = EXCLUDED.content, tags = EXCLUDED.tags, version = EXCLUDED.version, deleted = false, actor = EXCLUDED.actor, updated_at = now() RETURNING *`,
    o = serializeMemory(i[0]);
  // QUARANTINE: a guest's writes stay LOCAL — never synced to the cognitive brain.
  if (!gx) await enqueueOutbox("memory.sync", toSyncRecord(i[0]));
  return o;
}
// LIKE with the prefix's own % and _ taken literally (a partition may contain them).
var likeLiteral = (e) => e.replace(/[\\%_]/g, "\\$&");
// `a` is the scope prefix to search under. The match is the SAME boundary rule as
// partitionCovers (policy.js), so listing can never reach further than assertMemoryScope
// allows: the prefix itself, or the prefix followed by a real separator. A bare
// `LIKE prefix%` let a key scoped to "article:job4" list "article:job42" too.
// No prefix at all (a key whose memory scope is the empty list) lists nothing: the old
// `undefined + "%"` only returned nothing by accident, and DID return a partition whose
// name happened to start with "undefined". Anything that is not a string lists nothing
// too (String([[]]) is "", which would have meant "everything").
export async function searchMemories(e, t, a, n) {
  if (typeof a !== "string") return [];
  let r = Math.min(50, Math.max(1, Math.floor(n || 10))),
    p = a,
    l = likeLiteral(p),
    open = p === "" || /[:/-]$/.test(p),
    s1 = open ? l + "%" : l + ":%",
    s2 = open ? s1 : l + "/%",
    s3 = open ? s1 : l + "-%";
  return (
    t.trim()
      ? await sql`SELECT * FROM memories WHERE tenant = ${e} AND deleted = false AND (partition = ${p} OR partition LIKE ${s1} OR partition LIKE ${s2} OR partition LIKE ${s3}) AND (to_tsvector('english', content) @@ plainto_tsquery('english', ${t}) OR content ILIKE ${"%" + t + "%"})
        ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', ${t})) DESC, updated_at DESC LIMIT ${r}`
      : await sql`SELECT * FROM memories WHERE tenant = ${e} AND deleted = false AND (partition = ${p} OR partition LIKE ${s1} OR partition LIKE ${s2} OR partition LIKE ${s3}) ORDER BY updated_at DESC LIMIT ${r}`
  ).map(serializeMemory);
}
export async function forgetMemory(e, t, auth = null) {
  // A guest's forget is metered and QUARANTINED just like its write: without this,
  // write-then-forget would fan the (still-populated) content to the brain sync,
  // bypassing the quarantine (security review 2026-09-27).
  let gx = guestWriteContext(auth);
  if (gx && !(await checkNamedRateLimit(`mw:${gx.grantId}`, gx.ratePerMin)))
    throw new HttpError(429, "memory_write_rate_limited", { limit: gx.ratePerMin });
  let a =
    await sql`UPDATE memories SET deleted = true, version = ${Date.now()}, updated_at = now() WHERE id = ${t} AND tenant = ${e} RETURNING *`;
  if (!a.length) throw new HttpError(404, "memory_not_found");
  if (!gx) await enqueueOutbox("memory.sync", toSyncRecord(a[0])); // guest forgets never sync
  return serializeMemory(a[0]);
}
export async function applySyncRecords(e) {
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
export async function pullMemoryFromBridge() {
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
  // The bridge answers { changes, watermark } (see bridgewire.js); reading
  // { records, next } here found nothing and never advanced the cursor.
  let a = await t.json(),
    changes = Array.isArray(a.changes) ? a.changes : [],
    records = changes.map((c) => fromBridgeChange(c)).filter(Boolean),
    n = await applySyncRecords(records),
    r = Number(a.watermark) || e;
  n.foreign = changes.length - records.length;
  if (r > e) await setSetting("memory_pull_cursor", String(r));
  return {
    ...n,
    since: e,
    next: r,
  };
}
export var assertMemoryScope = (e, t) => {
  if (!memoryPartitions(parseJson(e.row.scope)).some((a) => partitionCovers(a, t)))
    throw new HttpError(403, "out_of_scope", {
      partition: t,
    });
  return t;
};
