# Rebuilding readable source for the runtime

The live runtime (0.3.0) existed only as a minified Bun bundle; the readable source was
lost. `src/runtime.js` is that bundle turned back into code people can work on, in two
passes, each **proven** to be the same program as `live/runtime-0.3.0.bundle.js`
(sha256 `755882b6…`, the hash the live service reports at `/health`).

| Pass | What | Proof |
|---|---|---|
| 1 · format | Prettier over the bundle (98 → 2,710 lines) | the formatted AST is identical to the bundle's (positions and quote style ignored) |
| 2 · names | 144 top-level bindings get real names (`m` → `env`, `d` → `sql`, …) via babel `scope.rename` | renaming back with the inverse map reproduces pass 1's AST exactly, AND every string, property key and export name is unchanged |
| 3 · split | `split.mjs` cuts the readable file (now `tools/rebuild/runtime.js`) into the ES modules in `src/`, by the `modules` plan below plus 10 contiguous route segments | every top-level unit appears once with an identical AST; order kept inside each module; route modules evaluate in the original order; no load-time read of a not-yet-evaluated module; one deliberate change (the `/health` source hash goes through `recordSource()`, see `src/README.md`) |

A negative control is part of the method: a map that renames a binding to `fetch`
(capturing the global) is rejected by the round-trip check.

## Reproduce

```
cd tools/rebuild && npm ci && npm run verify
```

`verify.mjs` runs passes 1 and 2 into a temp folder and **byte-compares** the result with
`tools/rebuild/runtime.js`, then runs pass 3 in check mode, which regenerates `src/` and
byte-compares every module; it exits 1 on any drift. Tool versions are pinned exactly (with a
lockfile), because a different Prettier or Babel could format or rename differently.
A new name that matches any identifier already in the program (a global like `fetch`,
or any existing binding) is refused before renaming.

## What this does NOT prove

- Nothing deploys from `src/` yet. The live service still runs the 0.3.0 bundle. Behaviour of
  `src/` (and of the bundle built from it) is pinned by the test suite in `test/`, which
  passes against the unsplit file, `src/index.js` and `dist/runtime.js` alike.
- Names inside functions are still minified-short (`e`, `t`, `a`); only top-level ones were named.
- Three names are best guesses, listed in `rename-map.json` → `unsure`: `POLICY_VERSION`,
  `outboxDrainScheduled`, `reissueGrantToken`.

## Next

1. ~~Split into modules~~ (pass 3, `src/`). ~~Tests against a throwaway Postgres~~ (`test/`).
2. A deploy path from git (`dist/runtime.js`), with `live/verify.mjs` run before and after,
   before `index.ts` (0.1.1) or anything else ever replaces the bundle. Note the deployed
   hash will change: `/health` reports the sha256 of whatever single file is deployed.
3. `split.mjs` is a one-time generator. Once `src/` is edited by hand, drop the pass-3 step
   from `verify.mjs` (keep passes 1-2 as the record of where the code came from).
