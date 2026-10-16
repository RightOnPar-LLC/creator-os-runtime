// Unit tests for src/busout.js — the bus.publish outbox kind, dependency-free (no DB, no config.js).
// The recordEvent -> outbox -> drain path against the DB is pinned in runtime.test.js block 26.
// bus-vectors.json is the SAME file as meshtool-frontdoor vm/rail-sandbox/bus-vectors.json, whose
// Python verifier (events.py, test_events.py) passes on it; this side proves the runtime signs to it.
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { BUS_MAX_BODY, BUS_SIGNATURE_HEADER, busArmed, busEnvelope, busEventsUrl, busSign, deliverBus } from "../src/busout.js";

const V = JSON.parse(readFileSync(new URL("./bus-vectors.json", import.meta.url), "utf8"));
const saved = { url: process.env.BUS_EVENTS_URL, key: process.env.BUS_EVENTS_KEY };
const URL_ = "https://rail.example.test/events";
// null or undefined = unset (no default parameters: arm(undefined) must NOT arm).
const arm = (url, key) => {
  if (url == null) delete process.env.BUS_EVENTS_URL; else process.env.BUS_EVENTS_URL = url;
  if (key == null) delete process.env.BUS_EVENTS_KEY; else process.env.BUS_EVENTS_KEY = key;
};
const armed = () => arm(URL_, V.key);
afterEach(() => arm(saved.url, saved.key));

// The gateway's rule, restated: HMAC-SHA256 over `${t}.${body}`, lowercase hex, |now - t| <= 300.
const gatewayAccepts = (key, body, header, now) => {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header || "");
  if (!m || Math.abs(now - Number(m[1])) > 300) return false;
  return createHmac("sha256", key).update(`${m[1]}.${body}`).digest("hex") === m[2];
};

describe("off by default", () => {
  test("unarmed unless BOTH env vars are set and the URL is https", () => {
    arm(undefined, undefined);
    expect(busArmed()).toBe(false);
    arm("https://rail.example.test/events", undefined);
    expect(busArmed()).toBe(false);
    arm(undefined, V.key);
    expect(busArmed()).toBe(false);
    arm("http://rail.example.test/events", V.key); // plain http: refused
    expect(busArmed()).toBe(false);
    expect(busEventsUrl()).toBe("");
    arm("not a url", V.key);
    expect(busArmed()).toBe(false);
    armed();
    expect(busArmed()).toBe(true);
  });

  test("deliverBus refuses to send while unarmed — no fetch at all", async () => {
    arm("http://rail.example.test/events", V.key);
    let calls = 0;
    await expect(deliverBus({ id: "x" }, async () => (calls++, new Response("", { status: 200 })))).rejects.toThrow("bus_unarmed");
    expect(calls).toBe(0);
  });
});

describe("shared test vectors (same file as the gateway's)", () => {
  test("busSign reproduces every valid vector byte for byte", () => {
    for (const c of V.valid) expect(busSign(V.key, c.body, c.t)).toBe(c.header);
  });

  test("the restated gateway rule agrees with every vector", () => {
    for (const c of V.valid) expect(gatewayAccepts(V.key, c.body, c.header, c.now ?? V.now)).toBe(true);
    for (const c of V.invalid) expect([c.name, gatewayAccepts(V.key, c.body, c.header, c.now ?? V.now)]).toEqual([c.name, false]);
  });

  test("NEGATIVE CONTROL: a signer that leaves the timestamp out of the MAC does not match the vector", () => {
    const c = V.valid[0];
    const mutant = `t=${c.t},v1=${createHmac("sha256", V.key).update(c.body).digest("hex")}`;
    expect(mutant).not.toBe(c.header);
    expect(gatewayAccepts(V.key, c.body, mutant, V.now)).toBe(false);
  });
});

describe("envelope", () => {
  test("id is the events row id; at comes from the row; tenant/actor clipped", () => {
    const ev = busEnvelope({ id: 42, type: "grant.issued", ts: new Date("2026-10-16T12:00:00Z"), data: { a: 1 }, tenant: "t_1", actor: "x".repeat(300) }, "creator-os-runtime");
    expect(ev).toEqual({ id: "rt_ev_42", type: "grant.issued", source: "creator-os-runtime", at: "2026-10-16T12:00:00.000Z", data: { a: 1 }, tenant: "t_1", actor: "x".repeat(128) });
  });

  test("types the gateway would refuse are never queued", () => {
    for (const type of ["Agent.Hello", "agent.hello world", "a..b", "a.", "9x", "a".repeat(65), "", null])
      expect([type, busEnvelope({ id: 1, type, data: {} })]).toEqual([type, null]);
    expect(busEnvelope({ id: 1, type: "agent.hello-world_2", data: {} })).not.toBeNull();
  });

  test("an event over 16 KiB goes without its data instead of 413-ing forever", () => {
    const ev = busEnvelope({ id: 7, type: "big.one", data: { pad: "x".repeat(BUS_MAX_BODY) } }, "creator-os-runtime");
    expect(ev.data.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(ev))).toBeLessThan(BUS_MAX_BODY);
  });
});

describe("delivery", () => {
  const ev = busEnvelope({ id: 9, type: "tenant.created", ts: Date.now(), data: { tier: "pro" }, tenant: "t_9", actor: "admin" }, "creator-os-runtime");
  const recorder = (status) => {
    const seen = [];
    const f = async (url, init) => (seen.push({ url, init }), new Response("{}", { status }));
    return { seen, f };
  };

  test("POSTs the exact body, signed so the gateway's rule accepts it", async () => {
    armed();
    const { seen, f } = recorder(200);
    await deliverBus(ev, f);
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe("https://rail.example.test/events");
    expect(seen[0].init.redirect).toBe("manual");
    expect(JSON.parse(seen[0].init.body)).toEqual(ev);
    expect(gatewayAccepts(V.key, seen[0].init.body, seen[0].init.headers[BUS_SIGNATURE_HEADER], Math.floor(Date.now() / 1000))).toBe(true);
    // ...and a different key does not
    expect(gatewayAccepts("1e".repeat(32), seen[0].init.body, seen[0].init.headers[BUS_SIGNATURE_HEADER], Math.floor(Date.now() / 1000))).toBe(false);
  });

  test("5xx, 408 and 429 are retryable; other 4xx are terminal", async () => {
    armed();
    for (const [status, terminal] of [[500, false], [502, false], [503, false], [408, false], [429, false], [400, true], [403, true], [413, true]]) {
      const err = await deliverBus(ev, recorder(status).f).then(() => null, (e) => e);
      expect([status, err?.message, err?.terminal === true]).toEqual([status, "bus " + status, terminal]);
    }
  });
});
