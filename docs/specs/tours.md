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
2. **One tour per agent name** per tenant while it is live. The name is lowercase letters,
   digits and dots. The table itself enforces it (a unique index), so two opens at the same
   moment cannot both win.
3. **Memory follows the name.** The day key opens the section `agent:<name>:` and no other,
   the same section a one-off key minted for that name opens.
4. **The agent renews with its current key.** Renewal cancels that key (and everything it
   handed out) and issues the next. No faster than once a minute.
5. **Time never refills money.** The budget is set once, when the tour is opened. Each day key
   is given whatever the tour has left; what it does not use goes back at renewal.
6. **The alarm.** If a key that a renewal replaced is presented again more than 2 minutes
   later, a second copy of it exists. Every key under the tour is cancelled, the tour is marked
   frozen, and it stays frozen until the owner reissues or ends it. (Within the 2 minutes it is
   a call that was already on its way: refused, no alarm. A replaced key presented after its own
   24 hours have run out is just an expired key: refused, no alarm.)
7. **Doing nothing ends it.** Miss a renewal and the key runs out within 24 hours. Only the
   owner can reissue. A sweep that runs with the reaper (every minute) ends a tour nobody has
   renewed for 48 hours, one whose end date has passed, and one whose holding grant was
   cancelled from outside; the name is then free and what was not spent is back with the
   owner. A frozen tour is not ended for being idle: it waits for the owner until its end date.
8. **Limits** (`policy.js`): one signature opens or extends by at most 7 days, and never past
   the tier's longest key lifetime; a tour lasts at most 30 days in all; never past the
   owner key's own end. If a tour has to end sooner than asked, the receipt says so
   (`limited_by`). An extension that would add less than an hour is refused as being at the
   limit already.
9. **Everything is on the record.** Each open, renewal, reissue, extension, freeze and end is
   a zero-amount ledger row (`tour-open`, `tour-renew`, ...) on the holding grant and an
   event (`tour.opened`, `tour.renewed`, ...), beside the reserve and release rows the keys
   themselves leave. An ended tour keeps why it ended (`ended_reason`).

## How it holds together when a step fails half way

One rule: **a tour's keys are every active grant directly under its holding grant, found by
parent.** `tours.current_key` is only a note of the key the tour handed out last. Anything that
must stop the agent, or must be sure only one key lives, goes by parent and never by that note.

| What happens | What the runtime does |
|---|---|
| A renewal cannot cancel the key in hand | Nothing has changed. The key still works; the agent asks again |
| A renewal cancels the old key and then cannot issue the next | The tour is marked frozen with that reason. Only the owner can reissue |
| The alarm (or an owner's end) lands in the middle of a renewal | The renewal hands its key over only if the tour is still active and still points at the old key. Otherwise the new key is cancelled and the renewal answers 409 |
| A renewal writes its key just as the alarm marks the tour frozen | The alarm looks under the tour a second time after marking it |
| The alarm cannot cancel a key | The tour is NOT marked frozen (it never reads frozen while a key works). The next use of the old key tries again. If the mark was written and the last cancel then failed, the sweep cancels it within a minute |
| A key is left working that the tour has lost sight of | Nobody was handed it. It shows in `live_keys`, and the next reissue, freeze or end cancels it. A reissued key gets everything the tour has left, because the lost key is cancelled first |
| The same dead key is used again and again | While frozen: nothing more happens. After the owner reissues: nothing at all (every key replaced before the reissue is cleared of the alarm) |
| Somebody cancels the tour's current key by hand with the words a renewal writes | Not the alarm. The current key is never "replaced" |
| The tour cannot be recorded when it is opened | The holding grant is cancelled; nothing stays held |
| The holding grant is cancelled through the ordinary grants route | Its keys go with it; the sweep (or the owner's next look) marks the tour ended and looks under it once more for a key written at that same moment |
| An old token for the holding grant is presented after an extension | Refused, and it does not end the tour: the row's end date decides, not the token's |

## API

| Call | Who | What |
|---|---|---|
| `POST /api/tours` | owner | `{ agent, days, caps, budget, scope?, constraints? }` -> `{ tour, key, receipt }` (201). `receipt.until` is the real end and `receipt.limited_by` is `asked` or `owner_key` |
| `GET /api/tours` | owner: every tour of the tenant. A tour's key: its own tour only | `{ tours }` |
| `POST /api/tours/renew` | the tour's current key | -> `{ tour, key, receipt }` (201). The key used is cancelled. 409 `tour_renew_in_progress`, `tour_frozen`, `tour_ended` or `tour_changed` when it lost a race: no key is handed out |
| `POST /api/tours/:id/reissue` | owner | a fresh key for a tour whose key ran out or that froze. Every key still working under the tour is cancelled first |
| `POST /api/tours/:id/extend` | owner | `{ days }`. More days, never more money. The receipt says which limit stopped it; 409 `tour_at_limit` lists every limit |
| `POST /api/tours/:id/end` | owner | cancels the holding grant and every key under it at once |
| `POST /api/admin/grants/reap` | admin | the reaper on demand. Now also answers `tours_ended` |

A tour reads:

- `status`: `active`, `key_run_out` (the key the tour handed out no longer works: the owner can
  reissue), `frozen`, `ended`, `over` (its end date has passed and the sweep has not been yet).
- `key`: the key the tour handed out last, if it still works.
- `live_keys`: every working key under the tour. More than `key` accounts for means a key the
  tour lost sight of (see the table above).
- `left`: the budget less everything settled anywhere under the tour, by any key that ever lived
  there, helpers included.
- `frozen_reason`, `ended_reason`.

## What a tour key can and cannot do

- It is an ordinary key: it can do what its powers allow, and hand out helper keys if the owner
  gave it `grant.issue`. A helper's key is a day at most and is cancelled at the next renewal.
- It cannot open, extend, reissue or end a tour, its own included.
- It cannot outlive the tour: the last key ends when the tour does.

## Tests

`test/runtime.test.js`, section 7c. The failure cases above are FORCED, not hoped for: a
database trigger that lives for one test makes one chosen statement fail, or makes something
else happen at that exact moment.

```
node test/run.mjs               the whole suite
node test/tours-controls.mjs    takes each rule OUT of the source in turn and expects the tests to fail
```

## Known limits

- A key written under the holding grant at the very moment that grant is cancelled is itself
  cancelled (above), but its budget stays held on the owner's key until that key rolls over.
  That is the older gap noted in `revokeGrantTree`; it fails safe (held, never handed out twice).
- If the tour cannot be recorded AND cancelling its holding grant then also fails, the holding
  grant stays (no key exists under it, and its token was never handed out) and its budget comes
  back to the owner when it runs out, 7 days later at most.
- A tour's limits are checked when it is opened and extended. Lowering a tenant's tier does not
  shorten a tour that is already open.

## Not built yet

- Tours opened by an agent for another agent (multi-day agent-to-agent work), which ask the
  owner by default.
- A furlough REQUEST: the agent asks for more days through the approvals queue.
- Earned standing: a clean record letting short extensions through without a signature.
- Passports. A tour hangs on the agent's name today and will hang on its passport.
- Payment holds hanging off the tour, so a multi-day hold can be opened from a tour key.
- MCP tools for tours (REST only for now) and the confirm page on the front door.

## Depends on

`fix(grants): spend counts all the way up the chain` (merged 2026-10-09). A tour puts a holding
grant between the owner and the key that spends; before that fix, spend two levels below a grant
was forgotten when the grant in between ended, so an ended tour would have handed the owner its
whole budget back.
