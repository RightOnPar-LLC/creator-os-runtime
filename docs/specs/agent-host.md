# Agent-host — a machine where an agent hires sub-agents

Status: **v1 control plane built** (this PR). The owner's decisions were taken with the
recommended defaults:

| Decision | Chosen |
|---|---|
| Ceilings per host | 10 live sub-agents, 2 levels below the host (owner may set 1–50 and 1–3). Spend is capped by the host's budget; a per-hour spend rate is not built yet. |
| Default dial for a new host | `ask` |
| Where the host page lives | DevDesk (the page is the next step; `GET /api/hosts/:id` is its data) |
| Which tiers may create hosts | `pro`, `studio`, `house` |

Built: `POST /api/hosts` (owner's root only), `GET /api/hosts/:id` (the hiring tree),
the ceilings and hire naming in `issueChildGrant`, the `agent-host` worker template,
`src/hostpolicy.js`. **Not built:** the agent program that runs inside the machine —
it lives in `RightOnPar-LLC/creator-worker`, which is still empty, so deploying the
`agent-host` template is refused (`creator_worker_repo_unpopulated`) until it exists.

## The idea in one paragraph

A human creates an agent to do agent-to-agent (A2A) work. That agent gets its own
machine — an *agent-host* — and a budget. Inside it, the agent can hire sub-agents:
each one is a child grant with a smaller budget, a narrower scope and a dial no
higher than its parent's. Every hire, every spend and every approval lands in the
ledger with the acting agent and the approving human on it. When something goes
wrong, the question "who did this, and who allowed it?" always has an answer.

## Most of it already exists

| Need | Already in the runtime | Where |
|---|---|---|
| Hire a sub-agent | Issue a child grant: budget ≤ parent's remaining, caps ⊆ parent's, depth + 1, capped by tier | `issueChildGrant`, `attenuationViolations` |
| Limit how free it is | The autonomy dial: `observe` / `ask` / `act`; a child can never out-rank its parent | `src/autonomy.js` (PR #29) |
| A human says yes | `ask`-level value actions wait for the tenant's root grant | `POST /api/approvals/:id` (PR #29) |
| Fire it | Revoke cascades down the tree and returns unspent budget to the parent | `revokeGrantTree` |
| Stop everything | Global kill switch | `settings.kill_switch` |
| Give it compute | Deploy a worker on Railway under the grant's name prefix and budget | `deployWorker` |
| An agent running with its own grant | The `builder` template already runs an agent holding `COS_GRANT_TOKEN` | `TEMPLATES.builder` |
| A record | Ledger rows per grant, now with autonomy / decision / approver | `ledger` |

So the agent-host is **not a new platform**. It is one new worker template plus a
few rules, on top of machinery that is already tested.

## What gets built

### 1. The `agent-host` template

A new entry in `TEMPLATES` (`src/railway.js`), modelled on `builder`:

- Runs the creator-worker image with `WORKER_KIND=agent-host`.
- Receives **its own grant token** (`COS_GRANT_TOKEN`) — minted fresh for this host,
  never the human's root.
- Needs: `ANTHROPIC_API_KEY` (or the house model), `COS_GRANT_TOKEN`.
- The host's grant must carry `grant.issue` (to hire), and whatever caps the work
  needs. It can only hand out what it holds.

### 2. Hiring = issuing a child grant

The host hires through the API that already exists:

```
POST /api/grants   (with the host's token)
{ "sub": "agent:<host>/<role>", "caps": [...], "budget": {...},
  "ttlSec": 3600, "constraints": { "autonomy": "ask" } }
```

Rules the runtime already enforces: budget comes out of the host's remaining;
caps ⊆ host's; depth ≤ tier max; dial ≤ host's dial.

New rules for hosts:

- **Sub-agents run inside the host by default.** A sub-agent is a process in the
  host's machine, not a new Railway service. Spawning another *machine* is a
  deploy, so it is a value action and goes through the dial like any deploy.
- **`sub` naming is structured** — `agent:<host-id>/<role>` — so every sub-agent is
  traceable to its host in the ledger. (Durable identity is the next phase; this is
  the interim convention.)
- **Hard ceilings per host** (**DECIDE** the numbers): max live sub-agents, max
  depth below the host, max spend per hour. Enforced in `attenuationViolations` as
  `host_subagents_exceeded` / `host_depth_exceeded`.

### 3. The dial on the host

- The human picks the host's dial when creating it. Recommended default: **`ask`**
  for the first week, then `act` once its ledger looks right.
- Sub-agents inherit the host's level unless the host sets them lower.
- The human can turn the host down at any time; it cascades to every sub-agent
  (`POST /api/grants/:id/autonomy`).

### 4. What the human sees

One page per host (DevDesk or the wallet, **DECIDE**):

- The hiring tree: host → sub-agents, each with its dial, budget used / left, status.
- Pending approvals with approve / deny.
- The host's ledger, filtered to it and its subtree (`GET /api/ledger` already
  scopes to a subtree).
- A single "stop" that revokes the host's grant (cascades).

### 5. Isolation — "VM" in stages

| Stage | What the machine is | When |
|---|---|---|
| **v1** | A Railway service per host (the existing deploy path). Sub-agents are processes inside it. | Build now, after #29 merges. |
| **v2** | Per-sub-agent sandboxing inside the host (separate process + resource limits; no shared credentials — each sub-agent holds only its own child token). | When a host runs untrusted third-party sub-agents. |
| **v3** | Real microVMs (e.g. Firecracker) per host. | When demand or a customer's security requirement justifies the cost. |

The accountability model is identical at every stage — only the wall between
sub-agents gets thicker. That is why it is safe to start at v1.

## What must be true before it ships

1. **PR #29 merged and its full test suite green** (the dial and approvals).
2. **The runtime deploys from the repo on green** (see `ship-on-green.md`) — true
   once this repo's CI is on `master`: `runtime-svc` already waits for it.
3. **A test that proves the ceilings:** a host tries to hire past its sub-agent
   limit, past its depth, and above its own dial — all three refused and recorded.
4. **Revoke drill:** revoking a host with live sub-agents stops all of them and
   returns their unspent budget to the human's root.

## Next phases it leans on (not blockers for v1)

- **Hash-chained ledger** — so the host's record is tamper-evident.
- **Durable agent identity** — so `agent:<host>/<role>` becomes a registered
  principal, and the runtime can tell a human's root from an agent holding one.

## Decisions for the owner

1. Ceilings per host: max live sub-agents, max depth below the host, max spend/hour.
2. Default dial for a new host (recommended: `ask`).
3. Where the host page lives (DevDesk or the wallet).
4. Which tier may create hosts (recommended: `pro` and above).
