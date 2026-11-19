# Runtime isolated staging rollout — review handoff

Prepared 2026-11-19 for the existing MeshTool brother-demo continuation, HQ claim 715.
**No apply or recovery has been run on a live host.** Root's first read-only plan
refused an ambiguous production environment before activation. Only read-only target
metadata and local mocked failure-path tests were performed in this lane. Root
remains the sole rollout operator.

## Files

- `runtime_staging_deploy.py`: deployment helper; default invocation is read-only.
- `test_runtime_staging_deploy.py`: 42 mocked tests; no Docker, SSH or network calls.
- `runtime_staging_db_observation_20261119.json`: sanitized, read-only baseline
  evidence behind the pinned production process and database checks.

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
| Production process / restart count | PID `700646`; restart count `0` |
| Production process StartedAt | `2026-11-14T08:51:34.616308668Z` |
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

Existing staging environment entries must be preserved exactly, except for these
four explicit additions. A conflicting pre-existing value is refused. Identical
duplicate entries are accepted only when their values are byte-identical; a
conflicting duplicate in staging or the candidate always refuses activation:

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
- The staging and candidate database URLs are handled only in process. Query strings
  and fragments are refused because the observed baseline has neither. Docker DNS
  aliases and links must resolve their configured target to the exact pinned staging
  database. The production database is proved separately through the pinned running
  process's owned, established TCP5432 sockets, as detailed below. The helper issues
  no direct SQL; existing health requests exercise the existing database pool.
- Before activation and after health, the candidate's network ID and resolved
  database target must equal the original staging target. Isolation is checked again
  after startup. Only boolean database-check results enter the receipt.
- Only the original staging container is stopped and renamed to a unique rollback
  name. It is retained. The new candidate takes the staging name and original ports.
- Live staging health must return `ok:true`, `db:true`, and the exact tested bundle
  hash. Redirects, malformed responses and mismatches fail the gate.
- Production's container/image identity, PID, StartedAt, restart count, running state,
  original health source hash, and full raw environment array must remain unchanged.
  Raw environment values exist only in memory. Owned-socket and database/storage
  pin checks repeat immediately before staging is stopped and after candidate health.

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

**42 tests passed.** They cover read-only default behavior, missing tested hash,
hash mismatch before activation, stale topology, conflicting proof origin,
environment/security-config drift, database alias and storage failures, network
rebinding, lock contention, unsafe archives, source recipe drift, stop/rename/start
and health failures, retained rollback, JSON-roundtrip recovery, interrupted
checkpoints, production drift, uncertainty on failed recovery, and secret-free
receipt/error output. The socket-specific tests cover missing sockets, foreign or
multiple owners, unexpected or multiple peers, wrong local addresses, PID/start/
restart drift, environment-array drift, database/network/address/storage/volume
changes, and socket loss before activation or after health. They also prove that
the production-only exception does not relax staging/candidate parsing.

## Follow-up from the first live read-only plan

The staging container has 11 environment entries and 11 unique keys. Production
has 29 entries and 28 unique keys: `DATABASE_URL` occurs twice with different values.
No values were displayed. The generic parser accepts only byte-identical duplicates;
conflicting values remain refused for staging and the candidate. Production's
ambiguous environment is retained unchanged and is never collapsed into a dictionary
or resolved by choosing the first or last entry.

A subsequent read-only observation found the unchanged, pinned production Bun
process owns 10 established PostgreSQL sockets to one Docker database container,
which is distinct from the staging database and has disjoint writable storage.
The configured production entry at index 1 maps to that observed peer; index 0
does not resolve through Docker network/link metadata. This is an observation of
the running process, not proof of every possible configured URL.

Root approved a narrow validation of the **current production process**, now
implemented in this review candidate:

- Only the observed production shape is accepted: exactly 29 entries, 28 unique
  keys, and exactly two differing `DATABASE_URL` entries. The raw array is retained
  and compared byte-for-byte in memory throughout an apply or recovery transaction.
- The exact production container, image, source hash, PID, StartedAt, restart count,
  Docker network ID, and process address are pinned. A process restart refuses the
  operation and requires a fresh, separately reviewed baseline.
- Every established TCP5432 socket in that network namespace must be owned solely
  by the pinned PID and use its pinned local address. There must be at least one
  socket, and every peer must resolve to the single independently pinned, running
  production database container. A missing, unresolved, second, or foreign peer
  refuses the operation.
- Both database containers' image IDs, network IDs, addresses, writable mount
  names/paths/destinations, and local-volume metadata are pinned. Their writable
  storage must be distinct. These pins are checked again around the socket read.
- The pre-stop and post-health checks repeat this evidence. Receipts identify the
  method as `productionDatabaseEvidence: owned_established_sockets`, with
  `socketPeersDistinct` and `databaseContainersDistinct`. They do not claim a
  normalized production URL comparison.

This proves the current pinned process's observed database isolation at those
checkpoints. It **does not prove how a later production restart will interpret the
two conflicting URL entries**, repair production configuration, or establish that
both configured URLs are safe. The earlier exploratory last-entry dictionary
comparison and its `normalizedTargetsDistinct` result were insufficient evidence
and must not be carried forward as proof. Production configuration is unchanged.

Independent review found three concrete issues—candidate database identity,
interrupted-checkpoint recovery, and hidden URL routing parameters—which were fixed
and tested. The current socket boundary then received an independent **PASS** for
the exact helper and test hashes below. The reviewer read the source, socket and
rollout paths, independently ran all 42 mocked tests, and found no remaining blocker
for the scoped rollout after a passing actual read-only plan. A JSON serialization
fix preserves manual recovery identity comparisons; its roundtrip test passes.

Current helper SHA256:
`3f760bdb636f08a088573235f19f2fc0daf464ed694c7b7e5f7fe5e0afcb7225`.
Reviewed test SHA256:
`9b813b247f91def0023e1e5419e9438fc7f5067b9703bc6ec44c0e6c2ac1dfa1`.
Final test SHA256 after removing one trailing space (no behavioral change):
`0b7420b59d1a74ea8c04ab2b8a4c38ff5cc53423fec303f5f1b5445a85d2fdb4`.

**Not verified:** a real candidate build on this host, a real candidate container
comparison, an actual staging switch/recovery, or the end-to-end grant/job demo.
Those remain the root operator's review and execution steps.
