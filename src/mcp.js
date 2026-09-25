// MCP tool catalogue and JSON-RPC response helper.

export var MCP_TOOLS = [
  {
    name: "runtime_health",
    description: "Health + armed integrations",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "grant_verify",
    description: "Introspect the presented grant",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "grant_issue",
    description: "Mint an attenuated child grant (needs grant.issue)",
    inputSchema: {
      type: "object",
      properties: {
        sub: {
          type: "string",
        },
        caps: {
          type: "array",
          items: {
            type: "string",
          },
        },
        ttlSec: {
          type: "number",
        },
        budget: {
          type: "object",
        },
        scope: {
          type: "object",
        },
        constraints: {
          type: "object",
        },
      },
      required: ["sub", "caps"],
    },
  },
  {
    name: "grant_list",
    description: "List the presented grant and every grant under it (needs grant.read)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "grant_revoke",
    description: "Revoke a grant in your own subtree, cascading (needs grant.issue)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
        },
        reason: {
          type: "string",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "cog_plan",
    description: "Ask the COG for a proposal from a natural-language intent",
    inputSchema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
        },
        hints: {
          type: "object",
        },
      },
      required: ["intent"],
    },
  },
  {
    name: "cog_execute",
    description: "Proposal \u2192 gatehouse \u2192 grants + deploys (dry-run unless confirm)",
    inputSchema: {
      type: "object",
      properties: {
        proposal: {
          type: "object",
        },
        confirm: {
          type: "boolean",
        },
      },
      required: ["proposal"],
    },
  },
  {
    name: "deploy_worker",
    description: "Direct deploy intent (needs deploy.worker)",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        template: {
          type: "string",
        },
        env: {
          type: "object",
        },
        confirm: {
          type: "boolean",
        },
      },
      required: ["name", "template"],
    },
  },
  {
    name: "deploy_status",
    description: "Status of a deploy (needs worker.status)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ledger_query",
    description: "Tenant ledger tail (needs ledger.read)",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
        },
      },
    },
  },
  {
    name: "memory_search",
    description: "Search tenant memory (needs memory.read)",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
        },
        partition: {
          type: "string",
        },
        limit: {
          type: "number",
        },
      },
    },
  },
  {
    name: "memory_write",
    description: "Remember something (needs memory.write)",
    inputSchema: {
      type: "object",
      properties: {
        partition: {
          type: "string",
        },
        key: {
          type: "string",
        },
        content: {
          type: "string",
        },
        tags: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_forget",
    description: "Tombstone a memory (needs memory.write)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
        },
      },
      required: ["id"],
    },
  },
];
export var jsonRpcResponse = (e, t, a) =>
  a
    ? {
        jsonrpc: "2.0",
        id: e,
        error: a,
      }
    : {
        jsonrpc: "2.0",
        id: e,
        result: t,
      };
