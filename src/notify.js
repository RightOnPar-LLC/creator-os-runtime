// Owner push (0.3.7): when an agent stops at "ask", the plan cheque goes to the owner's phone through ntfy.
// NTFY_URL is the full topic URL (https://ntfy.sh/<unguessable-topic>, or a self-hosted ntfy).
// NTFY_TOKEN is optional (a reserved or protected topic). Unset = no push, nothing else changes.
// The push never blocks or fails the ask: it carries a summary and a link, and signing still needs
// the owner signed in to the cockpit. Header values stay ASCII (ntfy reads them as HTTP headers).
import { env } from "./config.js";
import { recordEvent } from "./db.js";

const ascii = (s, n = 200) => String(s ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, n);
const dollars = (c) => "$" + (Math.max(0, +c || 0) / 100).toFixed(2);

export const ntfyArmed = () => /^https:\/\/[^\s/]+\/[A-Za-z0-9_-]{8,64}$/.test(String(env.NTFY_URL || ""));

export function chequePush({ approval, name, estCents, link, expiresInSec, asker }) {
  const hours = Math.max(1, Math.round((+expiresInSec || 0) / 3600));
  return {
    headers: {
      Title: ascii(`Plan cheque: deploy ${name}`, 120),
      Click: link,
      Actions: `view, Open cheque, ${link}, clear=true`,
      Priority: "high",
      Tags: "receipt",
    },
    body: ascii(`${asker || "An agent"} wants to deploy ${name}. Costs about ${dollars(estCents)}. Valid ${hours}h. Cheque ${approval}.`, 400),
  };
}

export async function pushCheque(cheque, tenantId) {
  if (!ntfyArmed()) return { pushed: false, reason: "unarmed" };
  const { headers, body } = chequePush(cheque);
  if (env.NTFY_TOKEN) headers.Authorization = "Bearer " + env.NTFY_TOKEN;
  let outcome;
  try {
    const r = await fetch(env.NTFY_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
    outcome = r.ok ? { pushed: true } : { pushed: false, reason: "http_" + r.status };
  } catch (x) {
    outcome = { pushed: false, reason: x?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
  await recordEvent(outcome.pushed ? "cheque.pushed" : "cheque.push_failed", { approval: cheque.approval, via: "ntfy", ...outcome }, tenantId, "notify").catch(() => {});
  return outcome;
}
