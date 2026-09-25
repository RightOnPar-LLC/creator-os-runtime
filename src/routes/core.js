// Routes: error handler, 404, /health, /.well-known/creator-os.json. Registration order is significant.
import {
  armedIntegrations,
  env,
  POLICY_VERSION,
  secretFingerprints,
  SERVICE_NAME,
  VERSION,
} from "../config.js";
import { HttpError, redactUrl, sha256Hex } from "../util.js";
import { isKillSwitchOn, sql } from "../db.js";
import { CAPS, TIERS } from "../policy.js";
import { TEMPLATES } from "../railway.js";
import { app, requireAdmin, sourceBytes, sourceSha256, sourceText } from "../http.js";

app.onError((e, t) => {
  if (e instanceof HttpError)
    return t.json(
      {
        error: e.code,
        detail: e.detail ?? null,
      },
      e.status,
    );
  let a = e?.status && Number.isInteger(e.status) ? e.status : 500,
    n = e?.message && a < 500 ? e.message : "internal_error";
  // redactUrl(): a query string can carry a shared secret (POST
  // /webhooks/railway?token=...); never let one reach this log line (2026-09-25 fix).
  if (a >= 500) console.error("ERR", t.req.method, redactUrl(t.req.url), e?.stack || e);
  return t.json(
    {
      error: n,
      detail: e?.detail ?? (env.RUNTIME_MODE === "dev" ? String(e?.message) : null),
    },
    a,
  );
});
app.notFound((e) =>
  e.json(
    {
      error: "not_found",
      hint: "GET /routes",
    },
    404,
  ),
);
app.get("/health", async (e) => {
  let t = !1;
  try {
    (await sql`SELECT 1`, (t = !0));
  } catch {}
  return e.json(
    {
      ok: t,
      service: SERVICE_NAME,
      version: VERSION,
      policy: POLICY_VERSION,
      db: t,
      killSwitch: await isKillSwitchOn(),
      armed: armedIntegrations(),
      // Secret fingerprints moved behind the admin key (GET /api/admin/fingerprints):
      // 8 hex of sha256 is harmless for a random key but lets anyone test guesses
      // offline against a weak one (2026-09-25 fix).
      source: {
        sha256: sourceSha256,
        bytes: sourceBytes,
        chunks: e.req.query("chunks")
          ? Array.from(
              {
                length: Math.ceil(sourceText.length / 4096),
              },
              (a, n) => sha256Hex(sourceText.slice(n * 4096, (n + 1) * 4096)).slice(0, 8),
            )
          : void 0,
      },
      time: new Date().toISOString(),
    },
    t ? 200 : 503,
  );
});
app.get("/api/admin/fingerprints", requireAdmin, (e) => e.json({ fingerprints: secretFingerprints() }));
app.get("/.well-known/creator-os.json", (e) =>
  e.json({
    name: SERVICE_NAME,
    version: VERSION,
    policy: POLICY_VERSION,
    surfaces: {
      api: "/api",
      mcp: "/mcp",
      docs: "/docs",
      routes: "/routes",
      cockpit: "/",
    },
    caps: CAPS,
    tiers: TIERS,
    templates: Object.fromEntries(
      Object.entries(TEMPLATES).map(([t, a]) => [
        t,
        {
          desc: a.desc,
          needs: a.needs,
          estCents: a.estCents,
        },
      ]),
    ),
    armed: armedIntegrations(),
  }),
);
