// Tenant memory: write, search, forget, sync records, pull from the cognitive bridge, scope checks.
import { env } from "./config.js";
import { HttpError, newId, parseJson, sha256Hex } from "./util.js";
import { getSetting, setSetting, sql } from "./db.js";
import { cogBridgeUrl, enqueueOutbox } from "./outbox.js";
import { memoryPartitions } from "./policy.js";

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
export async function writeMemory(e, t, a, n, r, s) {
  let i =
      await sql`INSERT INTO memories (id, tenant, partition, key, content, tags, version, deleted, actor, updated_at)
    VALUES (${newId("m")}, ${e}, ${t}, ${a || sha256Hex(n).slice(0, 16)}, ${n}, ${r}::jsonb, ${Date.now()}, false, ${s}, now())
    ON CONFLICT (tenant, partition, key) DO UPDATE SET content = EXCLUDED.content, tags = EXCLUDED.tags, version = EXCLUDED.version, deleted = false, actor = EXCLUDED.actor, updated_at = now() RETURNING *`,
    o = serializeMemory(i[0]);
  return (await enqueueOutbox("memory.sync", toSyncRecord(i[0])), o);
}
export async function searchMemories(e, t, a, n) {
  let r = Math.min(50, Math.max(1, Math.floor(n || 10))),
    s = a + "%";
  return (
    t.trim()
      ? await sql`SELECT * FROM memories WHERE tenant = ${e} AND deleted = false AND partition LIKE ${s} AND (to_tsvector('english', content) @@ plainto_tsquery('english', ${t}) OR content ILIKE ${"%" + t + "%"})
        ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', ${t})) DESC, updated_at DESC LIMIT ${r}`
      : await sql`SELECT * FROM memories WHERE tenant = ${e} AND deleted = false AND partition LIKE ${s} ORDER BY updated_at DESC LIMIT ${r}`
  ).map(serializeMemory);
}
export async function forgetMemory(e, t) {
  let a =
    await sql`UPDATE memories SET deleted = true, version = ${Date.now()}, updated_at = now() WHERE id = ${t} AND tenant = ${e} RETURNING *`;
  if (!a.length) throw new HttpError(404, "memory_not_found");
  return (await enqueueOutbox("memory.sync", toSyncRecord(a[0])), serializeMemory(a[0]));
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
export var assertMemoryScope = (e, t) => {
  if (!memoryPartitions(parseJson(e.row.scope)).some((a) => t.startsWith(a)))
    throw new HttpError(403, "out_of_scope", {
      partition: t,
    });
  return t;
};
