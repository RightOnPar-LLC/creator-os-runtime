// The autonomy dial — how much an agent may do without a human saying yes.
//
// Dependency-free on purpose (no db, no config), so the rules are unit-tested with
// bare `bun test` and every caller shares one definition.
//
// The dial is a per-grant level stored in grants.constraints.autonomy:
//   0 observe — may plan, never execute a value action.
//   1 ask     — every value action waits for a human approval (the tenant's root
//               grant). The agent's own `confirm: true` does NOT count at this level.
//   2 act     — today's behaviour: the agent may act inside its budget and scope
//               (the first-run dry-run gate still applies).
// A grant with no level is `act`, so every grant minted before the dial exists behaves
// exactly as before.
//
// Rules that make it an accountability tool, not a preference:
// - Attenuation: a child's level may never exceed its parent's. A request for more is
//   REFUSED (autonomy_widened), not silently clamped — the refusal is the signal.
// - Turning it down is immediate and cascades to every descendant; turning it up is
//   never an edit — it takes a new grant from the issuer.
// - Hard floors ask at every level: a hard-floor action needs a human no matter how
//   high the dial is set.

export const AUTONOMY_LEVELS = ["observe", "ask", "act"];
export const OBSERVE = 0;
export const ASK = 1;
export const ACT = 2;
export const DEFAULT_AUTONOMY = ACT;

// Actions the dial governs today: the ones the ledger already treats as value —
// spending on a deploy, and holding MESH in escrow.
export const VALUE_ACTIONS = new Set(["deploy", "escrow.open"]);
// Actions that ask a human at EVERY level. Money leaving the closed loop is refused
// outright elsewhere (escrow is MESH-only); it is listed so any future path that
// reaches it is floored by construction.
export const HARD_FLOORS = new Set(["money.out"]);

const isLevel = (n) => Number.isInteger(n) && n >= OBSERVE && n <= ACT;

// Accepts a number or a level name. Returns null for anything else.
export function parseAutonomy(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "string" && AUTONOMY_LEVELS.includes(v)) return AUTONOMY_LEVELS.indexOf(v);
  // Only numbers and numeric strings: Number([]) is 0 and Number(true) is 1, which
  // would quietly read an array as "observe" or a boolean as "ask".
  if (typeof v !== "number" && !(typeof v === "string" && /^\d+$/.test(v))) return null;
  const n = Number(v);
  return isLevel(n) ? n : null;
}

// The level a grant's constraints carry; absent or malformed reads as the default.
export function autonomyOf(constraints) {
  const n = parseAutonomy(constraints?.autonomy);
  return n === null ? DEFAULT_AUTONOMY : n;
}

// The level a new child asks for. Omitted inherits the parent's level. An explicit
// value is kept AS REQUESTED (not clamped), so attenuation can refuse a widening.
export function requestedAutonomy(requested, parentConstraints) {
  if (requested === undefined || requested === null || requested === "") return autonomyOf(parentConstraints);
  const n = parseAutonomy(requested);
  return n === null ? requested : n; // an unparseable value is kept so it is refused, never ignored
}

// Attenuation fault for a child's constraints against its parent's, or null.
export function autonomyViolation(childConstraints, parentConstraints) {
  if (childConstraints?.autonomy !== undefined && parseAutonomy(childConstraints.autonomy) === null)
    return "autonomy_invalid";
  return autonomyOf(childConstraints) > autonomyOf(parentConstraints) ? "autonomy_widened" : null;
}

// The gate. Returns { decision: "act" | "ask" | "refuse", level, reason }.
// `approvedBy` is the id of the human (root grant) that approved this exact action.
export function decide(level, action, { approvedBy = null } = {}) {
  const lvl = isLevel(level) ? level : DEFAULT_AUTONOMY;
  const base = { level: lvl, levelName: AUTONOMY_LEVELS[lvl] };
  if (approvedBy) return { ...base, decision: "act", reason: "approved" };
  if (HARD_FLOORS.has(action)) return { ...base, decision: "ask", reason: "hard_floor" };
  if (!VALUE_ACTIONS.has(action)) return { ...base, decision: "act", reason: "not_governed" };
  if (lvl === OBSERVE) return { ...base, decision: "refuse", reason: "autonomy_observe_only" };
  if (lvl === ASK) return { ...base, decision: "ask", reason: "autonomy_requires_approval" };
  return { ...base, decision: "act", reason: "within_autonomy" };
}

// Lowering is allowed; raising is not an edit (it needs a new grant from the issuer).
export function lowerCheck(current, next) {
  const n = parseAutonomy(next);
  if (n === null) return "autonomy_invalid";
  if (n > current) return "raise_requires_new_grant";
  return null;
}
