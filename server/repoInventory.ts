// Read-only GitHub repository inventory: "list all MD files in <repo>" answered from the real Git tree, not by a model.
// Only github.com URLs are recognised; requests always go to the fixed GitHub API base, so a URL in the request can
// never redirect the saved token to another host. Nothing is cloned, linked or written.
import { loadSecret } from "./secrets";
import { validName, validBranch, SECRET } from "./github";

const API = process.env.GITHUB_API || "https://api.github.com";
const MAX_TREE_CALLS = 300;   // fallback walk when GitHub truncates the recursive tree
export const SHOW_LIMIT = 500; // paths shown inline; the full list is always saved as a file

export type InventoryTarget = { owner: string; repo: string; branch?: string; exts: string[]; fromUrl: boolean };
export type Inventory = { fullName: string; url: string; branch: string; defaultBranch: string; commit: string; private: boolean;
  exts: string[]; paths: string[]; totalFiles: number; partial: string[]; submodules: number };

export class InventoryError extends Error { constructor(message: string, public status = 502) { super(message); } }

// github.com/<owner>/<repo>[/tree/<branch>] in plain text, <...> or Markdown link form.
export function parseGitHubUrl(text: string): { owner: string; repo: string; branch?: string } | null {
  const re = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\/tree\/([A-Za-z0-9._\/-]{1,200}))?/gi;
  for (const m of text.matchAll(re)) {
    const before = text[m.index! - 1];
    if (before && /[A-Za-z0-9.-]/.test(before) && !/https?:\/\/$/i.test(text.slice(0, m.index))) continue; // e.g. evilgithub.com
    const owner = m[1], repo = m[2].replace(/\.git$/i, "").replace(/[.]+$/, "");
    const branch = m[3]?.replace(/[.\/]+$/, "");
    if (!validName(owner) || !validName(repo)) continue;
    return { owner, repo, ...(branch && validBranch(branch) ? { branch } : {}) };
  }
  return null;
}

const NOT_EXT = new Set(["all", "the", "of", "source", "code", "these", "those", "project", "repo", "repository", "text", "list", "my", "any",
  "some", "every", "new", "changed", "modified", "important", "relevant", "other", "such", "which", "what", "and", "or", "binary", "large", "test", "tests"]);
const LIST = /\b(list|show|enumerate|find|count|give me|what are|which)\b|перечисл|покажи|список|найди|выведи|какие/i;
export const READ = /\b(read|summari[sz]e|summary|analy[sz]e|analysis|explain|review|describe|overview|study|inspect|go through|tell me about)\b|прочита|прочти|изучи|проанализ|резюм|опиши|объясни|обзор/i;
export const WRITE = /\b(fix|implement|change|refactor|rewrite|write|create|add|delete|remove|update|edit|rename|move|merge|close|commit|push)\b|исправ|измени|удали|добав|создай|перепиши/i;

// Is this a pure "list files" question? Returns the extension filter ([] = all files) or null.
export function inventoryIntent(request: string): string[] | null {
  const text = request.replace(/\[([^\]]*)\]\([^)]*\)/g, " $1 ").replace(/https?:\/\/\S+/g, " ");
  if (!LIST.test(text) || READ.test(text) || WRITE.test(text) || !/\bfiles?\b|файл/i.test(text)) return null;
  const exts = extsOf(text);
  if (!exts.length && !/\ball\s+(the\s+)?files\b|все\s+файл/i.test(text)) return null;
  return exts;
}
export function extsOf(text: string): string[] {
  const exts = new Set<string>();
  const add = (e: string) => { e = e.toLowerCase(); if (e === "markdown") { exts.add("md"); exts.add("markdown"); } else if (!NOT_EXT.has(e)) exts.add(e); };
  for (const m of text.matchAll(/(?:^|[\s(\["'`*,])\.?([A-Za-z0-9+]{1,10})[- ](?:files?\b|файл)/gi)) add(m[1]);
  for (const m of text.matchAll(/\*\.([A-Za-z0-9+]{1,10})\b/g)) add(m[1]);
  for (const m of text.matchAll(/extensions?\s+\.?([A-Za-z0-9+]{1,10})\b/gi)) add(m[1]);
  for (const m of text.matchAll(/(?:^|\s)\.([A-Za-z0-9+]{1,10})\b/g)) add(m[1]);
  return [...exts].sort();
}

export function inventoryTarget(request: string, linked?: { owner: string; name: string; branch: string } | null): InventoryTarget | null {
  const exts = inventoryIntent(request); if (!exts) return null;
  const url = parseGitHubUrl(request);
  if (url) return { ...url, exts, fromUrl: true };
  if (linked) return { owner: linked.owner, repo: linked.name, branch: linked.branch, exts, fromUrl: false };
  return null;
}

function savedToken(): string | null { try { return loadSecret(SECRET); } catch { return null; } }

async function apiCall(path: string, tok: string | null, raw = false, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(20_000);
  const res = await fetch(`${API}${path}`, {
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Relay" },
    redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(e => { if (signal?.aborted) throw new InventoryError("Cancelled.", 499); throw new InventoryError(`Cannot reach GitHub (${e.cause?.code || e.message}). Check the internet connection on the Relay PC.`); });
  const access = tok ? "with the saved GitHub token" : "without a GitHub token (public access only; connect GitHub in Settings for private repositories)";
  if (res.ok) return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  const body = await res.json().catch(() => ({} as any));
  if (res.status === 401) throw new InventoryError("GitHub rejected the saved token (401). It may be wrong, expired or revoked; update it in Settings.", 401);
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    throw new InventoryError(`GitHub rate limit reached ${access}${reset ? `; it resets at ${new Date(reset * 1000).toISOString()}` : ""}.`, 429);
  }
  if (res.status === 403) throw new InventoryError(`GitHub 403: ${body.message || "access denied"} (${access}).`, 403);
  if (res.status === 404) throw new InventoryError(`GitHub 404: the repository or branch was not found, or it is not accessible ${access}. A private repository returns 404 when the token has no access to it.`, 404);
  throw new InventoryError(`GitHub request failed (${res.status}${body.message ? `: ${body.message}` : ""}).`);
}

// One file's bytes at a pinned commit; the path must come from the real tree of that commit.
export async function fetchFile(owner: string, repo: string, path: string, commit: string, signal?: AbortSignal): Promise<Buffer> {
  return apiCall(`/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(commit)}`, savedToken(), true, signal);
}

export async function runInventory(t: InventoryTarget, signal?: AbortSignal): Promise<Inventory> {
  const tok = savedToken();
  const api = (path: string, tok: string | null) => apiCall(path, tok, false, signal);
  const meta = await api(`/repos/${t.owner}/${t.repo}`, tok);
  const branch = t.branch || meta.default_branch;
  if (!validBranch(String(branch || ""))) throw new InventoryError("GitHub did not report a usable default branch for this repository.");
  const head = await api(`/repos/${t.owner}/${t.repo}/branches/${branch.split("/").map(encodeURIComponent).join("/")}`, tok);
  const commit = head.commit.sha, rootTree = head.commit.commit.tree.sha;
  const files: string[] = [], partial: string[] = []; let submodules = 0;
  const collect = (prefix: string, entries: any[]) => { for (const e of entries) {
    const p = prefix + e.path;
    if (e.type === "blob") files.push(p); else if (e.type === "commit") submodules++;
  } };
  const full = await api(`/repos/${t.owner}/${t.repo}/git/trees/${rootTree}?recursive=1`, tok);
  if (!full.truncated) collect("", full.tree);
  else { // GitHub cut the recursive listing: walk directory by directory.
    const queue: { prefix: string; sha: string }[] = [{ prefix: "", sha: rootTree }]; let calls = 0;
    while (queue.length) {
      if (calls >= MAX_TREE_CALLS) { partial.push(`${queue.length} director${queue.length === 1 ? "y was" : "ies were"} not read (limit of ${MAX_TREE_CALLS} tree requests reached)`); break; }
      const { prefix, sha } = queue.shift()!; calls++;
      const level = await api(`/repos/${t.owner}/${t.repo}/git/trees/${sha}`, tok);
      if (level.truncated) partial.push(`GitHub truncated the listing of ${prefix || "the root directory"}`);
      collect(prefix, level.tree);
      for (const e of level.tree) if (e.type === "tree") queue.push({ prefix: `${prefix}${e.path}/`, sha: e.sha });
    }
  }
  const match = (p: string) => !t.exts.length || t.exts.some(e => p.toLowerCase().endsWith(`.${e}`));
  const paths = files.filter(match).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : 1));
  return { fullName: meta.full_name || `${t.owner}/${t.repo}`, url: `https://github.com/${t.owner}/${t.repo}`, branch, defaultBranch: meta.default_branch,
    commit, private: !!meta.private, exts: t.exts, paths, totalFiles: files.length, partial, submodules };
}

const filterLabel = (exts: string[]) => exts.length ? exts.map(e => `*.${e}`).join(", ") + " (case-insensitive)" : "all files";

export function inventoryText(inv: Inventory, savedAs?: string) {
  const shown = inv.paths.slice(0, SHOW_LIMIT);
  const head = [
    "Repository inventory - read by the Relay backend through the GitHub API (read-only). The model did not produce this list.",
    `Repository: [${inv.fullName}](${inv.url})${inv.private ? " (private)" : ""}`,
    `Branch: \`${inv.branch}\`${inv.branch === inv.defaultBranch ? " (default)" : ""} at commit \`${inv.commit.slice(0, 12)}\``,
    `Filter: ${filterLabel(inv.exts)}, all directories recursively.`,
    inv.partial.length ? `PARTIAL RESULT: ${inv.partial.join("; ")}. The count below covers only the directories that were read.` : "Complete listing of the Git tree for this commit.",
    `Matching files: ${inv.paths.length} of ${inv.totalFiles} files in the tree${inv.submodules ? ` (${inv.submodules} submodule(s) not traversed)` : ""}.`,
  ];
  const list = shown.map((p, i) => `${i + 1}. \`${p}\``).join("\n");
  const more = inv.paths.length > shown.length ? `\n\nShowing the first ${shown.length}. ` : "\n\n";
  return `${head.join("\n")}\n\n${list || "No matching files."}${more}${savedAs ? `Full list saved under Activity > Files > Generated as ${savedAs}.` : ""}`.trim();
}

export function inventoryFile(inv: Inventory) {
  return `# ${inv.fullName} @ ${inv.branch} ${inv.commit}\n# filter: ${filterLabel(inv.exts)}; ${inv.paths.length} of ${inv.totalFiles} files${inv.partial.length ? `; PARTIAL: ${inv.partial.join("; ")}` : ""}\n${inv.paths.join("\n")}\n`;
}
