// A2A Agent Card (Phase 1): serve /.well-known/agent.json so the agent world can discover and
// reason about this runtime with zero credentials. The card is GENERATED from the same registry
// that backs /routes and /mcp — never hand-maintained — so it cannot drift from reality.
//
// Pinned to A2A v1.0.1 (vendor/a2a/a2a.v1.0.1.proto is the authority; the doc's "v1.2" does not
// exist — see vendor/a2a/README.md). Field names are the proto3→JSON mapping (lowerCamelCase).
import { SERVICE_NAME, VERSION } from "./config.js";
import { MCP_TOOLS } from "./mcp.js";

export const A2A_VERSION = "1.0.1";
const RIGHTONPAR_URL = "https://rightonpar.com";

// tags derived from the tool name's family, so a stock A2A client can group skills without any
// runtime-specific knowledge. Every skill MUST carry tags (required at v1.0.x).
function skillTags(name) {
  let family = name.includes("_") ? name.slice(0, name.indexOf("_")) : name;
  let tags = [family];
  if (/grant/.test(name)) tags.push("authorization");
  if (/memory/.test(name)) tags.push("memory");
  if (/deploy|worker/.test(name)) tags.push("deploy");
  if (/cog/.test(name)) tags.push("orchestration");
  if (/ledger/.test(name)) tags.push("accounting");
  return [...new Set(tags)];
}

// One skill per real MCP tool — the tool registry IS the capability set. id === the tool name so
// the drift check can match a skill back to a live tool 1:1.
export function skillsFromRegistry(tools = MCP_TOOLS) {
  return tools.map((t) => ({
    id: t.name,
    name: t.name,
    description: t.description || t.name,
    tags: skillTags(t.name),
    examples: [`Call the ${t.name} tool over MCP with a valid grant.`],
  }));
}

// Build the card for a given public base URL (same derivation rule as the welcome package: never
// hard-coded — PUBLIC_URL or the request host). `tools` is injectable for testing.
export function buildAgentCard(baseUrl, { tools = MCP_TOOLS } = {}) {
  let base = String(baseUrl || "").replace(/\/+$/, "");
  return {
    name: SERVICE_NAME,
    description:
      "Grant-based capability control plane for agents: mint attenuated grants, plan and execute " +
      "via the COG, deploy workers, keep tenant memory, and read a verifiable ledger — all over MCP.",
    version: VERSION,
    provider: { url: RIGHTONPAR_URL, organization: "RightOnPar LLC" },
    // Honest capability declaration: A2A streaming/push land in Phase 2/3. Declare false now.
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    // The reachable machine interface today is the MCP endpoint. The A2A task binding
    // (tasks/send over JSON-RPC) is Phase 2 — declaring it now would be lying to the network.
    supportedInterfaces: [
      { url: base + "/mcp", protocolBinding: "MCP", protocolVersion: "2025-06-18" },
    ],
    // Bearer grant is what /mcp enforces; the card lets a stranger reason about how to get in.
    // Discovery itself (/.well-known/*) and the guest bootstrap are keyless — a stranger reads
    // this card, then mints a guest grant, with no prior credential.
    securitySchemes: {
      grantBearer: {
        httpAuthSecurityScheme: {
          scheme: "bearer",
          bearerFormat: "creator-os grant token",
          description: "Signed attenuated grant presented as a Bearer token on /mcp and /api/*.",
        },
      },
    },
    securityRequirements: [{ schemes: { grantBearer: { list: [] } } }],
    skills: skillsFromRegistry(tools),
  };
}

// Validate a card against the pinned v1.0.1 AgentCard contract (vendor/a2a/a2a.v1.0.1.proto).
// Returns [] when valid, else a list of specific violations. This encodes the proto's required
// fields, types, and the proto3→JSON field names — it is derived from the pinned proto, not from
// memory. Kept dependency-free (the runtime ships only hono); a fast-follow can swap in ajv over
// the proto-generated JSON Schema.
export function validateAgentCard(card) {
  let v = [];
  let isStr = (x) => typeof x === "string" && x.length > 0;
  let isStrArr = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");
  if (!card || typeof card !== "object" || Array.isArray(card)) return ["card_not_object"];
  for (let f of ["name", "description", "version"]) if (!isStr(card[f])) v.push(`missing_or_bad:${f}`);
  if (!isStrArr(card.defaultInputModes) || !card.defaultInputModes.length) v.push("missing:defaultInputModes");
  if (!isStrArr(card.defaultOutputModes) || !card.defaultOutputModes.length) v.push("missing:defaultOutputModes");
  let c = card.capabilities;
  if (!c || typeof c !== "object") v.push("missing:capabilities");
  else for (let k of ["streaming", "pushNotifications"]) if (k in c && typeof c[k] !== "boolean") v.push(`bad_type:capabilities.${k}`);
  if (!Array.isArray(card.supportedInterfaces) || !card.supportedInterfaces.length) v.push("missing:supportedInterfaces");
  else
    card.supportedInterfaces.forEach((i, n) => {
      if (!isStr(i?.url)) v.push(`iface[${n}]:missing_url`);
      if (!isStr(i?.protocolBinding)) v.push(`iface[${n}]:missing_protocolBinding`);
      if (!isStr(i?.protocolVersion)) v.push(`iface[${n}]:missing_protocolVersion`);
    });
  if (!Array.isArray(card.skills) || !card.skills.length) v.push("missing:skills");
  else
    card.skills.forEach((s, n) => {
      for (let f of ["id", "name", "description"]) if (!isStr(s?.[f])) v.push(`skill[${n}]:missing_${f}`);
      if (!isStrArr(s?.tags) || !s.tags.length) v.push(`skill[${n}]:missing_tags`); // tags REQUIRED at v1.0.x
    });
  // provider is optional, but if present both fields are required
  if (card.provider !== undefined && (!isStr(card.provider?.url) || !isStr(card.provider?.organization)))
    v.push("bad:provider");
  return v;
}
