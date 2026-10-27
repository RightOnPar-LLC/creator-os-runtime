// GitHub webhook payload -> one compact receipt (the `data` of a repo.<event> events row).
//
// Pure: no I/O, so it is testable without a database. The receipt answers "what happened, where,
// by whom, with what result" and links back to GitHub for the rest. It never copies a body:
// comment, review and PR text stay on GitHub (it can hold anything someone pasted), and only
// short titles and a commit's first line come along, each capped.
//
// Returns null for an event that should not become a receipt: per-check noise (a check_run that
// passed is already summarised by its check_suite / workflow_run), and runs still in progress.

var cap = (s, n) => (s == null ? null : String(s).slice(0, n));
var who = (u) => (u && u.login ? cap(u.login, 64) : null);
var FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export function githubReceipt(event, p) {
  p = p && typeof p === "object" ? p : {};
  let base = { repo: cap(p.repository?.full_name, 140), action: cap(p.action, 40), actor: who(p.sender) };
  switch (event) {
    case "push": {
      let head = p.head_commit;
      return {
        ...base,
        ref: cap(p.ref, 200),
        before: cap(p.before, 40),
        after: cap(p.after, 40),
        commits: Array.isArray(p.commits) ? p.commits.length : null,
        forced: !!p.forced,
        head: head ? cap(String(head.message || "").split("\n")[0], 120) : null,
        author: cap(head?.author?.email, 120),
        url: cap(p.compare, 300),
      };
    }
    case "pull_request": {
      let pr = p.pull_request || {};
      return {
        ...base,
        number: pr.number ?? p.number ?? null,
        title: cap(pr.title, 200),
        state: cap(pr.state, 20),
        merged: !!pr.merged,
        draft: !!pr.draft,
        author: who(pr.user),
        base: cap(pr.base?.ref, 200),
        head: cap(pr.head?.ref, 200),
        sha: cap(pr.head?.sha, 40),
        url: cap(pr.html_url, 300),
      };
    }
    case "pull_request_review":
      return {
        ...base,
        number: p.pull_request?.number ?? null,
        state: cap(p.review?.state, 30),
        author: who(p.review?.user),
        url: cap(p.review?.html_url, 300),
      };
    case "pull_request_review_comment":
    case "issue_comment":
      return {
        ...base,
        number: p.pull_request?.number ?? p.issue?.number ?? null,
        on: p.issue?.pull_request || p.pull_request ? "pull_request" : "issue",
        author: who(p.comment?.user),
        chars: typeof p.comment?.body === "string" ? p.comment.body.length : null,
        url: cap(p.comment?.html_url, 300),
      };
    case "issues":
      return {
        ...base,
        number: p.issue?.number ?? null,
        title: cap(p.issue?.title, 200),
        state: cap(p.issue?.state, 20),
        author: who(p.issue?.user),
        url: cap(p.issue?.html_url, 300),
      };
    case "check_suite":
    case "workflow_run": {
      let run = event === "workflow_run" ? p.workflow_run : p.check_suite;
      if (!run || p.action !== "completed") return null;
      return {
        ...base,
        name: cap(event === "workflow_run" ? run.name : run.app?.name, 120),
        conclusion: cap(run.conclusion, 30),
        sha: cap(run.head_sha, 40),
        branch: cap(run.head_branch, 200),
        prs: (run.pull_requests || []).map((x) => x.number).filter((n) => n != null).slice(0, 10),
        url: cap(run.html_url, 300),
      };
    }
    case "check_run": {
      let run = p.check_run;
      // One push fans out into dozens of check runs; only a failed one is worth its own receipt.
      if (!run || p.action !== "completed" || !FAILED.has(run.conclusion)) return null;
      return {
        ...base,
        name: cap(run.name, 120),
        conclusion: cap(run.conclusion, 30),
        sha: cap(run.head_sha, 40),
        prs: (run.pull_requests || []).map((x) => x.number).filter((n) => n != null).slice(0, 10),
        url: cap(run.html_url, 300),
      };
    }
    case "release":
      return {
        ...base,
        tag: cap(p.release?.tag_name, 100),
        name: cap(p.release?.name, 200),
        url: cap(p.release?.html_url, 300),
      };
    case "create":
    case "delete":
      return { ...base, ref: cap(p.ref, 200), ref_type: cap(p.ref_type, 20) };
    default:
      // Unknown or minor events still leave a trace: what, where, who.
      return { ...base, ref: cap(p.ref, 200), after: cap(p.after, 40) };
  }
}
