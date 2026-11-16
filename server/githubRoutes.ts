// HTTP routes for GitHub sign-in, repository import/indexing, file operations and the change workflow.
import type { Express, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { storage } from "./storage";
import { saveSecret, loadSecret, deleteSecret } from "./secrets";
import { gh, listRepos, listBranches, syncRepo, gitHistory, openPulls, validName, validBranch, GitHubError, WORKSPACE, SECRET } from "./github";
import { buildIndex, selectContext, type RepoIndex } from "./indexer";
import { CHANGE_FORMAT, parseChanges, applyChanges, writeFile, deleteFile, status, commit, push, openPullRequest, discard, currentBranch, safeRel, closePull, reopenPull, mergePull, deleteRemoteBranch, type Workflow } from "./changes";
import { describeAction, type GitAction } from "./intent";
import { forgetLogin } from "./github";

export type RepoLink = { fullName: string; owner: string; name: string; branch: string; dir: string; commit: string; indexedAt: string; fileCount: number; totalBytes: number; skipped: RepoIndex["skipped"];
  workflow?: Workflow;        // project default
  activeWorkflow?: Workflow;  // workflow of the change currently in the working tree
};
const wf = (p: any): Workflow => p.repo.workflow || "pull_request";
const activeWf = (p: any): Workflow => p.repo.activeWorkflow || wf(p);
const markActive = (p: any, w: Workflow) => { p.repo.activeWorkflow = w; storage.update(p.id, p); };

// Run one approved GitHub action from a plan.
export async function runGitAction(project: any, a: GitAction) {
  const r: RepoLink = project.repo;
  switch (a.type) {
    case "close_pr": { const o = await closePull(r.owner, r.name, a.number, a.deleteBranch); return `#${a.number} closed${o.branchDeleted ? `, branch ${o.branch} deleted` : a.deleteBranch ? " (branch kept: it belongs to a fork or was already deleted)" : ""}`; }
    case "reopen_pr": await reopenPull(r.owner, r.name, a.number); return `#${a.number} reopened`;
    case "merge_pr": { const o = await mergePull(r.owner, r.name, a.number, a.method); return o.merged ? `#${a.number} merged (${a.method}, ${String(o.sha).slice(0, 7)})` : `#${a.number} was not merged`; }
    case "delete_branch": await deleteRemoteBranch(r.owner, r.name, a.branch); return `branch ${a.branch} deleted`;
  }
}
export { describeAction };

const guide = (workflow: Workflow) => `REPOSITORY WORK: the project is a real Git repository hosted on GitHub, owned by the user.
${workflow === "direct"
  ? "Workflow for this run: DIRECT. The user asked to work on the repository itself without a pull request. Your change blocks are applied to the checked-out branch, then committed and pushed to it after the user reviews the diff."
  : "Workflow for this run: PULL REQUEST. Your change blocks are applied to a new working branch named after the user; after review the user commits, pushes and opens a pull request."}
- Base every change on the files shown. If you need a file that is not shown, name it instead of guessing its content.
- Keep changes focused on the request. Do not reformat unrelated code, reorder includes/usings or change line endings.
- Follow the conventions visible in the code, .editorconfig, CI workflows (.github/workflows), CODEOWNERS and pull request templates.
- Use the commit history in the context to understand why code is the way it is before changing it.
- Check the open pull requests in the context; if one changes the same files, state the conflict risk.
- Never write secrets, tokens, passwords or machine-specific absolute paths into files.
- Commits and pull requests are published under the user's own GitHub account. Write them in the user's voice; do not mention Relay, AI, agents or a model, and add no signatures or Co-authored-by lines.
- Finish with a proposed commit message (imperative subject up to 72 characters, blank line, body explaining why)${workflow === "direct" ? "" : " and a pull request description (summary, changes, how to test)"}.
- GitHub cannot delete pull requests (only GitHub Support can, e.g. for leaked secrets). "Delete a pull request" means close it and delete its branch.`;
export const CHANGE_ROLES = new Set(["coder", "tester"]);
export const changeInstructions = (role: string, workflow: Workflow) => (CHANGE_ROLES.has(role) ? `${guide(workflow)}\n\n${CHANGE_FORMAT}` : guide(workflow));

const indexFile = (r: RepoLink) => path.join(WORKSPACE, ".relay-index", `${r.owner}__${r.name}.json`);
const repoDir = (r: RepoLink) => path.join(WORKSPACE, r.owner, r.name);

function reindex(project: any) {
  const r: RepoLink = project.repo;
  const idx = buildIndex(repoDir(r));
  fs.mkdirSync(path.dirname(indexFile(r)), { recursive: true });
  fs.writeFileSync(indexFile(r), JSON.stringify(idx));
  Object.assign(r, { indexedAt: idx.builtAt, fileCount: idx.files.length, totalBytes: idx.totalBytes, skipped: idx.skipped });
  storage.update(project.id, project);
  return idx;
}
function loadIndex(project: any): RepoIndex {
  const f = indexFile(project.repo);
  if (!fs.existsSync(f)) return reindex(project);
  const idx = JSON.parse(fs.readFileSync(f, "utf8")) as RepoIndex;
  idx.root = repoDir(project.repo); // the Relay folder may have moved
  return idx;
}

// Context for a run on a GitHub project: repository map, ranked files, git history and open pull requests.
export async function repoContext(project: any, request: string, budget: number) {
  const r: RepoLink = project.repo, dir = repoDir(r);
  if (!fs.existsSync(path.join(dir, ".git"))) throw new GitHubError(`The local copy of ${r.fullName} is missing. Use "Update from GitHub" on the Projects page.`, 409);
  const idx = loadIndex(project);
  const branch = await currentBranch(dir).catch(() => r.branch);
  const header = `REPOSITORY: ${r.fullName} on GitHub. Base branch: ${r.branch}. Checked-out branch: ${branch}. Commit ${r.commit.slice(0, 10)}. ${idx.files.length} indexed files.`;
  const gitBudget = Math.min(Math.floor(budget * 0.1), 12000);
  const sel = selectContext(idx, request, budget - gitBudget, header);
  const hist = await gitHistory(dir, sel.chosen.slice(0, 12)).catch(() => ({ recent: "", byFile: {} as Record<string, string> }));
  let pullsText = "";
  try {
    const pulls = await openPulls(r.owner, r.name);
    pullsText = pulls.length ? pulls.map(p => {
      const overlap = p.files.filter((f: string) => sel.chosen.includes(f));
      return `#${p.number} ${p.title} (${p.head} -> ${p.base}, by ${p.author}${p.draft ? ", draft" : ""}, updated ${String(p.updatedAt).slice(0, 10)})${overlap.length ? ` - ALSO CHANGES: ${overlap.join(", ")}` : ""}`;
    }).join("\n") : "(none)";
  } catch (e: any) { pullsText = `(not available: ${e.message})`; }
  let g = `\n\nGIT HISTORY (hash, date, author, subject)\nRecent commits on ${branch}:\n${hist.recent || "(none)"}\n`;
  for (const f of Object.keys(hist.byFile)) if (hist.byFile[f]) g += `\nLatest commits touching ${f}:\n${hist.byFile[f]}\n`;
  g += `\nOPEN PULL REQUESTS:\n${pullsText}\n`;
  const text = sel.text + g.slice(0, gitBudget);
  const shown = sel.chosen.slice(0, 6).join(", ") + (sel.chosen.length > 6 ? ", ..." : "");
  return { text, files: sel.chosen as string[], note: `Context: ${sel.chosen.length} of ${idx.files.length} files from ${r.fullName} selected (${text.length.toLocaleString("en-US")} characters)${shown ? `: ${shown}` : ""}` };
}

const fail = (res: Response, e: any) => res.status(e instanceof GitHubError ? e.status : 500).json({ message: e.message || "Failed." });
const repoProject = (id: number) => {
  const p = storage.get(id, "project");
  if (!p?.repo) throw new GitHubError("This project is not linked to a GitHub repository.", 404);
  return p;
};

export const applyingRuns = new Set<number>();
export function registerGitHubRoutes(app: Express, busy: () => boolean) {
  const guardIdle = () => { if (busy()) throw new GitHubError("A run is being planned or executed. Wait for it to finish before changing files.", 409); };

  // ---- sign-in
  app.get("/api/github/status", async (_req, res) => {
    let tok: string | null = null;
    try { tok = loadSecret(SECRET); } catch (e: any) { return res.json({ connected: false, error: e.message }); }
    if (!tok) return res.json({ connected: false });
    try { const u = await gh("/user", tok); res.json({ connected: true, login: u.login, name: u.name || "" }); }
    catch (e: any) { res.json({ connected: false, error: e.message }); }
  });
  app.post("/api/github/token", async (req, res) => {
    const tok = String(req.body?.token || "").trim();
    if (!/^[A-Za-z0-9_]{20,255}$/.test(tok)) return res.status(400).json({ message: "That does not look like a GitHub token (github_pat_... or ghp_...)." });
    try { const u = await gh("/user", tok); saveSecret(SECRET, tok); forgetLogin(); res.json({ connected: true, login: u.login, name: u.name || "" }); }
    catch (e) { fail(res, e); }
  });
  app.delete("/api/github/token", (_req, res) => { deleteSecret(SECRET); forgetLogin(); res.json({ connected: false }); });

  // ---- repository picker
  app.get("/api/github/repos", async (_req, res) => { try { res.json(await listRepos()); } catch (e) { fail(res, e); } });
  app.get("/api/github/repos/:owner/:repo/branches", async (req, res) => {
    const { owner, repo } = req.params;
    if (!validName(owner) || !validName(repo)) return res.status(400).json({ message: "Invalid repository name." });
    try { res.json(await listBranches(owner, repo)); } catch (e) { fail(res, e); }
  });

  // ---- import (clone + index) and update
  app.post("/api/github/import", async (req, res) => {
    try {
      guardIdle();
      const [owner, name] = String(req.body?.fullName || "").split("/");
      const branch = String(req.body?.branch || "");
      if (!validName(owner || "") || !validName(name || "") || !validBranch(branch)) throw new GitHubError("Choose a repository and a branch.");
      const { commit: head } = await syncRepo(owner, name, branch);
      const fullName = `${owner}/${name}`;
      let project = storage.list("project").find((p: any) => p.repo?.fullName === fullName);
      const repo: RepoLink = { fullName, owner, name, branch, dir: `${owner}/${name}`, commit: head, indexedAt: "", fileCount: 0, totalBytes: 0, skipped: {} as any };
      if (project) { project.repo = repo; storage.update(project.id, project); }
      else project = storage.create("project", { name, description: String(req.body?.description || "").slice(0, 500), language: String(req.body?.language || "Mixed").slice(0, 50), files: [], repo });
      reindex(project);
      res.status(201).json(storage.get(project.id, "project"));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/projects/:id/sync", async (req, res) => {
    try {
      guardIdle();
      const p = repoProject(Number(req.params.id)), r: RepoLink = p.repo;
      const branch = await currentBranch(repoDir(r)).catch(() => r.branch);
      if (branch !== r.branch) throw new GitHubError(`You are on the working branch ${branch}. Finish it (commit, push, pull request) or discard it before updating.`, 409);
      r.commit = (await syncRepo(r.owner, r.name, r.branch)).commit;
      storage.update(p.id, p); reindex(p);
      res.json(storage.get(p.id, "project"));
    } catch (e) { fail(res, e); }
  });
  app.get("/api/projects/:id/activity", async (req, res) => {
    try {
      const p = repoProject(Number(req.params.id)), r: RepoLink = p.repo;
      const hist = await gitHistory(repoDir(r), []);
      const pulls = await openPulls(r.owner, r.name).catch((e: any) => ({ error: e.message }));
      res.json({ commits: hist.recent.split("\n").filter(Boolean), pulls });
    } catch (e) { fail(res, e); }
  });

  // ---- files
  app.get("/api/projects/:id/files", (req, res) => {
    try { const p = repoProject(Number(req.params.id)); const idx = loadIndex(p); res.json({ files: idx.files.map(f => ({ path: f.p, size: f.size, lines: f.lines, lang: f.lang })), skipped: idx.skipped }); }
    catch (e) { fail(res, e); }
  });
  app.get("/api/projects/:id/file", (req, res) => {
    try {
      const p = repoProject(Number(req.params.id)); const { rel, full } = safeRel(repoDir(p.repo), String(req.query.path || ""));
      if (!fs.existsSync(full)) throw new GitHubError(`${rel} does not exist.`, 404);
      const buf = fs.readFileSync(full);
      if (buf.length > 2_000_000 || buf.subarray(0, 8192).includes(0)) return res.json({ path: rel, binary: true, size: buf.length });
      res.json({ path: rel, content: buf.toString("utf8"), size: buf.length });
    } catch (e) { fail(res, e); }
  });
  app.put("/api/projects/:id/file", async (req, res) => {
    try {
      guardIdle();
      const p = repoProject(Number(req.params.id));
      if (typeof req.body?.content !== "string") throw new GitHubError("Missing file content.");
      const out = await writeFile(repoDir(p.repo), p.repo.branch, String(req.body.path || ""), Buffer.from(req.body.content, "utf8"), `edit ${req.body.path}`, activeWf(p));
      markActive(p, activeWf(p)); reindex(p); res.json(out);
    } catch (e) { fail(res, e); }
  });
  app.delete("/api/projects/:id/file", async (req, res) => {
    try { guardIdle(); const p = repoProject(Number(req.params.id)); const out = await deleteFile(repoDir(p.repo), p.repo.branch, String(req.query.path || ""), activeWf(p)); markActive(p, activeWf(p)); reindex(p); res.json(out); }
    catch (e) { fail(res, e); }
  });
  app.post("/api/projects/:id/upload", async (req, res) => {
    try {
      guardIdle();
      const p = repoProject(Number(req.params.id));
      const folder = String(req.body?.folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const files = Array.isArray(req.body?.files) ? req.body.files : [];
      if (!files.length || files.length > 200) throw new GitHubError("Choose between 1 and 200 files.");
      const written: string[] = [];
      for (const f of files) {
        const name = String(f.name || "").replace(/\\/g, "/");
        const data = Buffer.from(String(f.base64 || ""), "base64");
        if (data.length > 25_000_000) throw new GitHubError(`${name} is larger than 25 MB; GitHub rejects files over 100 MB and warns above 50 MB.`);
        written.push((await writeFile(repoDir(p.repo), p.repo.branch, folder ? `${folder}/${name}` : name, data, `upload ${name}`, activeWf(p))).path);
      }
      markActive(p, activeWf(p)); reindex(p);
      res.json({ branch: await currentBranch(repoDir(p.repo)), written });
    } catch (e) { fail(res, e); }
  });

  // ---- change workflow
  app.post("/api/runs/:id/apply", async (req, res) => {
    const id = Number(req.params.id);
    if (applyingRuns.has(id)) return res.status(409).json({ message: "Changes are already being applied for this conversation." });
    applyingRuns.add(id);
    try {
      guardIdle();
      const run = storage.get(Number(req.params.id), "run");
      if (!run) throw new GitHubError("Run not found.", 404);
      if (run.status !== "complete") throw new GitHubError("Apply changes after the run completes.", 409);
      const p = repoProject(run.projectId);
      const text = run.steps.filter((s: any) => CHANGE_ROLES.has(s.role) && s.output).map((s: any) => s.output).join("\n\n");
      const { changes, problems } = parseChanges(text);
      if (!changes.length) throw new GitHubError(`No change blocks found in the Developer or Test engineer output.${problems.length ? " " + problems.join(" ") : ""}`, 422);
      const workflow: Workflow = run.workflow || wf(p);
      const out = await applyChanges(repoDir(p.repo), p.repo.branch, changes, run.request, workflow);
      markActive(p, workflow);
      run.applied = { ...out, problems, at: new Date().toISOString() };
      run.events.push({ time: new Date().toISOString(), message: `Applied ${out.applied.length} change(s) to branch ${out.branch}${out.failed.length ? `; ${out.failed.length} failed` : ""}` });
      storage.update(run.id, run); reindex(p);
      res.json(run.applied);
    } catch (e) { fail(res, e); }
    finally { applyingRuns.delete(id); }
  });
  app.get("/api/projects/:id/changes", async (req, res) => {
    try { const p = repoProject(Number(req.params.id)); res.json(await status(repoDir(p.repo), p.repo.branch)); } catch (e) { fail(res, e); }
  });
  app.post("/api/projects/:id/commit", async (req, res) => {
    try {
      guardIdle();
      const message = String(req.body?.message || "").trim();
      if (message.length < 3 || message.length > 5000) throw new GitHubError("Write a commit message (3-5000 characters).");
      const p = repoProject(Number(req.params.id)); const out = await commit(repoDir(p.repo), p.repo.branch, message, activeWf(p)); res.json(out);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/projects/:id/push", async (req, res) => {
    try {
      guardIdle(); const p = repoProject(Number(req.params.id));
      const out = await push(repoDir(p.repo), p.repo.branch, activeWf(p));
      if (out.branch === p.repo.branch) { delete p.repo.activeWorkflow; storage.update(p.id, p); reindex(p); } // direct work is finished once pushed
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/projects/:id/pull-request", async (req, res) => {
    try {
      const p = repoProject(Number(req.params.id)), r: RepoLink = p.repo;
      const title = String(req.body?.title || "").trim();
      if (title.length < 3 || title.length > 250) throw new GitHubError("Write a pull request title (3-250 characters).");
      res.json(await openPullRequest(r.owner, r.name, repoDir(r), r.branch, title, String(req.body?.body || "").slice(0, 60000), !!req.body?.draft));
    } catch (e) { fail(res, e); }
  });
  app.patch("/api/projects/:id/workflow", (req, res) => {
    try {
      const p = repoProject(Number(req.params.id)); const w = req.body?.workflow;
      if (w !== "direct" && w !== "pull_request") throw new GitHubError('Workflow must be "direct" or "pull_request".');
      p.repo.workflow = w; storage.update(p.id, p); res.json(p);
    } catch (e) { fail(res, e); }
  });
  const prAction = (route: string, make: (req: any) => GitAction) => app.post(route, async (req, res) => {
    try { const p = repoProject(Number(req.params.id)); res.json({ message: await runGitAction(p, make(req)) }); } catch (e) { fail(res, e); }
  });
  prAction("/api/projects/:id/pulls/:n/close", req => ({ type: "close_pr", number: Number(req.params.n), deleteBranch: !!req.body?.deleteBranch }));
  prAction("/api/projects/:id/pulls/:n/reopen", req => ({ type: "reopen_pr", number: Number(req.params.n) }));
  prAction("/api/projects/:id/pulls/:n/merge", req => ({ type: "merge_pr", number: Number(req.params.n), method: ["squash", "rebase"].includes(req.body?.method) ? req.body.method : "merge" }));
  app.post("/api/projects/:id/discard", async (req, res) => {
    try { guardIdle(); const p = repoProject(Number(req.params.id)); const out = await discard(repoDir(p.repo), p.repo.branch); delete p.repo.activeWorkflow; storage.update(p.id, p); reindex(p); res.json(out); } catch (e) { fail(res, e); }
  });
}
