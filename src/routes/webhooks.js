// Routes: inbound webhooks: stripe, railway, github, brain, mesh. Registration order is significant.
import { env } from "../config.js";
import { hmacSha256, HttpError, safeEqual, sha256Hex } from "../util.js";
import { getSetting, recordEvent, sql } from "../db.js";
import {
  handleRailwayEvent,
  handleStripeEvent,
  markWebhookHandled,
  recordWebhookEvent,
  verifyTimestampedSignature,
} from "../webhooks.js";
import { app, readJsonBody } from "../http.js";

app.post("/webhooks/stripe", async (e) => {
  if (!env.STRIPE_WEBHOOK_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "STRIPE_WEBHOOK_SECRET",
    });
  let t = await e.req.text();
  if (!verifyTimestampedSignature(t, e.req.header("stripe-signature"), env.STRIPE_WEBHOOK_SECRET))
    throw new HttpError(401, "bad_signature");
  let a = JSON.parse(t),
    n = await recordWebhookEvent("stripe", String(a.id), a.type, a);
  if (n === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  let r = await handleStripeEvent(a);
  return (
    await markWebhookHandled(n, r),
    e.json({
      received: !0,
      result: r,
    })
  );
});
app.post("/webhooks/railway", async (e) => {
  if (!env.RAILWAY_WEBHOOK_TOKEN)
    throw new HttpError(503, "unarmed", {
      needs: "RAILWAY_WEBHOOK_TOKEN",
    });
  // Header only: a query string lands in access/proxy logs and Railway's own
  // request logs, so a ?token= shared secret leaks anywhere those are kept or
  // forwarded. No query fallback (2026-09-25 fix; re-point the Railway webhook
  // at the x-runtime-token header, never a URL, when arming it).
  let t = e.req.header("x-runtime-token") || "";
  if (!safeEqual(t, env.RAILWAY_WEBHOOK_TOKEN)) throw new HttpError(401, "bad_token");
  let a = await readJsonBody(e),
    n = `${a.resource?.deployment?.id || a.resource?.service?.id || "na"}:${a.type}:${a.timestamp || ""}`,
    r = await recordWebhookEvent("railway", n, a.type || null, a);
  if (r === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  let s = await handleRailwayEvent(a);
  return (
    await markWebhookHandled(r, s),
    e.json({
      received: !0,
      result: s,
    })
  );
});
app.post("/webhooks/github", async (e) => {
  if (!env.GITHUB_WEBHOOK_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "GITHUB_WEBHOOK_SECRET",
    });
  let t = await e.req.text(),
    a = e.req.header("x-hub-signature-256") || "";
  if (!safeEqual(a, "sha256=" + hmacSha256(env.GITHUB_WEBHOOK_SECRET, t)))
    throw new HttpError(401, "bad_signature");
  let n = JSON.parse(t || "{}"),
    // Dedupe on the SIGNED body, not x-github-delivery: that header is outside
    // the HMAC, so a captured body replayed with a fresh delivery id used to
    // count as new (2026-09-25 fix). A genuine GitHub redelivery carries the
    // same body, so it is still recognised as a replay.
    r = sha256Hex(t),
    s = e.req.header("x-github-event") || "unknown";
  // Rows written before 0.3.1 are keyed by delivery id, not body hash. Treat a
  // match on the old key, or (for events that carry one) the same repo + after
  // sha + type, as a replay too, so a pre-0.3.1 body can't be re-processed
  // under a fresh delivery id (review on PR #5).
  let d = e.req.header("x-github-delivery") || "",
    legacy = await sql`SELECT 1 FROM webhook_events WHERE source = 'github' AND (event_id = ${d}
      OR (${n.after ? String(n.after) : null}::text IS NOT NULL AND type = ${s}
          AND payload->>'repo' = ${n.repository?.full_name ?? null} AND payload->>'after' = ${n.after ? String(n.after) : null})) LIMIT 1`;
  if (legacy.length)
    return e.json({
      received: !0,
      replay: !0,
    });
  let i = await recordWebhookEvent("github", r, s, {
      repo: n.repository?.full_name,
      ref: n.ref,
      after: n.after,
    });
  if (i === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  return (
    await recordEvent(
      "repo." + s,
      {
        repo: n.repository?.full_name,
        ref: n.ref,
        after: n.after,
      },
      null,
      "github",
    ),
    await markWebhookHandled(i, {
      emitted: !0,
    }),
    e.json({
      received: !0,
    })
  );
});
app.post("/webhooks/brain", async (e) => {
  if (!env.BRAIN_WEBHOOK_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "BRAIN_WEBHOOK_SECRET",
    });
  let t = await e.req.text();
  if (!safeEqual(e.req.header("x-brain-signature") || "", hmacSha256(env.BRAIN_WEBHOOK_SECRET, t)))
    throw new HttpError(401, "bad_signature");
  let a = JSON.parse(t || "{}"),
    n = await recordWebhookEvent("brain", String(a.id || sha256Hex(t)), a.type || null, a);
  if (n === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  return (
    await recordEvent(
      "brain." + String(a.type || "event").slice(0, 60),
      a.data ?? a,
      a.tenant || null,
      "brain",
    ),
    await markWebhookHandled(n, {
      emitted: !0,
    }),
    e.json({
      received: !0,
    })
  );
});
app.post("/webhooks/mesh", async (e) => {
  if (!env.MESH_RECEIPT_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "MESH_RECEIPT_SECRET",
    });
  let t = await e.req.text();
  if (!safeEqual(e.req.header("x-mesh-signature") || "", hmacSha256(env.MESH_RECEIPT_SECRET, t)))
    throw new HttpError(401, "bad_signature");
  let a = JSON.parse(t || "{}"),
    n = await recordWebhookEvent("mesh", String(a.receipt_id || sha256Hex(t)), "receipt", a);
  if (n === null)
    return e.json({
      received: !0,
      replay: !0,
    });
  let r = (await getSetting("receipt_grants")) === "on";
  return (
    await recordEvent(
      "mesh.receipt",
      {
        amount: a.amount,
        capability: a.capability,
        minted: r,
      },
      a.tenant || null,
      "mesh",
    ),
    await markWebhookHandled(n, {
      stored: !0,
      minted: !1,
      receiptGrants: r,
    }),
    e.json(
      {
        received: !0,
        stored: !0,
        minted: !1,
        note: r
          ? "receipt\u2192grant lane armed but minting not yet implemented"
          : "receipt stored; receipt\u2192grant lane is off",
      },
      202,
    )
  );
});
