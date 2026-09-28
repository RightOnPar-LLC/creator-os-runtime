# Ship on green — changes that pass every test merge and deploy themselves

Status: **design + first step built** (CI for this repo). Applies estate-wide.

## The goal

The owner should not spend the day pressing merge and deploy buttons. A change that
passes every test should merge and go live on its own. A change that touches
something risky should stop and ask — the same idea as the autonomy dial, applied
to the build pipeline.

## The pipeline

```
PR opened ──► CI runs every test ──► all green? ──► auto-merge ──► deploy ──► smoke test
                                         │                                    │
                                    red: stays open,                    smoke fails:
                                    the session that                    roll back to the
                                    opened it fixes it                  last good deploy
```

1. **Every repo runs its full test suite on every PR** (GitHub Actions).
2. **Auto-merge is on.** A session that opens a PR enables auto-merge on it; GitHub
   merges it the moment the required checks pass. No human click.
3. **Merging deploys.** The deploy platform watches the default branch and deploys
   every push *after CI passes on it*.
4. **Deploys prove themselves.** A health check / smoke test runs against the new
   deploy; if it fails, the platform keeps (or rolls back to) the last good version.

## What still stops for a human (the pipeline's dial)

Ship-on-green is the pipeline at autonomy `act`. These stay at `ask` — the PR gets a
`needs-human` label and auto-merge is not enabled:

- **Money and value movement** — anything that changes how MESH, escrow capture, or
  payouts move (e.g. `escrow_capture`, settlement, pricing).
- **Legal-gated surfaces** — anything behind the legal packet (securities line,
  cash-out, custody).
- **Destructive or irreversible changes** — dropping tables/columns, deleting data,
  rotating or exposing credentials.
- **Auth and the ring-fence** — token scopes, grant attenuation, MeshTool/SteeleZone
  separation.

Everything else — UI, copy, design, docs, tests, additive features, bug fixes —
ships on green.

## Where each service stands

| Service | Tests on PR | Deploys on merge | Gap |
|---|---|---|---|
| creator-os-runtime (runtime.meshtool.ai) | **Added now** (`.github/workflows/test.yml`) | No — it is a hand-pasted Railway Function; the repo's Dockerfile is unused | Switch the Railway service source to this repo with "wait for CI" |
| cognitive-mcp (memory.meshtool.ai) | Yes (Rust tests, Node CI) | No — the daemon runs on the owner's machine behind a tunnel | The Node `npm audit` job is red on existing advisories and would block every auto-merge; fix the lockfile or make audit non-blocking. Deploy needs a pull-updater on the box (later). |
| meshmarket (market / wallet) | Yes (selftest in the deploy gate) | Button (`workflow_dispatch`) by design | Change the trigger to push-on-main, keeping the predeploy selftest and smoke |
| the-foundry (DevDesk) | Yes (selftest) | Button by design | Same as meshmarket |

## One-time switches the owner makes (each takes minutes)

1. **GitHub, per repo:** Settings → General → *Allow auto-merge*; and a branch rule
   on the default branch requiring the CI checks to pass.
2. **Railway, runtime service:** connect the service to `RightOnPar-LLC/creator-os-runtime`
   (branch `master`, `deploy/Dockerfile`) and turn on *Wait for CI*. The health check
   (`/health`) is already configured in `railway.json`.
   - Do this only after the CI below is green on `master`, and ideally first in a
     staging environment: moving from a pasted Function to a built image changes
     the Bun version (1.4.0 → 1.4.2) and is a production change.
3. **meshmarket / the-foundry:** approve changing `deploy.yml` from a button to
   push-on-main (the gates stay the same).

Once these are on, a session can open a PR with auto-merge enabled and walk away —
green ships, red comes back to the session to fix.

## Why this is safe

- The tests are the gate. Every repo already has a predeploy selftest; the runtime
  now runs its full characterisation suite on every PR.
- The risky classes keep a human in the loop (above).
- The health check / smoke test catches a bad deploy and the platform keeps the
  last good version.
- Every merge and deploy is on the record (GitHub history + the platform's deploy log).
