// Routes: memory API, cognitive-mcp sync, admin outbox/memory. Registration order is significant.
import { HttpError, parseJson } from "../util.js";
import { sql } from "../db.js";
import { drainOutbox } from "../outbox.js";
import { memoryPartitions } from "../policy.js";
import {
  applySyncRecords,
  assertMemoryScope,
  forgetMemory,
  pullMemoryFromBridge,
  searchMemories,
  serializeMemory,
  toSyncRecord,
  writeMemory,
} from "../memory.js";
import { app, readJsonBody, requireAdmin, requireGrant, requireSyncToken } from "../http.js";

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
        t, // auth → guest write cap + brain-sync quarantine
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
