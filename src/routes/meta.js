// Routes: /routes inventory and /selftest. Registration order is significant.
import { SERVICE_NAME } from "../config.js";
import { hmacSha256, nowSec } from "../util.js";
import { parseGrantToken, signGrantToken, vaultDecrypt, vaultEncrypt, vaultKey } from "../tokens.js";
import { attenuationViolations, gatehouseEvaluate, zeroUsage } from "../policy.js";
import { verifyTimestampedSignature } from "../webhooks.js";
import { app, routeInventory } from "../http.js";
import { MCP_TOOLS } from "../mcp.js";
import { buildAgentCard, validateAgentCard } from "../a2a.js";
import { buildEscrow } from "../escrow.js";

app.get("/routes", (e) => {
  let t = routeInventory();
  return e.json({
    routes: t,
    count: t.length,
  });
});
app.get("/selftest", async (e) => {
  let t = [],
    a = (i, o) => {
      try {
        let l = o();
        t.push({
          name: i,
          pass: l === !0,
          info: l === !0 ? void 0 : l,
        });
      } catch (l) {
        t.push({
          name: i,
          pass: !1,
          info: String(l?.message || l),
        });
      }
    },
    n = {
      id: "gr_p",
      tenant: "t_x",
      status: "active",
      depth: 0,
      exp: nowSec() + 3600,
      caps: ["deploy.worker", "worker.status", "grant.issue"],
      scope: {
        railway: {
          projects: ["p1"],
          environments: ["production"],
        },
        workers: {
          namePrefix: "t-abc-",
        },
      },
      budget: {
        usd_cents: 100,
        calls: 10,
        deploys: 2,
      },
      reserved: zeroUsage(),
      settled: {
        usd_cents: 40,
        calls: 1,
        deploys: 1,
      },
      constraints: {
        maxWorkers: 2,
        maxReplicas: 1,
        allowDelete: !1,
        requireDryRun: !0,
      },
    },
    r = {
      caps: ["deploy.worker"],
      scope: {
        railway: {
          projects: ["p1"],
          environments: ["production"],
        },
        workers: {
          namePrefix: "t-abc-x-",
        },
      },
      budget: {
        usd_cents: 60,
        calls: 5,
        deploys: 1,
      },
      exp: nowSec() + 600,
      constraints: {
        maxWorkers: 1,
        maxReplicas: 1,
        allowDelete: !1,
        requireDryRun: !0,
      },
      depth: 1,
    };
  (a("sign/verify roundtrip", () => {
    let i = JSON.stringify({
      v: 1,
      iss: SERVICE_NAME,
      id: "x",
    });
    return parseGrantToken(signGrantToken(i))?.payload?.id === "x";
  }),
    a("tampered token rejected", () => {
      let i = signGrantToken(
          JSON.stringify({
            v: 1,
            iss: SERVICE_NAME,
            id: "x",
          }),
        ),
        [o, l, c] = i.split("."),
        E = `${o}.${Buffer.from(
          JSON.stringify({
            v: 1,
            iss: SERVICE_NAME,
            id: "y",
          }),
        ).toString("base64url")}.${c}`;
      return parseGrantToken(E) === null;
    }),
    a("attenuation ok child accepted", () => {
      let i = attenuationViolations(n, r, "starter");
      return i.length === 0 || i;
    }),
    a("cap widening rejected", () =>
      attenuationViolations(
        n,
        {
          ...r,
          caps: ["worker.delete"],
        },
        "starter",
      ).includes("cap_not_in_parent:worker.delete"),
    ),
    a("unknown cap rejected", () =>
      attenuationViolations(
        n,
        {
          ...r,
          caps: ["money.send"],
        },
        "starter",
      ).includes("unknown_cap:money.send"),
    ),
    a("budget over parent remaining rejected", () =>
      attenuationViolations(
        n,
        {
          ...r,
          budget: {
            usd_cents: 61,
            calls: 1,
            deploys: 1,
          },
        },
        "starter",
      ).includes("budget_exceeds_parent_remaining"),
    ),
    a("allowDelete widening rejected", () =>
      attenuationViolations(
        n,
        {
          ...r,
          constraints: {
            ...r.constraints,
            allowDelete: !0,
          },
        },
        "starter",
      ).includes("allowDelete_widened"),
    ),
    a("policy fail-closed on garbage", () =>
      attenuationViolations(null, r, "starter").includes("policy_evaluation_error"),
    ),
    a("gatehouse denies malformed proposal", () => {
      let i = gatehouseEvaluate(
        {
          id: "t_abcdef",
          tier: "starter",
          status: "active",
          allowed_targets: {},
        },
        null,
        {
          nope: 1,
        },
      );
      return !i.ok && i.reasons.includes("malformed_proposal");
    }),
    a("gatehouse denies forbidden cap family", () => {
      let i = gatehouseEvaluate(
        {
          id: "t_abcdef",
          tier: "starter",
          status: "active",
          allowed_targets: {},
        },
        null,
        {
          grants: [
            {
              caps: ["wallet.spend"],
              ttlSec: 10,
              budget: {},
            },
          ],
          deploys: [],
        },
      );
      return !i.ok && i.reasons.includes("forbidden_cap_family");
    }),
    a("stripe signature verifies", () => {
      let i = nowSec(),
        o = `t=${i},v1=${hmacSha256("whsec_test", `${i}.{"id":"evt_1"}`)}`;
      return (
        verifyTimestampedSignature('{"id":"evt_1"}', o, "whsec_test") &&
        !verifyTimestampedSignature('{"id":"evt_1"} ', o, "whsec_test") &&
        !verifyTimestampedSignature(
          '{"id":"evt_1"}',
          `t=${i - 1000},v1=${hmacSha256("whsec_test", `${i - 1000}.{"id":"evt_1"}`)}`,
          "whsec_test",
        )
      );
    }),
    a("vault seal/open roundtrip (when armed)", () => {
      if (!vaultKey()) return "skipped:unarmed";
      let i = vaultEncrypt("secret");
      return vaultDecrypt(i) === "secret";
    }),
    a("route inventory derives from app (\u226545 routes, all tagged)", () => {
      let i = routeInventory();
      return (
        (i.length >= 45 && i.every((o) => !!o.auth)) || {
          count: i.length,
        }
      );
    }),
    a("A2A agent card validates against the pinned v1.0.1 contract", () => {
      let v = validateAgentCard(buildAgentCard("https://selftest.local"));
      return v.length === 0 || v;
    }),
    a("A2A card skills match the MCP tool registry (no drift)", () => {
      let ids = buildAgentCard("https://selftest.local").skills.map((s) => s.id).sort(),
        tools = MCP_TOOLS.map((t) => t.name).sort();
      return JSON.stringify(ids) === JSON.stringify(tools) || { ids, tools };
    }),
    a("A2A card interface path is a live route", () => {
      let iface = buildAgentCard("https://selftest.local").supportedInterfaces[0].url,
        path = new URL(iface).pathname,
        inv = routeInventory();
      return inv.some((o) => o.path === path) || { path };
    }),
    a(
      "memory scope widening rejected",
      () =>
        attenuationViolations(
          {
            ...n,
            scope: {
              ...n.scope,
              memory: {
                partitions: ["worker:a"],
              },
            },
          },
          {
            ...r,
            scope: {
              ...r.scope,
              memory: {
                partitions: ["worker:"],
              },
            },
          },
          "starter",
        ).includes("scope_memory_widened") &&
        attenuationViolations(
          {
            ...n,
            scope: {
              ...n.scope,
              memory: {
                partitions: ["worker:a"],
              },
            },
          },
          {
            ...r,
            scope: {
              ...r.scope,
              memory: {
                partitions: ["worker:a-1"],
              },
            },
          },
          "starter",
        ).length === 0,
    ),
    // No request can reach this (grants.exp is BIGINT NOT NULL), so it is proven here: a payer
    // key whose end cannot be read must refuse the hold, never wave it through.
    a("payment hold refused when the payer key's end cannot be read", () => {
      let ask = { amount: 1, payee_tenant: "t_y", condition: { kind: "receipt:mesh" }, ttlSec: 600 },
        refusal = (row) => {
          try {
            return (buildEscrow(row, ask, "starter"), null);
          } catch (err) {
            return err?.code || String(err?.message || err);
          }
        },
        readable = refusal(n),
        unreadable = refusal({ ...n, exp: void 0 });
      return (readable === null && unreadable === "escrow_deadline_exceeds_payer_key") || { readable, unreadable };
    }));
  let s = t.every((i) => i.pass || String(i.info || "").startsWith("skipped"));
  return e.json(
    {
      pass: s,
      count: t.length,
      results: t,
    },
    s ? 200 : 500,
  );
});
