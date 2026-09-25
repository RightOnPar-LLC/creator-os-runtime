// Durable outbox to the Brain and the cognitive bridge, with retry/backoff.
import { env, SERVICE_NAME } from "./config.js";
import { hmacSha256, parseJson } from "./util.js";
import { sql } from "./db.js";

export var cogBridgeUrl = () => (env.COG_BRIDGE_URL || "").replace(/\/$/, "");
export async function enqueueOutbox(e, t) {
  if (!(e === "brain.event" ? !!env.BRAIN_URL : !!(cogBridgeUrl() && env.COG_BRIDGE_TOKEN))) return;
  if ((await sql`INSERT INTO outbox (kind, payload) VALUES (${e}, ${t}::jsonb)`, !outboxDrainScheduled))
    ((outboxDrainScheduled = !0),
      setTimeout(
        () =>
          drainOutbox(25)
            .catch(() => {})
            .finally(() => {
              outboxDrainScheduled = !1;
            }),
        30,
      ));
}
var outboxDrainScheduled = !1;
async function deliverOutboxItem(e, t) {
  if (e === "brain.event") {
    let a = JSON.stringify(t),
      n = await fetch(env.BRAIN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-brain-signature": hmacSha256(env.BRAIN_WEBHOOK_SECRET || "", a),
          "x-runtime": SERVICE_NAME,
        },
        body: a,
      });
    if (!n.ok) throw Error("brain " + n.status);
    return;
  }
  if (e === "memory.sync") {
    let a = await fetch(cogBridgeUrl() + "/sync/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.COG_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({
        records: [t],
      }),
    });
    if (!a.ok) throw Error("bridge " + a.status);
    return;
  }
  throw Error("unknown_kind");
}
export async function drainOutbox(e) {
  let t = await sql`SELECT * FROM outbox WHERE done = false AND next_at <= now() ORDER BY id LIMIT ${e}`,
    a = 0,
    n = 0;
  for (let r of t)
    try {
      (await deliverOutboxItem(r.kind, parseJson(r.payload)),
        await sql`UPDATE outbox SET done = true WHERE id = ${r.id}`,
        a++);
    } catch (s) {
      let i = r.attempts + 1;
      (await sql`UPDATE outbox SET attempts = ${i}, next_at = ${new Date(Date.now() + Math.min(300, 2 ** i) * 1000)}, last_error = ${String(s?.message || s).slice(0, 300)}, done = ${i >= 10} WHERE id = ${r.id}`,
        n++);
    }
  return {
    ok: a,
    failed: n,
    more: t.length === e,
  };
}
