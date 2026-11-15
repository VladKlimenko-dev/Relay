// GitHub access: REST API calls with the stored token, and git clone/update into the local workspace.
// The token is passed to git through GIT_CONFIG_* environment variables, so it never lands in .git/config,
// in the remote URL, or on the command line.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadSecret } from "./secrets";

const API = process.env.GITHUB_API || "https://api.github.com";
const GIT_BASE = process.env.GITHUB_GIT_BASE || "https://github.com"; // tests point this at local bare repos
export const WORKSPACE = path.resolve(process.env.RELAY_WORKSPACE || "workspace");
export const SECRET = "github-token";

export const validName = (s: string) => /^[A-Za-z0-9._-]{1,100}$/.test(s) && !s.startsWith(".");
export const validBranch = (s: string) => /^[A-Za-z0-9._\/-]{1,200}$/.test(s) && !s.startsWith("-") && !s.includes("..") && !s.endsWith("/") && !s.endsWith(".lock");

export class GitHubError extends Error { constructor(message: string, public status = 400) { super(message); } }

export function token() {
  const t = loadSecret(SECRET);
  if (!t) throw new GitHubError("GitHub is not connected. Add a token in Settings.", 401);
  return t;
}

export async function gh(pathname: string, tok = token(), method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${API}${pathname}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Relay", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    signal: AbortSignal.timeout(20_000),
  }).catch(e => { throw new GitHubError(`Cannot reach GitHub (${e.cause?.code || e.message}). Check the internet connection.`, 502); });
  if (res.status === 401) throw new GitHubError("GitHub rejected the token (401). It may be wrong, expired or revoked.", 401);
  if (res.status === 403 || res.status === 404) {
    const body = await res.json().catch(() => ({}));
    throw new GitHubError(`GitHub ${res.status}: ${body.message || "no access"}. For a fine-grained token, add this repository with Contents and Pull requests set to "Read and write".`, res.status);
  }
  if (res.status === 422) { const body = await res.json().catch(() => ({})); throw new GitHubError(`GitHub refused: ${[body.message, ...(body.errors || []).map((e: any) => e.message || e.code)].filter(Boolean).join("; ")}`, 422); }
  if (res.status === 405 || res.status === 409) { const body = await res.json().catch(() => ({})); throw new GitHubError(`GitHub refused: ${body.message || res.status}`, 409); }
  if (!res.ok) throw new GitHubError(`GitHub request failed (${res.status}).`, 502);
  return res.status === 204 ? {} : res.json();
}

export async function listRepos() {
  const repos: any[] = [];
  for (let page = 1; page <= 10; page++) { // up to 1000 repositories
    const batch = await gh(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.map(r => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, description: r.description || "", language: r.language || "", updatedAt: r.pushed_at || r.updated_at, sizeKb: r.size }));
}

export async function listBranches(owner: string, repo: string) {
  const out: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/repos/${owner}/${repo}/branches?per_page=100&page=${page}`);
    out.push(...batch.map((b: any) => b.name));
    if (batch.length < 100) break;
  }
  return out;
}

export function git(args: string[], cwd: string, tok: string, timeoutMs = 30 * 60_000): Promise<string> {
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${tok}`).toString("base64")}`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${GIT_BASE}/.extraheader`, GIT_CONFIG_VALUE_0: header,
    GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "" }; // do not ask or store credentials elsewhere
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd, env, windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
    p.on("error", e => { clearTimeout(timer); reject(new GitHubError(e.message.includes("ENOENT") ? "Git is not installed or not on PATH. Run setup.cmd." : e.message, 500)); });
    p.on("close", code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new GitHubError(`git ${args[0]} failed: ${err.replaceAll(tok, "***").trim().slice(-500)}`, 500)); });
  });
}

// Clone the branch (shallow) or update an existing clone. Refuses to overwrite local changes.
export async function syncRepo(owner: string, repo: string, branch: string) {
  const tok = token();
  const dir = path.join(WORKSPACE, owner, repo);
  if (fs.existsSync(path.join(dir, ".git"))) {
    const dirty = await git(["status", "--porcelain"], dir, tok);
    if (dirty) throw new GitHubError(`The local copy in ${dir} has uncommitted changes; Relay will not overwrite them.`, 409);
    await git(["fetch", "origin", branch], dir, tok);
    await git(["checkout", "-B", branch, "FETCH_HEAD"], dir, tok);
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    // Partial clone: full commit history (for log/blame/diff), file contents fetched on demand.
    await git(["clone", "--filter=blob:none", "--branch", branch, "--single-branch", "--", `${GIT_BASE}/${owner}/${repo}.git`, dir], WORKSPACE, tok);
  }
  const commit = await git(["rev-parse", "HEAD"], dir, tok);
  return { dir, commit };
}

const LOG_FORMAT = "--format=%h%x09%ad%x09%an%x09%s";

// Recent commits on the checked-out branch, and the latest commits touching each given file.
export async function gitHistory(dir: string, files: string[], perFile = 3) {
  const tok = loadSecret(SECRET) || "";
  const recent = await git(["log", "-n", "15", "--date=short", LOG_FORMAT], dir, tok).catch(() => "");
  const byFile: Record<string, string> = {};
  for (const f of files) byFile[f] = await git(["log", "-n", String(perFile), "--date=short", LOG_FORMAT, "--", f], dir, tok).catch(() => "");
  return { recent, byFile };
}

// Open pull requests with the files each one changes (first 10 PRs).
export async function openPulls(owner: string, repo: string) {
  const pulls = await gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`);
  const out = [];
  for (const [i, pr] of pulls.entries()) {
    const files = i < 10 ? (await gh(`/repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=100`).catch(() => [])).map((f: any) => f.filename) : [];
    out.push({ number: pr.number, title: pr.title, author: pr.user?.login || "", head: pr.head?.ref || "", base: pr.base?.ref || "", draft: !!pr.draft, updatedAt: pr.updated_at, url: pr.html_url, files });
  }
  return out;
}

let cachedLogin = "";
export async function currentLogin() {
  if (!cachedLogin) cachedLogin = (await gh("/user")).login;
  return cachedLogin;
}
export const forgetLogin = () => { cachedLogin = ""; };
