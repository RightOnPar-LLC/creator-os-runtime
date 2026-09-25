// Routes: Railway OAuth connect (tenant vault). Registration order is significant.
import { createHash, randomBytes } from "crypto";
import { env } from "../config.js";
import { HttpError, newId } from "../util.js";
import { recordEvent, sql } from "../db.js";
import { vaultEncrypt, vaultKey } from "../tokens.js";
import { app, requireGrant } from "../http.js";

app.get("/auth/railway/start", requireGrant("tenant.read"), async (e) => {
  let t = e.get("auth");
  if (!env.RAILWAY_OAUTH_CLIENT_ID || !env.RAILWAY_OAUTH_CLIENT_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "RAILWAY_OAUTH_CLIENT_ID+SECRET",
    });
  if (!vaultKey())
    throw new HttpError(503, "unarmed", {
      needs: "VAULT_KEY",
    });
  let a = randomBytes(32).toString("base64url"),
    n = createHash("sha256").update(a).digest("base64url"),
    r = randomBytes(16).toString("base64url");
  await sql`INSERT INTO oauth_states (state, tenant, verifier) VALUES (${r}, ${t.tenant.id}, ${a})`;
  let s = `${env.PUBLIC_URL || new URL(e.req.url).origin}/auth/railway/callback`,
    i = new URL("https://backboard.railway.com/oauth/auth");
  return (
    (i.search = new URLSearchParams({
      response_type: "code",
      client_id: env.RAILWAY_OAUTH_CLIENT_ID,
      redirect_uri: s,
      scope: "openid",
      state: r,
      code_challenge: n,
      code_challenge_method: "S256",
    }).toString()),
    e.json({
      authorizeUrl: i.toString(),
      redirect_uri: s,
      state: r,
    })
  );
});
app.get("/auth/railway/callback", async (e) => {
  if (!env.RAILWAY_OAUTH_CLIENT_ID || !env.RAILWAY_OAUTH_CLIENT_SECRET)
    throw new HttpError(503, "unarmed", {
      needs: "RAILWAY_OAUTH_CLIENT_ID+SECRET",
    });
  let { code: t, state: a, error: n } = e.req.query();
  if (n) throw new HttpError(400, "oauth_denied", n);
  let r = a
    ? (
        await sql`DELETE FROM oauth_states WHERE state = ${a} AND created_at > now() - interval '10 minutes' RETURNING *`
      )[0]
    : null;
  if (!r || !t) throw new HttpError(400, "bad_state");
  let s = `${env.PUBLIC_URL || new URL(e.req.url).origin}/auth/railway/callback`,
    i = await fetch("https://backboard.railway.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization:
          "Basic " +
          Buffer.from(`${env.RAILWAY_OAUTH_CLIENT_ID}:${env.RAILWAY_OAUTH_CLIENT_SECRET}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: t,
        redirect_uri: s,
        code_verifier: r.verifier,
      }),
    }),
    o = await i.json().catch(() => ({}));
  if (!i.ok || !o.access_token) throw new HttpError(502, "token_exchange_failed");
  let l = vaultEncrypt(JSON.stringify(o));
  return (
    await sql`INSERT INTO vault (id, tenant, provider, ciphertext, iv, tag, meta) VALUES (${newId("v")}, ${r.tenant}, 'railway', ${l.ciphertext}, ${l.iv}, ${l.tag}, ${{
      scope: o.scope || null,
      obtained: new Date().toISOString(),
    }}::jsonb)
    ON CONFLICT (tenant, provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, meta = EXCLUDED.meta, created_at = now()`,
    await recordEvent(
      "vault.stored",
      {
        provider: "railway",
      },
      r.tenant,
      "oauth",
    ),
    e.html(
      '<!doctype html><meta charset=utf-8><title>Connected</title><body style="font-family:system-ui;padding:40px"><h2>Railway connected.</h2><p>You can close this tab.</p><a href="/">Back to hub</a>',
    )
  );
});
