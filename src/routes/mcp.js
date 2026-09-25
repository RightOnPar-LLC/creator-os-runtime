// Routes: MCP streamable-http endpoint. Registration order is significant.
import { armedIntegrations, SERVICE_NAME, VERSION } from "../config.js";
import { HttpError, parseJson } from "../util.js";
import { isKillSwitchOn, sql } from "../db.js";
import { memoryPartitions, remainingBudget } from "../policy.js";
import { issueChildGrant, revokeGrantTree, verifyGrant } from "../grants.js";
import { assertMemoryScope, forgetMemory, searchMemories, writeMemory } from "../memory.js";
import { deployWorker, refreshDeployStatus } from "../railway.js";
import { cogExecute, cogPlan } from "../cog.js";
import { app, bearerToken, readJsonBody } from "../http.js";
import { jsonRpcResponse, MCP_TOOLS } from "../mcp.js";
import { publicBaseUrl } from "../oauth.js";

app.get("/mcp", (e) =>
  e.json({
    transport: "streamable-http",
    methods: ["initialize", "tools/list", "tools/call", "ping"],
    tools: MCP_TOOLS.map((t) => t.name),
    auth: "Bearer <grant>",
  }),
);
app.post("/mcp", async (e) => {
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
    await verifyGrant(t, null);
  } catch (l) {
    if (l instanceof HttpError && l.status === 401) return a(l.code);
  }
  let n = await readJsonBody(e),
    r = n.id ?? null;
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
    i = n.params?.arguments || {},
    o = (l) =>
      jsonRpcResponse(r, {
        content: [
          {
            type: "text",
            text: JSON.stringify(l),
          },
        ],
        structuredContent: l,
      });
  try {
    if (s === "runtime_health") {
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
    let c = await verifyGrant(bearerToken(e), l[s]);
    switch (s) {
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
        return e.json(
          o({
            revoked: await revokeGrantTree(
              E,
              String(i.reason || "revoked by " + c.row.sub).slice(0, 200),
              c.row.sub,
            ),
          }),
        );
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
            ledger:
              await sql`SELECT * FROM ledger WHERE tenant = ${c.tenant.id} ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, +i.limit || 50))}`,
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
              memory: await forgetMemory(c.tenant.id, String(i.id)),
            }),
          )
        );
      }
    }
  } catch (l) {
    if (l instanceof HttpError)
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
    throw l;
  }
  return e.json(
    jsonRpcResponse(r, void 0, {
      code: -32603,
      message: "unhandled",
    }),
  );
});
