// Pass 3 of the runtime rebuild: split the proven readable file into ES modules,
// MECHANICALLY, and prove the split is the same program.
//
//   node split.mjs <runtime.js> <outDir>          write src/ modules
//   node split.mjs <runtime.js> <outDir> --check  regenerate into a temp dir and
//                                                 byte-compare with <outDir>
//
// How: every top-level statement (and every declarator of a multi-declarator `var`)
// is one "unit". Each unit is assigned to a module (the `modules` plan in
// rename-map.json, plus the route segments below), keeping its original source text.
// Imports/exports are computed from babel's scope analysis.
//
// Proofs (the script exits 1 if any fails):
//   1. Every original unit appears exactly once across the modules, and its AST is
//      identical (positions/quote style ignored) — except the ONE deliberate change
//      listed in DELIBERATE below.
//   2. Inside every module, units keep their original relative order.
//   3. Route registrations (app.get/post/put/delete/onError/notFound) are evaluated
//      in their original order: route modules are imported by index.js in sequence
//      and no other module imports a route module.
//   4. No module reads another module's binding at load time before that module has
//      been evaluated (simulated ESM evaluation order; hoisted functions exempt).
//   5. No binding is assigned outside its home module (ESM imports are read-only),
//      except the three source-hash variables, which move behind recordSource().
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");
const prettier = require("prettier");
const acorn = require("acorn");

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , inFile, outDirArg, flag] = process.argv;
if (!inFile || !outDirArg) {
  console.error("usage: node split.mjs <runtime.js> <outDir> [--check]");
  process.exit(2);
}
const CHECK = flag === "--check";
const src = readFileSync(inFile, "utf8").split("\r\n").join("\n");
const { modules: PLAN } = JSON.parse(readFileSync(join(HERE, "rename-map.json"), "utf8"));

// ---- module plan -----------------------------------------------------------------
// rename-map.json group -> file. The "imports" group is not a module: Hono and the
// crypto functions become per-module imports; BunSQL goes with the database.
const GROUP_FILE = {
  config: "config.js", db: "db.js", util: "util.js", "crypto-tokens-vault": "tokens.js",
  policy: "policy.js", "grants-ledger": "grants.js", memory: "memory.js", outbox: "outbox.js",
  "railway-deploys": "railway.js", "cog-planner": "cog.js", webhooks: "webhooks.js",
  "http-app-auth": "http.js", mcp: "mcp.js", oauth: "oauth.js", "cockpit-status-docs": "cockpit.js",
};
// Bindings created by the boot sequence at the bottom of the file live in index.js.
const BOOT_BINDINGS = new Set(["signingKeySource", "LISTEN_PORT", "serverConfig"]);
const EXTERNAL = { Hono: "hono" }; // everything else imported comes from "crypto"

// Route registrations, cut into contiguous segments; a segment starts at the route
// whose "METHOD path" is listed. Order here = original order = import order.
const ROUTE_SEGMENTS = [
  ["routes/core.js", "onError", "error handler, 404, /health, /.well-known/creator-os.json"],
  ["routes/admin.js", "POST /api/tenants", "admin: tenants, kill switch, policy, breakglass, grants, read-only tables"],
  ["routes/grants.js", "GET /api/grants/verify", "grant-holder API: grants, cog, deploys, ledger, events, tenant"],
  ["routes/memory.js", "POST /api/memory", "memory API, cognitive-mcp sync, admin outbox/memory"],
  ["routes/railway-auth.js", "GET /auth/railway/start", "Railway OAuth connect (tenant vault)"],
  ["routes/webhooks.js", "POST /webhooks/stripe", "inbound webhooks: stripe, railway, github, brain, mesh"],
  ["routes/mcp.js", "GET /mcp", "MCP streamable-http endpoint"],
  ["routes/oauth.js", "GET /.well-known/oauth-protected-resource", "OAuth 2.1 + PKCE authorization server for MCP clients"],
  ["routes/cockpit.js", "GET /", "cockpit, status page, docs"],
  ["routes/meta.js", "GET /routes", "/routes inventory and /selftest"],
];

const DESCRIBE = {
  "config.js": "Service identity, env (secrets trimmed at load), armed-integration flags, secret fingerprints.",
  "db.js": "Postgres (Bun.SQL) connection, schema + migration, settings, events, tenant/grant lookups.",
  "util.js": "Small pure helpers: JSON, time, ids, hashing, HMAC, constant-time compare, HTML escape, HttpError.",
  "tokens.js": "Grant token signing (cog1.<payload>.<hmac>) and the AES-256-GCM vault.",
  "policy.js": "Caps, tiers, usage arithmetic, attenuation rules and the gatehouse.",
  "grants.js": "Grant lifecycle: mint root, issue child, revoke tree, settle usage, rate limit, verify.",
  "memory.js": "Tenant memory: write, search, forget, sync records, pull from the cognitive bridge, scope checks.",
  "outbox.js": "Durable outbox to the Brain and the cognitive bridge, with retry/backoff.",
  "railway.js": "Worker templates and Railway deploy/status/restart/delete via GraphQL.",
  "cog.js": "COG planner (deterministic, optionally LLM-assisted) and executor.",
  "webhooks.js": "Webhook signature checks, idempotency records, Stripe and Railway event handlers.",
  "http.js": "The Hono app, auth middleware (admin, grant, sync token), route inventory, source-hash state.",
  "mcp.js": "MCP tool catalogue and JSON-RPC response helper.",
  "oauth.js": "OAuth client profiles, redirect allow-list, grant issuance for OAuth clients.",
  "cockpit.js": "HTML page shell, status report (product probes), docs store and markdown renderer.",
};
for (const [file, , desc] of ROUTE_SEGMENTS) DESCRIBE[file] = `Routes: ${desc}. Registration order is significant.`;

const MODULE_ORDER = [
  "config.js", "util.js", "db.js", "outbox.js", "tokens.js", "policy.js", "grants.js", "memory.js",
  "railway.js", "cog.js", "webhooks.js", "http.js", "mcp.js", "oauth.js", "cockpit.js",
  ...ROUTE_SEGMENTS.map((s) => s[0]),
  "index.js",
];

const bindingModule = new Map();
for (const g of PLAN) {
  if (g.name === "imports") continue;
  const file = GROUP_FILE[g.name];
  if (!file) throw new Error("unmapped group " + g.name);
  for (const m of g.members) bindingModule.set(m, BOOT_BINDINGS.has(m) ? "index.js" : file);
}
bindingModule.set("BunSQL", "db.js");

// ---- parse + units ---------------------------------------------------------------
const ast = parse(src, { sourceType: "module", allowAwaitOutsideFunction: true });
const body = ast.program.body;
const units = []; // {id, stmtIndex, node, kind, text, module, declares:[]}
const routeKey = (stmt) => {
  const e = stmt.type === "ExpressionStatement" && stmt.expression;
  if (!e || e.type !== "CallExpression" || e.callee.type !== "MemberExpression") return null;
  if (e.callee.object.type !== "Identifier" || e.callee.object.name !== "app") return null;
  const m = e.callee.property.name;
  if (m === "onError" || m === "notFound") return m;
  const p = e.arguments[0];
  return `${m.toUpperCase()} ${p && p.type === "StringLiteral" ? p.value : "?"}`;
};

let segment = -1;
body.forEach((stmt, i) => {
  const base = { stmtIndex: i };
  if (stmt.type === "ImportDeclaration") return; // recomputed per module
  if (stmt.type === "ExportNamedDeclaration") {
    units.push({ ...base, node: stmt, kind: "export", text: src.slice(stmt.start, stmt.end), module: "index.js", declares: [] });
    return;
  }
  if (stmt.type === "VariableDeclaration") {
    stmt.declarations.forEach((d, j) => {
      const names = Object.keys(t.getBindingIdentifiers(d.id));
      const mods = new Set(names.map((n) => bindingModule.get(n)));
      if (mods.size !== 1 || mods.has(undefined)) throw new Error(`no single module for ${names.join(",")}`);
      // original text; prettier re-indents afterwards (a textual dedent would corrupt template literals)
      const text = src.slice(d.start, d.end);
      units.push({ ...base, declIndex: j, node: d, kind: stmt.kind, text: `${stmt.kind} ${text};`, module: [...mods][0], declares: names });
    });
    return;
  }
  if (stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") {
    const n = stmt.id.name;
    const mod = bindingModule.get(n);
    if (!mod) throw new Error("unmapped binding " + n);
    units.push({ ...base, node: stmt, kind: stmt.type, text: src.slice(stmt.start, stmt.end), module: mod, declares: [n] });
    return;
  }
  const rk = routeKey(stmt);
  if (rk) {
    const next = ROUTE_SEGMENTS[segment + 1];
    if (next && next[1] === rk) segment++;
    if (segment < 0) throw new Error("route before first segment: " + rk);
    units.push({ ...base, node: stmt, kind: "route", route: rk, text: src.slice(stmt.start, stmt.end), module: ROUTE_SEGMENTS[segment][0], declares: [] });
    return;
  }
  // remaining side-effect statements: placed by what they touch
  const text = src.slice(stmt.start, stmt.end);
  let module;
  if (/^for \(let e of TRIMMED_SECRET_ENV_KEYS\)/.test(text)) module = "config.js";
  else if (/^if \(!DB_CONNECTION_URL\)/.test(text)) module = "db.js";
  else if (i > body.findIndex((s) => routeKey(s) === "GET /selftest")) module = "index.js"; // boot sequence
  else throw new Error("unplaced statement at stmt " + i + ": " + text.slice(0, 80));
  units.push({ ...base, node: stmt, kind: "stmt", text, module, declares: [] });
});
if (segment !== ROUTE_SEGMENTS.length - 1) throw new Error("not every route segment was found");
units.forEach((u, k) => (u.id = k));

// the deliberate change: the source-hash block in index.js calls recordSource()
const SOURCE_VARS = ["sourceSha256", "sourceBytes", "sourceText"];
const sourceBlock = units.find((u) => u.kind === "stmt" && u.module === "index.js" && u.text.includes("Bun.file(import.meta.path)"));
if (!sourceBlock) throw new Error("source-hash block not found");
const DELIBERATE_ORIGINAL = sourceBlock.text;
sourceBlock.text = "try {\n  recordSource(await Bun.file(import.meta.path).text());\n} catch {}";
sourceBlock.extraRefs = ["recordSource"];
const recordSourceUnit = {
  id: units.length, stmtIndex: body.indexOf(units.find((u) => u.declares.includes("sourceText")).node) + 0.5,
  kind: "FunctionDeclaration", module: "http.js", declares: ["recordSource"], synthetic: true,
  text:
    "// The entry point (index.js) hashes the file it was loaded from and hands the text here.\n" +
    "// Bundled for production, that file is the whole single-file runtime, as before the split.\n" +
    "function recordSource(e) {\n  ((sourceText = e), (sourceSha256 = sha256Hex(sourceText)), (sourceBytes = Buffer.byteLength(sourceText, \"utf8\")));\n}",
};
units.push(recordSourceUnit);
bindingModule.set("recordSource", "http.js");

// ---- references ------------------------------------------------------------------
const unitOf = (path) => {
  const top = path.find((p) => p.parentPath && p.parentPath.isProgram());
  const i = body.indexOf(top.node);
  const cand = units.filter((u) => u.stmtIndex === i && !u.synthetic);
  if (cand.length === 1) return cand[0];
  return cand.find((u) => path.node.start >= u.node.start && path.node.end <= u.node.end) || null;
};
const externalNames = new Map(); // name -> source
const refs = []; // {from: unit, name, eager}
const violations = [];
traverse(ast, {
  Program(p) {
    for (const [name, b] of Object.entries(p.scope.bindings)) {
      if (b.kind === "module") {
        externalNames.set(name, EXTERNAL[name] || "crypto");
      } else if (!bindingModule.has(name)) throw new Error("binding without a module: " + name);
      for (const r of b.referencePaths) {
        const u = unitOf(r);
        if (!u) throw new Error("reference outside units: " + name);
        refs.push({ from: u, name, eager: !r.getFunctionParent() });
      }
      for (const v of b.constantViolations) {
        const u = unitOf(v);
        if (u.module !== bindingModule.get(name)) violations.push({ name, module: u.module, unit: u.id });
      }
    }
    p.stop();
  },
});
// source-hash vars: their assignment moved into recordSource() (http.js)
const badViolations = violations.filter((v) => !(SOURCE_VARS.includes(v.name) && v.unit === sourceBlock.id));
if (badViolations.length) throw new Error("cross-module assignment: " + JSON.stringify(badViolations));
for (const name of SOURCE_VARS) refs.push({ from: recordSourceUnit, name, eager: false });
refs.push({ from: recordSourceUnit, name: "sha256Hex", eager: false });
refs.push({ from: sourceBlock, name: "recordSource", eager: true });
// drop refs that came from the replaced text of the source block
for (let k = refs.length - 1; k >= 0; k--) {
  if (refs[k].from === sourceBlock && SOURCE_VARS.includes(refs[k].name)) refs.splice(k, 1);
  else if (refs[k].from === sourceBlock && refs[k].name === "sha256Hex") refs.splice(k, 1);
}

// ---- imports / exports per module ------------------------------------------------
const modFiles = [...new Set(units.map((u) => u.module))];
const imports = new Map(modFiles.map((m) => [m, new Map()])); // module -> (source -> Set(names))
const exported = new Set();
for (const r of refs) {
  const m = r.from.module;
  let from;
  if (externalNames.has(r.name)) from = externalNames.get(r.name);
  else {
    const home = bindingModule.get(r.name);
    if (home === m) continue;
    from = home;
    exported.add(r.name);
  }
  const map = imports.get(m);
  if (!map.has(from)) map.set(from, new Set());
  map.get(from).add(r.name);
}
for (const [m, map] of imports) for (const from of map.keys()) {
  if (from.startsWith("routes/")) throw new Error(`${m} imports route module ${from}`);
}

// ---- proof 4: simulated ESM evaluation order -------------------------------------
const rank = (f) => { const i = MODULE_ORDER.indexOf(f); if (i < 0) throw new Error("no rank " + f); return i; };
const depsOf = (m) => {
  const own = [...imports.get(m).keys()].filter((f) => f.endsWith(".js")).sort((a, b) => rank(a) - rank(b));
  return m === "index.js" ? [...own, ...ROUTE_SEGMENTS.map((s) => s[0])] : own;
};
const evalOrder = [];
const state = new Map();
const visit = (m) => {
  if (state.has(m)) return;
  state.set(m, "visiting");
  for (const d of depsOf(m)) visit(d);
  state.set(m, "done");
  evalOrder.push(m);
};
visit("index.js");
const evalPos = new Map(evalOrder.map((m, i) => [m, i]));
for (const m of modFiles) if (!evalPos.has(m)) throw new Error("module never evaluated: " + m);
const routeEval = evalOrder.filter((m) => m.startsWith("routes/"));
if (JSON.stringify(routeEval) !== JSON.stringify(ROUTE_SEGMENTS.map((s) => s[0]))) throw new Error("route modules evaluate out of order: " + routeEval);
const declUnit = new Map();
for (const u of units) for (const n of u.declares) declUnit.set(n, u);
for (const r of refs) {
  if (!r.eager || externalNames.has(r.name)) continue;
  const d = declUnit.get(r.name);
  if (d.kind === "FunctionDeclaration" && !d.synthetic) continue; // hoisted, initialised at link time
  if (d.module === r.from.module) {
    if (d.id > r.from.id && !d.synthetic) throw new Error(`eager use of ${r.name} before its declaration in ${d.module}`);
  } else if (evalPos.get(d.module) >= evalPos.get(r.from.module)) {
    throw new Error(`${r.from.module} reads ${r.name} at load time before ${d.module} is evaluated`);
  }
}

// ---- emit ------------------------------------------------------------------------
const relImport = (fromFile, target) => {
  if (!target.endsWith(".js")) return target;
  let p = relative(dirname(join("/x", fromFile)), join("/x", target)).split("\\").join("/");
  return p.startsWith(".") ? p : "./" + p;
};
function emit(m) {
  const lines = [];
  const header = m === "index.js"
    ? [
        "// creator-os-runtime entry point. Imports every module, registers the routes in their",
        "// original order (one module per segment, imported in sequence below), then boots:",
        "// source hash, schema migration, grant signing key, kill-switch default, banner.",
        "// Production runs the single bundled file built from here (see src/README.md).",
      ]
    : [`// ${DESCRIBE[m]}`];
  lines.push(...header);
  const map = imports.get(m);
  const sources = [...map.keys()].sort((a, b) => {
    const ea = a.endsWith(".js"), eb = b.endsWith(".js");
    if (ea !== eb) return ea ? 1 : -1;
    return ea ? rank(a) - rank(b) : a.localeCompare(b);
  });
  for (const s of sources) {
    const names = [...map.get(s)].sort((a, b) => a.localeCompare(b));
    lines.push(`import { ${names.join(", ")} } from "${relImport(m, s)}";`);
  }
  if (m === "index.js") for (const [f] of ROUTE_SEGMENTS) lines.push(`import "${relImport(m, f)}";`);
  lines.push("");
  const mine = units.filter((u) => u.module === m).sort((a, b) => a.stmtIndex - b.stmtIndex || (a.declIndex ?? 0) - (b.declIndex ?? 0));
  for (const u of mine) {
    const exp = u.declares.some((n) => exported.has(n));
    let text = u.text;
    if (exp) {
      if (u.synthetic) text = text.replace(/^function /m, "export function ");
      else text = "export " + text;
    }
    lines.push(text);
  }
  return lines.join("\n") + "\n";
}
const out = {};
for (const m of modFiles) out[m] = await prettier.format(emit(m), { parser: "babel", printWidth: 110 });

// ---- proofs 1 + 2: unit ASTs identical, per-module order kept ---------------------
const IGNORE = new Set(["start", "end", "loc", "range", "raw"]);
const strip = (n) => Array.isArray(n) ? n.map(strip)
  : n && typeof n === "object" ? Object.fromEntries(Object.keys(n).sort().filter((k) => !IGNORE.has(k)).map((k) => [k, strip(n[k])])) : n;
// an export list names bindings from other units, which acorn rejects in isolation: compare it as code
const astKey = (code) => code.startsWith("export {") ? "EXPORT:" + code : JSON.stringify(strip(acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true }).body));
const unitCode = (node, kind) => generate(kind ? t.variableDeclaration(kind, [node]) : node, { comments: false }).code;

const want = new Map(); // key -> original unit
for (const u of units) {
  if (u.synthetic) continue;
  const code = u === sourceBlock ? null : unitCode(u.node, ["var", "let", "const"].includes(u.kind) ? u.kind : null);
  if (code) want.set(astKey(code), u);
}
const seen = new Set();
const deliberate = [];
for (const m of modFiles) {
  const mAst = parse(out[m], { sourceType: "module", allowAwaitOutsideFunction: true });
  let last = -1;
  for (const s of mAst.program.body) {
    if (s.type === "ImportDeclaration") continue;
    let inner = s;
    if (s.type === "ExportNamedDeclaration" && s.declaration) inner = s.declaration;
    const pieces = inner.type === "VariableDeclaration" ? inner.declarations.map((d) => unitCode(d, inner.kind)) : [unitCode(inner)];
    for (const code of pieces) {
      const u = want.get(astKey(code));
      if (!u) { deliberate.push({ module: m, code }); continue; }
      if (seen.has(u.id)) throw new Error("unit emitted twice: " + u.id);
      seen.add(u.id);
      const pos = u.stmtIndex + (u.declIndex ?? 0) / 1000;
      if (pos < last) throw new Error(`order changed inside ${m} at unit ${u.id}`);
      last = pos;
    }
  }
}
const missing = [...want.values()].filter((u) => !seen.has(u.id));
if (missing.length) {
  const NL = String.fromCharCode(10);
  throw new Error("units missing from output:" + NL + missing.map((u) => `${u.id} ${u.module} ${u.text.slice(0, 120)}`).join(NL) +
    NL + "unmatched:" + NL + deliberate.map((d) => `${d.module}: ${d.code.slice(0, 120)}`).join(NL));
}
const expectedDeliberate = [
  { module: "http.js", has: "function recordSource(" },
  { module: "index.js", has: "recordSource(await Bun.file(import.meta.path).text())" },
];
if (deliberate.length !== expectedDeliberate.length ||
    !expectedDeliberate.every((e) => deliberate.some((d) => d.module === e.module && d.code.includes(e.has)))) {
  throw new Error("unexpected changed units:\n" + deliberate.map((d) => d.module + ": " + d.code.slice(0, 200)).join("\n"));
}

// ---- write or check --------------------------------------------------------------
const listJs = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).map((p) => p.split("\\").join("/"))
  .filter((p) => p.endsWith(".js") && statSync(join(dir, p)).isFile()) : [];
if (CHECK) {
  const have = listJs(outDirArg).filter((p) => p !== "runtime.js").sort();
  const wantFiles = Object.keys(out).sort();
  let drift = JSON.stringify(have) !== JSON.stringify(wantFiles) ? [`file set differs: have ${have} want ${wantFiles}`] : [];
  for (const f of wantFiles) {
    const h = existsSync(join(outDirArg, f)) ? readFileSync(join(outDirArg, f), "utf8").split("\r\n").join("\n") : null;
    if (h !== out[f]) drift.push("differs: " + f);
  }
  if (drift.length) { console.error("DRIFT:\n  " + drift.join("\n  ")); process.exit(1); }
  console.log(`src/ is byte-identical to the mechanical split of ${relative(process.cwd(), inFile)} (${wantFiles.length} modules)`);
} else {
  for (const [f, code] of Object.entries(out)) {
    mkdirSync(dirname(join(outDirArg, f)), { recursive: true });
    writeFileSync(join(outDirArg, f), code);
  }
  console.log(`wrote ${Object.keys(out).length} modules to ${outDirArg}`);
}
console.log(`proved: ${seen.size} units identical, order kept per module, ${ROUTE_SEGMENTS.length} route segments in order, ` +
  `load-time reads safe, 1 deliberate change (source hash via recordSource)`);
