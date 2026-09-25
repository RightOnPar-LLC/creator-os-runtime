// Pass 1 of the runtime rebuild: reformat the live 0.3.0 bundle for humans and
// PROVE the result is the same program — same AST, ignoring only positions and
// quote style. Usage: node format-and-prove.mjs <bundle.js> <out.js>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const prettier = require("prettier");
const acorn = require("acorn");

const [, , inFile, outFile] = process.argv;
const src = readFileSync(inFile, "utf8");
const out = await prettier.format(src, { parser: "babel", printWidth: 110 });

const IGNORE = new Set(["start", "end", "loc", "range", "raw"]);
const strip = (n) => {
  if (Array.isArray(n)) return n.map(strip);
  if (n && typeof n === "object") {
    const o = {};
    for (const k of Object.keys(n).sort()) if (!IGNORE.has(k)) o[k] = strip(n[k]);
    // Template elements: keep the cooked value, drop raw formatting.
    return o;
  }
  return n;
};
const parse = (s) => acorn.parse(s, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
const a = JSON.stringify(strip(parse(src)));
const b = JSON.stringify(strip(parse(out)));
if (a !== b) {
  let i = 0; while (a[i] === b[i]) i++;
  console.error(`AST MISMATCH at char ${i}:\n  in : ${a.slice(i - 80, i + 80)}\n  out: ${b.slice(i - 80, i + 80)}`);
  process.exit(1);
}
writeFileSync(outFile, out);
console.log(`same program: AST identical (${a.length} chars of AST). ${src.split("\n").length} → ${out.split("\n").length} lines.`);
