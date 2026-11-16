import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Folder, FolderInput, GitBranch, MessageSquare, MoreHorizontal, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "./lib/queryClient";
import type { Project, Run } from "@shared/schema";

const json = async (method: string, path: string, data?: unknown) => (await apiRequest(method, path, data)).json();
export const conversationTitle = (r: Run) => r.title || r.turns?.[0]?.request || r.request;
const refresh = () => queryClient.invalidateQueries();

export function NameDialog({ open, title, label, initial, onClose, onSave }: { open: boolean; title: string; label: string; initial: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [value, setValue] = useState(initial); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setValue(initial); setError(""); } }, [open, initial]);
  async function save(e: any) { e.preventDefault(); if (!value.trim()) return; setBusy(true); setError(""); try { await onSave(value.trim()); onClose(); } catch (err: any) { setError(err.message); } finally { setBusy(false); } }
  return <Dialog open={open} onOpenChange={o => !o && !busy && onClose()}><DialogContent className="app-dialog"><DialogTitle>{title}</DialogTitle><DialogDescription>{label}</DialogDescription>
    <form className="dialog-form" onSubmit={save}><input autoFocus data-testid="input-name" value={value} maxLength={120} onChange={e => setValue(e.target.value)} aria-label={label}/>
      {error && <div role="alert" className="error-banner">{error}</div>}
      <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button data-testid="button-save-name" className="button primary" disabled={busy || !value.trim()}>Save</button></div></form>
  </DialogContent></Dialog>;
}

export function MoveDialog({ run, projects, onClose }: { run: Run | null; projects: Project[]; onClose: () => void }) {
  const [target, setTarget] = useState<number | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { setTarget(null); setError(""); }, [run?.id]);
  const options = projects.filter(p => !p.archived && p.id !== run?.projectId);
  async function move() {
    if (!run || target === null) return; setBusy(true); setError("");
    try { const r = await json("PATCH", `/api/runs/${run.id}`, { projectId: target }); queryClient.setQueryData(["/api/runs", run.id], r); await refresh(); onClose(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <Dialog open={!!run} onOpenChange={o => !o && !busy && onClose()}><DialogContent className="app-dialog"><DialogTitle>Move to project</DialogTitle><DialogDescription>Choose the destination project. Follow-ups will use that project's source context.</DialogDescription>
    <div className="move-list" role="radiogroup">{options.length ? options.map(p => <label key={p.id} className={`move-option ${target === p.id ? "chosen" : ""}`}><input type="radio" name="move-target" data-testid={`move-target-${p.id}`} checked={target === p.id} onChange={() => setTarget(p.id)}/><Folder size={14}/><span>{p.name}</span>{p.repo && <small>GitHub</small>}</label>) : <p className="small-muted">No other active project. Create one under Your projects first.</p>}</div>
    {error && <div role="alert" className="error-banner">{error}</div>}
    <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" data-testid="button-confirm-move" className="button primary" disabled={busy || target === null} onClick={move}>Move</button></div>
  </DialogContent></Dialog>;
}

export function ConversationMenu({ run, disabled, onRename, onMove, onDelete, onArchived }: { run: Run; disabled: boolean; onRename: () => void; onMove: () => void; onDelete: () => void; onArchived?: () => void }) {
  async function archive() { try { await json("PATCH", `/api/runs/${run.id}`, { archived: !run.archived }); await refresh(); if (!run.archived) onArchived?.(); } catch (e: any) { alert(e.message); } }
  return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="icon-button" data-testid={`menu-conversation-${run.id}`} aria-label="Conversation actions" title="Conversation actions"><MoreHorizontal size={16}/></button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="relay-menu">
      <DropdownMenuItem data-testid="menu-rename" onSelect={onRename}><Pencil size={14}/>Rename</DropdownMenuItem>
      <DropdownMenuItem data-testid="menu-move" disabled={disabled} onSelect={onMove}><FolderInput size={14}/>Move to project</DropdownMenuItem>
      <DropdownMenuItem data-testid="menu-archive" disabled={disabled} onSelect={archive}>{run.archived ? <><ArchiveRestore size={14}/>Restore from archive</> : <><Archive size={14}/>Archive</>}</DropdownMenuItem>
      <DropdownMenuSeparator/>
      <DropdownMenuItem data-testid="menu-delete" disabled={disabled} className="danger" onSelect={onDelete}><Trash2 size={14}/>Delete</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>;
}

export function DeleteProjectDialog({ project, runs, onClose, onDeleted }: { project: Project | null; runs: Run[]; onClose: () => void; onDeleted: (id: number) => void }) {
  const [files, setFiles] = useState(false); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { setFiles(false); setError(""); }, [project?.id]);
  const count = runs.filter(r => r.projectId === project?.id).length;
  async function remove() {
    if (!project) return; setBusy(true); setError("");
    try { await json("DELETE", `/api/projects/${project.id}${files ? "?files=delete" : ""}`); onDeleted(project.id); await refresh(); onClose(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <Dialog open={!!project} onOpenChange={o => !o && !busy && onClose()}><DialogContent className="app-dialog"><DialogTitle>Delete project “{project?.name}”?</DialogTitle>
    <DialogDescription>This permanently deletes the project, its {count} conversation{count === 1 ? "" : "s"} and their saved session files on the Relay server PC. Folder registrations are removed; folder contents on disk and changes already on GitHub are not touched.</DialogDescription>
    <label className="checkbox-row"><input type="checkbox" data-testid="toggle-delete-project-files" checked={files} onChange={e => setFiles(e.target.checked)}/><span>Also delete this project's retained generated and uploaded files. Unchecked: they stay in Settings › Retained files.</span></label>
    {error && <div role="alert" className="error-banner">{error}</div>}
    <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" data-testid="button-confirm-delete-project" className="button secondary delete-conversation" disabled={busy} onClick={remove}><Trash2 size={15}/>{busy ? "Deleting…" : "Delete project"}</button></div>
  </DialogContent></Dialog>;
}

export function ProjectTree(props: { projects: Project[]; runs: Run[]; selectedProjectId: number | null; runId: number | null; busy: boolean;
  onOpenRun: (id: number) => void; onNewConversation: (projectId: number) => void; onRepo: (id: number) => void;
  onImportFiles: () => void; onImportGitHub: () => void; onDeleteProject: (p: Project) => void }) {
  const { projects, runs } = props;
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [rename, setRename] = useState<Project | null>(null);
  const [create, setCreate] = useState(false);
  useEffect(() => { if (props.selectedProjectId !== null) setOpen(o => o[props.selectedProjectId!] === undefined ? { ...o, [props.selectedProjectId!]: true } : o); }, [props.selectedProjectId]);
  const activeProjects = projects.filter(p => !p.archived), archivedProjects = projects.filter(p => p.archived);
  const archivedRuns = runs.filter(r => r.archived && !projects.find(p => p.id === r.projectId)?.archived);
  async function patchProject(p: Project, data: object) { try { await json("PATCH", `/api/projects/${p.id}`, data); await refresh(); } catch (e: any) { alert(e.message); } }
  return <div className="sidebar-projects" data-testid="project-tree">
    <div className="nav-label">YOUR PROJECTS
      <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="icon-button" data-testid="button-add-project" aria-label="Add project" title="Add project"><Plus size={14}/></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="relay-menu">
          <DropdownMenuItem data-testid="menu-new-project" onSelect={() => setCreate(true)}><Folder size={14}/>New project</DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onImportFiles}><Upload size={14}/>Import source files</DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onImportGitHub}><GitBranch size={14}/>Import from GitHub</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
    </div>
    {!activeProjects.length && <p className="tree-empty">No projects yet. Use + to create one; your first message also creates “General”.</p>}
    {activeProjects.map(p => {
      const items = runs.filter(r => r.projectId === p.id && !r.archived), expanded = !!open[p.id];
      return <div key={p.id} className="tree-project">
        <div className={`tree-row ${props.selectedProjectId === p.id ? "current" : ""}`}>
          <button type="button" className="tree-toggle" data-testid={`tree-project-${p.id}`} aria-expanded={expanded} onClick={() => setOpen({ ...open, [p.id]: !expanded })}>
            {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}{p.repo ? <GitBranch size={13}/> : <Folder size={13}/>}<span>{p.name}</span><small>{items.length}</small>
          </button>
          <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="icon-button tree-menu" data-testid={`menu-project-${p.id}`} aria-label={`Actions for ${p.name}`}><MoreHorizontal size={14}/></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="relay-menu">
              <DropdownMenuItem data-testid="menu-project-new-conversation" disabled={props.busy} onSelect={() => props.onNewConversation(p.id)}><MessageSquare size={14}/>New conversation</DropdownMenuItem>
              {p.repo && <DropdownMenuItem onSelect={() => props.onRepo(p.id)}><GitBranch size={14}/>Files, changes and pull requests</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => setRename(p)}><Pencil size={14}/>Rename</DropdownMenuItem>
              <DropdownMenuItem data-testid="menu-project-archive" onSelect={() => patchProject(p, { archived: true })}><Archive size={14}/>Archive project</DropdownMenuItem>
              <DropdownMenuSeparator/>
              <DropdownMenuItem className="danger" data-testid="menu-project-delete" onSelect={() => props.onDeleteProject(p)}><Trash2 size={14}/>Delete project</DropdownMenuItem>
            </DropdownMenuContent></DropdownMenu>
        </div>
        {expanded && <div className="tree-children">
          <button type="button" className="tree-conversation new" disabled={props.busy} data-testid={`tree-new-conversation-${p.id}`} onClick={() => props.onNewConversation(p.id)}><Plus size={12}/>New conversation</button>
          {items.map(r => <button type="button" key={r.id} data-testid={`tree-conversation-${r.id}`} className={`tree-conversation ${props.runId === r.id ? "current" : ""}`} onClick={() => props.onOpenRun(r.id)} title={conversationTitle(r)}><MessageSquare size={12}/><span>{conversationTitle(r)}</span></button>)}
        </div>}
      </div>;
    })}
    {(archivedProjects.length > 0 || archivedRuns.length > 0) && <div className="tree-project archived">
      <button type="button" className="tree-toggle" data-testid="tree-archived" aria-expanded={archiveOpen} onClick={() => setArchiveOpen(!archiveOpen)}>{archiveOpen ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<Archive size={13}/><span>Archived</span><small>{archivedProjects.length + archivedRuns.length}</small></button>
      {archiveOpen && <div className="tree-children">
        {archivedProjects.map(p => <div key={`p${p.id}`} className="tree-row"><span className="tree-archived-name"><Folder size={12}/>{p.name}</span><button type="button" className="icon-button" data-testid={`restore-project-${p.id}`} aria-label={`Restore ${p.name}`} title="Restore project" onClick={() => patchProject(p, { archived: false })}><ArchiveRestore size={13}/></button><button type="button" className="icon-button" aria-label={`Delete ${p.name}`} title="Delete project" onClick={() => props.onDeleteProject(p)}><Trash2 size={13}/></button></div>)}
        {archivedRuns.map(r => <button type="button" key={`r${r.id}`} className={`tree-conversation ${props.runId === r.id ? "current" : ""}`} data-testid={`tree-archived-conversation-${r.id}`} onClick={() => props.onOpenRun(r.id)}><MessageSquare size={12}/><span>{conversationTitle(r)}</span></button>)}
      </div>}
    </div>}
    <NameDialog open={!!rename} title="Rename project" label="Project name" initial={rename?.name || ""} onClose={() => setRename(null)} onSave={async name => { await json("PATCH", `/api/projects/${rename!.id}`, { name }); await refresh(); }}/>
    <NameDialog open={create} title="New project" label="Project name" initial="" onClose={() => setCreate(false)} onSave={async name => { const p = await json("POST", "/api/projects", { name, description: "", language: "Mixed", files: [] }); await refresh(); setOpen(o => ({ ...o, [p.id]: true })); props.onNewConversation(p.id); }}/>
  </div>;
}
