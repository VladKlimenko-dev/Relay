// Changing repositories: agent change blocks, manual file edits/uploads/deletes, and the git workflow
// (working branch -> review diff -> commit -> push -> pull request). Nothing reaches GitHub without an explicit request.
import fs from "node:fs";
import path from "node:path";
import { git, gh, token, currentLogin, GitHubError } from "./github";

// ---------------------------------------------------------------- paths
// Repository-relative path, normalized to "/", that cannot escape the repository or touch .git.
export function safeRel(dir: string, rel: string) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) throw new GitHubError(`Invalid path "${rel}": use a path relative to the repository root.`);
  const parts = clean.split("/");
  if (parts.some(p => p === ".." || p === "" || p === ".")) throw new GitHubError(`Invalid path "${rel}".`);
  if (parts.some(p => p.toLowerCase() === ".git")) throw new GitHubError(`Paths inside .git cannot be changed.`);
  if (/[<>:"|?*\x00-\x1f]/.test(clean)) throw new GitHubError(`Path "${rel}" contains characters Windows does not allow.`);
  const full = path.resolve(dir, ...parts);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new GitHubError(`Invalid path "${rel}".`);
  return { rel: parts.join("/"), full };
}

// ---------------------------------------------------------------- change blocks written by agents
export type Change =
  | { op: "write"; path: string; content: string }
  | { op: "edit"; path: string; edits: { search: string; replace: string }[] }
  | { op: "delete"; path: string }
  | { op: "rename"; path: string; to: string };

export const CHANGE_FORMAT = `When you change repository files, write each change in exactly one of these forms (paths relative to the repository root):

FILE: path/to/new_or_rewritten_file.ext
\`\`\`language
<complete file content>
\`\`\`

EDIT: path/to/existing_file.ext
<<<<<<< SEARCH
<exact lines copied from the current file, enough to be unique>
=======
<replacement lines>
>>>>>>> REPLACE
(repeat SEARCH/REPLACE blocks for more edits in the same file; keep each block small)

DELETE: path/to/file.ext
RENAME: old/path.ext -> new/path.ext

Use EDIT for small changes to existing files and FILE for new files or full rewrites. SEARCH text must match the current file exactly, including indentation.`;

const DIRECTIVE = /^\s*(?:#{1,6}\s*|\*\*|`)?(FILE|EDIT|DELETE|RENAME)\s*:\s*`?(.+?)`?\s*(?:\*\*)?\s*$/;

export function parseChanges(text: string): { changes: Change[]; problems: string[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const changes: Change[] = [], problems: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DIRECTIVE);
    if (!m) continue;
    const kind = m[1], arg = m[2].trim();
    if (kind === "DELETE") { changes.push({ op: "delete", path: arg }); continue; }
    if (kind === "RENAME") {
      const [from, to] = arg.split(/\s*->\s*/);
      if (from && to) changes.push({ op: "rename", path: from, to }); else problems.push(`RENAME needs "old -> new": ${arg}`);
      continue;
    }
    if (kind === "FILE") {
      let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
      const open = lines[j]?.match(/^\s*(`{3,}|~{3,})/);
      if (!open) { problems.push(`FILE ${arg}: no code block follows.`); continue; }
      const fenceMark = open[1];
      const body: string[] = []; let k = j + 1;
      while (k < lines.length && lines[k].trim() !== fenceMark) body.push(lines[k++]);
      if (k >= lines.length) { problems.push(`FILE ${arg}: code block is not closed.`); continue; }
      changes.push({ op: "write", path: arg, content: body.join("\n") + "\n" });
      i = k; continue;
    }
    // EDIT: SEARCH/REPLACE blocks until the next directive
    const edits: { search: string; replace: string }[] = [];
    let k = i + 1;
    while (k < lines.length && !DIRECTIVE.test(lines[k])) {
      if (/^\s*<{5,}\s*SEARCH\s*$/.test(lines[k])) {
        const search: string[] = [], replace: string[] = []; let target = search; k++;
        while (k < lines.length && !/^\s*>{5,}\s*REPLACE\s*$/.test(lines[k])) {
          if (/^\s*={5,}\s*$/.test(lines[k]) && target === search) target = replace; else target.push(lines[k]);
          k++;
        }
        if (k >= lines.length) { problems.push(`EDIT ${arg}: a SEARCH block has no REPLACE end marker.`); break; }
        edits.push({ search: search.join("\n"), replace: replace.join("\n") });
      }
      k++;
    }
    if (edits.length) changes.push({ op: "edit", path: arg, edits }); else problems.push(`EDIT ${arg}: no SEARCH/REPLACE blocks found.`);
    i = k - 1;
  }
  return { changes, problems };
}

// Apply one search/replace to LF text: exact first, then ignoring trailing whitespace on each line.
function replaceOnce(text: string, search: string, replace: string): string | null {
  if (search === "") return null;
  const at = text.indexOf(search);
  if (at >= 0) return text.indexOf(search, at + 1) >= 0 ? null : text.slice(0, at) + replace + text.slice(at + search.length);
  const fileLines = text.split("\n"), want = search.split("\n").map(l => l.trimEnd());
  const matches: number[] = [];
  for (let s = 0; s + want.length <= fileLines.length; s++) if (want.every((w, n) => fileLines[s + n].trimEnd() === w)) matches.push(s);
  if (matches.length !== 1) return null;
  fileLines.splice(matches[0], want.length, ...replace.split("\n"));
  return fileLines.join("\n");
}

// ---------------------------------------------------------------- working branch
export async function currentBranch(dir: string) { return git(["rev-parse", "--abbrev-ref", "HEAD"], dir, token()); }

// Workflow "pull_request" (default): changes go to a new branch <login>/<date>-<topic> and reach the base branch only through a PR.
// Workflow "direct": changes stay on the checked-out branch (normally the base branch) and are pushed there.
export type Workflow = "pull_request" | "direct";
export async function ensureWorkBranch(dir: string, base: string, hint: string, workflow: Workflow = "pull_request") {
  const tok = token();
  const current = await currentBranch(dir);
  if (current !== base || workflow === "direct") return current;
  const slug = hint.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "change";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  // Branch named after the user (e.g. klim/20261115-add-export) so the work reads as theirs on GitHub.
  const who = (await currentLogin().catch(() => "work")).toLowerCase().replace(/[^a-z0-9-]/g, "") || "work";
  const name = `${who}/${stamp}-${slug}`;
  await git(["checkout", "-b", name], dir, tok);
  return name;
}

const eolOf = (s: string) => (s.includes("\r\n") ? "\r\n" : "\n");

export async function applyChanges(dir: string, base: string, changes: Change[], hint: string, workflow: Workflow = "pull_request") {
  const branch = await ensureWorkBranch(dir, base, hint, workflow);
  const applied: string[] = [], failed: string[] = [];
  for (const c of changes) {
    try {
      const { rel, full } = safeRel(dir, c.path);
      if (c.op === "write") {
        const existed = fs.existsSync(full), eol = existed ? eolOf(fs.readFileSync(full, "utf8")) : "\n";
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, eol === "\r\n" ? c.content.replace(/\n/g, "\r\n") : c.content);
        applied.push(`${existed ? "rewrote" : "created"} ${rel}`);
      } else if (c.op === "edit") {
        if (!fs.existsSync(full)) { failed.push(`EDIT ${rel}: file does not exist`); continue; }
        const raw = fs.readFileSync(full, "utf8"), eol = eolOf(raw);
        let text = raw.replace(/\r\n/g, "\n"); const bad: number[] = [];
        c.edits.forEach((e, n) => { const next = replaceOnce(text, e.search.replace(/\r\n/g, "\n"), e.replace.replace(/\r\n/g, "\n")); if (next === null) bad.push(n + 1); else text = next; });
        if (bad.length) { failed.push(`EDIT ${rel}: SEARCH block ${bad.join(", ")} not found exactly once; file left unchanged`); continue; }
        fs.writeFileSync(full, eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
        applied.push(`edited ${rel} (${c.edits.length} block${c.edits.length > 1 ? "s" : ""})`);
      } else if (c.op === "delete") {
        if (!fs.existsSync(full)) { failed.push(`DELETE ${rel}: file does not exist`); continue; }
        fs.rmSync(full); applied.push(`deleted ${rel}`);
      } else {
        const to = safeRel(dir, c.to);
        if (!fs.existsSync(full)) { failed.push(`RENAME ${rel}: file does not exist`); continue; }
        fs.mkdirSync(path.dirname(to.full), { recursive: true });
        fs.renameSync(full, to.full); applied.push(`renamed ${rel} -> ${to.rel}`);
      }
    } catch (e: any) { failed.push(`${c.op.toUpperCase()} ${c.path}: ${e.message}`); }
  }
  return { branch, applied, failed };
}

// ---------------------------------------------------------------- manual file operations
export async function writeFile(dir: string, base: string, rel: string, data: Buffer, hint: string, workflow: Workflow = "pull_request") {
  const branch = await ensureWorkBranch(dir, base, hint, workflow);
  const p = safeRel(dir, rel);
  fs.mkdirSync(path.dirname(p.full), { recursive: true });
  fs.writeFileSync(p.full, data);
  return { branch, path: p.rel };
}
export async function deleteFile(dir: string, base: string, rel: string, workflow: Workflow = "pull_request") {
  const branch = await ensureWorkBranch(dir, base, "delete", workflow);
  const p = safeRel(dir, rel);
  if (!fs.existsSync(p.full)) throw new GitHubError(`${p.rel} does not exist.`, 404);
  fs.rmSync(p.full);
  return { branch, path: p.rel };
}

// ---------------------------------------------------------------- status, diff, commit, push, pull request
export async function status(dir: string, base: string) {
  const tok = token();
  const branch = await currentBranch(dir);
  await git(["add", "-A"], dir, tok); // stage everything so new files appear in the diff; nothing is committed
  const baseRef = `origin/${base}`;
  const porcelain = await git(["status", "--porcelain"], dir, tok);
  const files = porcelain.split("\n").filter(Boolean).map(l => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  const commits = branch === base ? "" : await git(["log", "--date=short", "--format=%h%x09%ad%x09%an%x09%s", `${baseRef}..HEAD`], dir, tok).catch(() => "");
  const stat = await git(["diff", "--cached", "--stat", baseRef], dir, tok).catch(() => "");
  let diff = await git(["diff", "--cached", "--find-renames", baseRef], dir, tok).catch(() => "");
  const truncated = diff.length > 400_000; if (truncated) diff = diff.slice(0, 400_000);
  const upstream = await git(["rev-parse", "--abbrev-ref", "@{u}"], dir, tok).catch(() => "");
  const unpushed = upstream ? Number(await git(["rev-list", "--count", "@{u}..HEAD"], dir, tok).catch(() => "0")) : null;
  return { branch, base, onBase: branch === base, uncommitted: files, commits: commits.split("\n").filter(Boolean), stat, diff, truncated, upstream, unpushed };
}

async function ensureIdentity(dir: string) {
  const tok = token();
  const email = await git(["config", "user.email"], dir, tok).catch(() => "");
  const name = await git(["config", "user.name"], dir, tok).catch(() => "");
  if (email && name) return;
  // No git identity on this PC: use the GitHub account (private noreply address) for this repository only.
  const u = await gh("/user");
  if (!name) await git(["config", "--local", "user.name", u.name || u.login], dir, tok);
  if (!email) await git(["config", "--local", "user.email", `${u.id}+${u.login}@users.noreply.github.com`], dir, tok);
}

export async function commit(dir: string, base: string, message: string, workflow: Workflow = "pull_request") {
  const tok = token();
  const branch = await currentBranch(dir);
  if (branch === base && workflow !== "direct") throw new GitHubError(`Workflow is "pull request": Relay does not commit to the base branch ${base}. Switch the project to "Direct to branch" to commit there.`, 409);
  await git(["add", "-A"], dir, tok);
  const staged = await git(["diff", "--cached", "--name-only"], dir, tok);
  if (!staged) throw new GitHubError("Nothing to commit.", 409);
  await ensureIdentity(dir);
  await git(["commit", "-m", message], dir, tok);
  return { branch, commit: await git(["rev-parse", "--short", "HEAD"], dir, tok) };
}

export async function push(dir: string, base: string, workflow: Workflow = "pull_request") {
  const tok = token();
  const branch = await currentBranch(dir);
  if (branch === base && workflow !== "direct") throw new GitHubError(`Workflow is "pull request": Relay does not push to the base branch ${base}.`, 409);
  const dirty = await git(["status", "--porcelain"], dir, tok);
  if (dirty) throw new GitHubError("There are uncommitted changes. Commit them first.", 409);
  let rebased = false;
  if (branch === base) {
    // Direct work: if someone pushed meanwhile, replay the local commits on top (never force-push).
    await git(["fetch", "origin", base], dir, tok);
    const behind = Number(await git(["rev-list", "--count", `HEAD..origin/${base}`], dir, tok));
    if (behind > 0) {
      try { await git(["rebase", `origin/${base}`], dir, tok); rebased = true; }
      catch { await git(["rebase", "--abort"], dir, tok).catch(() => {}); throw new GitHubError(`${base} on GitHub has ${behind} new commit(s) that conflict with yours. Resolve the conflict in ${dir} with git, or discard and redo the change.`, 409); }
    }
  }
  try { await git(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], dir, tok); } // never --force
  catch (e: any) {
    if (/protected branch|GH006|required status|review/i.test(e.message)) throw new GitHubError(`GitHub refused the push: ${base} is a protected branch (pull requests or checks required). Use the pull request workflow for this repository.`, 409);
    throw e;
  }
  return { branch, rebased };
}

// ---------------------------------------------------------------- pull request management
// GitHub does not allow deleting pull requests (only GitHub Support can, e.g. for leaked secrets).
// "Delete" therefore means: close it, and optionally delete its head branch.
export async function closePull(owner: string, repo: string, n: number, deleteBranch: boolean) {
  const pr = await gh(`/repos/${owner}/${repo}/pulls/${n}`);
  if (pr.state === "closed") { if (!deleteBranch) return { number: n, state: pr.merged_at ? "merged" : "closed", note: "already closed" }; }
  else await gh(`/repos/${owner}/${repo}/pulls/${n}`, token(), "PATCH", { state: "closed" });
  let branchDeleted = false;
  if (deleteBranch && pr.head?.repo?.full_name === `${owner}/${repo}`) branchDeleted = (await deleteRemoteBranch(owner, repo, pr.head.ref)).deleted;
  return { number: n, state: "closed", branchDeleted, branch: pr.head?.ref };
}
export async function reopenPull(owner: string, repo: string, n: number) {
  await gh(`/repos/${owner}/${repo}/pulls/${n}`, token(), "PATCH", { state: "open" });
  return { number: n, state: "open" };
}
export async function mergePull(owner: string, repo: string, n: number, method: "merge" | "squash" | "rebase") {
  const r = await gh(`/repos/${owner}/${repo}/pulls/${n}/merge`, token(), "PUT", { merge_method: method });
  return { number: n, merged: !!r.merged, sha: r.sha, method };
}
export async function deleteRemoteBranch(owner: string, repo: string, branch: string) {
  const info = await gh(`/repos/${owner}/${repo}`);
  if (branch === info.default_branch) throw new GitHubError(`Relay will not delete the default branch ${branch}.`, 409);
  await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, token(), "DELETE");
  return { branch, deleted: true };
}

export async function openPullRequest(owner: string, repo: string, dir: string, base: string, title: string, body: string, draft: boolean) {
  const branch = await currentBranch(dir);
  if (branch === base) throw new GitHubError("Pull requests come from a working branch. Make a change first; Relay creates the branch.", 409);
  const pr = await gh(`/repos/${owner}/${repo}/pulls`, token(), "POST", { title, head: branch, base, body, draft });
  return { number: pr.number, url: pr.html_url };
}

// Leave the working branch: back to an updated base branch. The branch is deleted only if it was never pushed.
export async function discard(dir: string, base: string) {
  const tok = token();
  const branch = await currentBranch(dir);
  if (branch === base) {
    // Direct work: drop uncommitted changes and unpushed commits; the branch returns to its state on GitHub.
    await git(["reset", "--hard", `origin/${base}`], dir, tok);
    await git(["clean", "-fd"], dir, tok);
    return { branch: base, deleted: false };
  }
  await git(["reset", "--hard"], dir, tok);
  await git(["clean", "-fd"], dir, tok);
  await git(["checkout", base], dir, tok);
  const pushed = await git(["ls-remote", "--heads", "origin", branch], dir, tok).catch(() => "unknown"); // offline: keep the branch
  if (!pushed) await git(["branch", "-D", branch], dir, tok);
  return { branch: base, deleted: !pushed, left: branch };
}
