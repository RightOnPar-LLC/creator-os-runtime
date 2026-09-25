// Pass 2 of the runtime rebuild: give top-level bindings real names, SAFELY.
// Renames go through babel's scope.rename (handles shadowing and export
// specifiers). Proof: apply the inverse map to the result the same way and
// require an AST identical to the input (positions/quote style ignored), and
// require the exported names and every string/property key to be unchanged.
// Usage: node rename-and-prove.mjs <formatted.js> <rename-map.json> <out.js>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const prettier = require("prettier");
const acorn = require("acorn");

const [, , inFile, mapFile, outFile] = process.argv;
const src = readFileSync(inFile, "utf8");
const { map } = JSON.parse(readFileSync(mapFile, "utf8"));

function renameAll(code, m) {
  const ast = parse(code, { sourceType: "module" });
  const missing = [];
  traverse(ast, {
    Program(path) {
      for (const [from, to] of Object.entries(m)) {
        if (!path.scope.hasOwnBinding(from)) { missing.push(from); continue; }
        path.scope.rename(from, to);
      }
      path.stop();
    },
  });
  if (missing.length) throw new Error(`not top-level bindings: ${missing.join(", ")}`);
  return generate(ast, { retainLines: false, comments: true }).code;
}

const IGNORE = new Set(["start", "end", "loc", "range", "raw"]);
const strip = (n) => Array.isArray(n) ? n.map(strip)
  : n && typeof n === "object" ? Object.fromEntries(Object.keys(n).sort().filter((k) => !IGNORE.has(k)).map((k) => [k, strip(n[k])])) : n;
const astOf = (s) => JSON.stringify(strip(acorn.parse(s, { ecmaVersion: "latest", sourceType: "module" })));

// Every string literal, template chunk and non-computed property key — renaming
// must never touch these (they are wire formats: SQL, JSON keys, env var names).
const surface = (s) => {
  const out = [];
  const walk = (n, parentKey) => {
    if (Array.isArray(n)) return n.forEach((x) => walk(x));
    if (!n || typeof n !== "object") return;
    if (n.type === "Literal" && typeof n.value === "string") out.push("S:" + n.value);
    if (n.type === "TemplateElement") out.push("T:" + n.value.cooked);
    if ((n.type === "Property" || n.type === "MethodDefinition" || n.type === "PropertyDefinition") && !n.computed && n.key?.type === "Identifier") out.push("K:" + n.key.name);
    if (n.type === "MemberExpression" && !n.computed && n.property?.type === "Identifier") out.push("P:" + n.property.name);
    if (n.type === "ExportSpecifier") out.push("E:" + (n.exported.name ?? n.exported.value));
    for (const k of Object.keys(n)) if (!IGNORE.has(k)) walk(n[k]);
  };
  walk(acorn.parse(s, { ecmaVersion: "latest", sourceType: "module" }));
  return out.join("\n");
};

const renamed = await prettier.format(renameAll(src, map), { parser: "babel", printWidth: 110 });
const inverse = Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
if (Object.keys(inverse).length !== Object.keys(map).length) throw new Error("rename map is not one-to-one");
const back = renameAll(renamed, inverse);

if (astOf(back) !== astOf(src)) { console.error("ROUND-TRIP FAILED: renaming back does not reproduce the original program"); process.exit(1); }
if (surface(renamed) !== surface(src)) { console.error("SURFACE CHANGED: a string, property key or export name was altered"); process.exit(1); }
writeFileSync(outFile, renamed);
console.log(`renamed ${Object.keys(map).length} bindings; round-trip AST identical; strings/keys/exports unchanged. ${renamed.split("\n").length} lines.`);
