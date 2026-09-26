// 0.3.3: the operator exec toggle. An admin on/off switch (settings key
// "operator_exec", absent = off) that lets the claude.ai connector's operator
// profile additionally carry cog.execute + lsp.diagnose. Imports only db.js so
// both grants.js (enforcement) and oauth.js (issuance) can use it without a cycle.
import { getSetting } from "./db.js";

export var OPERATOR_SUB = "agent:claude-operator";
export var OPERATOR_EXEC_CAPS = ["cog.execute", "lsp.diagnose"];
export var OPERATOR_EXEC_SETTING = "operator_exec";
export async function isOperatorExecOn() {
  return (await getSetting(OPERATOR_EXEC_SETTING)) === "on";
}
