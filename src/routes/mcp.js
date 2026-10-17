// Routes: MCP streamable-http endpoint. Registration order is significant.
import { toolReceiptMiddleware, bindToolReceipt, bindPublicToolReceipt, readToolReceipts } from "../tool-receipts.js";
import { armedIntegrations, SERVICE_NAME, VERSION } from "../config.js";
import { HttpError, parseJson } from "../util.js";
import { notATourReason } from "../tours.js";
import { isKillSwitchOn, sql } from "../db.js";
import { memoryPartitions, remainingBudget } from "../policy.js";
import { issueChildGrant, revokeGrantTree, verifyGrant } from "../grants.js";
import { assertMemoryScope, forgetMemory, searchMemories, writeMemory } from "../memory.js";
import { deployWorker, refreshDeployStatus } from "../railway.js";
import { cogExecute, cogPlan } from "../cog.js";
import { app, bearerToken, readJsonBody } from "../http.js";
import { jsonRpcResponse, MCP_TOOLS } from "../mcp.js";
import { publicBaseUrl } from "../oauth.js";
import { issueGuestGrantGuarded, welcomePackage } from "../guest.js";

app.get("/mcp", (e) =>
  e.json({
    transport: "streamable-http",
    methods: ["initialize", "tools/list", "tools/call", "ping"],
    tools: MCP_TOOLS.map((t) => t.name),
    auth: "Bearer <grant>",
  }),
);
app.use("/mcp", toolReceiptMiddleware(MCP_TOOLS.map((t) => t.name)));
app.post("/mcp", async (e) => {
  let n = await readJsonBody(e),
    r = n.id ?? null,
    o = (l) =>
      jsonRpcResponse(r, {
        content: [{ type: "text", text: JSON.stringify(l) }],
        structuredContent: l,
      });
  // THE ONE pre-grant door: keyless guest_welcome mints the SAME guest grant as the
  // public POST /api/guest — same sybil gate, same GUEST_CAPS envelope, same pool
  // breaker — and returns the welcome package. It never calls verifyGrant and always
  // returns, so control never reaches the grant gate below; every other method and
  // every other tools/call name falls through to the unchanged gate.
  if (n.method === "tools/call" && n.params?.name === "guest_welcome") {
    await bindPublicToolReceipt(e);
    if (await isKillSwitchOn()) throw new HttpError(503, "runtime_paused");
    let ip = e.req.header("x-real-ip") || (e.req.header("x-forwarded-for") || "").split(",")[0].trim() || "noip",
      g = await issueGuestGrantGuarded({ ip, agentName: n.params?.arguments?.agent_name, homeUrl: n.params?.arguments?.home_url });
    return e.json(o(welcomePackage(g.row, g.token, publicBaseUrl(e))));
  }
  let t = bearerToken(e),
    a = (l) =>
      e.json(
        {
          error: l,
        },
        401,
        {
          "WWW-Authenticate": `Bearer resource_metadata="${publicBaseUrl(e)}/.well-known/oauth-protected-resource"`,
        },
      );
  if (!t) return a("missing_grant");
  try {
    const verified = await verifyGrant(t, null);
    await bindToolReceipt(e, verified);
  } catch (l) {
    if (l instanceof HttpError) {
      // 401 (missing/bad/expired/revoked grant) carries the OAuth discovery
      // header. Any other rejection here — rate_limited, tenant_suspended,
      // runtime_paused — used to fall through silently: this catch only
      // matched status 401, so the request ran as if verifyGrant had
      // succeeded. For "tools/call" the SECOND verifyGrant call (below) used
      // to re-check and catch it; now that call no longer re-checks the rate
      // limit (it would double-count), so an uncaught rejection here would
      // go uncaught entirely (2026-09-25 fix, alongside the double-count fix).
      if (l.status === 401) return a(l.code);
      return e.json(
        {
          error: l.code,
          detail: l.detail ?? null,
        },
        l.status,
      );
    }
    throw l;
  }
  // n / r were read at the top (before the gate) so the keyless branch could see the method
  if (n.method === "notifications/initialized") return e.body(null, 202);
  if (n.method === "initialize")
    return e.json(
      jsonRpcResponse(r, {
        protocolVersion: n.params?.protocolVersion || "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVICE_NAME,
          version: VERSION,
        },
      }),
    );
  if (n.method === "ping") return e.json(jsonRpcResponse(r, {}));
  if (n.method === "tools/list")
    return e.json(
      jsonRpcResponse(r, {
        tools: MCP_TOOLS,
      }),
    );
  if (n.method !== "tools/call")
    return e.json(
      jsonRpcResponse(r, void 0, {
        code: -32601,
        message: "method_not_found",
      }),
    );
  let s = n.params?.name,
    i = n.params?.arguments || {};
  try {
    if (s === "runtime_health") {
      await bindToolReceipt(e, e.get("toolReceiptAuth"), true);
      let E = !1;
      try {
        (await sql`SELECT 1`, (E = !0));
      } catch {}
      return e.json(
        o({
          ok: E,
          version: VERSION,
          armed: armedIntegrations(),
          killSwitch: await isKillSwitchOn(),
        }),
      );
    }
    let l = {
      tool_receipts: "ledger.read",
      grant_verify: null,
      grant_issue: "grant.issue",
      grant_list: "grant.read",
      grant_revoke: "grant.issue",
      cog_plan: "cog.plan",
      cog_execute: "cog.execute",
      deploy_worker: "deploy.worker",
      deploy_status: "worker.status",
      ledger_query: "ledger.read",
      memory_search: "memory.read",
      memory_write: "memory.write",
      memory_forget: "memory.write",
    };
    if (!(s in l))
      return e.json(
        jsonRpcResponse(r, void 0, {
          code: -32602,
          message: "unknown_tool",
        }),
      );
    // Already counted against the rate limit by the pre-check above (line ~36);
    // don't count this second, cap-specific verification too, or one MCP call
    // spends two units of budget while the same call over REST spends one
    // (2026-09-25 fix).
    let c = await verifyGrant(bearerToken(e), l[s], null, !1);
    await bindToolReceipt(e, c, true);
    switch (s) {
      case "tool_receipts":
        return e.json(o({ receipts: await readToolReceipts(c, i.limit) }));
      case "grant_verify":
        return e.json(
          o({
            id: c.row.id,
            tenant: c.tenant.id,
            sub: c.row.sub,
            caps: parseJson(c.row.caps),
            scope: parseJson(c.row.scope),
            remaining: remainingBudget(c.row),
            exp: Number(c.row.exp),
          }),
        );
      case "grant_issue": {
        let E = await issueChildGrant(c.row, i, c.row.sub);
        return e.json(
          o({
            id: E.row.id,
            token: E.token,
            exp: Number(E.row.exp),
          }),
        );
      }
      case "grant_list": {
        let E =
          await sql`WITH RECURSIVE sub AS (SELECT * FROM grants WHERE id = ${c.row.id} UNION ALL SELECT g.* FROM grants g JOIN sub ON g.parent = sub.id) SELECT id, parent, depth, sub, status, caps, budget, reserved, settled, exp FROM sub ORDER BY depth, created_at`;
        return e.json(
          o({
            grants: E.map((T) => ({
              id: T.id,
              parent: T.parent,
              depth: T.depth,
              sub: T.sub,
              status: T.status,
              caps: parseJson(T.caps),
              exp: Number(T.exp),
              remaining: remainingBudget(T),
            })),
          }),
        );
      }
      case "grant_revoke": {
        let E = String(i.id || "");
        if (
          !(
            await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${c.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id) SELECT 1 FROM sub WHERE id = ${E}`
          ).length
        )
          throw new HttpError(403, "not_in_subtree");
        let reason = String(i.reason || "revoked by " + c.row.sub).slice(0, 200);
        notATourReason(reason); // "tour: ..." is the runtime's own (tours.js): the alarm reads one of them back
        return e.json(o({ revoked: await revokeGrantTree(E, reason, c.row.sub) }));
      }
      case "cog_plan":
        return e.json(
          o({
            proposal: await cogPlan(c, String(i.intent || ""), i.hints || {}),
          }),
        );
      case "cog_execute":
        return e.json(o(await cogExecute(c, i.proposal, !!i.confirm)));
      case "deploy_worker":
        return e.json(o(await deployWorker(c, i, !!i.confirm, c.row.sub)));
      case "deploy_status":
        return e.json(
          o({
            deploy: await refreshDeployStatus(c, String(i.id)),
          }),
        );
      case "ledger_query":
        return e.json(
          o({
            // subtree-scoped, mirroring GET /api/ledger — a pooled guest sees only its own rows
            ledger:
              await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${c.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
              SELECT * FROM ledger WHERE tenant = ${c.tenant.id} AND grant_id IN (SELECT id FROM sub) ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, +i.limit || 50))}`,
          }),
        );
      case "memory_search": {
        let E = i.partition
          ? assertMemoryScope(c, String(i.partition))
          : memoryPartitions(parseJson(c.row.scope))[0];
        return e.json(
          o({
            memories: await searchMemories(c.tenant.id, String(i.q || ""), E, +i.limit || 10),
          }),
        );
      }
      case "memory_write": {
        if (!i.content) throw new HttpError(400, "content_required");
        let E = assertMemoryScope(c, String(i.partition || "tenant").slice(0, 80));
        return e.json(
          o({
            memory: await writeMemory(
              c.tenant.id,
              E,
              i.key ? String(i.key).slice(0, 120) : null,
              String(i.content).slice(0, 20000),
              Array.isArray(i.tags) ? i.tags.map(String) : [],
              c.row.sub,
              c, // auth → guest write cap + brain-sync quarantine
            ),
          }),
        );
      }
      case "memory_forget": {
        let E =
          await sql`SELECT partition FROM memories WHERE id = ${String(i.id)} AND tenant = ${c.tenant.id}`;
        if (!E.length) throw new HttpError(404, "memory_not_found");
        return (
          assertMemoryScope(c, E[0].partition),
          e.json(
            o({
              memory: await forgetMemory(c.tenant.id, String(i.id), c),
            }),
          )
        );
      }
    }
  } catch (l) {
    if (l instanceof HttpError) {
      e.set("toolReceiptErrorStatus", l.status);
      return e.json({
        jsonrpc: "2.0",
        id: r,
        result: {
          isError: !0,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: l.code,
                detail: l.detail ?? null,
              }),
            },
          ],
        },
      });
    }
    throw l;
  }
  return e.json(
    jsonRpcResponse(r, void 0, {
      code: -32603,
      message: "unhandled",
    }),
  );
});
