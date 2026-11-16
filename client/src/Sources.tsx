import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, FileText, FolderOpen, Globe, Plug, Plus, Trash2, Upload, X } from "lucide-react";
import { apiRequest, queryClient } from "./lib/queryClient";
import type { FileAsset, LocalFolder, Project, Run } from "@shared/schema";

const json = async (method: string, path: string, data?: unknown) => (await apiRequest(method, path, data)).json();
const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const host = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };
function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = () => reject(new Error("Could not read the file.")); r.readAsDataURL(file); });
}
// Cumulative sources over all messages of the conversation; only sources Relay actually accessed are listed.
export function cumulativeSources(run?: Run) {
  const turns = run ? [...(run.turns || []), run] : [];
  const web = new Map<string, { title: string; url: string; query: string }>();
  const connectors = new Map<string, { repo: string; branch: string; path: string; url: string }>();
  const local = new Map<string, { folderId: number; root: string; path: string; kind: string; bytes?: number }>();
  for (const t of turns) {
    for (const s of t.research?.sources || []) if (!web.has(s.url)) web.set(s.url, s);
    for (const s of t.connectorSources || []) connectors.set(`${s.repo}/${s.path}`, s);
    for (const s of t.localSources || []) local.set(`${s.folderId}:${s.kind}:${s.path}`, s);
  }
  return { web: [...web.values()], connectors: [...connectors.values()], local: [...local.values()] };
}

function Branch({ icon: Icon, label, count, children, testid, defaultOpen = false }: { icon: any; label: string; count: number; children: any; testid: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <div className="source-branch">
    <button type="button" className="source-branch-head" data-testid={`sources-${testid}`} aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<Icon size={14}/><span>{label}</span><span className="count">{count}</span>
    </button>
    {open && <div className="source-branch-body">{children}</div>}
  </div>;
}

function FileRow({ file, onDeleted }: { file: FileAsset; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false); const [error, setError] = useState("");
  async function remove() {
    try { await json("DELETE", `/api/files/${file.id}`); onDeleted(); }
    catch (e: any) { setError(e.message); }
  }
  return <div className="source-file" data-testid={`file-${file.id}`}>
    <FileText size={13}/><span title={file.name}>{file.name}<small>{size(file.size)}</small></span>
    <a className="icon-button" href={`/api/files/${file.id}/download`} download aria-label={`Download ${file.name}`} title="Download"><Download size={14}/></a>
    {confirm ? <><button type="button" className="text-button danger" data-testid={`confirm-delete-file-${file.id}`} onClick={remove}>Delete file</button><button type="button" className="icon-button" aria-label="Cancel" onClick={() => setConfirm(false)}><X size={13}/></button></>
      : <button type="button" className="icon-button" data-testid={`delete-file-${file.id}`} aria-label={`Delete ${file.name}`} title="Delete this file from the Relay PC" onClick={() => setConfirm(true)}><Trash2 size={14}/></button>}
    {error && <div role="alert" className="error-banner">{error}</div>}
  </div>;
}

export function SourcesPanel({ run, project, pending, setPending }: { run?: Run; project?: Project; pending: FileAsset[]; setPending: (f: FileAsset[]) => void }) {
  const { data: files = [] } = useQuery<FileAsset[]>({ queryKey: [`/api/files?runId=${run?.id}`], enabled: !!run, refetchInterval: run && ["planning", "running"].includes(run.status) ? 3000 : false });
  const { data: folders = [] } = useQuery<LocalFolder[]>({ queryKey: [`/api/projects/${project?.id}/folders`], enabled: !!project });
  const [folderPath, setFolderPath] = useState(""); const [error, setError] = useState(""); const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sources = cumulativeSources(run);
  const generated = files.filter(f => f.origin === "generated"), uploaded = [...files.filter(f => f.origin === "uploaded"), ...(run ? [] : pending)];
  const readFiles = sources.local.filter(s => s.kind === "file");
  const refreshFiles = () => queryClient.invalidateQueries({ queryKey: [`/api/files?runId=${run?.id}`] });
  async function upload(list: FileList | null) {
    if (!list?.length) return; setUploading(true); setError("");
    try {
      const added: FileAsset[] = [];
      for (const file of Array.from(list)) {
        if (file.size > 20 * 1048576) throw new Error(`${file.name} is larger than 20 MB.`);
        added.push(await json("POST", "/api/files", { name: file.name, dataBase64: await readBase64(file), runId: run?.id ?? null, projectId: project?.id ?? null }));
      }
      if (run) await refreshFiles(); else setPending([...pending, ...added]);
    } catch (e: any) { setError(e.message); }
    finally { setUploading(false); if (input.current) input.current.value = ""; }
  }
  async function addFolder() {
    if (!project || !folderPath.trim()) return; setError("");
    try { await json("POST", `/api/projects/${project.id}/folders`, { path: folderPath }); setFolderPath(""); await queryClient.invalidateQueries({ queryKey: [`/api/projects/${project.id}/folders`] }); }
    catch (e: any) { setError(e.message); }
  }
  async function removeFolder(id: number) {
    try { await json("DELETE", `/api/folders/${id}`); await queryClient.invalidateQueries({ queryKey: [`/api/projects/${project?.id}/folders`] }); }
    catch (e: any) { setError(e.message); }
  }
  return <div className="sources-panel" data-testid="sources-panel">
    <div className="sources-title">Sources <span className="small-muted">cumulative for this conversation</span></div>
    <Branch icon={Globe} label="Web" count={sources.web.length} testid="web">
      {sources.web.length ? sources.web.map((s, i) => <a key={s.url} className="source-link" href={s.url} target="_blank" rel="noreferrer">[{i + 1}] {s.title}<small>{host(s.url)} · {s.query}</small></a>) : <p className="small-muted">No web pages were read in this conversation.</p>}
    </Branch>
    <Branch icon={FileText} label="Files" count={generated.length + uploaded.length} testid="files">
      <Branch icon={FileText} label="Generated" count={generated.length} testid="files-generated">
        {generated.length ? generated.map(f => <FileRow key={f.id} file={f} onDeleted={refreshFiles}/>) : <p className="small-muted">No generated files yet. Each completed agent output is kept as a file.</p>}
      </Branch>
      <Branch icon={Upload} label="Uploaded" count={uploaded.length} testid="files-uploaded">
        {uploaded.map(f => run ? <FileRow key={f.id} file={f} onDeleted={refreshFiles}/> : <FileRow key={f.id} file={f} onDeleted={() => setPending(pending.filter(p => p.id !== f.id))}/>)}
        {!run && pending.length > 0 && <p className="small-muted">Attached to your next message.</p>}
        <input ref={input} type="file" multiple className="sr-only" aria-label="Upload files" data-testid="input-upload-files" onChange={e => upload(e.target.files)}/>
        <button type="button" className="text-button" data-testid="button-upload-files" disabled={uploading} onClick={() => input.current?.click()}><Plus size={13}/>{uploading ? "Uploading…" : "Upload files"}</button>
      </Branch>
    </Branch>
    <Branch icon={FolderOpen} label="Local folders" count={readFiles.length} testid="local">
      <p className="small-muted">Folders on the Relay server PC registered for this project. Relay lists them and reads files you name in a message.</p>
      {folders.map(f => <div key={f.id} className="source-file"><FolderOpen size={13}/><span title={f.root}>{f.root}</span><button type="button" className="icon-button" aria-label={`Unregister ${f.root}`} title="Unregister (files on disk are not touched)" onClick={() => removeFolder(f.id)}><X size={13}/></button></div>)}
      {readFiles.map(s => <a key={`${s.folderId}:${s.path}`} className="source-link" href={`/api/folders/${s.folderId}/file?path=${encodeURIComponent(s.path)}`} target="_blank" rel="noreferrer">{s.path}<small>{s.root}</small></a>)}
      {project && <div className="folder-add"><input data-testid="input-folder-path" aria-label="Folder path on the Relay server PC" placeholder="C:\Projects\MyApp" value={folderPath} onChange={e => setFolderPath(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addFolder(); }}/><button type="button" className="button secondary" data-testid="button-add-folder" onClick={addFolder}>Add folder</button></div>}
    </Branch>
    <Branch icon={Plug} label="Connectors" count={sources.connectors.length} testid="connectors">
      {sources.connectors.length ? sources.connectors.map(s => <a key={`${s.repo}/${s.path}`} className="source-link" href={s.url} target="_blank" rel="noreferrer">{s.path}<small>GitHub · {s.repo} · {s.branch}</small></a>) : <p className="small-muted">No connector content was used in this conversation.</p>}
    </Branch>
    {error && <div role="alert" className="error-banner">{error}</div>}
  </div>;
}

export function RetainedFiles() {
  const { data: files = [] } = useQuery<FileAsset[]>({ queryKey: ["/api/files"] });
  const orphaned = files.filter(f => !f.conversationExists);
  return <section className="settings-section"><div className="settings-section-title"><FileText size={19}/><h2>Retained files</h2></div>
    <p className="settings-note">Files stay in the files folder on the Relay server PC until you delete them. These belong to deleted conversations or were never sent.</p>
    {orphaned.length ? orphaned.map(f => <FileRow key={f.id} file={f} onDeleted={() => queryClient.invalidateQueries({ queryKey: ["/api/files"] })}/>) : <p className="small-muted">No retained files outside existing conversations.</p>}
  </section>;
}
