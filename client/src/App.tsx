import { useEffect, useRef, useState } from "react";
import { Router, Switch, Route, Link, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./lib/queryClient";
import { AccessGate } from "./AccessGate";
import { RemoteSettings } from "./RemoteSettings";
import { SystemStatus } from "./SystemStatus";
import { useForm } from "react-hook-form";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowUp, ArrowUpRight, ArrowRight, AudioLines, Bot, Braces, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, CircleStop, Clock3, Code2, Cpu, Database, Download, FileCode2, FileText, FlaskConical, Folder, FolderOpen, GitBranch, Layers3, LoaderCircle, Menu, MessageSquare, Network, Paperclip, Pause, Play, Plus, Search, Settings2, ShieldCheck, SlidersHorizontal, Terminal, Trash2, Workflow, X, Zap } from "lucide-react";
import type { Agent, Evaluation, Project, Role, Run, Step } from "@shared/schema";
import { sessionToRestore } from "@shared/sessionSelection";
import { GitHubSettings, WebSearchSettings, ImportGitHubDialog, RepoDialog, GitActionsCard, ApplyChanges, ResearchCard } from "./Connections";

const roleIcons = { orchestrator: Network, architect: GitBranch, coder: Code2, tester: FlaskConical, data: Database, analyst: Search };
const roleDescriptions: Record<string, string> = { orchestrator: "Breaks down requests and coordinates the team.", architect: "Plans the structure, interfaces, and dependencies.", coder: "Turns the plan into proposed code changes.", tester: "Writes tests and checks for edge cases.", data: "Works with supplied and synthetic datasets.", analyst: "Reviews the result against your requirements." };
const nav = [{ href: "/", name: "Workspace", icon: MessageSquare }, { href: "/agents", name: "Agents", icon: Network }, { href: "/projects", name: "Projects", icon: Folder }, { href: "/runs", name: "Run history", icon: Clock3 }, { href: "/evaluations", name: "Evaluations", icon: ShieldCheck }];
const statuses: Record<string, string> = { planning: "Planning", pausing: "Pausing", paused: "Paused and saved", approval: "Needs approval", running: "Running", complete: "Complete", failed: "Failed", cancelled: "Cancelled", queued: "Queued", pending: "Not evaluated", pass: "Pass", fail: "Fail" };
const formatTime = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const json = async (method: string, path: string, data?: unknown) => (await apiRequest(method, path, data)).json();
const invalidate = () => queryClient.invalidateQueries();
type LiveProgress = { active: boolean; label?: string; phase?: "waiting" | "prompt" | "thinking" | "writing"; elapsedSeconds?: number; promptTotal?: number; promptDone?: number; thinkTokens?: number; outTokens?: number; tokensPerSecond?: number | null; tail?: string };
const phaseText = { waiting: "Sending the request to the model", prompt: "Reading the prompt and source context", thinking: "Thinking (reasoning before the answer)", writing: "Writing the answer" };
const clock = (sec = 0) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
function ProgressBox({ p }: { p: LiveProgress | null }) {
  if (!p?.active) return <div className="activity-live"><LoaderCircle size={13} className="spin"/> Waiting for local model response…</div>;
  const pct = p.promptTotal ? Math.round((p.promptDone || 0) / p.promptTotal * 100) : null;
  return <div className="progress-box" data-testid="live-progress">
    <div className="progress-head"><LoaderCircle size={13} className="spin"/><strong>{p.label}</strong><time>{clock(p.elapsedSeconds)}</time></div>
    <div className="progress-phase">{phaseText[p.phase || "waiting"]}{p.phase === "prompt" && pct !== null ? ` · ${pct}%` : ""}</div>
    {p.phase === "prompt" && pct !== null && <div className="progress-bar"><span style={{ width: `${pct}%` }}/></div>}
    <div className="progress-stats"><span>Thinking {p.thinkTokens || 0} tok</span><span>Answer {p.outTokens || 0} tok</span><span>{p.tokensPerSecond ? `${p.tokensPerSecond} tok/s` : "speed …"}</span></div>
    {p.tail && <pre className="progress-tail">{p.tail.slice(-220)}</pre>}
  </div>;
}

function download(name: string, content: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportRun(run: Run) {
  const messages = [...(run.turns || []), run].map((turn, index) =>
    `## Message ${index + 1}\nStatus: ${turn.status}\n\n${turn.request}\n\n${turn.steps.map(s => `### ${s.title}\nAgent: ${s.role}\nStatus: ${s.status}\n\n${s.output || "No output."}`).join("\n\n")}`).join("\n\n");
  download(`relay-run-${run.id}.md`, `# Relay conversation ${run.id}\n\nMode: ${run.mode}\nStatus: ${run.status}\nProject: ${run.projectName}\nCreated: ${run.createdAt}\n\n${messages}\n\nNote: outputs are proposals. No code was executed by this runtime.`);
}
function Badge({ children, kind = "" }: { children: any; kind?: string }) { return <span className={`badge ${kind}`}>{children}</span>; }
function IconButton({ children, label, onClick, disabled = false, testid }: { children: any; label: string; onClick: () => void; disabled?: boolean; testid?: string }) { return <button type="button" data-testid={testid || `button-${label.toLowerCase().replaceAll(" ", "-")}`} className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>; }
function RichOutput({ text }: { text: string }) {
  return <div className="rich-output">{text.split(/(```[\s\S]*?```)/g).map((block, i) => block.startsWith("```") ? <pre key={i}><code>{block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code></pre> : <div key={i} className="prose-text">{block}</div>)}</div>;
}

function ControlRoom() {
  const [location, navigate] = useLocation();
  const { data: projects = [], isLoading, error: loadError } = useQuery<Project[]>({ queryKey: ["/api/projects"] });
  const { data: agents = [] } = useQuery<Agent[]>({ queryKey: ["/api/agents"] });
  const { data: runs = [], isSuccess: runsLoaded } = useQuery<Run[]>({ queryKey: ["/api/runs"], refetchInterval: 2500 });
  const { data: evaluations = [] } = useQuery<Evaluation[]>({ queryKey: ["/api/evaluations"] });
  const [projectId, setProjectId] = useState<number | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const { data: currentRun } = useQuery<Run>({ queryKey: ["/api/runs", runId], enabled: runId !== null, refetchInterval: query => ["planning", "running", "pausing"].includes(query.state.data?.status || "") ? 800 : false });
  const [mode, setMode] = useState<"demo" | "ollama">("demo");
  const [panel, setPanel] = useState<"activity" | "outputs">("activity");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [githubModal, setGithubModal] = useState(false);
  const [repoProjectId, setRepoProjectId] = useState<number | null>(null);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [output, setOutput] = useState<Step | null>(null);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modelStatus, setModelStatus] = useState<{ connected: boolean; models: string[]; message?: string; runtime?: string; endpoint?: string; context?: number; maxTokens?: number; thinking?: boolean; timeoutMinutes?: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [runSearch, setRunSearch] = useState("");
  const [runFilter, setRunFilter] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<Run | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const chatForm = useForm({ defaultValues: { request: "" } });
  const request = chatForm.watch("request");
  const bottom = useRef<HTMLDivElement>(null);
  const selected = projects.find(p => p.id === projectId) || projects[0];
  const activeRun = currentRun && currentRun.id === runId ? currentRun : undefined;
  const working = ["planning", "running", "pausing"].includes(activeRun?.status || "");
  const paused = activeRun?.status === "paused", pausing = activeRun?.status === "pausing";
  const stopped = activeRun?.status === "cancelled";
  const restored = useRef(false);
  useEffect(() => {
    if (!runsLoaded || restored.current) return;
    restored.current = true;
    let saved: string | null = null;
    try { saved = localStorage.getItem("relay-selected-run"); } catch {}
    const run = sessionToRestore(runs, saved);
    if (run) { setRunId(run.id); setProjectId(run.projectId); setMode(run.mode); }
  }, [runsLoaded, runs]);
  useEffect(() => {
    if (runId === null) return;
    try { localStorage.setItem("relay-selected-run", String(runId)); } catch {}
  }, [runId]);
  const pageName = nav.find(n => n.href === location)?.name || "Settings";
  useEffect(() => { if (projects.length && projectId === null) setProjectId(projects[0].id); }, [projects]);
  useEffect(() => { setMobileOpen(false); window.scrollTo({ top: 0 }); }, [location]);
  useEffect(() => { if (activeRun) bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [activeRun?.status]);
  async function send(values: { request: string }) {
    if (values.request.trim().length < 3 || busy || working) return;
    setBusy(true); setError("");
    try {
      if (runId !== null && !activeRun) throw new Error("Wait for the current conversation to load before replying.");
      const r = activeRun
        ? await json("POST", `/api/runs/${activeRun.id}/messages`, { request: values.request, expectedTurn: activeRun.turns?.length || 0 })
        : await json("POST", "/api/runs", { request: values.request, mode, projectId: selected?.id ?? null });
      queryClient.setQueryData(["/api/runs", r.id], r);
      setRunId(r.id); chatForm.reset(); await invalidate();
    }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function changeRun(action: "start" | "cancel" | "pause" | "resume") {
    if (!runId) return;
    setBusy(true); setError("");
    try {
      const run = await json("POST", `/api/runs/${runId}/${action}`);
      queryClient.setQueryData(["/api/runs", runId], run); await invalidate();
    }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function checkConnection() {
    setChecking(true);
    try { setModelStatus(await json("GET", "/api/runtime")); }
    catch { setModelStatus({ connected: false, models: [], message: "Could not reach the app backend. Try again." }); }
    finally { setChecking(false); }
  }
  const [live, setLive] = useState<LiveProgress | null>(null);
  useEffect(() => {
    if (!(busy || working) || mode === "demo") { setLive(null); return; }
    let stop = false;
    const tick = () => json("GET", "/api/progress").then(p => { if (!stop) setLive(p); }).catch(() => {});
    tick(); const timer = setInterval(tick, 1000);
    return () => { stop = true; clearInterval(timer); };
  }, [busy, working, mode]);
  // Start in local-model mode when the model server answers; Demo stays available in Settings.
  useEffect(() => { json("GET", "/api/runtime").then(st => { setModelStatus(st); if (st?.connected) setMode("ollama"); }).catch(() => {}); }, []);
  function newTask() { restored.current = true; try { localStorage.removeItem("relay-selected-run"); } catch {} setRunId(null); setError(""); setMobileOpen(false); setPanel("activity"); chatForm.reset(); navigate("/"); window.scrollTo({ top: 0 }); }
  function openRun(id: number) { setRunId(id); setError(""); navigate("/"); }
  function confirmDelete(run: Run) { setDeleteError(""); setDeleteTarget(run); }
  async function deleteConversation() {
    if (!deleteTarget || deleting) return;
    const id = deleteTarget.id;
    setDeleting(true); setDeleteError("");
    try {
      await json("DELETE", `/api/runs/${id}`);
      await queryClient.cancelQueries({ queryKey: ["/api/runs"] });
      queryClient.setQueryData<Run[]>(["/api/runs"], list => list?.filter(r => r.id !== id));
      if (runId === id) { setRunId(null); setOutput(null); setPanel("activity"); chatForm.reset(); setError(""); }
      try { if (localStorage.getItem("relay-selected-run") === String(id)) localStorage.removeItem("relay-selected-run"); } catch {}
      queryClient.removeQueries({ queryKey: ["/api/runs", id], exact: true });
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/runs"], exact: true });
    } catch (e: any) { setDeleteError(e.message); }
    finally { setDeleting(false); }
  }
  function choosePrompt(text: string) { chatForm.setValue("request", text); document.getElementById("request")?.focus(); }
  const activeCount = agents.filter(a => a.enabled && a.role !== "orchestrator").length;
  const currentStep = activeRun?.steps.find(s => s.status === "running");
  const modelName = (a?: Agent) => a?.model.split(":").pop()?.toUpperCase() || "14B";
  const workflow = <section className="workflow-panel">
    <div className="section-head"><div><Workflow size={16}/><h2>Agent workflow</h2><span className="count">{activeCount + 1}</span></div><button data-testid="button-configure-agents" className="text-button" onClick={() => navigate("/agents")}>Configure <SlidersHorizontal size={14}/></button></div>
    <div className="workflow-canvas">
      <div className="layer-caption">LAYER 01 <span>COORDINATION</span></div>
      <button data-testid="node-orchestrator" className={`orchestrator-node ${working ? "is-working" : ""}`} onClick={() => setEditAgent(agents.find(a => a.role === "orchestrator") || null)}>
        <Network size={24}/><div><strong>Orchestrator</strong><span>Plan · delegate · review</span></div><span className={`node-dot ${working ? "pulse" : ""}`}/>
      </button>
      <div className="trunk"/><div className="branch-line"/>
      <div className="specialists">{agents.filter(a => a.role !== "orchestrator").map(a => {
        const Icon = roleIcons[a.role]; const s = activeRun?.steps.find(s => s.role === a.role);
        return <button data-testid={`node-${a.role}`} key={a.role} className={`specialist ${s?.status || ""} ${!a.enabled ? "off" : ""}`} onClick={() => setEditAgent(a)}>
          <span className="node-connector"/><Icon size={21}/><strong>{a.name}</strong><span className="agent-size">{modelName(a)} <span>· {mode === "demo" ? "Demo" : "Local"}</span></span>
          <span className={`agent-state ${s?.status || ""}`}>{s?.status === "running" ? <LoaderCircle size={10} className="spin"/> : s?.status === "complete" ? <Check size={10}/> : <span className="tiny-dot"/>}{s ? statuses[s.status] : a.enabled ? "Ready" : "Disabled"}</span>
        </button>;
      })}</div>
      <div className="layer-caption lower">LAYER 02 <span>SPECIALIST AGENTS</span></div>
      <div className="workflow-note"><ShieldCheck size={13}/><span>Human approval first</span><span className="separator">/</span><span>Sequential execution</span></div>
    </div>
    <div className="workflow-footer"><span><span className={`dot ${working ? "green" : ""}`}/>{working ? `${currentStep ? agents.find(a => a.role === currentStep.role)?.name : "Team"} is working` : "Team ready for your next task"}</span><span>EN / RU</span></div>
  </section>;

  return <div className="app-shell">
    <a href="#main" className="skip-link" onClick={e => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)}/>}
    <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
      <div className="brand"><span>relay<span className="brand-period">.</span></span><Badge>LOCAL AI</Badge></div>
      <button data-testid="button-project-switch" className="workspace-switch" onClick={() => navigate("/projects")}><span className="workspace-avatar">P</span><span>Personal workspace<small>Local-first development</small></span><ChevronDown size={14}/></button>
      <button data-testid="button-new-task" className="new-task" onClick={newTask} disabled={working}><Plus size={17}/>New task<span>↗</span></button>
      <span className="nav-label">WORKSPACE</span>
      <nav>{nav.map(n => <Link key={n.href} href={n.href} onClick={() => setMobileOpen(false)} data-testid={`nav-${n.name.toLowerCase().replaceAll(" ", "-")}`} className={`nav-link ${location === n.href ? "selected" : ""}`}><n.icon size={18}/>{n.name}{n.name === "Agents" && <span className="nav-count">{agents.length || 6}</span>}</Link>)}</nav>
      <div className="sidebar-projects"><div className="nav-label">YOUR PROJECTS<IconButton label="Add project" onClick={() => setProjectModal(true)}><Plus size={14}/></IconButton></div>{projects.slice(0, 3).map(p => <button data-testid={`sidebar-project-${p.id}`} key={p.id} className={`project-shortcut ${selected?.id === p.id ? "current" : ""}`} onClick={() => { setProjectId(p.id); newTask(); }}><span className="project-square"/><span>{p.name}</span>{p.sample && <small>EXAMPLE</small>}</button>)}</div>
      <div className="sidebar-bottom">
        <div className="runtime-mini"><span className="runtime-symbol"><Cpu size={18}/></span><div><strong>{mode === "demo" ? "Demo runtime" : "Local model"}</strong><span>{mode === "demo" ? "Explore without a model" : modelStatus?.connected ? `${modelStatus.runtime} connected` : "Not connected"}</span></div><span className={`dot ${modelStatus?.connected && mode === "ollama" ? "green" : "amber"}`}/></div>
        <Link href="/settings" data-testid="nav-settings" className={`nav-link ${location === "/settings" ? "selected" : ""}`}><Settings2 size={18}/>Settings</Link>
        <button data-testid="button-help" className="nav-link" onClick={() => setHelp(true)}><CircleHelp size={18}/>How Relay works<ArrowUpRight className="end" size={14}/></button>
        <div className="profile"><span className="profile-avatar">Y</span><span>Your workspace<small>Personal edition</small></span><Badge>v0.1</Badge></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><IconButton label="Open navigation" onClick={() => setMobileOpen(true)}><Menu className="mobile-menu" size={19}/></IconButton><span>Personal workspace</span><ChevronRight size={14}/><strong>{pageName}</strong></div><div className="topbar-right"><span className="review-mode"><ShieldCheck size={14}/>Review-first</span><SystemStatus/><button data-testid="button-runtime-header" className="runtime-pill" onClick={() => navigate("/settings")}><span className={`dot ${mode === "demo" ? "amber" : ""}`}/>{mode === "demo" ? "Demo mode" : "Local model"}<ChevronDown size={12}/></button></div></header>
      <main id="main" tabIndex={-1} className={`main ${location === "/" ? "workspace-main" : ""}`}>
        <Switch>
          <Route path="/">
            <div className="page-heading"><div><div className="eyebrow">YOUR AI DEVELOPMENT STUDIO</div><h1>Workspace</h1><p>You set the direction. Your agents work together.</p></div><button data-testid="button-context" className="button secondary context-button" onClick={() => navigate("/projects")}><Folder size={15}/>{selected?.name || "Choose project"}<ChevronDown size={14}/></button></div>
            {loadError && <div role="alert" className="error-banner">Could not load your workspace. <button onClick={() => invalidate()}>Try again</button></div>}
            {isLoading ? <div className="loading-workspace"><LoaderCircle className="spin"/>Loading your workspace…</div> : <div className="workspace-grid">
              <section className="chat-panel">
                <div className="section-head"><div><MessageSquare size={16}/><h2>Conversation</h2></div><div><span className="small-muted">{activeRun ? `RUN ${String(activeRun.id).padStart(3, "0")}` : "New session"}</span>{activeRun && <IconButton label="Delete conversation" testid="button-delete-current-conversation" disabled={busy || working || deleting} onClick={() => confirmDelete(activeRun)}><Trash2 size={16}/></IconButton>}</div></div>
                <div className="chat-content">
                  {!activeRun ? <div className="welcome">
                    <div className="welcome-avatar"><AudioLines size={25}/></div><div className="assistant-label">RELAY ORCHESTRATOR</div>
                    <h2>What are we building?</h2><p>Describe a feature, share a problem, or bring an existing project. I’ll put the right agents to work.</p>
                    <div className="language-line"><span>C++</span><span>C#</span><span>Python</span><span>Web applications</span></div>
                    <div className="suggestion-label">A FEW PLACES TO START</div>
                    {[
                      { icon: Code2, title: "Build something new", desc: "From an idea to an implementation", prompt: "Build a Python FastAPI task API with input validation, persistence, and a complete test suite." },
                      { icon: FlaskConical, title: "Make your code more reliable", desc: "Review, find edge cases, and write tests", prompt: "Review this project for bugs and security issues. Propose fixes and write regression tests." },
                      { icon: Database, title: "Turn data into understanding", desc: "Generate a dataset and plan an analysis", prompt: "Generate a synthetic API performance dataset with 20 records, and write a Python script to analyze latency and errors. Clearly label synthetic data." },
                    ].map(s => <button data-testid={`suggest-${s.title.split(" ")[0].toLowerCase()}`} key={s.title} className="suggestion" onClick={() => choosePrompt(s.prompt)}><s.icon size={19}/><span><strong>{s.title}</strong><small>{s.desc}</small></span><ArrowUpRight size={15}/></button>)}
                  </div> : <div className="messages">
                    {activeRun.turns?.map((turn, index) => <div key={index} data-testid={`conversation-turn-${index}`}>
                      <div className="user-message"><div className="message-meta"><span className="profile-avatar small">Y</span><strong>You</strong><time>{formatTime(turn.messageAt || turn.createdAt)}</time></div><p>{turn.request}</p></div>
                      <div className="assistant-message"><div className="message-meta"><Network size={18} className="accent"/><strong>Previous response</strong><Badge>{statuses[turn.status]}</Badge></div>
                        {turn.steps.some(step => step.output) ? turn.steps.filter(step => step.output).map((step, i) => <details key={i} className="settings-note"><summary>{step.title} · {step.role} · {statuses[step.status]}{step.status !== "complete" ? " (unfinished)" : ""}</summary><RichOutput text={step.output || ""}/></details>) : <p>No specialist output was generated for this message.</p>}
                        {turn.error && <p className="small-muted">{turn.error}</p>}
                      </div>
                    </div>)}
                    <div className="user-message"><div className="message-meta"><span className="profile-avatar small">Y</span><strong>You</strong><time>{formatTime(activeRun.messageAt || activeRun.createdAt)}</time></div><p>{activeRun.request}</p></div>
                    <div className="assistant-message"><div className="message-meta"><Network size={18} className="accent"/><strong>Orchestrator</strong><Badge kind={activeRun.mode === "demo" ? "amber" : "green"}>{activeRun.mode === "demo" ? "DEMO" : "LOCAL"}</Badge></div>
                      <p>{activeRun.status === "planning" ? "Your request is saved. The orchestrator is preparing a plan; you can pause and save at any time." : pausing ? "Saving the response and waiting for any in-flight action to settle…" : paused ? "Paused and saved locally. Resume this request now or after restarting Relay." : activeRun.status === "approval" ? "Here’s the plan. Review the handoffs, then give the team the go-ahead." : activeRun.status === "complete" ? "The team has finished. Your proposed outputs are ready to review." : activeRun.status === "running" ? "The team is working through the approved plan. Each agent receives the previous agent’s output." : stopped ? "Stopped and saved. Reopen this session after restarting Relay and choose Resume when ready." : "This run needs your attention."}</p>
                      {(paused || stopped) && <div role="status" data-testid={paused ? "pause-saved" : "stop-saved"} className="success-banner">{paused ? "Paused" : "Stopped"} and saved{activeRun.savedAt ? ` at ${formatTime(activeRun.savedAt)}` : ""} on the Relay server PC: <code>sessions/session-{activeRun.id}.json</code>. Prompts, source context, partial answers and progress are preserved. Resume uses saved text, not an exact model-state checkpoint.</div>}
                      <div className="plan-card"><div className="plan-header"><Layers3 size={15}/><strong>Execution plan</strong><span>{activeRun.steps.length} steps</span></div>{activeRun.steps.map((s, i) => <div key={i} className={`plan-step ${s.status}`}><span className="step-number">{s.status === "complete" ? <Check size={12}/> : s.status === "running" ? <LoaderCircle size={12} className="spin"/> : i + 1}</span><div><strong>{s.title}</strong><small>{agents.find(a => a.role === s.role)?.name || s.role}</small></div>{s.output && <IconButton label={`View ${s.role} output`} onClick={() => setOutput(s)}><ArrowUpRight size={14}/></IconButton>}</div>)}
                      {activeRun.status === "approval" && <div className="plan-actions"><button data-testid="button-approve" className="button primary" onClick={() => changeRun("start")} disabled={busy}><Play size={14}/>{busy ? "Starting…" : `Approve ${activeRun.mode === "demo" ? "demo" : "local"} run`}</button><button data-testid="button-discard-plan" className="text-button" disabled={busy} onClick={() => changeRun("cancel")}>Discard</button></div>}</div>
                      <GitActionsCard run={activeRun}/><ResearchCard run={activeRun}/>{activeRun.mode === "demo" && <div className="inline-note"><FlaskConical size={13}/><span>Simulated workflow with example outputs. No model is running.</span></div>}
                      {activeRun.status === "complete" && <div className="completion"><CheckCheck size={17}/><span>{activeRun.steps.length} outputs ready. Code and tests have not been executed.</span><button data-testid="button-review-outputs" className="text-button" onClick={() => setPanel("outputs")}>Review <ArrowRight size={13}/></button></div>}
                      <ApplyChanges run={activeRun} project={projects.find(p => p.id === activeRun.projectId)}/>{activeRun.error && <div role="alert" className="error-banner">{activeRun.error}</div>}
                    </div>
                  </div>}
                  <div ref={bottom}/>
                </div>
                <div className="composer-area">{error && <div className="error-banner" role="alert">{error}</div>}
                  <Form {...chatForm}><form onSubmit={chatForm.handleSubmit(send)} className="composer">
                    <FormField control={chatForm.control} name="request" rules={{ minLength: 3 }} render={({ field }) => <FormItem><FormLabel className="sr-only">Your request</FormLabel><FormControl><textarea {...field} id="request" data-testid="input-request" placeholder={runId !== null ? "Reply in this conversation…\nUse New task to start a separate chat." : "Describe what you want to build…\nYou can write in English or Russian."} rows={3} disabled={busy || working} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chatForm.handleSubmit(send)(); } }}/></FormControl></FormItem>}/>
                    <div className="composer-toolbar"><div><IconButton label="Import source files" onClick={() => setProjectModal(true)}><Paperclip size={17}/></IconButton><span className="composer-project"><Folder size={13}/>{selected?.repo ? `${selected.repo.fullName} · ${selected.repo.fileCount.toLocaleString("en-US")} files indexed` : `${selected?.files.length || 0} ${selected?.files.length === 1 ? "file" : "files"} in context`}</span></div>
                      {working || paused || (stopped && !request.trim()) ? <div className="generation-controls">
                        {paused || stopped ? <button type="button" data-testid="button-resume" className="send-button" aria-label="Resume saved response" title="Resume saved response" onClick={() => changeRun("resume")} disabled={busy}><Play size={18}/></button> :
                          <button type="button" data-testid="button-pause" className="send-button" aria-label="Pause and save response" title="Pause and save response" onClick={() => changeRun("pause")} disabled={busy || pausing}>{pausing ? <LoaderCircle size={18} className="spin"/> : <Pause size={18}/>}</button>}
                        {!stopped && <button type="button" data-testid="button-stop" className="stop-button" aria-label="Stop and save session" onClick={() => changeRun("cancel")} disabled={busy}><CircleStop size={16}/>Stop</button>}
                      </div> : <button data-testid="button-send" className="send-button" type="submit" aria-label="Send request" disabled={request.trim().length < 3 || busy}>{busy ? <LoaderCircle className="spin" size={18}/> : <ArrowUp size={19}/>}</button>}
                    </div>
                    {busy && !working && mode === "ollama" && <ProgressBox p={live}/>}
                  </form></Form>
                  <div className="composer-note"><span><ShieldCheck size={11}/>You approve every run</span><span>Enter to send · Shift + Enter for a new line</span></div>
                </div>
              </section>
              <div className="right-column">{workflow}
                <section className="activity-panel"><div className="panel-tabs"><div><button data-testid="tab-activity" className={panel === "activity" ? "active" : ""} onClick={() => setPanel("activity")}><Terminal size={15}/>Activity</button><button data-testid="tab-outputs" className={panel === "outputs" ? "active" : ""} onClick={() => setPanel("outputs")}><FileCode2 size={15}/>Outputs <span className="count">{activeRun?.steps.filter(s => s.output).length || 0}</span></button></div>{activeRun && <IconButton label="Export run" onClick={() => exportRun(activeRun)}><Download size={15}/></IconButton>}</div>
                  {panel === "activity" ? <div className="activity-list">{(activeRun?.events || [{ time: "", message: "Workspace initialized" }, { time: "", message: `${activeCount} specialist agents ready` }, { time: "", message: "Waiting for your first request" }]).map((e, i, arr) => <div className={`activity-item ${i === arr.length - 1 ? "latest" : ""}`} key={i}><span className="activity-dot"/><span>{e.message}</span><time>{e.time ? formatTime(e.time) : "SYSTEM"}</time></div>)}{working && (activeRun?.mode === "demo" ? <div className="activity-live"><LoaderCircle size={13} className="spin"/> Simulating agent handoff…</div> : <ProgressBox p={live}/>)}</div> : <div className="output-list">{activeRun?.steps.some(s => s.output) ? activeRun.steps.filter(s => s.output).map((s, i) => <button data-testid={`output-${s.role}`} className="output-row" key={i} onClick={() => setOutput(s)}><FileText size={20}/><span><strong>{s.title}</strong><small>{s.role} · {activeRun.mode === "demo" ? "Example output" : "Model-generated proposal"}</small></span><ChevronRight size={15}/></button>) : <div className="empty-outputs"><FileCode2 size={25}/><h3>A place for the finished work</h3><p>Agent outputs appear here after a run.</p></div>}</div>}
                  <div className="activity-footer"><span>{mode === "demo" ? "DEMO ENVIRONMENT" : "LOCAL MODEL ADAPTER"}</span><span><span className="dot"/>No shell execution</span></div>
                </section>
                <div className="quality-strip"><ShieldCheck size={20}/><div><strong>Built for a higher standard</strong><span>Compare your team against Opus 5.5.</span></div><button data-testid="button-open-evaluations" className="icon-button" aria-label="Open evaluations" onClick={() => navigate("/evaluations")}><ArrowUpRight size={18}/></button></div>
              </div>
            </div>}
          </Route>
          <Route path="/agents">
            <PageHeading eyebrow="THE RIGHT SPECIALIST FOR EVERY STEP" title="Your agent team" text="One orchestrator. Five focused roles. Models you control." action={<Badge kind="green">{activeCount} specialists enabled</Badge>}/>
            <div className="info-banner"><Cpu size={18}/><div><strong>Different roles, not necessarily different models.</strong><p>Agents run sequentially and share one loaded model by default, so the GPU holds a single model. Changing a role does not train a new model.</p></div></div>
            <div className="agents-grid">{agents.map(a => { const Icon = roleIcons[a.role]; return <article className={`agent-card ${a.role === "orchestrator" ? "coordinator-card" : ""}`} key={a.role}><div className="agent-card-top"><Icon size={24}/><Badge kind={a.enabled ? "green" : ""}>{a.role === "orchestrator" ? "COORDINATOR" : a.enabled ? "ENABLED" : "DISABLED"}</Badge></div><h2>{a.name}</h2><p>{roleDescriptions[a.role]}</p><div className="agent-model"><Cpu size={14}/><code>{a.model}</code></div><button data-testid={`configure-${a.role}`} className="button secondary" onClick={() => setEditAgent(a)}><Settings2 size={14}/>Configure agent<ArrowUpRight size={14}/></button></article>; })}</div>
          </Route>
          <Route path="/projects">
            <PageHeading eyebrow="CONTEXT MAKES BETTER CODE" title="Projects" text="Give your team the source files they need." action={<div className="heading-actions"><button data-testid="button-import-github" className="button secondary" onClick={() => setGithubModal(true)}><GitBranch size={16}/>Import from GitHub</button><button data-testid="button-import-project" className="button primary" onClick={() => setProjectModal(true)}><Plus size={16}/>Import files</button></div>}/>
            <div className="info-banner"><ShieldCheck size={18}/><div><strong>Import only code you want to share with this workspace.</strong><p>Files are stored in this app’s backend database. The hosted preview is not your PC. Secrets, credentials, binaries, and dependencies should stay out.</p></div></div>
            <div className="project-grid">{projects.map(p => <article className="project-card" key={p.id}><div className="project-card-top"><FolderOpen size={26}/><Badge kind={p.sample ? "" : "green"}>{p.repo ? "GITHUB" : p.sample ? "EXAMPLE PROJECT" : "IMPORTED"}</Badge></div><h2>{p.name}</h2><p>{p.description || "Source context for your agent team."}</p><div className="project-meta"><span><span className="dot green"/>{p.language}</span>{p.repo ? <><span>{p.repo.fileCount.toLocaleString("en-US")} files</span><span>{p.repo.branch}</span></> : <><span>{p.files.length} {p.files.length === 1 ? "file" : "files"}</span><span>{(p.files.reduce((n, f) => n + f.content.length, 0) / 1000).toFixed(1)}k characters</span></>}</div>{p.repo && <button data-testid={`button-open-repo-${p.id}`} className="button secondary" onClick={() => setRepoProjectId(p.id)}><GitBranch size={14}/>Files, changes and pull requests</button>}<div className="project-files">{p.files.slice(0, 4).map((f, i) => <div key={i}><FileCode2 size={14}/>{f.name}</div>)}{p.files.length > 4 && <small>+ {p.files.length - 4} more files</small>}</div><button data-testid={`open-project-${p.id}`} className="button secondary" onClick={() => { setProjectId(p.id); newTask(); }}>Open in workspace<ArrowRight size={15}/></button></article>)}</div>
          </Route>
          <Route path="/runs">
            <PageHeading eyebrow="EVERY HANDOFF, ACCOUNTED FOR" title="Run history" text="Review the requests, decisions, and outputs of your team." action={<button className="button primary" onClick={newTask}><Plus size={16}/>New task</button>}/>
            <div className="table-toolbar"><label className="search-input"><Search size={16}/><input data-testid="input-run-search" aria-label="Search runs" placeholder="Search requests…" value={runSearch} onChange={e => setRunSearch(e.target.value)}/></label><select data-testid="select-run-filter" aria-label="Filter runs by status" value={runFilter} onChange={e => setRunFilter(e.target.value)}><option value="all">All statuses</option>{["planning", "approval", "running", "pausing", "paused", "complete", "cancelled", "failed"].map(s => <option key={s} value={s}>{statuses[s]}</option>)}</select></div>
            <div className="runs-table">{runs.filter(r => r.request.toLowerCase().includes(runSearch.toLowerCase()) && (runFilter === "all" || r.status === runFilter)).length ? <><div className="run-table-head conversation-table-head"><span>REQUEST</span><span>STATUS</span><span>RUNTIME</span><span>CREATED</span><span/></div>{runs.filter(r => r.request.toLowerCase().includes(runSearch.toLowerCase()) && (runFilter === "all" || r.status === runFilter)).map(r => <div key={r.id} className="conversation-history-row"><button data-testid={`run-row-${r.id}`} className="run-row" onClick={() => openRun(r.id)}><span><strong>{r.request}</strong><small>{r.projectName} · {r.steps.length} agents · {r.mode === "demo" ? "Demo" : "Ollama"}</small></span><Badge kind={r.status === "complete" ? "green" : r.status === "failed" ? "red" : "amber"}>{statuses[r.status]}</Badge><span>{r.mode === "demo" ? "Demo" : "Ollama"}</span><time>{new Date(r.createdAt).toLocaleDateString()}<small>{formatTime(r.createdAt)}</small></time><ChevronRight size={16}/></button><IconButton label={`Delete conversation ${r.id}`} testid={`button-delete-conversation-${r.id}`} disabled={busy || deleting || ["planning", "running", "pausing"].includes(r.status)} onClick={() => confirmDelete(r)}><Trash2 size={16}/></IconButton></div>)}</> : <div className="large-empty"><Clock3 size={30}/><h2>{runs.length ? "No matching runs" : "Your first run starts with an idea"}</h2><p>{runs.length ? "Try another search or status filter." : "Send a request in your workspace to start a traceable workflow."}</p><button className="button secondary" onClick={newTask}>Open workspace<ArrowRight size={15}/></button></div>}</div>
          </Route>
          <Route path="/evaluations">
            <PageHeading eyebrow="QUALITY IS MEASURED, NOT PROMISED" title="Evaluations" text="Your target: Opus 5.5-level programming on your own tasks." action={<button data-testid="button-export-evaluations" className="button secondary" onClick={() => download("relay-evaluations.csv", "task,language,candidate,reference,note\n" + evaluations.map(e => [e.name, e.language, e.candidate, e.reference, e.note].map(v => `"${v.replaceAll('"', '""')}"`).join(",")).join("\n"), "text/csv")}><Download size={15}/>Export CSV</button>}/>
            <div className="evaluation-intro"><div><Badge kind="amber">NOT BENCHMARKED</Badge><h2>A quality target. Not a parity claim.</h2><p>Run the same held-out tasks with your local team and Opus 5.5, using the same repository, instructions, tools, and time budget. Record independently verified outcomes here.</p></div><div className="eval-score"><strong>{evaluations.filter(e => e.candidate !== "pending").length}<span> / {evaluations.length}</span></strong><span>local outcomes recorded</span></div></div>
            <div className="section-head plain"><h2>Acceptance task set</h2><span className="small-muted">Manual outcome tracking</span></div>
            <div className="evaluation-list">{evaluations.map(e => <EvaluationRow key={e.id} item={e}/>)}</div>
            <div className="info-banner"><FlaskConical size={18}/><div><strong>Generated tests are not passing tests.</strong><p>This version drafts code and tests; it does not compile or execute them. Evaluation outcomes are manually entered and are not independently verified by Relay. No Opus model is connected.</p></div></div>
          </Route>
          <Route path="/settings">
            <PageHeading eyebrow="YOUR MODELS. YOUR WORKFLOW." title="Settings" text="Choose how your agent team runs."/>
            <section className="settings-section"><div className="settings-section-title"><Cpu size={19}/><h2>Runtime</h2></div><div className="runtime-options"><button data-testid="runtime-demo" className={`runtime-option ${mode === "demo" ? "chosen" : ""}`} onClick={() => setMode("demo")}><div><FlaskConical size={21}/><span className="radio-mark"/></div><strong>Demo environment</strong><p>Explore planning, approvals, and handoffs with labeled example outputs. No model calls.</p></button><button data-testid="runtime-ollama" className={`runtime-option ${mode === "ollama" ? "chosen" : ""}`} onClick={() => setMode("ollama")}><div><Cpu size={21}/><span className="radio-mark"/></div><strong>Local model</strong><p>Run real model inference through llama.cpp or Ollama on this PC.</p></button></div>
              <div className="connection-row"><div><span className="field-label">{(modelStatus?.runtime || "Ollama").toUpperCase()} ENDPOINT</span><code>{modelStatus?.endpoint || "http://127.0.0.1:11434"}</code></div><button data-testid="button-test-connection" className="button secondary" disabled={checking} onClick={checkConnection}>{checking ? <LoaderCircle size={15} className="spin"/> : <Zap size={15}/>}Test connection</button></div>
              {modelStatus && <div role="status" data-testid="status-connection" className={modelStatus.connected ? "success-banner" : "error-banner"}>{modelStatus.connected ? `Connected to ${modelStatus.runtime}. Models: ${modelStatus.models.join(", ") || "none"}. Context ${modelStatus.context}, max output ${modelStatus.maxTokens}, thinking ${modelStatus.thinking ? "on" : "off"}, timeout ${modelStatus.timeoutMinutes} min.` : modelStatus.message || "Ollama is not available on this app server."}</div>}
              <p className="settings-note">The hosted preview cannot reach Ollama on your PC. For local use, run this app’s backend alongside Ollama. No cloud model fallback is used. Runtime selection applies to new runs.</p>
            </section>
            <GitHubSettings/>
            <WebSearchSettings/>
            <RemoteSettings/>
            <section className="settings-section"><div className="settings-section-title"><ShieldCheck size={19}/><h2>Execution boundaries</h2></div><div className="policy-row"><div><strong>Approval before specialist execution</strong><p>Sending a request lets the orchestrator plan. Specialists wait for your approval.</p></div><Badge kind="green">ALWAYS ON</Badge></div><div className="policy-row"><div><strong>Sequential agents</strong><p>One specialist runs at a time, with previous outputs as context.</p></div><Badge>1 AT A TIME</Badge></div><div className="policy-row"><div><strong>Repository and shell access</strong><p>Imported files are context only. No file writes, builds, tests, or web collection.</p></div><Badge kind="amber">NOT CONNECTED</Badge></div><div className="policy-row"><div><strong>Storage</strong><p>SQLite on this app server. Survives restarts, not guaranteed across redeployment.</p></div><Badge>SERVER-SIDE</Badge></div></section>
          </Route>
          <Route><div className="large-empty"><h1>Page not found</h1><button className="button primary" onClick={() => navigate("/")}>Back to workspace</button></div></Route>
        </Switch>
      </main>
    </div>
    <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null); }}><DialogContent className="app-dialog"><DialogTitle>Delete conversation?</DialogTitle><DialogDescription>This permanently removes all messages, outputs and the saved session file from the Relay server PC. Project files, repositories and changes already made on GitHub are not deleted. This cannot be undone.</DialogDescription><p>{deleteTarget?.request}</p>{deleteError && <div role="alert" className="error-banner">{deleteError}</div>}<div className="dialog-footer"><button type="button" className="button secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</button><button type="button" data-testid="button-confirm-delete-conversation" className="button secondary delete-conversation" disabled={deleting} onClick={deleteConversation}><Trash2 size={16}/>{deleting ? "Deleting…" : "Delete conversation"}</button></div></DialogContent></Dialog>
    <ProjectDialog open={projectModal} onClose={() => setProjectModal(false)} onCreated={p => { setProjectId(p.id); setProjectModal(false); newTask(); }}/>
    <ImportGitHubDialog open={githubModal} onClose={() => setGithubModal(false)} onCreated={p => { setProjectId(p.id); setGithubModal(false); setRepoProjectId(p.id); }}/>
    {repoProjectId !== null && <RepoDialog project={projects.find(p => p.id === repoProjectId) || null} onClose={() => setRepoProjectId(null)}/>}
    <AgentDialog agent={editAgent} onClose={() => setEditAgent(null)}/>
    <Dialog open={!!output} onOpenChange={o => !o && setOutput(null)}><DialogContent className="app-dialog output-dialog"><DialogTitle>{output?.title}</DialogTitle><DialogDescription>Agent output · {output?.role}. A proposal, not an executed result.</DialogDescription><div className="output-dialog-body"><RichOutput text={output?.output || ""}/></div><div className="dialog-footer"><button data-testid="button-download-output" className="button primary" onClick={() => output && download(`${output.role}-output.md`, output.output || "")}><Download size={15}/>Download Markdown</button></div></DialogContent></Dialog>
    <Dialog open={help} onOpenChange={setHelp}><DialogContent className="app-dialog"><DialogTitle>From request to reviewed output</DialogTitle><DialogDescription>Relay is a local-first, multi-agent development workspace.</DialogDescription><div className="help-steps">{["Choose a project or import source files as context.", "Describe your task in English or Russian.", "Review the orchestrator’s plan and approve it.", "Specialists work sequentially, sharing their outputs.", "Review and export the proposed code, tests, and analysis."].map((t, i) => <div key={i}><span className="step-number">{i + 1}</span><p>{t}</p></div>)}</div><div className="info-banner"><ShieldCheck size={18}/><p>Demo mode is simulated. Live mode requires local Ollama. This version does not execute code, train models, browse the web, or claim Opus-level performance.</p></div></DialogContent></Dialog>
  </div>;
}
function PageHeading({ eyebrow, title, text, action }: { eyebrow: string; title: string; text: string; action?: any }) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{text}</p></div>{action}</div>; }
function EvaluationRow({ item }: { item: Evaluation }) {
  const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  async function save(field: string, value: string) { setSaving(true); setError(""); try { await json("PATCH", `/api/evaluations/${item.id}`, { ...item, [field]: value }); await invalidate(); } catch (e: any) { setError(e.message); } finally { setSaving(false); } }
  return <div className="evaluation-row"><div><Badge>{item.language}</Badge><h3>{item.name}</h3><span className="small-muted">External execution required</span></div><label>Local team<select data-testid={`candidate-${item.id}`} disabled={saving} value={item.candidate} onChange={e => save("candidate", e.target.value)}>{["pending", "pass", "fail"].map(s => <option key={s} value={s}>{statuses[s]}</option>)}</select></label><label>Opus 5.5 reference<select data-testid={`reference-${item.id}`} disabled={saving} value={item.reference} onChange={e => save("reference", e.target.value)}>{["pending", "pass", "fail"].map(s => <option key={s} value={s}>{statuses[s]}</option>)}</select></label>{error && <p role="alert" className="error-banner">{error}</p>}</div>;
}
function ProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: Project) => void }) {
  const form = useForm({ defaultValues: { name: "", description: "", language: "Python" } });
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { form.reset(); setFiles([]); setError(""); } }, [open]);
  async function readFiles(list: FileList | null) {
    if (!list) return; setError("");
    const allowed = /\.(py|cpp|cc|c|h|hpp|cs|csproj|sln|js|jsx|ts|tsx|html|css|json|md|txt|csv|yaml|yml|toml|sql)$/i;
    const next = [...files]; let rejected = 0;
    for (const file of Array.from(list)) {
      if (!allowed.test(file.name) || /secret|credential|(^|\.)env($|\.)|package-lock|yarn\.lock/i.test(file.name) || file.size > 80000 || next.length >= 25) { rejected++; continue; }
      if (!next.some(f => f.name === file.name)) next.push({ name: file.name, content: await file.text() });
    }
    setFiles(next); if (rejected) setError(`${rejected} file(s) skipped. Use supported text files up to 80 KB each, maximum 25 files. Secret-like filenames are excluded.`);
  }
  async function save(values: { name: string; description: string; language: string }) { setBusy(true); setError(""); try { const p = await json("POST", "/api/projects", { ...values, files }); await invalidate(); onCreated(p); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  return <Dialog open={open} onOpenChange={o => !o && onClose()}><DialogContent className="app-dialog"><DialogTitle>Bring your project</DialogTitle><DialogDescription>Add focused source context for your agent team. Imported files are stored on this app server, not trained into a model.</DialogDescription><Form {...form}><form onSubmit={form.handleSubmit(save)} className="dialog-form">
    <FormField control={form.control} name="name" rules={{ required: "Give your project a name.", maxLength: 80 }} render={({ field }) => <FormItem><FormLabel>Project name</FormLabel><FormControl><input data-testid="input-project-name" {...field} placeholder="e.g. Inventory service"/></FormControl><FormMessage/></FormItem>}/>
    <div className="form-grid"><FormField control={form.control} name="language" render={({ field }) => <FormItem><FormLabel>Primary language</FormLabel><FormControl><select data-testid="select-project-language" {...field}>{["Python", "C++", "C#", "Web", "Mixed"].map(l => <option key={l}>{l}</option>)}</select></FormControl></FormItem>}/><FormField control={form.control} name="description" render={({ field }) => <FormItem><FormLabel>Short description</FormLabel><FormControl><input {...field} data-testid="input-project-description" placeholder="What does it do?" maxLength={500}/></FormControl></FormItem>}/></div>
    <input ref={input} className="sr-only" type="file" multiple aria-label="Choose source files" data-testid="input-source-files" onChange={e => readFiles(e.target.files)}/>
    <button type="button" className="upload-area" data-testid="button-choose-files" onClick={() => input.current?.click()}><FolderOpen size={25}/><strong>Choose source files</strong><span>Code, documentation, or datasets · 25 files max</span></button>
    {files.length > 0 && <div className="file-selection">{files.map((f, i) => <div key={i}><FileCode2 size={14}/><span>{f.name}</span><IconButton label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, index) => index !== i))}><X size={13}/></IconButton></div>)}</div>}
    {error && <div className="error-banner" role="alert">{error}</div>}<p className="small-muted">Do not upload API keys, passwords, private keys, or proprietary code you cannot share. Review file contents for secrets.</p>
    <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button data-testid="button-create-project" className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15}/> : <Plus size={15}/>}Create project</button></div>
  </form></Form></DialogContent></Dialog>;
}
function AgentDialog({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const form = useForm<Agent>({ defaultValues: { role: "coder", name: "", model: "", prompt: "", enabled: true } }); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (agent) { form.reset(agent); setError(""); } }, [agent]);
  async function save(values: Agent) { setBusy(true); setError(""); try { await json("PATCH", `/api/agents/${values.role}`, values); await invalidate(); onClose(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  return <Dialog open={!!agent} onOpenChange={o => !o && onClose()}><DialogContent className="app-dialog"><DialogTitle>Configure {agent?.name}</DialogTitle><DialogDescription>Give this role a model and focused instructions. Changes apply to new runs.</DialogDescription><Form {...form}><form onSubmit={form.handleSubmit(save)} className="dialog-form">
    <FormField control={form.control} name="model" rules={{ required: true, pattern: /^[a-zA-Z0-9._:/-]+$/ }} render={({ field }) => <FormItem><FormLabel>Ollama model tag</FormLabel><FormControl><input {...field} data-testid="input-agent-model" placeholder="qwen3.8:27b"/></FormControl><FormMessage/></FormItem>}/>
    <FormField control={form.control} name="prompt" rules={{ required: true, minLength: 10 }} render={({ field }) => <FormItem><FormLabel>Role instructions</FormLabel><FormControl><textarea {...field} data-testid="input-agent-prompt" rows={6}/></FormControl><FormMessage/></FormItem>}/>
    {agent?.role !== "orchestrator" && <FormField control={form.control} name="enabled" render={({ field }) => <FormItem className="checkbox-row"><FormControl><input data-testid="toggle-agent-enabled" type="checkbox" checked={field.value} onChange={field.onChange}/></FormControl><FormLabel>Include this agent in planning</FormLabel></FormItem>}/>}
    {error && <div className="error-banner" role="alert">{error}</div>}<div className="dialog-footer"><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button data-testid="button-save-agent" className="button primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save agent"}</button></div>
  </form></Form></DialogContent></Dialog>;
}
export default function App() { return <QueryClientProvider client={queryClient}><AccessGate><Router hook={useHashLocation}><ControlRoom/></Router></AccessGate></QueryClientProvider>; }
