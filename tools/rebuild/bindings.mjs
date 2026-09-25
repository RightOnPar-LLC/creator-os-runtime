// List every top-level binding in the formatted runtime with a short context snippet,
// so names can be chosen from what each thing actually is.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const [, , file, outJson] = process.argv;
const src = readFileSync(file, "utf8");
const ast = parse(src, { sourceType: "module" });
const rows = [];
traverse(ast, {
  Program(path) {
    for (const [name, b] of Object.entries(path.scope.bindings)) {
      const n = b.path.node;
      const start = n.start ?? b.identifier.start;
      rows.push({ name, kind: b.kind, refs: b.references, snippet: src.slice(start, start + 220).replace(/\s+/g, " ") });
    }
    path.stop();
  },
});
rows.sort((a, b) => b.refs - a.refs);
writeFileSync(outJson, JSON.stringify(rows, null, 1));
console.log(`${rows.length} top-level bindings; ${rows.filter((r) => r.name.length <= 3).length} with names of 3 chars or fewer`);
