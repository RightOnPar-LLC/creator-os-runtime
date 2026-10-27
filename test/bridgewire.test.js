// Contract tests for src/bridgewire.js — the runtime <-> cognitive-mcp bridge wire.
// Dependency-free (no harness, no DB): the fixtures are pinned to the brain's Rust
// types in cognitive-mcp feat/http-bridge rust/src/sync.rs:
//   Change  { scope: String, key: String, value: Option<String>, version: i64, deleted: bool }
//   Payload { content: String, tags: String, created_at: i64, updated_at: i64,
//             expires_at: Option<i64>, retracted_at: Option<i64>, retracted_by: Option<String> }
// and the route bodies in rust/src/http.rs:
//   POST /sync/apply   { changes: [Change] }         (a missing `changes` defaults to [] -> 200, applied 0)
//   GET  /sync/changes -> { changes: [Change], watermark }
import { describe, expect, test } from "bun:test";
import { SCOPE_PREFIX, fromBridgeChange, toBridgeChange } from "../src/bridgewire.js";

const T = 1790000000123; // a runtime version: Date.now() at write
const rec = (o = {}) => ({
  partition: "t_abc/notes",
  key: "k1",
  content: "hello",
  tags: ["a", "b"],
  version: T,
  deleted: false,
  updated_at: "2026-09-28T10:00:00.000Z",
  ...o,
});

const isI64 = (n) => Number.isSafeInteger(n);

describe("push: runtime record -> bridge Change", () => {
  test("matches the Rust Change/Payload field names and types exactly", () => {
    const c = toBridgeChange(rec());
    expect(Object.keys(c).sort()).toEqual(["deleted", "key", "scope", "value", "version"]);
    expect(typeof c.scope).toBe("string");
    expect(typeof c.key).toBe("string");
    expect(typeof c.value).toBe("string");
    expect(isI64(c.version)).toBe(true);
    expect(c.deleted).toBe(false);
    const p = JSON.parse(c.value);
    expect(typeof p.content).toBe("string");
    expect(typeof p.tags).toBe("string"); // Rust `tags: String` — a JSON array as text
    expect(JSON.parse(p.tags)).toEqual(["a", "b"]);
    expect(isI64(p.created_at) && isI64(p.updated_at)).toBe(true);
  });

  test("the request body the outbox sends carries `changes`, never `records`", () => {
    // Guards the exact silent-200 failure: the brain defaults a missing `changes` to [].
    const body = JSON.parse(JSON.stringify({ changes: [toBridgeChange(rec())] }));
    expect(Array.isArray(body.changes)).toBe(true);
    expect(body.changes).toHaveLength(1);
    expect(body.records).toBeUndefined();
  });

  test("scope stays on the MeshTool side of the fence, keyed by tenant and partition", () => {
    const c = toBridgeChange(rec());
    expect(SCOPE_PREFIX.startsWith("tenant:mesh:")).toBe(true);
    expect(c.scope).toBe(`${SCOPE_PREFIX}t_abc/notes`);
  });

  test("the brain key is globally unique: same key in two tenants or partitions differs", () => {
    const a = toBridgeChange(rec()).key;
    expect(toBridgeChange(rec({ partition: "t_other/notes" })).key).not.toBe(a);
    expect(toBridgeChange(rec({ partition: "t_abc/other" })).key).not.toBe(a);
  });

  test("updated_at is the runtime's version (its last-write time)", () => {
    expect(JSON.parse(toBridgeChange(rec()).value).updated_at).toBe(T);
  });

  test("a forget becomes a tombstone with no payload", () => {
    const c = toBridgeChange(rec({ deleted: true }));
    expect(c.deleted).toBe(true);
    expect(c.value).toBeNull();
  });

  test("a malformed record is refused, not sent", () => {
    expect(toBridgeChange(rec({ partition: "no-slash" }))).toBeNull();
    expect(toBridgeChange(rec({ key: "" }))).toBeNull();
    expect(toBridgeChange(null)).toBeNull();
  });
});

describe("pull: bridge Change -> runtime record", () => {
  test("round trip preserves tenant, partition, key, content and tags — even with / and : in them", () => {
    const r = rec({ partition: "t_abc/deep/path:x", key: "a:b/c d" });
    const back = fromBridgeChange(toBridgeChange(r));
    expect(back).toEqual({
      partition: "t_abc/deep/path:x",
      key: "a:b/c d",
      content: "hello",
      tags: ["a", "b"],
      version: T,
      deleted: false,
    });
  });

  test("an echo of our own write comes back with the same version, so applySyncRecords skips it", () => {
    expect(fromBridgeChange(toBridgeChange(rec())).version).toBe(T);
  });

  test("reads a page exactly as the Rust sync_changes serialises it", () => {
    // value = serde_json::to_string(&Payload) — Option fields present as null.
    const page = {
      changes: [
        {
          scope: `${SCOPE_PREFIX}t_abc/notes`,
          key: "rt:t_abc:notes:k9",
          value: JSON.stringify({
            content: "from the brain",
            tags: '["x"]',
            created_at: 1790000000000,
            updated_at: 1790000000500,
            expires_at: null,
            retracted_at: null,
            retracted_by: null,
          }),
          version: 42,
          deleted: false,
        },
        { scope: `${SCOPE_PREFIX}t_abc/notes`, key: "rt:t_abc:notes:gone", value: null, version: 43, deleted: true },
      ],
      watermark: 43,
    };
    const out = page.changes.map((c) => fromBridgeChange(c, 1790000009999));
    expect(out[0]).toEqual({
      partition: "t_abc/notes",
      key: "k9",
      content: "from the brain",
      tags: ["x"],
      version: 1790000000500, // the brain's updated_at, NOT its store counter (42)
      deleted: false,
    });
    expect(out[1]).toMatchObject({ partition: "t_abc/notes", key: "gone", deleted: true, version: 1790000009999 });
  });

  test("never imports anything outside the runtime's scope prefix", () => {
    const v = JSON.stringify({ content: "secret", tags: "[]", created_at: 1, updated_at: 2 });
    for (const scope of ["agent:default", "shared:estate", "tenant:mesh:somehandle", "repo:x/y"]) {
      expect(fromBridgeChange({ scope, key: "rt:t_abc:notes:k", value: v, version: 1, deleted: false })).toBeNull();
    }
  });

  test("ignores brain-native rows (UUID sync keys) even inside the prefix", () => {
    const v = JSON.stringify({ content: "c", tags: "[]", created_at: 1, updated_at: 2 });
    expect(
      fromBridgeChange({ scope: `${SCOPE_PREFIX}t_abc/notes`, key: "0b7c2f7e-4a8e-4bde-9d1e-3f3a0c1d2e4f", value: v, version: 1 }),
    ).toBeNull();
  });

  test("refuses a key that names a different tenant than its scope", () => {
    const v = JSON.stringify({ content: "c", tags: "[]", created_at: 1, updated_at: 2 });
    expect(
      fromBridgeChange({ scope: `${SCOPE_PREFIX}t_abc/notes`, key: "rt:t_victim:notes:k", value: v, version: 1 }),
    ).toBeNull();
  });

  test("bad payloads are dropped, not thrown", () => {
    const scope = `${SCOPE_PREFIX}t_abc/notes`;
    expect(fromBridgeChange({ scope, key: "rt:t_abc:notes:k", value: "{not json", version: 1 })).toBeNull();
    expect(fromBridgeChange({ scope, key: "rt:t_abc:notes:%E0%A4%A", value: "{}", version: 1 })).toBeNull();
    expect(fromBridgeChange({ scope, key: "rt:t_abc:notes", value: "{}", version: 1 })).toBeNull();
  });
});
