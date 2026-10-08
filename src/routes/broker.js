// Routes: repo broker — scoped GitHub access.
import { HttpError } from "../util.js";
import { app, readJsonBody, requireGrant } from "../http.js";
import { validateRepoScope, performRepoOp } from "../broker.js";

app.post("/api/repos/read", requireGrant("repo.read"), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let repo = String(a?.repo || ""), path = String(a?.path || "");
  if (!repo) throw new HttpError(400, "repo_required");
  return e.json(await performRepoOp(t.row, "read", repo, { path }));
});

app.post("/api/repos/diff", requireGrant("repo.diff"), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let repo = String(a?.repo || ""), ref = String(a?.ref || "HEAD");
  if (!repo) throw new HttpError(400, "repo_required");
  return e.json(await performRepoOp(t.row, "diff", repo, { ref }));
});

app.post("/api/repos/pr", requireGrant("repo.pr"), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let repo = String(a?.repo || ""), title = String(a?.title || ""), body = String(a?.body || "");
  if (!repo) throw new HttpError(400, "repo_required");
  if (!title) throw new HttpError(400, "title_required");
  return e.json(await performRepoOp(t.row, "pr", repo, { title, body }));
});
