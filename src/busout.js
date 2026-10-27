// Outbox kind bus.publish: runtime events -> the one events bus (meshtool rail POST /events,
// NATS JetStream stream MESH_EVENTS). OFF unless BUS_EVENTS_URL (https only) and BUS_EVENTS_KEY
// are both set. Wire contract, shared with meshtool-frontdoor vm/rail-sandbox/events.py:
//   X-Bus-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(key, `${t}.${body}`)>
//   body {id, type, source, at, data, tenant, actor}; the gateway refuses anything older
//   than 5 minutes and dedups on id (Nats-Msg-Id), so a retried row is published once.
// test/bus-vectors.json is the same file as the gateway's; both suites must pass on it.
//
// Deliberately does not import config.js: that module fixes RATE_LIMIT_PER_MIN and friends when it
// first loads, so a unit test importing this file must not be the one that loads it. The env object
// is the same one config.js exports (Bun.env), read at call time; config.js still trims BUS_EVENTS_KEY.
import { hmacSha256, nowSec } from "./util.js";

var env = globalThis.Bun?.env ?? process.env;

export var BUS_SIGNATURE_HEADER = "x-bus-signature";
export var BUS_TYPE_RE = /^[a-z][a-z0-9._-]{0,63}$/;
export var BUS_MAX_BODY = 16384;

export function busEventsUrl() {
  let u = (env.BUS_EVENTS_URL || "").trim();
  if (!u) return "";
  try {
    return new URL(u).protocol === "https:" ? u : "";
  } catch {
    return "";
  }
}
export var busArmed = () => !!(busEventsUrl() && env.BUS_EVENTS_KEY);
export var busSign = (key, body, t = nowSec()) => `t=${t},v1=${hmacSha256(key, `${t}.${body}`)}`;

// The gateway turns the type into subject tokens: an empty token ("a..b", "a.") is not a subject.
export var busTypeOk = (type) => typeof type === "string" && BUS_TYPE_RE.test(type) && !type.split(".").includes("");
var short = (v) => (v == null ? null : String(v).slice(0, 128));

// One events row -> the bus envelope, or null when the gateway would refuse its type
// (no point queueing a row that can only ever fail). id is the events row id, namespaced.
export function busEnvelope({ id, type, ts, data, tenant, actor }, source) {
  if (!busTypeOk(type)) return null;
  let ev = {
    id: `rt_ev_${id}`,
    type,
    source,
    at: new Date(ts ?? Date.now()).toISOString(),
    data: data && typeof data === "object" && !Array.isArray(data) ? data : {},
    tenant: short(tenant),
    actor: short(actor),
  };
  let bytes = Buffer.byteLength(JSON.stringify(ev));
  // Over the gateway's 16 KiB cap: send the event without its data rather than a row that 413s forever.
  if (bytes > BUS_MAX_BODY) ev.data = { truncated: true, bytes };
  return ev;
}

// A 4xx other than 408/429 will not get better on retry: the outbox marks it done (terminal).
export async function deliverBus(payload, doFetch = fetch) {
  let url = busEventsUrl();
  if (!url || !env.BUS_EVENTS_KEY) throw Error("bus_unarmed");
  let body = JSON.stringify(payload),
    r = await doFetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        [BUS_SIGNATURE_HEADER]: busSign(env.BUS_EVENTS_KEY, body),
        "x-runtime": String(payload?.source || ""),
      },
      body,
    });
  if (r.ok) return;
  let err = Error("bus " + r.status);
  if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) err.terminal = !0;
  throw err;
}
