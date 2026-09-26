// Routes: OAuth 2.1 + PKCE authorization server for MCP clients. Registration order is significant.
import { randomBytes } from "crypto";
import { escapeHtml, HttpError, newId, nowSec, sha256Base64Url, sha256Hex } from "../util.js";
import { getGrant, getTenant, recordEvent, sql } from "../db.js";
import { reissueGrantToken } from "../tokens.js";
import { revokeGrantTree } from "../grants.js";
import { app, readJsonBody, requireAdmin } from "../http.js";
import {
  effectiveCaps,
  ensureRootGrant,
  isAllowedRedirectUri,
  issueOAuthGrant,
  mintRefreshToken,
  oauthError,
  OPERATOR_PROFILE,
  profileForGrant,
  profileForRedirect,
  protectedResourceMetadata,
  publicBaseUrl,
  tokenResponse,
  validateAuthorizeRequest,
} from "../oauth.js";
import { renderPage } from "../cockpit.js";

app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
app.get("/.well-known/oauth-authorization-server", (e) => {
  let t = publicBaseUrl(e);
  return e.json({
    issuer: t,
    authorization_endpoint: t + "/oauth/authorize",
    token_endpoint: t + "/oauth/token",
    registration_endpoint: t + "/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: OPERATOR_PROFILE.caps,
  });
});
app.post("/oauth/register", async (e) => {
  let t = await readJsonBody(e),
    a = Array.isArray(t.redirect_uris) ? t.redirect_uris.map(String) : [];
  if (!a.length || !a.every(isAllowedRedirectUri))
    return oauthError(e, "invalid_redirect_uri", "redirect_uris must be https on an allowed host");
  if (Number((await sql`SELECT count(*)::int AS n FROM oauth_clients`)[0].n) > 500)
    return oauthError(e, "temporarily_unavailable", "client table full", 503);
  let n = newId("oc"),
    r = String(t.client_name || "mcp client").slice(0, 80);
  return (
    await sql`INSERT INTO oauth_clients (id, name, redirect_uris) VALUES (${n}, ${r}, ${a}::jsonb)`,
    await recordEvent(
      "oauth.client_registered",
      {
        id: n,
        name: r,
      },
      null,
      "oauth",
    ),
    e.json(
      {
        client_id: n,
        client_name: r,
        redirect_uris: a,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    )
  );
});
app.get("/oauth/authorize", async (e) => {
  let t = e.req.query(),
    a = await validateAuthorizeRequest(t),
    n = profileForRedirect(t.redirect_uri),
    displayCaps = await effectiveCaps(n),
    r = JSON.stringify({
      client_id: t.client_id,
      redirect_uri: t.redirect_uri,
      code_challenge: t.code_challenge,
      state: t.state || "",
    }).replace(/</g, "\\u003c");
  return e.html(
    renderPage(
      "Approve connector",
      `<h1>Approve connector</h1><div class="card"><p><b>${escapeHtml(a.name)}</b> wants to act on this runtime as <code>${n.sub}</code>.</p>
<p>It gets a <b>grant</b> (never the admin key): <code>${displayCaps.join(", ")}</code>${n.parts ? `<br>Memory only in <code>${n.parts.join(", ")}</code>` : ""}<br>Budget up to \xA2${n.usd} \xB7 ${n.calls} calls \xB7 0 deploys \xB7 no delete<br>${n === OPERATOR_PROFILE ? "Lifetime \u2264 7 days (capped by tier), then you approve again." : "Stays connected (auto-renews) until you revoke it."} Revoke anytime in Grants.</p>
<p>Redirects to <code>${escapeHtml(new URL(t.redirect_uri).host)}</code></p></div>
<div class="card" id="unlock" hidden><p>Unlock with the admin key (stays in this tab).</p><input id="k" type="password" style="width:100%"><button id="u">Unlock</button></div>
<div class="card" id="go" hidden><label>Tenant <select id="t"></select></label><p><button id="ok">Approve</button> <button id="no">Deny</button></p><p id="msg"></p></div>
<script>const C=${r};const $=i=>document.getElementById(i);let K=sessionStorage.getItem("cos_admin");
async function api(p,o={}){const r=await fetch(p,{...o,headers:{"content-type":"application/json",authorization:"Bearer "+K}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
async function load(){try{const j=await api("/api/tenants");$("t").innerHTML=j.tenants.filter(t=>t.status==="active").map(t=>'<option value="'+t.id+'">'+t.name.replace(/</g,"")+" \xB7 "+t.tier+" \xB7 "+t.id+"</option>").join("");$("unlock").hidden=true;$("go").hidden=false}catch(e){$("unlock").hidden=false;$("go").hidden=true}}
$("u").onclick=()=>{K=$("k").value.trim();$("k").value="";sessionStorage.setItem("cos_admin",K);load()};
$("no").onclick=()=>{const u=new URL(C.redirect_uri);u.searchParams.set("error","access_denied");if(C.state)u.searchParams.set("state",C.state);location=u};
$("ok").onclick=async()=>{$("ok").disabled=true;try{const j=await api("/oauth/approve",{method:"POST",body:JSON.stringify({...C,tenant:$("t").value})});location=j.redirect}catch(e){$("msg").textContent="Failed: "+e.message;$("ok").disabled=false}};
K?load():$("unlock").hidden=false;</script>`,
    ),
  );
});
app.post("/oauth/approve", requireAdmin, async (e) => {
  let t = await readJsonBody(e);
  await validateAuthorizeRequest(t);
  let a = await getTenant(String(t.tenant || ""));
  if (!a || a.status !== "active") throw new HttpError(404, "tenant_not_found");
  let n = await ensureRootGrant(a),
    r = randomBytes(24).toString("base64url");
  (await sql`INSERT INTO oauth_codes (hash, client_id, redirect_uri, challenge, tenant, root_id) VALUES (${sha256Hex(r)}, ${t.client_id}, ${t.redirect_uri}, ${t.code_challenge}, ${a.id}, ${n.id})`,
    await recordEvent(
      "oauth.approved",
      {
        client: t.client_id,
        root: n.id,
      },
      a.id,
      "admin",
    ));
  let s = new URL(t.redirect_uri);
  if ((s.searchParams.set("code", r), t.state)) s.searchParams.set("state", t.state);
  return e.json({
    redirect: s.toString(),
  });
});
app.post("/oauth/token", async (e) => {
  let t = (e.req.header("content-type") || "").includes("json")
    ? await readJsonBody(e)
    : Object.fromEntries(new URLSearchParams(await e.req.text()));
  if (t.grant_type === "authorization_code") {
    let a = (
      await sql`DELETE FROM oauth_codes WHERE hash = ${sha256Hex(String(t.code || ""))} AND created_at > now() - interval '10 minutes' RETURNING *`
    )[0];
    if (!a || a.client_id !== t.client_id || a.redirect_uri !== t.redirect_uri)
      return oauthError(e, "invalid_grant", "code invalid, expired, or mismatched");
    if (sha256Base64Url(String(t.code_verifier || "")) !== a.challenge)
      return oauthError(e, "invalid_grant", "pkce verification failed");
    let n = profileForRedirect(a.redirect_uri),
      r = nowSec() + n.consent,
      s = await issueOAuthGrant(a.root_id, r, n);
    return e.json(tokenResponse(s, await mintRefreshToken(a.client_id, a.tenant, a.root_id, s.row.id, r), n));
  }
  if (t.grant_type === "refresh_token") {
    let h = sha256Hex(String(t.refresh_token || "")),
      existing = (await sql`SELECT * FROM oauth_refresh WHERE hash = ${h}`)[0];
    // Rotate-on-use means a refresh token works exactly once; the row is only
    // ever marked revoked by that one legitimate exchange. Seeing it again
    // means the token was captured and is being replayed by someone else —
    // the WHERE revoked=false used to make that look identical to an unknown
    // token (just another invalid_grant), so a stolen refresh token and the
    // legitimate client's NEW one both stayed live. Revoke the grant it was
    // tied to and say so (2026-09-25 fix).
    if (existing?.revoked) {
      // Revoke every grant this CLIENT still has a live (unrotated) refresh
      // chain for, not just the stale row's own grant_id: the legitimate
      // rotation may have moved this client onto a NEW child grant (when the
      // old one was near expiry) rather than reissuing the same one.
      let live = await sql`UPDATE oauth_refresh SET revoked = true WHERE client_id = ${existing.client_id} AND revoked = false RETURNING grant_id`,
        ids = [...new Set([existing.grant_id, ...live.map((r) => r.grant_id)])];
      for (let id of ids) await revokeGrantTree(id, "refresh_token_reuse_detected", "oauth");
      await recordEvent(
        "oauth.refresh_reuse_detected",
        {
          client: existing.client_id,
          grants: ids,
        },
        existing.tenant,
        "oauth",
      );
      return oauthError(e, "invalid_grant", "refresh token reused; grant revoked");
    }
    let a = (
      await sql`UPDATE oauth_refresh SET revoked = true WHERE hash = ${h} AND revoked = false RETURNING *`
    )[0];
    if (!a || (t.client_id && a.client_id !== t.client_id))
      return oauthError(e, "invalid_grant", "refresh token invalid");
    if (Number(a.consent_until) <= nowSec())
      return oauthError(e, "invalid_grant", "consent window ended; approve again");
    let n = await getGrant(a.grant_id);
    if (!n || n.status === "revoked") return oauthError(e, "invalid_grant", "operator grant was revoked");
    // Same profile the grant was approved under, or no refresh at all.
    let r = profileForGrant(n);
    if (!r) return oauthError(e, "invalid_grant", "grant profile unknown; approve again");
    let s =
      n.status === "active" && Number(n.exp) - nowSec() > 3600
        ? {
            row: n,
            token: reissueGrantToken(n),
          }
        : await issueOAuthGrant(a.root_id, Number(a.consent_until), r).catch(() => null);
    if (!s) return oauthError(e, "invalid_grant", "root grant inactive; approve again");
    return e.json(
      tokenResponse(
        s,
        await mintRefreshToken(a.client_id, a.tenant, a.root_id, s.row.id, Number(a.consent_until)),
        r,
      ),
    );
  }
  return oauthError(e, "unsupported_grant_type", "use authorization_code or refresh_token");
});
