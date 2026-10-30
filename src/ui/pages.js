// The runtime's human pages (DW, 2026-10-30: "out with the old, in with the new"). They live in this repo and
// ship in the bundle, so git == live: the old cockpit was a doc pasted into the database (`_cockpit`), which
// nothing reads any more. The Bun text imports below are inlined by `bun build`, so production still runs one file.
//   /        the Runtime Browser: grants, worlds, receipts, ledger, memory, the Crown, and the seal
//   /loop    one world's live loop          /card   a person's world          /invite   choose your way in
// Every page reads only this runtime's own API. Signed out they show only what /health and /status.json
// already make public; signed in, /api/admin/* rides on the operator session cookie.
import look from "./look.css" with { type: "text" };
import kit from "./kit.js" with { type: "text" };
import runtime from "./runtime.html" with { type: "text" };
import loop from "./loop.html" with { type: "text" };
import card from "./card.html" with { type: "text" };
import invite from "./invite.html" with { type: "text" };

const fill = (html) => html.replace("/*LOOK*/", () => look).replace("/*KIT*/", () => kit);
export const PAGES = { runtime: fill(runtime), loop: fill(loop), card: fill(card), invite: fill(invite) };

// Sent with every page: no referrer leaking a /?connect=… request id, and the browser never caches a page
// that may show signed-in data. Framing is left as it was (the deck shows the runtime in its centre); a
// cross-site frame carries no session anyway, because the cookie is SameSite=Lax.
export const PAGE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
