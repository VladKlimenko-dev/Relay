// GitHub (sign-in, repository picker, repository files, changes, pull requests) and web search settings.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./lib/queryClient";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Check, ExternalLink, FileCode2, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Globe, KeyRound, LoaderCircle, RefreshCw, Save, Search, Trash2, Upload, X } from "lucide-react";
import type { Project, Run } from "@shared/schema";

const json = async (method: string, path: string, data?: unknown) => (await apiRequest(method, path, data)).json();
const invalidate = () => queryClient.invalidateQueries();
const q = (s: string) => encodeURIComponent(s);

function useAction() {
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [note, setNote] = useState("");
  async function act(label: string, fn: () => Promise<any>, done?: (r: any) => string | void) {
    setBusy(label); setError(""); setNote("");
    try { const r = await fn(); const m = done?.(r); if (m) setNote(m); await invalidate(); return r; }
    catch (e: any) { setError(e.message); } finally { setBusy(""); }
  }
  const banners = <>{error && <div role="alert" className="error-banner">{error}</div>}{note && <div role="status" className="success-banner">{note}</div>}</>;
  return { busy, act, banners, setError };
}
const Spin = ({ on, icon }: { on: boolean; icon: any }) => (on ? <LoaderCircle size={15} className="spin"/> : icon);

// ---------- Settings: GitHub account ----------
export function GitHubSettings() {
  const { data: st } = useQuery<{ connected: boolean; login?: string; name?: string; error?: string }>({ queryKey: ["/api/github/status"] });
  const [tokenText, setTokenText] = useState("");
  const { busy, act, banners } = useAction();
  return <section className="settings-section"><div className="settings-section-title"><GitBranch size={19}/><h2>GitHub</h2></div>
    {st?.connected
      ? <div className="connection-row"><div><span className="field-label">SIGNED IN</span><code data-testid="text-github-login">{st.login}{st.name ? ` (${st.name})` : ""}</code></div>
          <button data-testid="button-github-disconnect" className="button secondary" disabled={!!busy} onClick={() => act("out", () => json("DELETE", "/api/github/token"))}><Spin on={busy === "out"} icon={<X size={15}/>}/>Disconnect</button></div>
      : <form className="connection-row" onSubmit={e => { e.preventDefault(); act("in", () => json("POST", "/api/github/token", { token: tokenText.trim() }), () => { setTokenText(""); return "Connected."; }); }}>
          <div className="grow"><label className="field-label" htmlFor="gh-token">PERSONAL ACCESS TOKEN</label><input id="gh-token" data-testid="input-github-token" type="password" autoComplete="off" value={tokenText} onChange={e => setTokenText(e.target.value)} placeholder="github_pat_… or ghp_…"/></div>
          <button data-testid="button-github-connect" className="button primary" disabled={!!busy || tokenText.trim().length < 20}><Spin on={busy === "in"} icon={<KeyRound size={15}/>}/>Connect</button></form>}
    {st?.error && !st.connected && <div className="error-banner">{st.error}</div>}
    {banners}
    <p className="settings-note">Create the token at github.com → Settings → Developer settings → Personal access tokens. Fine-grained (recommended): choose the repositories, then Contents: Read and write, Pull requests: Read and write, Metadata: Read. Classic: the <code>repo</code> scope. The token is stored on this PC only (Windows DPAPI, your user account). Commits and pull requests are made as you; Relay adds no marks to them.</p>
  </section>;
}

// ---------- Settings: web search ----------
export function WebSearchSettings() {
  const { data: st } = useQuery<{ provider: string; enabled: boolean; tavily: boolean; searxng: string; builtin: { ready: boolean; message: string }; error?: string }>({ queryKey: ["/api/search/status"] });
  const [key, setKey] = useState(""); const [searx, setSearx] = useState("");
  const [testQ, setTestQ] = useState("std::filesystem recursive_directory_iterator example");
  const [results, setResults] = useState<{ title: string; url: string; snippet: string }[] | null>(null);
  const { busy, act, banners } = useAction();
  useEffect(() => { if (st) setSearx(st.searxng || ""); }, [st?.searxng]);
  const save = (body: any, msg = "Saved.") => act("save", () => json("POST", "/api/search/settings", body), () => msg);
  return <section className="settings-section"><div className="settings-section-title"><Globe size={19}/><h2>Web search</h2></div>
    <div className="runtime-options compact">
      {[["builtin", "Built-in search", "Installed and started by Relay. No account, API key, Docker or server address."], ["off", "Off", "Agents work only from your project and the model's knowledge."]].map(([id, title, text]) =>
        <button key={id} data-testid={`search-provider-${id}`} className={`runtime-option ${st?.provider === id ? "chosen" : ""}`} onClick={() => save({ provider: id })}><div><span className="radio-mark"/></div><strong>{title}</strong><p>{text}</p></button>)}
    </div>
    {st?.provider === "builtin" && <div role="status" data-testid="status-builtin-search" className={st.builtin?.ready ? "success-banner" : "error-banner"}>{st.builtin?.message}</div>}
    <details className="settings-note"><summary>Advanced: external search provider</summary>
      <p>Optional only. SearXNG requires an existing server; Tavily requires your own key. Neither is needed for built-in search.</p>
      <div className="heading-actions">
        <button data-testid="search-provider-searxng" className="button secondary" disabled={!!busy} onClick={() => save({ provider: "searxng" })}>Use external SearXNG</button>
        <button data-testid="search-provider-tavily" className="button secondary" disabled={!!busy} onClick={() => save({ provider: "tavily" })}>Use Tavily</button>
      </div>
    {st?.provider === "tavily" && <form className="connection-row" onSubmit={e => { e.preventDefault(); save({ tavilyKey: key.trim() }, "Key saved.").then(() => setKey("")); }}>
      <div className="grow"><label className="field-label" htmlFor="tv-key">TAVILY API KEY {st.tavily ? "· SAVED" : ""}</label><input id="tv-key" data-testid="input-tavily-key" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={st.tavily ? "Saved. Paste a new key to replace it." : "tvly-…"}/></div>
      <button data-testid="button-save-tavily" className="button primary" disabled={!!busy || key.trim().length < 10}><KeyRound size={15}/>Save key</button>
      {st.tavily && <button type="button" className="button secondary" onClick={() => save({ tavilyKey: "" }, "Key removed.")}>Remove</button>}</form>}
    {st?.provider === "searxng" && <form className="connection-row" onSubmit={e => { e.preventDefault(); save({ searxng: searx.trim() }); }}>
      <div className="grow"><label className="field-label" htmlFor="sx-url">SEARXNG URL (JSON FORMAT MUST BE ENABLED)</label><input id="sx-url" data-testid="input-searxng" value={searx} onChange={e => setSearx(e.target.value)} placeholder="http://127.0.0.1:8888"/></div>
      <button className="button primary" disabled={!!busy}><Save size={15}/>Save</button></form>}
    </details>
    {st?.provider !== "off" && <form className="connection-row" onSubmit={e => { e.preventDefault(); act("test", () => json("POST", "/api/search/test", { query: testQ }), r => { setResults(r.results); return undefined; }); }}>
      <div className="grow"><label className="field-label" htmlFor="sx-test">TEST A SEARCH</label><input id="sx-test" value={testQ} onChange={e => setTestQ(e.target.value)}/></div>
      <button data-testid="button-test-search" className="button secondary" disabled={!!busy || !st?.enabled}><Spin on={busy === "test"} icon={<Search size={15}/>}/>Search</button></form>}
    {results && <div className="search-results">{results.length ? results.map((r, i) => <a key={i} href={r.url} target="_blank" rel="noreferrer"><strong>{r.title}</strong><small>{r.url}</small><span>{r.snippet}</span></a>) : <p className="small-muted">No results.</p>}</div>}
    {banners}
    <p className="settings-note">Search engines receive the approved query text and your connection's IP address. Review planned queries for confidential details before approval. Relay reads result pages and passes findings with links to the agents; external pages are untrusted. Free engines can block or rate-limit requests. Search failures are reported, not treated as verified findings.</p>
  </section>;
}

// ---------- Import from GitHub ----------
type RepoItem = { fullName: string; private: boolean; defaultBranch: string; description: string; language: string; updatedAt: string };
export function ImportGitHubDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: Project) => void }) {
  const { data: st } = useQuery<{ connected: boolean }>({ queryKey: ["/api/github/status"], enabled: open });
  const { data: repos, isLoading, error } = useQuery<RepoItem[]>({ queryKey: ["/api/github/repos"], enabled: open && !!st?.connected });
  const [filter, setFilter] = useState(""); const [pick, setPick] = useState<RepoItem | null>(null);
  const [branches, setBranches] = useState<string[]>([]); const [branch, setBranch] = useState("");
  const { busy, act, banners, setError } = useAction();
  useEffect(() => { if (open) { setPick(null); setFilter(""); setError(""); } }, [open]);
  useEffect(() => {
    if (!pick) return; setBranch(pick.defaultBranch); setBranches([pick.defaultBranch]);
    const [o, r] = pick.fullName.split("/");
    json("GET", `/api/github/repos/${q(o)}/${q(r)}/branches`).then((b: string[]) => setBranches(b.length ? b : [pick.defaultBranch])).catch(e => setError(e.message));
  }, [pick?.fullName]);
  const shown = (repos || []).filter(r => r.fullName.toLowerCase().includes(filter.toLowerCase())).slice(0, 200);
  const lang = (l: string) => (/c\+\+|^c$/i.test(l) ? "C++" : /c#/i.test(l) ? "C#" : /python/i.test(l) ? "Python" : /typescript|javascript|html|css|vue|svelte/i.test(l) ? "Web" : "Mixed");
  return <Dialog open={open} onOpenChange={o => !o && !busy && onClose()}><DialogContent className="app-dialog wide-dialog"><DialogTitle>Import from GitHub</DialogTitle>
    <DialogDescription>Relay clones the repository to this PC, indexes the code, and sends the agents the files relevant to each request.</DialogDescription>
    {!st?.connected ? <div className="info-banner"><KeyRound size={18}/><div><strong>Sign in to GitHub first.</strong><p>Settings → GitHub → paste a personal access token.</p></div></div> : <>
      <label className="search-input"><Search size={16}/><input data-testid="input-repo-filter" autoFocus placeholder="Filter repositories…" value={filter} onChange={e => setFilter(e.target.value)}/></label>
      <div className="repo-list">{isLoading ? <div className="small-muted"><LoaderCircle size={14} className="spin"/> Loading repositories…</div> : error ? <div className="error-banner">{(error as Error).message}</div> :
        shown.map(r => <button type="button" data-testid={`repo-${r.fullName}`} key={r.fullName} className={`repo-item ${pick?.fullName === r.fullName ? "chosen" : ""}`} onClick={() => setPick(r)}>
          <span><strong>{r.fullName}</strong>{r.private && <em>private</em>}<small>{r.description || "No description"}</small></span><span className="small-muted">{r.language}</span></button>)}</div>
      {pick && <div className="form-grid"><label>Branch<select data-testid="select-branch" value={branch} onChange={e => setBranch(e.target.value)}>{branches.map(b => <option key={b}>{b}</option>)}</select></label><div className="small-muted">Default branch: {pick.defaultBranch}. Large repositories take a while: files download once, updates are incremental.</div></div>}
    </>}
    {banners}
    <div className="dialog-footer"><button type="button" className="button secondary" disabled={!!busy} onClick={onClose}>Cancel</button>
      <button data-testid="button-import-repo" className="button primary" disabled={!pick || !branch || !!busy} onClick={() => act("import", () => json("POST", "/api/github/import", { fullName: pick!.fullName, branch, description: pick!.description, language: lang(pick!.language) }), p => { onCreated(p); })}>
        <Spin on={busy === "import"} icon={<GitBranch size={15}/>}/>{busy ? "Cloning and indexing…" : "Import"}</button></div>
  </DialogContent></Dialog>;
}

// ---------- Repository panel ----------
type Changes = { branch: string; base: string; onBase: boolean; uncommitted: { status: string; path: string }[]; commits: string[]; stat: string; diff: string; truncated: boolean; upstream: string; unpushed: number | null };
type Pull = { number: number; title: string; author: string; head: string; base: string; draft: boolean; url: string; files: string[] };

export function RepoDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const [tab, setTab] = useState<"files" | "changes" | "activity">("files");
  const repo = project?.repo;
  const { busy, act, banners } = useAction();
  if (!project || !repo) return null;
  const workflow = repo.workflow || "pull_request";
  return <Dialog open onOpenChange={o => !o && onClose()}><DialogContent className="app-dialog repo-dialog"><DialogTitle>{repo.fullName}</DialogTitle>
    <DialogDescription>Branch {repo.branch} · commit {repo.commit.slice(0, 7)} · {repo.fileCount.toLocaleString("en-US")} indexed files · {(repo.totalBytes / 1e6).toFixed(1)} MB</DialogDescription>
    <div className="repo-toolbar">
      <button data-testid="button-sync" className="button secondary" disabled={!!busy} onClick={() => act("sync", () => json("POST", `/api/projects/${project.id}/sync`), () => "Updated from GitHub and re-indexed.")}><Spin on={busy === "sync"} icon={<RefreshCw size={15}/>}/>Update from GitHub</button>
      <div className="segmented" role="radiogroup" aria-label="Workflow">
        {[["pull_request", "Pull request"], ["direct", "Direct to branch"]].map(([id, label]) => <button key={id} role="radio" aria-checked={workflow === id} data-testid={`workflow-${id}`} className={workflow === id ? "active" : ""} disabled={!!busy} onClick={() => act("wf", () => json("PATCH", `/api/projects/${project.id}/workflow`, { workflow: id }))}>{label}</button>)}
      </div>
      <span className="small-muted">{workflow === "direct" ? `Changes are committed and pushed to ${repo.branch}.` : "Changes go to a working branch and a pull request."} A request can override it: “without a PR”, “напрямую в main”.</span>
    </div>
    {banners}
    <div className="panel-tabs"><div>{(["files", "changes", "activity"] as const).map(t => <button key={t} data-testid={`repo-tab-${t}`} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t === "files" ? "Files" : t === "changes" ? "Changes" : "Activity"}</button>)}</div></div>
    <div className="repo-body">{tab === "files" ? <FilesTab project={project}/> : tab === "changes" ? <ChangesTab project={project}/> : <ActivityTab project={project}/>}</div>
  </DialogContent></Dialog>;
}

function FilesTab({ project }: { project: Project }) {
  const id = project.id;
  const { data } = useQuery<{ files: { path: string; size: number; lines: number; lang: string }[]; skipped: Record<string, number> }>({ queryKey: [`/api/projects/${id}/files`] });
  const [filter, setFilter] = useState(""); const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState(""); const [original, setOriginal] = useState(""); const [binary, setBinary] = useState(false);
  const [folder, setFolder] = useState(""); const upload = useRef<HTMLInputElement>(null);
  const { busy, act, banners } = useAction();
  const files = useMemo(() => (data?.files || []).filter(f => f.path.toLowerCase().includes(filter.toLowerCase())), [data, filter]);
  async function view(path: string) {
    const f = await act("open", () => json("GET", `/api/projects/${id}/file?path=${q(path)}`));
    if (f) { setOpen(path); setBinary(!!f.binary); setContent(f.content || ""); setOriginal(f.content || ""); }
  }
  async function doUpload(list: FileList | null) {
    if (!list?.length) return;
    const items = await Promise.all(Array.from(list).map(f => new Promise<{ name: string; base64: string }>((ok, bad) => { const r = new FileReader(); r.onload = () => ok({ name: f.name, base64: String(r.result).split(",")[1] || "" }); r.onerror = () => bad(r.error); r.readAsDataURL(f); })));
    await act("upload", () => json("POST", `/api/projects/${id}/upload`, { folder, files: items }), r => `Uploaded ${r.written.length} file(s) to branch ${r.branch}. Review them in Changes.`);
    if (upload.current) upload.current.value = "";
  }
  return <div className="files-tab">
    <div className="files-side">
      <label className="search-input"><Search size={15}/><input data-testid="input-file-filter" placeholder={`Filter ${data?.files.length ?? 0} files…`} value={filter} onChange={e => setFilter(e.target.value)}/></label>
      <div className="file-list">{files.slice(0, 500).map(f => <button key={f.path} className={open === f.path ? "chosen" : ""} onClick={() => view(f.path)} title={`${f.lines} lines`}><FileCode2 size={13}/><span>{f.path}</span></button>)}
        {files.length > 500 && <p className="small-muted">{files.length - 500} more. Narrow the filter.</p>}</div>
      <div className="upload-row"><input aria-label="Target folder" placeholder="Target folder, e.g. src/utils" value={folder} onChange={e => setFolder(e.target.value)}/>
        <input ref={upload} type="file" multiple className="sr-only" data-testid="input-upload" onChange={e => doUpload(e.target.files)}/>
        <button className="button secondary" disabled={!!busy} onClick={() => upload.current?.click()}><Spin on={busy === "upload"} icon={<Upload size={15}/>}/>Upload</button></div>
      {data?.skipped && <p className="small-muted">Not indexed: {Object.entries(data.skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}.</p>}
    </div>
    <div className="file-editor">{open ? <>
      <div className="editor-head"><code>{open}</code>
        {!binary && <button data-testid="button-save-file" className="button primary" disabled={!!busy || content === original} onClick={() => act("save", () => json("PUT", `/api/projects/${id}/file`, { path: open, content }), r => { setOriginal(content); return `Saved on branch ${r.branch}.`; })}><Save size={15}/>Save</button>}
        <button data-testid="button-delete-file" className="button secondary danger" disabled={!!busy} onClick={() => { if (confirm(`Delete ${open}?`)) act("del", () => json("DELETE", `/api/projects/${id}/file?path=${q(open)}`), r => { setOpen(null); return `Deleted on branch ${r.branch}.`; }); }}><Trash2 size={15}/>Delete</button></div>
      {binary ? <p className="small-muted">Binary or very large file. It can be replaced by uploading a file with the same name.</p> : <textarea data-testid="textarea-file" spellCheck={false} value={content} onChange={e => setContent(e.target.value)}/>}
    </> : <p className="small-muted">Choose a file to view or edit it. Edits, uploads and deletions stay on this PC until you commit and push them in Changes.</p>}</div>
    {banners}
  </div>;
}

function ChangesTab({ project }: { project: Project }) {
  const id = project.id; const repo = project.repo!;
  const { data: ch, refetch, isFetching } = useQuery<Changes>({ queryKey: [`/api/projects/${id}/changes`] });
  const [message, setMessage] = useState(""); const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [draft, setDraft] = useState(false);
  const [pr, setPr] = useState<{ number: number; url: string } | null>(null);
  const { busy, act, banners } = useAction();
  if (!ch) return <div className="small-muted"><LoaderCircle size={14} className="spin"/> Reading the working tree…</div>;
  const direct = (repo.activeWorkflow || repo.workflow || "pull_request") === "direct";
  const canPush = !ch.uncommitted.length && (ch.onBase ? direct && (ch.unpushed ?? 0) > 0 : (ch.unpushed === null || ch.unpushed > 0));
  return <div className="changes-tab">
    <div className="changes-head"><span><GitBranch size={14}/> <strong>{ch.branch}</strong> {ch.onBase ? "(base branch)" : `→ ${ch.base}`}</span>
      <span className="small-muted">{ch.uncommitted.length} uncommitted · {ch.commits.length} commit(s) on branch{ch.unpushed !== null ? ` · ${ch.unpushed} not pushed` : ch.onBase ? "" : " · not on GitHub yet"}</span>
      <button className="icon-button" aria-label="Refresh" onClick={() => refetch()}><Spin on={isFetching} icon={<RefreshCw size={15}/>}/></button></div>
    {ch.uncommitted.length > 0 && <div className="change-files">{ch.uncommitted.map(f => <div key={f.path}><code className={`st st-${f.status[0]}`}>{f.status}</code><span>{f.path}</span></div>)}</div>}
    {ch.uncommitted.length > 0 && <form className="commit-row" onSubmit={e => { e.preventDefault(); act("commit", () => json("POST", `/api/projects/${id}/commit`, { message }), r => { setMessage(""); refetch(); return `Committed ${r.commit} on ${r.branch}.`; }); }}>
      <textarea data-testid="input-commit-message" rows={3} placeholder={"Commit message: short subject\n\nWhy the change was made"} value={message} onChange={e => setMessage(e.target.value)}/>
      <button data-testid="button-commit" className="button primary" disabled={!!busy || message.trim().length < 3}><Spin on={busy === "commit"} icon={<GitCommitHorizontal size={15}/>}/>Commit</button></form>}
    <div className="change-actions">
      <button data-testid="button-push" className="button primary" disabled={!!busy || !canPush} onClick={() => act("push", () => json("POST", `/api/projects/${id}/push`), r => { refetch(); return `Pushed ${r.branch}${r.rebased ? " (rebased on the latest commits first)" : ""}.`; })}><Spin on={busy === "push"} icon={<Upload size={15}/>}/>Push{ch.onBase ? ` to ${ch.branch}` : ""}</button>
      <button data-testid="button-discard" className="button secondary danger" disabled={!!busy || (ch.onBase && !ch.uncommitted.length && !(ch.unpushed ?? 0))} onClick={() => { if (confirm(ch.onBase ? `Discard all local changes and unpushed commits on ${ch.branch}?` : `Discard local changes and leave ${ch.branch}? Pushed branches stay on GitHub.`)) act("discard", () => json("POST", `/api/projects/${id}/discard`), () => { refetch(); return "Discarded."; }); }}><Trash2 size={15}/>Discard</button>
    </div>
    {!ch.onBase && ch.upstream && !ch.uncommitted.length && (ch.unpushed === 0) && <form className="pr-form" onSubmit={e => { e.preventDefault(); act("pr", () => json("POST", `/api/projects/${id}/pull-request`, { title, body, draft }), r => { setPr(r); return `Pull request #${r.number} opened.`; }); }}>
      <strong><GitPullRequest size={15}/> Open a pull request: {ch.branch} → {ch.base}</strong>
      <input data-testid="input-pr-title" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)}/>
      <textarea data-testid="input-pr-body" rows={5} placeholder={"What changed and why. How to test."} value={body} onChange={e => setBody(e.target.value)}/>
      <label className="check"><input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)}/> Draft</label>
      <button data-testid="button-open-pr" className="button primary" disabled={!!busy || title.trim().length < 3}><Spin on={busy === "pr"} icon={<GitPullRequest size={15}/>}/>Open pull request</button>
      {pr && <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number} on GitHub <ExternalLink size={12}/></a>}</form>}
    {banners}
    {ch.commits.length > 0 && <div className="commit-list">{ch.commits.map(c => <code key={c}>{c.replaceAll("\t", "  ")}</code>)}</div>}
    {ch.diff ? <pre className="diff-view">{ch.diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : l.startsWith("diff ") ? "file" : ""}>{l}{"\n"}</span>)}{ch.truncated && "\n… diff truncated"}</pre> : <p className="small-muted">No differences from origin/{ch.base}.</p>}
  </div>;
}

function ActivityTab({ project }: { project: Project }) {
  const id = project.id;
  const { data, refetch, isFetching, error } = useQuery<{ commits: string[]; pulls: Pull[] }>({ queryKey: [`/api/projects/${id}/activity`] });
  const { busy, act, banners } = useAction();
  const prAct = (n: number, what: string, body: any, msg: string) => { if (confirm(msg)) act(`${what}${n}`, () => json("POST", `/api/projects/${id}/pulls/${n}/${what}`, body), r => { refetch(); return r.message; }); };
  if (error) return <div className="error-banner">{(error as Error).message}</div>;
  if (!data) return <div className="small-muted"><LoaderCircle size={14} className="spin"/> Loading…</div>;
  return <div className="activity-tab">
    <div className="changes-head"><strong>Open pull requests ({data.pulls.length})</strong><button className="icon-button" aria-label="Refresh" onClick={() => refetch()}><Spin on={isFetching} icon={<RefreshCw size={15}/>}/></button></div>
    {data.pulls.map(p => <div key={p.number} className="pull-row" data-testid={`pull-${p.number}`}>
      <div><a href={p.url} target="_blank" rel="noreferrer"><strong>#{p.number} {p.title}</strong></a>{p.draft && <em> draft</em>}<small>{p.author} · {p.head} → {p.base} · {p.files.length ? `${p.files.length} file(s)` : ""}</small></div>
      <div className="pull-actions">
        <button className="button secondary" disabled={!!busy} onClick={() => prAct(p.number, "merge", { method: "squash" }, `Squash and merge #${p.number} into ${p.base}?`)}><GitMerge size={14}/>Merge</button>
        <button className="button secondary" disabled={!!busy} onClick={() => prAct(p.number, "close", { deleteBranch: false }, `Close #${p.number}?`)}><X size={14}/>Close</button>
        <button data-testid={`button-delete-pr-${p.number}`} className="button secondary danger" disabled={!!busy} onClick={() => prAct(p.number, "close", { deleteBranch: true }, `Close #${p.number} and delete branch ${p.head}? GitHub does not allow deleting pull requests; this is the closest equivalent.`)}><Trash2 size={14}/>Close + delete branch</button>
      </div></div>)}
    {!data.pulls.length && <p className="small-muted">No open pull requests. To reopen a closed one, ask in the chat: “reopen PR #12”.</p>}
    {banners}
    <strong>Recent commits</strong><div className="commit-list">{data.commits.map(c => <code key={c}>{c.replaceAll("\t", "  ")}</code>)}</div>
  </div>;
}

// ---------- Workspace: approved GitHub actions and applying the proposal ----------
export function GitActionsCard({ run }: { run: Run }) {
  if (!run.gitActions?.length) return null;
  const label = (a: any) => a.type === "close_pr" ? `Close pull request #${a.number}${a.deleteBranch ? " and delete its branch" : ""}` : a.type === "reopen_pr" ? `Reopen pull request #${a.number}` : a.type === "merge_pr" ? `Merge pull request #${a.number} (${a.method})` : `Delete branch ${a.branch}`;
  return <div className="plan-card git-actions"><div className="plan-header"><GitPullRequest size={15}/><strong>GitHub actions</strong><span>{run.gitActions.length}</span></div>
    {run.gitActions.map((a, i) => <div key={i} className={`plan-step ${a.status || "queued"}`}><span className="step-number">{a.status === "complete" ? <Check size={12}/> : a.status === "failed" ? <X size={12}/> : i + 1}</span><div><strong>{label(a)}</strong><small>{a.result || (run.status === "approval" ? "Runs after your approval" : "")}</small></div></div>)}</div>;
}

export function ApplyChanges({ run, project }: { run: Run; project?: Project }) {
  const { busy, act, banners } = useAction();
  if (!run.repo || run.status !== "complete" || !run.steps.some(s => (s.role === "coder" || s.role === "tester") && s.output)) return null;
  const a = run.applied;
  return <div className="apply-box">
    <div><GitBranch size={15}/><strong>{run.workflow === "direct" ? `Direct to ${project?.repo?.branch || "the branch"}` : "Pull request workflow"}</strong></div>
    {a ? <p data-testid="text-applied">Applied {a.applied.length} change(s) on branch <code>{a.branch}</code>{a.failed.length ? `. Not applied: ${a.failed.join("; ")}` : ""}{a.problems.length ? `. ${a.problems.join(" ")}` : ""}. Review, commit and push them in Projects → {project?.name} → Changes.</p>
       : <p>The developer and test engineer proposed file changes. Applying writes them into your local clone{run.workflow === "direct" ? "" : " on a new working branch"}; nothing goes to GitHub until you commit and push.</p>}
    {!a && <button data-testid="button-apply" className="button primary" disabled={!!busy} onClick={() => act("apply", () => json("POST", `/api/runs/${run.id}/apply`))}><Spin on={busy === "apply"} icon={<Check size={15}/>}/>Apply proposed changes</button>}
    {banners}
  </div>;
}

export function ResearchCard({ run }: { run: Run }) {
  const r = run.research; if (!r?.items.length) return null;
  return <div className="plan-card"><div className="plan-header"><Globe size={15}/><strong>Web research</strong><span>{r.done ? `${r.sources?.length || 0} sources` : `${r.items.length} searches`}</span></div>
    {r.items.map((it, i) => <div key={i} className={`plan-step ${r.done ? "complete" : "queued"}`}><span className="step-number">{r.done ? <Check size={12}/> : i + 1}</span><div><strong>{it.q}</strong><small>{it.where === "docs" ? "Official documentation" : it.where === "github" ? "GitHub code" : "Web"}</small></div></div>)}
    {!!r.sources?.length && <div className="source-list">{r.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer">[{i + 1}] {s.title}</a>)}</div>}</div>;
}
