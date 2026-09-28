// Unit tests for src/hostpolicy.js — the agent-host rules, dependency-free. The routes
// and the hire checks against the DB are pinned in runtime.test.js block 23.
import { describe, expect, test } from "bun:test";
import {
  HOST_DEFAULTS,
  HOST_DEFAULT_CAPS,
  HOST_TIERS,
  hireSub,
  hireViolation,
  hostLimits,
  hostName,
} from "../src/hostpolicy.js";

describe("owner decisions (defaults)", () => {
  test("hosts start at `ask`, 10 live sub-agents, 2 levels deep, pro tier and up", () => {
    expect(HOST_DEFAULTS).toEqual({ maxSubagents: 10, maxDepthBelow: 2, autonomy: "ask" });
    expect(HOST_TIERS).toEqual(["pro", "studio", "house"]);
    expect(HOST_DEFAULT_CAPS).toContain("grant.issue"); // a host must be able to hire
    expect(HOST_DEFAULT_CAPS).not.toContain("deploy.worker"); // but not spend on machines by default
  });
});

describe("limits", () => {
  test("omitted -> defaults; out of range -> clamped; non-integer -> refused", () => {
    expect(hostLimits({})).toEqual({ maxSubagents: 10, maxDepthBelow: 2 });
    expect(hostLimits({ maxSubagents: 500, maxDepthBelow: 0 })).toEqual({ maxSubagents: 50, maxDepthBelow: 1 });
    expect(hostLimits({ maxSubagents: 2.5 })).toBeNull();
    expect(hostLimits({ maxDepthBelow: "two" })).toBeNull();
  });
});

describe("names", () => {
  test("host names are short slugs", () => {
    expect(hostName("Research-Desk")).toBe("research-desk");
    for (const bad of ["", "x", "has space", "-lead", "a".repeat(33), null]) expect(hostName(bad)).toBeNull();
  });

  test("every hire is named agent:<host-id>/<role>, whatever it asked for", () => {
    expect(hireSub("gr_h1", "agent:scraper")).toBe("agent:gr_h1/scraper");
    expect(hireSub("gr_h1", "host:evil")).toBe("agent:gr_h1/host-evil"); // cannot pose as a host
    expect(hireSub("gr_h1", "../../root")).toBe("agent:gr_h1/..-..-root");
    expect(hireSub("gr_h1", undefined)).toBe("agent:gr_h1/sub");
    expect(hireSub("gr_h1", "x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("ceilings", () => {
  const limits = { maxSubagents: 2, maxDepthBelow: 1 };
  test("within the ceilings: no fault", () => {
    expect(hireViolation(limits, { hostDepth: 1, childDepth: 2, liveBelow: 1 })).toBeNull();
  });
  test("CONTROL: one hire too many is refused", () => {
    expect(hireViolation(limits, { hostDepth: 1, childDepth: 2, liveBelow: 2 })).toBe("host_subagents_exceeded");
  });
  test("CONTROL: one level too deep is refused", () => {
    expect(hireViolation(limits, { hostDepth: 1, childDepth: 3, liveBelow: 0 })).toBe("host_depth_exceeded");
  });
  test("no host above: no ceilings", () => {
    expect(hireViolation(undefined, { hostDepth: 0, childDepth: 5, liveBelow: 99 })).toBeNull();
  });
});
