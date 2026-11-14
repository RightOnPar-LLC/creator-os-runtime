// Routes: the public trust engine (src/receipts.js holds the signing). Registration order is significant.
//
//   GET  /.well-known/receipt-keys.json   public Ed25519 key(s) — PUBLIC; fetch once, verify offline forever
//   GET  /api/receipts/:id                one PUBLIC receipt by id (private ones answer 404, same as missing)
//   POST /api/receipts/verify             check a receipt: key, signature, ledger, chain — PUBLIC, rate-limited
//   GET  /verify  and  /verify/:id        the human page: paste a receipt, see each check (also re-checked
//                                         in the browser against the published key, so you need not trust us)
//   POST /api/admin/receipts              issue a receipt — admin-only for now; products call issueReceipt()
//   GET  /api/admin/receipts/audit        walk the whole chain, re-check every signature and link
import { app, readJsonBody, requireAdmin } from "../http.js";
import { publicBaseUrl } from "../oauth.js";
import { HttpError } from "../util.js";
import { recordEvent } from "../db.js";
import { checkNamedRateLimit } from "../grants.js";
import { auditChain, getPublicReceipt, issueReceipt, receiptKeys, verifyReceipt } from "../receipts.js";
import { PAGES, PAGE_HEADERS } from "../ui/pages.js";

var PUBLIC_CORS = { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" };

app.get("/.well-known/receipt-keys.json", (e) => e.json(receiptKeys(), 200, PUBLIC_CORS));

app.get("/api/receipts/:id", async (e) => {
  let r = await getPublicReceipt(e.req.param("id"));
  if (!r) throw new HttpError(404, "receipt_not_found");
  return e.json(r, 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" });
});

app.post("/api/receipts/verify", async (e) => {
  if (!(await checkNamedRateLimit("receipts:verify", 600))) throw new HttpError(429, "rate_limited");
  let b = await readJsonBody(e);
  // Either the whole receipt ({receipt, sig, kid}) or, for a public one, just its id.
  if (typeof b?.id === "string" && !b.receipt) {
    let pub = await getPublicReceipt(b.id);
    if (!pub) throw new HttpError(404, "receipt_not_found", { hint: "paste the whole receipt to check a private one" });
    b = pub;
  }
  let out = await verifyReceipt({ receipt: b?.receipt, sig: b?.sig, kid: b?.kid });
  return e.json(out, 200, { "access-control-allow-origin": "*", "cache-control": "no-store" });
});

app.get("/verify", (e) => e.html(PAGES.verify, 200, PAGE_HEADERS));
app.get("/verify/:id", (e) => e.html(PAGES.verify, 200, PAGE_HEADERS));

app.post("/api/admin/receipts", requireAdmin, async (e) => {
  let b = await readJsonBody(e);
  let out = await issueReceipt({
    kind: b?.kind,
    subject: b?.subject,
    result: b?.result ?? {},
    evidence: b?.evidence ?? [],
    tenant: b?.tenant ?? null,
    grant: b?.grant ?? null,
    isPublic: b?.public === true,
    issuer: publicBaseUrl(e),
  });
  await recordEvent("receipt.issued", { id: out.receipt.id, seq: out.receipt.seq, kind: out.receipt.kind, hash: out.hash }, out.receipt.tenant, "admin");
  return e.json(out, 201);
});

app.get("/api/admin/receipts/audit", requireAdmin, async (e) => e.json(await auditChain()));
