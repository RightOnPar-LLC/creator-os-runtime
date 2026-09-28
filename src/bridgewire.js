// Wire adapter between the runtime's memory sync records and the cognitive-mcp
// bridge's /sync routes (cognitive-mcp feat/http-bridge, rust/src/http.rs + sync.rs).
//
// The two sides speak different shapes, and the brain side fails SILENTLY on the
// wrong one: POST /sync/apply defaults a missing `changes` field to an empty list
// and answers 200 {applied:0}, and GET /sync/changes returns {changes, watermark}
// where the runtime read {records, next}. Without this adapter every push was
// "delivered" and every pull applied nothing — both with HTTP 200.
//
//   runtime record : { partition:"<tenant>/<partition>", key, content, tags[], version, deleted, updated_at }
//   bridge Change  : { scope, key, value: JSON|null, version, deleted }
//   Change.value   : { content, tags: "<json array>", created_at: ms, updated_at: ms, ... }
//
// Scope: runtime memories live under SCOPE_PREFIX, on the MeshTool (mainstream)
// side of the ring-fence. A pull only ever imports scopes under that prefix, so
// the runtime can never ingest agent:, shared:, or any other tenant namespace.
//
// Key: the brain's `key` is a global identity (sync_key), so it must be unique
// across tenants and partitions — it is "rt:" + the three parts URI-encoded,
// which contain no ":" and decode unambiguously.
//
// Versions: the brain's `version` is its own store-wide counter, meaningless
// against a runtime row's version. Both sides resolve conflicts by last-write
// time (the runtime's version is Date.now() at write; the brain compares
// updated_at), so a pulled row takes its updated_at (ms) as its runtime version. A tombstone carries no timestamp; it takes
// the pull time, so a delete wins over anything written before it.

export const SCOPE_PREFIX = "tenant:mesh:runtime/";
const KEY_PREFIX = "rt:";

const toMs = (v) => {
  const n = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? n : Date.now();
};

const splitPartition = (p) => {
  const s = String(p || "");
  const i = s.indexOf("/");
  return i > 0 && i < s.length - 1 ? [s.slice(0, i), s.slice(i + 1)] : null;
};

// runtime sync record -> bridge Change (or null if the record is malformed).
export function toBridgeChange(r) {
  const parts = splitPartition(r?.partition);
  if (!parts || !r.key) return null;
  const [tenant, partition] = parts;
  // The runtime stamps version = Date.now() on every write and forget, so it IS
  // the row's last-write time; using it keeps a round trip exact (an echo pulled
  // back carries the same number and is skipped, not rewritten).
  const updated = Number(r.version) > 0 ? Number(r.version) : toMs(r.updated_at);
  return {
    scope: `${SCOPE_PREFIX}${tenant}/${partition}`,
    key: KEY_PREFIX + [tenant, partition, String(r.key)].map(encodeURIComponent).join(":"),
    value: r.deleted
      ? null
      : JSON.stringify({
          content: String(r.content ?? ""),
          tags: JSON.stringify(Array.isArray(r.tags) ? r.tags : []),
          created_at: updated,
          updated_at: updated,
        }),
    version: Number(r.version) || 0,
    deleted: !!r.deleted,
  };
}

// bridge Change -> runtime sync record, or null when it is not a runtime memory
// (outside SCOPE_PREFIX, foreign key shape, key/scope disagreeing, bad payload).
export function fromBridgeChange(c, now = Date.now()) {
  if (!c || typeof c.scope !== "string" || !c.scope.startsWith(SCOPE_PREFIX)) return null;
  if (typeof c.key !== "string" || !c.key.startsWith(KEY_PREFIX)) return null;
  const segs = c.key.slice(KEY_PREFIX.length).split(":");
  if (segs.length !== 3) return null;
  let tenant, partition, key;
  try {
    [tenant, partition, key] = segs.map(decodeURIComponent);
  } catch {
    return null;
  }
  if (!tenant || !partition || !key) return null;
  // The key names the row; the scope must agree with it, or a record could claim
  // one tenant's scope while writing into another tenant's rows.
  if (c.scope !== `${SCOPE_PREFIX}${tenant}/${partition}`) return null;

  if (c.deleted || c.value == null) {
    return { partition: `${tenant}/${partition}`, key, content: "", tags: [], version: now, deleted: true };
  }
  let p;
  try {
    p = JSON.parse(c.value);
  } catch {
    return null;
  }
  let tags = [];
  try {
    const t = typeof p.tags === "string" ? JSON.parse(p.tags) : p.tags;
    if (Array.isArray(t)) tags = t.map(String);
  } catch {}
  return {
    partition: `${tenant}/${partition}`,
    key,
    content: String(p.content ?? ""),
    tags,
    version: toMs(p.updated_at),
    deleted: false,
  };
}
