# Receipt-before-run — a live action runs only the plan that was simmed

Status: **built in 0.3.5** (DevDesk work item #112). Opt-in per grant; nothing changes for a grant that does not ask for it.

## The rule

The sim decides, the live call only does. A deploy's dry run returns a `planHash`. A live deploy that carries that
`planHash` runs only if the plan it would run now hashes the same, and an unspent dry run of that plan exists in the
tenant from the last `PLAN_RECEIPT_TTL_SEC` (default 900). Running spends the dry run: one sim buys one live run.

## What a grant can ask for (constraints)

| Constraint | Meaning | Attenuation |
|---|---|---|
| `requirePlanReceipt: true` | Every live deploy under this grant needs a matching, unspent plan receipt. `confirm: true` and `AUTONOMOUS_DEPLOYS=1` do not skip it. | Once on, every grant below has it. A child may turn it on, never off. |
| `maxLiveActions: n` | At most `n` live Railway mutations (deploy, restart, delete) under this grant. `1` = a one-use grant. | A child gets the smaller of its ask and its parent's. Counted on the grant and every grant above it, so minting children cannot multiply it. |

A `planHash` sent by any caller is always checked, even without `requirePlanReceipt`.

## The flow

1. Sim: `POST /api/deploys {name, template}` (or MCP `deploy_worker`), answer `status: dry_run`, `planHash`.
2. Optional: the parent mints a one-use child, `constraints: {maxLiveActions: 1, requirePlanReceipt: true}`.
3. Live: `POST /api/deploys {name, template, confirm: true, planHash}`.

What the hash covers: tenant, action, project, environment, worker name, template, source, replicas, every env
value (`COS_GRANT` left out, so a parent's sim is a valid receipt for its child), price, and policy version. Change any
of them and the answer is `plan_receipt_mismatch`, plus a fresh sim of the new plan.

## Refusals (all answer as a dry run, `executed: false`, nothing reaches Railway)

- `plan_receipt_required`: the grant needs a receipt and none was sent.
- `plan_receipt_mismatch`: the plan changed since the sim.
- `plan_receipt_missing`: no unspent sim of this plan in the time window (already spent, or too old).
- `live_actions_used_up`: this grant, or one above it, has used its live actions.

Spending the receipt and counting the live action happen in one transaction, so a refused action spends neither.
If Railway then fails, both stay spent. Nothing is retried on a spent receipt. Sim again.

## Not covered yet (round two)

- restart and delete count against `maxLiveActions` but have no plan receipt (Railway gives no dry run for them).
- `cog_execute` deploys go through the same `deployWorker`, but the COG proposal format does not carry a `planHash` yet.
- Cloudflare and other platforms: the runtime does not execute on them, so there is nothing to gate here.
  GitHub changes already have their receipt: PR + CI.
