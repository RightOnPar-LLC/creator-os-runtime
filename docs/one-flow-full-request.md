# FULL REQUEST — One flow for Meshtool, DevDesk, and every seat

Date: 2026-11-04. Owner: Dw. Status: REQUEST, not a merge, not a deploy.
This is the full request Dw built in the 2026-11-04 voice call, naming each
piece and checking it against the one flow before writing it down.

## The rule, in one sentence

One conversation, one planner, one editor — for Meshtool, for DevDesk, and
for every seat. Dw never moves over to a different AI just to do edits, and
a seat buyer never gets a different AI flow either.

## Outcome wanted

A single front door where Dw (and, inside their own fence, a seat buyer)
talks, plans, and edits, with every tool, model, and surface below running
through that same flow, in the same order, with a receipt per call, on Dw's
own iron where the estate already runs there. No piece below becomes a
second conversation, a second planner, or a second AI to jump to.

## 1. Front door and planner order (already drafted as PR #82)

- Front door: Dw talks to Frank / COG in one place. That conversation is
  where planning, decisions, and edits start — not in a separate AI chat.
- Planner order, from draft PR #82 (RightOnPar-LLC/creator-os-runtime,
  branch dw/cog-hybrid-ollama-anthropic, head ff15c14, draft only,
  src/cog.js only):
  1. Ollama first — own iron, free, local-first (gpt-oss:120b via OLLAMA_URL)
  2. Claude second — Anthropic, only if Ollama gives no plan
     (COG_ANTHROPIC_MODEL or claude-sonnet-4-5, max_tokens 300)
  3. OpenAI third — only if Ollama and Claude both give no plan
     (env-gated: OPENAI_API_KEY and COG_OPENAI_MODEL both required,
     otherwise that leg is skipped, never faked)
  4. Deterministic plan last — the existing fallback in cogPlan, unchanged.
- Every successful plan tags which provider answered (llmProvider).
- No provider key is in code. All keys come from env at runtime, placed
  by Dw. Frank never receives or relays a key value.

## 2. Copilot — editor only, never a runtime provider

Copilot has no model API to call from the COG planner at runtime. Its place
is code suggestions inside Dw's editor, on the same code the planner is
working with. That is not a second conversation. Copilot is NOT added to
planWithLlm, and no Copilot API route is invented.

## 3. Seats — the buyer's seat, Dw not in charge of it

- When somebody buys a seat, they get their own scoped space inside the
  same flow: own seat / tenant / folder / wallet, own branch, own draft PR,
  own staging check, receipts per call.
- The buyer works through the same front door, same planner order, same
  editor path. They do not get a different AI, and Dw does not babysit
  their seat.
- The fence that already governs self-serve seats stays: no prod deploy,
  no Dw-org repo creation, no money-out without identity, no cross-tenant
  reads or writes, no touching Dw's desk, tenant, listings, or operator
  controls.
- Nothing goes live from a seat without the taps that matter: merge and
  prod deploy stay Dw's separate taps, one at a time, after staging proof.

## 4. Every piece Dw named, and how it fits the one flow

Each item below is a tool, a surface, state, or a connection — never a
second AI conversation. Each runs behind the same front door, called by
the planner in order, inside the caller's seat scope, with a receipt.

- **Cloudflare Turnstile.** A human check at the front door, before
  anything hits a model, same check for every seat. A gate in front of
  the planner, not a separate AI. Not coded into PR #82 yet — that PR is
  the planner chain only.
- **Cognitive MCP.** Meshtool/cognitive-mcp (private, main, Rust) — agent
  memory / context at memory.meshtool.ai/mcp, bridged to the runtime's
  Postgres memories. The planner calls it; Dw does not go talk to it
  separately. Condition: every call stays under the caller's own tenant
  and memory scope, the same scope rule COG already enforces for plan
  evidence. Tokens stay as env var names, never values in chat.
- **The whole MCP market.** Market capabilities are listings invoked
  through the same front door, each under its own provider / seat /
  tenant, receipt per call. No separate AI chat per capability. Money-out
  still needs identity, prod deploy still needs Dw's tap, cross-tenant
  calls stay denied.
- **Durable Objects.** State, not a separate AI. One per seat is the
  natural shape — the id owner profile already works that way, in a
  Durable Object (OWNER_CREDENTIALS), host-only cookie, Face ID on that
  device only. Condition: one object per seat, never shared across
  seats, and it holds state, not a second planner.
- **Workflows.** Workflows run inside the same front door, called by the
  planner in order, with receipts, inside the seat's scope. No separate
  AI, just another tool in the one flow.
- **All of our skills.** The estate's skills live behind the one front
  door, called by the planner in order, each under its own seat and
  tenant with a receipt. Copilot stays in the editor, nothing jumps to
  a different AI, and it all stays portable to Dw's own iron.
- **Containers.** Containers are how each piece is packaged, not another
  AI to talk to. Each container runs in its seat's scope, called through
  the same planner, with receipts, on Dw's iron.
- **The VM character model (from yesterday's talk).** The character is
  its own VM, and each AI is a container inside that VM. That fits the
  one flow: the VM is the character's home, each AI is a container
  inside it, and everything still comes through the same front door
  with the planner deciding the order. Portable, on Dw's iron per seat,
  Copilot in the editor only.
- **Calling one of those AIs / containers.** Dw calls it through the
  same front door, same as everything else. He asks here, the planner
  picks the right container in his VM, it runs in his seat's scope, he
  gets a receipt, and Copilot just helps with the code in the editor.
  One flow, no jumping around.
- **Playwright browser control.** Playwright is a tool, not another AI.
  It runs behind the same front door, in the seat's container, with a
  receipt. Dw calls it here, the planner picks the Playwright container,
  it does the browser work, Copilot stays in the editor.
- **Network tunnels, tunnel and mesh.** The connection layer inside the
  seat's VM, not another AI. Reuse what already exists — the estate's
  tunnel and mesh (Headscale / meshnet, cloudflared) — do not rebuild a
  second network for this. Called through the same front door, planner
  in charge, receipt per use, on Dw's iron. If a tunnel or mesh piece is
  missing for a given seat, that gap is named as a gap, not papered over.
- **Monetization gateway.** A tool the planner calls, in the seat's
  scope, with a receipt, behind the same front door on Dw's iron.
  Money-out still needs Dw's tap, and identity is still claimed at
  money-out, not at listing.
- **Bulk redirects.** A tool, not another AI. Runs behind the same front
  door, in the seat's scope, called by the planner with a receipt, and
  any production change still needs Dw's tap.
- **Web tag management.** A tool behind the one front door, called by
  the planner in order, runs in the seat's container with a receipt,
  Copilot only helps with the code in the editor. On Dw's iron, no
  separate AI jump.

## 5. The runtime piece — health check and receipt per tool

Every tool run shows up in one place, in the same flow, with nothing
hidden: a simple health check and a receipt for each tool, in the runtime.
That is polish on the runtime, not another AI. The receipt names the tool,
the seat / tenant, the planner provider that answered (llmProvider), and
the outcome — the same receipt discipline already required for all work.

## 6. Scope — where this applies

Meshtool, DevDesk, and all seat work: market, runtime, DevDesk, memory,
id, and a seat's own tenant / folder / wallet work, all through the same
flow, not a different AI per surface. PR #82 is runtime-only and draft;
this request does not claim code has landed in the Meshtool or DevDesk
repos. When their planner work is built, it follows this same order and
these same gates instead of inventing a per-surface AI.

## 7. Hard floors and taps — unchanged

- Four hard floors, never automatic: money-out; outward publish / send
  on Dw's behalf (wayfinding exception only); credential / ACL changes
  to people; irreversible deletes.
- Merge to master / main and prod deploy stay Dw's separate taps, one at
  a time, after staging proof. In creator-os-runtime, merge auto-deploys
  to prod, so a merge tap there IS a prod tap — never bundled, never
  auto-merged.
- No secret values in chat, files, or repos. No invented money-out
  provider, destination, or fee. No demo-customer testing until internal
  proof passes. A failed live check stops the line.
- Archives are never deleted wholesale. Live pointers to retired
  endpoints are removed; archives themselves stay for history.

## 8. What is NOT in this request

- Not a merge, not a deploy, not a live switch for any piece above.
- Not a fourth runtime provider (Copilot is editor-only).
- Not a new network, a new project, or a new AI per surface.
- Not a claim that Ollama is reachable from Railway prod today, that
  Turnstile is coded into PR #82, or that the OpenAI leg is live — see
  open inputs below.

## 9. Acceptance — what "done" means

1. One front door serves Meshtool, DevDesk, and a seat, with the planner
   order in §1 and Copilot editor-only in §2.
2. Each piece in §4 is callable through that front door, inside the
   caller's seat scope, with a health check and a receipt, and no piece
   requires switching to a different AI chat.
3. A seat buyer gets their own scoped seat automatically through the
   same flow, with Dw not in charge of their seat, and the fence in §3
   holding on money-out, prod deploy, org repo creation, and
   cross-tenant access.
4. Staging proof for PR #82, with earlier providers down, proving each
   fallback actually fires, before any merge tap. Same staging proof
   discipline for any Meshtool / DevDesk planner work that follows.
5. Live verification at the same pin after any merge / deploy tap,
   with a failed live check stopping the line.

## 10. Open inputs — Dw's, not to be invented

- COG_OPENAI_MODEL name, and placement of OPENAI_API_KEY, if the OpenAI
  leg is to be live. Without both, that leg is skipped, not faked.
- Turnstile site configuration, placed by Dw in the service's own
  dashboard — Frank never handles the value.
- Whether Ollama is reachable from Railway prod, and if not, which
  tunnel / mesh route carries it — the Claude / OpenAI legs are what
  keep COG answering while that is unresolved, not a claim it is solved.
- Any tunnel / mesh gap for a given seat, named as a gap when found.
- Staging deploy tap for PR #82, then merge tap, then prod deploy tap,
  each named separately by Dw.

## Files and PRs this request rests on

- Draft PR #82, RightOnPar-LLC/creator-os-runtime, branch
  dw/cog-hybrid-ollama-anthropic, head ff15c14 — planner chain only.
- Draft PR #80, same repo, branch dw/cog-status-ollama-gate, head
  aa467a55 — status line, staging proof still owed.
- Write-up: workspace your_files/cog-hybrid-one-place.md (fit checks
  for Turnstile, Cognitive MCP / MCP market, Durable Objects, and the
  one-flow rule for Meshtool, DevDesk, and seats).
- This file: workspace your_files/cog-one-flow-full-request.md.
