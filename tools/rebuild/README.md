# Rebuilding readable source for the runtime

The live runtime (0.3.0) existed only as a minified Bun bundle; the readable source was
lost. `src/runtime.js` is that bundle turned back into code people can work on, in two
passes, each **proven** to be the same program as `live/runtime-0.3.0.bundle.js`
(sha256 `755882b6…`, the hash the live service reports at `/health`).

| Pass | What | Proof |
|---|---|---|
| 1 · format | Prettier over the bundle (98 → 2,710 lines) | the formatted AST is identical to the bundle's (positions and quote style ignored) |
| 2 · names | 144 top-level bindings get real names (`m` → `env`, `d` → `sql`, …) via babel `scope.rename` | renaming back with the inverse map reproduces pass 1's AST exactly, AND every string, property key and export name is unchanged |

A negative control is part of the method: a map that renames a binding to `fetch`
(capturing the global) is rejected by the round-trip check.

## Reproduce

```
cd tools/rebuild && npm install
node format-and-prove.mjs ../../live/runtime-0.3.0.bundle.js /tmp/formatted.js
node rename-and-prove.mjs /tmp/formatted.js rename-map.json /tmp/readable.js
# /tmp/readable.js == ../../src/runtime.js
```

## What this does NOT prove

- Nothing runs from `src/runtime.js` yet. The live service still runs the bundle.
- Names inside functions are still minified-short (`e`, `t`, `a`); only top-level ones were named.
- Three names are best guesses, listed in `rename-map.json` → `unsure`: `POLICY_VERSION`,
  `outboxDrainScheduled`, `reissueGrantToken`.

## Next

1. Split `src/runtime.js` into the modules suggested in `rename-map.json` → `modules`.
2. Tests against a throwaway Postgres (route table, `/health`, grants, OAuth).
3. A deploy path from git, with `live/verify.mjs` run before and after, before
   `index.ts` (0.1.1) or anything else ever replaces the bundle.
