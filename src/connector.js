// Connector exec switch (0.3.3). One admin switch decides whether the claude.ai
// connector -- the OAuth "operator" profile, sub agent:claude-operator -- may use
// cog.execute and lsp.diagnose.
//
//   OFF (the default, and whenever the setting is missing): operator sign-ins get the
//        base caps only, AND any grant whose lineage includes an operator grant has
//        these caps masked at verify time. Turning it off bites on the next call,
//        not at the next re-approval -- including children the connector minted.
//   ON:  new operator grants carry them (never more than the tenant's root carries).
//
// Masking happens in verifyGrant, the one chokepoint every REST route, every MCP
// tool, lsp-mcp's introspection (GET /api/grants/verify) and child issuance go
// through, so no path can see the unmasked caps while the switch is off.
import { getSetting, setSetting, sql } from "./db.js";
import { parseJson } from "./util.js";

export var OPERATOR_SUB = "agent:claude-operator";
export var CONNECTOR_EXEC_CAPS = ["cog.execute", "lsp.diagnose"];
export var CONNECTOR_EXEC_SETTING = "connector_exec";

export async function isConnectorExecOn() {
  return (await getSetting(CONNECTOR_EXEC_SETTING)) === "on";
}
export async function setConnectorExec(on) {
  await setSetting(CONNECTOR_EXEC_SETTING, on ? "on" : "off");
}
// True when the grant itself, or any ancestor, is an operator grant. Depth is capped
// by tier (max 6), the guard at 16 only stops a malformed cycle.
export async function hasOperatorLineage(grantId) {
  return (
    (
      await sql`WITH RECURSIVE up AS (
        SELECT id, parent, sub, 0 AS d FROM grants WHERE id = ${grantId}
        UNION ALL SELECT g.id, g.parent, g.sub, up.d + 1 FROM grants g JOIN up ON g.id = up.parent WHERE up.d < 16)
      SELECT 1 FROM up WHERE sub = ${OPERATOR_SUB} LIMIT 1`
    ).length > 0
  );
}
// The caps a grant may USE right now. Cheap checks first: a grant carrying neither
// cap, or a root grant (roots are never under an operator), costs no extra query.
export async function effectiveCaps(row, caps) {
  if (!caps.some((c) => CONNECTOR_EXEC_CAPS.includes(c))) return caps;
  if (row.sub !== OPERATOR_SUB && Number(row.depth) === 0) return caps;
  if (await isConnectorExecOn()) return caps;
  if (row.sub !== OPERATOR_SUB && !(await hasOperatorLineage(row.id))) return caps;
  return caps.filter((c) => !CONNECTOR_EXEC_CAPS.includes(c));
}
// Caps an operator grant is ISSUED with. rootRow undefined = not known yet (the
// consent page, before a tenant is picked): show what an up-to-date root would give.
export async function operatorCapsFor(baseCaps, rootRow) {
  if (!(await isConnectorExecOn())) return [...baseCaps];
  let root = rootRow === void 0 ? CONNECTOR_EXEC_CAPS : parseJson(rootRow?.caps) || [];
  return [...baseCaps, ...CONNECTOR_EXEC_CAPS.filter((c) => root.includes(c) && !baseCaps.includes(c))];
}
