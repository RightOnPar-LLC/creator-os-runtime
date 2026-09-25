// Webhook signature checks, idempotency records, Stripe and Railway event handlers.
import { env } from "./config.js";
import { hmacSha256, nowSec, safeEqual } from "./util.js";
import { getTenant, recordEvent, sql } from "./db.js";
import { writeMemory } from "./memory.js";

export function verifyTimestampedSignature(e, t, a, n = 300) {
  if (!t) return !1;
  let r = Object.fromEntries(t.split(",").map((o) => o.split("=").map((l) => l.trim()))),
    s = r.t,
    i = r.v1;
  if (!s || !i) return !1;
  if (Math.abs(nowSec() - Number(s)) > n) return !1;
  return safeEqual(hmacSha256(a, `${s}.${e}`), i);
}
export async function recordWebhookEvent(e, t, a, n) {
  let r =
    await sql`INSERT INTO webhook_events (source, event_id, type, payload) VALUES (${e}, ${t}, ${a}, ${n}::jsonb)
    ON CONFLICT (source, event_id) DO NOTHING RETURNING id`;
  return r.length ? r[0].id : null;
}
export async function markWebhookHandled(e, t) {
  await sql`UPDATE webhook_events SET handled = true, result = ${t}::jsonb WHERE id = ${e}`;
}
export async function handleStripeEvent(e) {
  let t = e.type,
    a = e.data?.object || {},
    n = (() => {
      try {
        return JSON.parse(env.STRIPE_PRICE_MAP || "{}");
      } catch {
        return {};
      }
    })(),
    r = (i) => (i && n[i]) || null,
    s = async (i) => (i ? (await sql`SELECT * FROM tenants WHERE stripe_customer = ${i}`)[0] : null);
  if (t === "checkout.session.completed") {
    let i = a.client_reference_id || a.metadata?.tenant,
      o = i ? await getTenant(i) : null;
    if (!o)
      return {
        ignored: "no_tenant",
      };
    return (
      await sql`UPDATE tenants SET stripe_customer = ${a.customer || null}, stripe_subscription = ${a.subscription || null}, status = 'active', period_start = now(), deploys_period = 0, updated_at = now() WHERE id = ${o.id}`,
      await recordEvent(
        "billing.activated",
        {
          customer: a.customer,
        },
        o.id,
        "stripe",
      ),
      {
        activated: o.id,
      }
    );
  }
  if (t === "customer.subscription.updated" || t === "customer.subscription.created") {
    let i = await s(a.customer);
    if (!i)
      return {
        ignored: "unknown_customer",
      };
    let o = r(a.items?.data?.[0]?.price?.id),
      l = ["active", "trialing"].includes(a.status) ? "active" : "suspended";
    if (o)
      await sql`UPDATE tenants SET tier = ${o}, status = ${l}, stripe_subscription = ${a.id}, updated_at = now() WHERE id = ${i.id}`;
    else
      await sql`UPDATE tenants SET status = ${l}, stripe_subscription = ${a.id}, updated_at = now() WHERE id = ${i.id}`;
    return (
      await recordEvent(
        "billing.updated",
        {
          tier: o,
          status: l,
        },
        i.id,
        "stripe",
      ),
      {
        tenant: i.id,
        tier: o,
        status: l,
      }
    );
  }
  if (t === "customer.subscription.deleted" || t === "invoice.payment_failed") {
    let i = await s(a.customer);
    if (!i)
      return {
        ignored: "unknown_customer",
      };
    return (
      await sql`UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = ${i.id}`,
      await recordEvent(
        "billing.suspended",
        {
          reason: t,
        },
        i.id,
        "stripe",
      ),
      {
        suspended: i.id,
      }
    );
  }
  if (t === "invoice.paid") {
    let i = await s(a.customer);
    if (!i)
      return {
        ignored: "unknown_customer",
      };
    return (
      await sql`UPDATE tenants SET status = 'active', period_start = now(), deploys_period = 0, updated_at = now() WHERE id = ${i.id}`,
      await recordEvent("billing.period_reset", {}, i.id, "stripe"),
      {
        period_reset: i.id,
      }
    );
  }
  return {
    ignored: t,
  };
}
export async function handleRailwayEvent(e) {
  let t = e.resource?.service?.id,
    a = e.resource?.deployment?.id,
    n = String(e.details?.status || e.type || "")
      .toLowerCase()
      .replace("deployment.", "");
  if (!t)
    return {
      ignored: "no_service",
    };
  let r =
    await sql`UPDATE deploys SET status = ${n}, railway_deployment_id = ${a || null}, updated_at = now() WHERE railway_service_id = ${t} RETURNING id, tenant, name, template`;
  for (let s of r)
    if (
      (await recordEvent(
        "deploy.status",
        {
          id: s.id,
          name: s.name,
          status: n,
        },
        s.tenant,
        "railway",
      ),
      /fail|crash/.test(n))
    )
      (await recordEvent(
        "worker.failed",
        {
          id: s.id,
          name: s.name,
          template: s.template,
          status: n,
          repairHint: "COG may propose a bounded repair grant",
        },
        s.tenant,
        "railway",
      ),
        await writeMemory(
          s.tenant,
          `worker:${s.name}`,
          `status:${n}`,
          `worker ${s.name} (${s.template}) ${n} at ${new Date().toISOString()}`,
          ["railway", s.template, n],
          "railway",
        ));
  return {
    matched: r.length,
    status: n,
  };
}
