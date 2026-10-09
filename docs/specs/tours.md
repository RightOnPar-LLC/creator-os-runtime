# Tours: more time for an agent, without a longer key

Owner's direction, 2026-10-09: "I don't mind more time, it just needs to be safe."

## The problem

A key an agent holds lives 24 hours at most (`AGENT_ISSUED_MAX_TTL_SEC`). That is right for
safety and wrong for work that takes days: a worker started on Monday is dead on Tuesday,
and nothing renews it. Making keys longer is the unsafe answer: a long key, once copied,
works for weeks and nobody has to look at it.

## The idea

Keep every key short. Make the STAY long.

A **tour** is a record on the runtime that says: the agent named `<agent>` may keep getting a
fresh 24-hour key until `<until>`, inside this fixed budget and these powers.

| Piece | What it is |
|---|---|
| Tour | a row in `tours` plus a **holding grant** (a child of the tenant's root grant) |
| Holding grant | holds the tour's budget, powers and end date. It is NOT a credential: its token is never handed out, and `verifyGrant` refuses it by its `scope.tour.holder` mark |
| Day key | an ordinary child of the holding grant. 24 hours at most, like every key a non-root key issues |

Nothing here is a new value engine. Holding, spending and giving back are `issueChildGrant`,
`settleGrantUsage` and `revokeGrantTree`, exactly as for any other key.

## Rules

1. **Only the owner opens a tour** (the tenant's root grant). Also reissue, extend and end.
2. **One tour per agent name** per tenant. The name is lowercase letters, digits and dots.
3. **Memory follows the name.** The day key opens the section `agent:<name>:` and no other,
   the same section a one-off key minted for that name opens.
4. **The agent renews with its current key.** Renewal cancels that key (and everything it
   handed out) and issues the next. No faster than once a minute.
5. **Time never refills money.** The budget is set once, when the tour is opened. Each day key
   is given whatever the tour has left; what it does not use goes back at renewal.
6. **The alarm.** If a key that a renewal replaced is presented again more than 2 minutes
   later, a second copy of it exists. The tour freezes, its current key is cancelled, and it
   stays frozen until the owner reissues or ends it. (Within the 2 minutes it is a call that
   was already on its way: refused, no alarm.)
7. **Doing nothing ends it.** Miss a renewal and the key runs out within 24 hours. Only the
   owner can reissue. A tour nobody has renewed for 48 hours is finished.
8. **Limits** (`policy.js`): one signature opens or extends by at most 7 days, and never past
   the tier's longest key lifetime; a tour lasts at most 30 days in all; never past the
   owner key's own end.
9. **Everything is on the record.** Each open, renewal, reissue, extension, freeze and end is
   a zero-amount ledger row (`tour-open`, `tour-renew`, ...) on the holding grant and an
   event (`tour.opened`, `tour.renewed`, ...), beside the reserve and release rows the keys
   themselves leave.

## API

| Call | Who | What |
|---|---|---|
| `POST /api/tours` | owner | `{ agent, days, caps, budget, scope?, constraints? }` -> `{ tour, key, receipt }` (201) |
| `GET /api/tours` | owner: every tour of the tenant. A tour's key: its own tour only | `{ tours }` |
| `POST /api/tours/renew` | the tour's current key | -> `{ tour, key, receipt }` (201). The key used is cancelled |
| `POST /api/tours/:id/reissue` | owner | a fresh key for a tour whose key ran out or that froze |
| `POST /api/tours/:id/extend` | owner | `{ days }`. More days, never more money. The receipt says which limit stopped it |
| `POST /api/tours/:id/end` | owner | cancels the holding grant and every key under it at once |

A tour's `status` reads: `active`, `key_run_out` (no live key: the owner can reissue),
`frozen`, `ended`, `over` (its end date has passed).

## What a tour key can and cannot do

- It is an ordinary key: it can do what its powers allow, and hand out helper keys if the owner
  gave it `grant.issue`. A helper's key is a day at most and is cancelled at the next renewal.
- It cannot open, extend, reissue or end a tour, its own included.
- It cannot outlive the tour: the last key ends when the tour does.

## Not built yet

- Tours opened by an agent for another agent (multi-day agent-to-agent work), which ask the
  owner by default.
- A furlough REQUEST: the agent asks for more days through the approvals queue.
- Earned standing: a clean record letting short extensions through without a signature.
- Passports. A tour hangs on the agent's name today and will hang on its passport.
- Payment holds hanging off the tour, so a multi-day hold can be opened from a tour key.
- MCP tools for tours (REST only for now) and the confirm page on the front door.

## Depends on

`fix(grants): spend counts all the way up the chain`. A tour puts a holding grant between the
owner and the key that spends; before that fix, spend two levels below a grant was forgotten
when the grant in between ended, so an ended tour would have handed the owner its whole
budget back.
