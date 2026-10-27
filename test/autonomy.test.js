// Unit tests for src/autonomy.js — the autonomy dial's rules, dependency-free (no DB,
// no harness), so they run with bare `bun test`. The route-level behaviour (approvals,
// ledger rows, cascade) is pinned in runtime.test.js block 22.
import { describe, expect, test } from "bun:test";
import {
  ACT,
  ASK,
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY,
  OBSERVE,
  autonomyOf,
  autonomyViolation,
  decide,
  lowerCheck,
  parseAutonomy,
  requestedAutonomy,
} from "../src/autonomy.js";

describe("levels", () => {
  test("three levels, and a grant without one is `act` — every existing grant is unchanged", () => {
    expect(AUTONOMY_LEVELS).toEqual(["observe", "ask", "act"]);
    expect(DEFAULT_AUTONOMY).toBe(ACT);
    expect(autonomyOf({})).toBe(ACT);
    expect(autonomyOf(undefined)).toBe(ACT);
    expect(autonomyOf({ maxWorkers: 2, requireDryRun: true })).toBe(ACT);
  });

  test("names and numbers both parse; anything else is null", () => {
    expect(parseAutonomy("observe")).toBe(OBSERVE);
    expect(parseAutonomy("ask")).toBe(ASK);
    expect(parseAutonomy(2)).toBe(ACT);
    expect(parseAutonomy("1")).toBe(ASK);
    for (const bad of [3, -1, 1.5, "auto", "banana", {}, [], true, false, " 1"]) expect(parseAutonomy(bad)).toBeNull();
  });
});

describe("attenuation — a child can never out-rank its parent", () => {
  test("CONTROL: a child asking for more than its parent is REFUSED, not clamped", () => {
    const parent = { autonomy: ASK };
    const child = { autonomy: requestedAutonomy("act", parent) };
    expect(child.autonomy).toBe(ACT); // kept as asked...
    expect(autonomyViolation(child, parent)).toBe("autonomy_widened"); // ...so it is refused
  });

  test("a legacy parent (no level) is `act`: a child may not ask above that", () => {
    expect(autonomyViolation({ autonomy: ACT }, {})).toBeNull();
    expect(autonomyViolation({ autonomy: OBSERVE }, {})).toBeNull();
  });

  test("omitted inherits the parent's level; equal or lower is fine", () => {
    expect(requestedAutonomy(undefined, { autonomy: ASK })).toBe(ASK);
    expect(requestedAutonomy(null, {})).toBe(ACT);
    expect(autonomyViolation({ autonomy: ASK }, { autonomy: ASK })).toBeNull();
    expect(autonomyViolation({ autonomy: OBSERVE }, { autonomy: ASK })).toBeNull();
  });

  test("an unparseable level is refused, never silently ignored", () => {
    const child = { autonomy: requestedAutonomy("banana", { autonomy: ACT }) };
    expect(autonomyViolation(child, { autonomy: ACT })).toBe("autonomy_invalid");
  });
});

describe("the gate", () => {
  test("observe refuses, ask asks, act acts — for every value action", () => {
    for (const action of ["deploy", "escrow.open"]) {
      expect(decide(OBSERVE, action).decision).toBe("refuse");
      expect(decide(OBSERVE, action).reason).toBe("autonomy_observe_only");
      expect(decide(ASK, action).decision).toBe("ask");
      expect(decide(ACT, action).decision).toBe("act");
    }
  });

  test("a human approval lets the exact action through at any level", () => {
    expect(decide(ASK, "deploy", { approvedBy: "gr_root" })).toMatchObject({ decision: "act", reason: "approved" });
  });

  test("actions the dial does not govern pass untouched", () => {
    expect(decide(OBSERVE, "memory.read").decision).toBe("act");
  });

  test("a hard floor asks even at the highest level", () => {
    expect(decide(ACT, "money.out")).toMatchObject({ decision: "ask", reason: "hard_floor" });
  });

  test("a malformed level falls back to the default rather than throwing", () => {
    expect(decide(99, "deploy").level).toBe(DEFAULT_AUTONOMY);
  });
});

describe("turning the dial", () => {
  test("down is allowed, level is kept", () => {
    expect(lowerCheck(ACT, "ask")).toBeNull();
    expect(lowerCheck(ACT, 0)).toBeNull();
    expect(lowerCheck(ASK, ASK)).toBeNull();
  });

  test("CONTROL: up is never an edit — it takes a new grant", () => {
    expect(lowerCheck(ASK, "act")).toBe("raise_requires_new_grant");
    expect(lowerCheck(OBSERVE, 1)).toBe("raise_requires_new_grant");
  });

  test("garbage is rejected", () => {
    expect(lowerCheck(ACT, "max")).toBe("autonomy_invalid");
  });
});
