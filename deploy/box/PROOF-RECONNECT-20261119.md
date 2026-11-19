# Runtime isolated staging rollout — review handoff

Prepared 2026-11-19 for the existing MeshTool brother-demo continuation, HQ claim 715.
**This helper has not been run on a live host.** Only read-only target metadata and
local mocked failure-path tests were performed. Root remains the sole rollout operator.

## Files

- `runtime_staging_deploy.py`: deployment helper; default invocation is read-only.
- `test_runtime_staging_deploy.py`: 26 mocked tests; no Docker, SSH or network calls.

## Before using it

1. Review the exact Runtime reconnect commit and its source plus compiled-artifact
   test results. Retain the full 40-character commit SHA and the SHA256 of the exact
   `runtime.js` bytes that passed the artifact tests.
2. Have that commit object available in the existing Runtime Git repository on
   `meshtool-prod`. The helper performs no fetch, checkout, merge or push. Its default
   repo is `/opt/runtime/src`; the origin must be the existing
   `RightOnPar-LLC/creator-os-runtime` repository.
3. Retain the unchanged production deployment timer and its master branch. The
   ordinary `deploy/box/deploy.sh` stages and then deploys production; it is not used.
4. Place the reviewed helper through the existing operator connection, then run the
   read-only plan using the existing `sudo -n` authority. No credentials are passed
   as arguments. The only environment values added by the helper are the four
   public, fixed proof settings below.

## Commands for the operator after review

The paths and placeholders below are examples for the operator, not executed work.
Replace `REVIEWED_HELPER_PATH`, `FULL_CANDIDATE_SHA`, and `TESTED_BUNDLE_SHA256` with
the reviewed file path and the two recorded hashes.

Read-only plan:

```sh
sudo -n python3 REVIEWED_HELPER_PATH \
  --repo /opt/runtime/src \
  --sha FULL_CANDIDATE_SHA \
  --expected-bundle-sha256 TESTED_BUNDLE_SHA256
```

After the plan and exact candidate are reviewed, the same invocation plus `--apply`
builds and replaces only the pinned staging container:

```sh
sudo -n python3 REVIEWED_HELPER_PATH \
  --repo /opt/runtime/src \
  --sha FULL_CANDIDATE_SHA \
  --expected-bundle-sha256 TESTED_BUNDLE_SHA256 \
  --apply
```

The result names the private, durable receipt under
`/opt/staging/proof-reconnect-receipts/`. Preserve that exact path. To restore the
retained original staging container after a successful rollout or an interrupted
intermediate phase:

```sh
sudo -n python3 REVIEWED_HELPER_PATH \
  --rollback-receipt /opt/staging/proof-reconnect-receipts/EXACT_RECEIPT.json
```

Recovery accepts `candidate_created`, `stopping_original`, `original_retained`,
`starting_candidate`, `staged`, `rollback_started`, and
`uncertain_manual_recovery_required`. It rechecks the exact retained original and
candidate IDs, image identities and allowed names. It refuses unrelated containers.
If a restored identity cannot be proved, it reports uncertainty and stops. It never
attempts a production repair.

## Scope and pins

Read-only observations on `meshtool-prod` confirmed Python **3.12.3** and this baseline:

| Item | Expected value |
|---|---|
| Staging container | `staging-runtime` |
| Staging ID | `090fc51c6884d1dbdc09b39cf6321ef40d42237fba25f2291d1f382ff0b11fa5` |
| Production container | `own-rails-runtime-prod` |
| Production ID | `5146ed5cf72447487286ba4ab485060cc593af62e217cfa2e53e3bd1177109e0` |
| Both baseline image IDs | `sha256:a6b89fcfad50fa125c3870253acef39e40ad98d742ecff82fb8c09ead8fc805f` |
| Baseline Runtime bundle hash | `59107df04578198aef024dae1a8cf7882f3ef2573e89bfb24429156a0d8b9525` |
| Staging network | `staging-net` |
| Network ID | `60b98edbb630a5f50d6b2adc53209b54811cb45c2a5de53446afbf5b3153e75c` |
| Bindings | `127.0.0.1:18080:3000` and `100.85.34.93:18080:3000` |
| Existing environment file | `/opt/staging/runtime.env` |
| Existing mounts / custom aliases / IPAM config | None |
| Restart policy | `unless-stopped` |
| Deployment lock | `/opt/runtime/deploy/lock` |
| Staging watchdog lock | `/run/staging-rail-watchdog.lock` |

Both locks fail closed if busy. Neither production timer configuration nor watchdog
configuration is edited. The helper holds the two locks throughout the rollout or
recovery transaction.

Existing environment entries must be preserved exactly, except for these four
explicit additions. A conflicting pre-existing value is refused:

```text
PUBLIC_URL=https://staging-runtime.meshtool.ai
DEVDESK_PROOF_ENABLED=1
DEVDESK_PROOF_TENANT=t_uCUhCZP_FcnB
DEVDESK_PROOF_REDIRECT_URI=https://chatgpt-devdesk.meshtool.ai/runtime/callback
```

`PUBLIC_URL` was absent in the observed baseline. No secret is added, rotated or
printed. Existing secrets are supplied directly from the existing environment file
to Docker and compared in process against the old container. Receipts contain only
the four public additions and safe identity metadata.

## What apply verifies

- Exact Git commit object and correct repository origin; branch names are refused.
- Existing `deploy/Dockerfile` and `package.json` blob identities remain unchanged.
- `git archive` identifies that commit. Archive traversal, symlinks and special
  members are refused. The image is built from those archived committed bytes.
- The image's `/app/runtime.js` hash equals **the independent tested-artifact hash**
  before a candidate container is created or staging is stopped.
- The candidate is created but not started. Its environment, HostConfig and runtime
  command configuration are compared with the original. Any difference outside the
  four public proof additions refuses activation; inspect it rather than weaken the
  check.
- Database URLs are handled only in process. Query strings and fragments are refused
  because the observed baseline has neither. Docker DNS aliases and links resolve
  each database target. The staging and production database containers and writable
  storage paths must be separate. No SQL query is sent.
- Before activation and after health, the candidate's network ID and resolved
  database target must equal the original staging target. Isolation is checked again
  after startup. Only boolean database-check results enter the receipt.
- Only the original staging container is stopped and renamed to a unique rollback
  name. It is retained. The new candidate takes the staging name and original ports.
- Live staging health must return `ok:true`, `db:true`, and the exact tested bundle
  hash. Redirects, malformed responses and mismatches fail the gate.
- Production's identity, running state and original health hash must remain unchanged.

## Recovery behavior and limits

On a caught activation failure, the helper stops and retains its own candidate,
restores the original staging container under its original name, checks its original
health hash, and checks production again. A restored failure still exits nonzero.
An unverified restoration reports `uncertain_manual_recovery_required`.

Receipts are written atomically with mode 0600 and fsynced before dangerous phase
transitions. Power loss or SIGKILL cannot run an automatic handler, so the same helper
provides the checkpoint-based recovery command above. No prior container or image is
deleted. The only auto-removed container is the isolated, portless image-hash probe
created specifically by this helper.

This helper does not issue grants, complete OAuth, submit jobs, alter database rows,
change a tenant's tier, or prove the NATS demo. Those are subsequent scoped steps.
Restoring a container does not reverse data written after the rollout.

The existing master deploy timer can replace staging after a later master change.
Recheck the exact candidate hash before and after the proof. Once a successful
rollout changes the pinned staging ID, another `--apply` refuses until the original
is restored or a new baseline is separately reviewed; no automatic unpinning occurs.

## Validation performed

From this scratch directory:

```sh
python3 -m unittest -v test_runtime_staging_deploy.py
```

**26 tests passed.** They cover read-only default behavior, missing tested hash,
hash mismatch before activation, stale topology, conflicting proof origin,
environment/security-config drift, database alias and storage failures, network
rebinding, lock contention, unsafe archives, source recipe drift, stop/rename/start
and health failures, retained rollback, JSON-roundtrip recovery, interrupted
checkpoints, production drift, uncertainty on failed recovery, and secret-free
receipt/error output.

Independent review found three concrete issues—candidate database identity,
interrupted-checkpoint recovery, and hidden URL routing parameters—which were fixed
and tested. The reviewer found no remaining blocker for this scoped rollout after
the actual read-only plan passes. A final JSON serialization fix preserves manual
recovery identity comparisons; its roundtrip test passes.

**Not verified:** a real candidate build on this host, a real candidate container
comparison, an actual staging switch/recovery, or the end-to-end grant/job demo.
Those remain the root operator's review and execution steps.
