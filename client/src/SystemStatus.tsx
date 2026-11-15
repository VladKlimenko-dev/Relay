import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Power, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import "./SystemStatus.css";

type Status = {
  server: string; uptimeSeconds: number; memoryMiB: number; localLogs: boolean; canShutdown: boolean;
  activity: { active: boolean; phase: string }; shuttingDown: boolean; shutdownError: string;
};
type Runtime = { connected: boolean; runtime: string; modelOverride: string | null; context: number; models: string[] };
type Logs = { stdout: { text: string; truncated: boolean }; stderr: { text: string; truncated: boolean } };
const get = async <T,>(url: string): Promise<T> => (await apiRequest("GET", url)).json();
export function SystemStatus() {
  const [open, setOpen] = useState(false), [service, setService] = useState("server");
  const [confirm, setConfirm] = useState(false), [error, setError] = useState(""), [requested, setRequested] = useState(false);
  const status = useQuery<Status>({ queryKey: ["/api/system/status"], queryFn: () => get("/api/system/status"), enabled: open, staleTime: 0, refetchInterval: open ? 3000 : false });
  const runtime = useQuery<Runtime>({ queryKey: ["/api/runtime", "status-panel"], queryFn: () => get("/api/runtime"), enabled: open && !requested, staleTime: 0, refetchInterval: open && !requested ? 5000 : false });
  const logs = useQuery<Logs>({ queryKey: ["/api/system/logs", service], queryFn: () => get(`/api/system/logs?service=${service}`), enabled: open && !!status.data?.localLogs && !requested, staleTime: 0, refetchInterval: open && !requested ? 5000 : false });
  async function stop() {
    setError("");
    try {
      await apiRequest("POST", "/api/system/shutdown", { confirm: true });
      setRequested(true); setConfirm(false); void status.refetch();
    } catch (e: any) { setError(e.message); setConfirm(false); }
  }
  const s = status.data, m = runtime.data;
  const stopping = requested && !s?.shutdownError;
  const refresh = () => { void status.refetch(); void runtime.refetch(); if (s?.localLogs) void logs.refetch(); };
  return <>
    <button className="runtime-pill" data-testid="button-system-status" onClick={() => setOpen(true)}><Activity size={14}/>Status</button>
    <Dialog open={open} onOpenChange={value => { setOpen(value); setConfirm(false); }}>
      <DialogContent className="app-dialog system-status-dialog">
        <DialogTitle>System status</DialogTitle>
        <DialogDescription>Relay and the model run in the background. Closing the browser does not stop them.</DialogDescription>
        {status.isError ? <div role="status" className="error-banner">{stopping ? "Connection closed after the shutdown request. Run start-relay.cmd to reopen Relay." : "Relay cannot be reached. Check the PC and logs/relay.stderr.log; the last status is no longer current."}</div> : s ? <>
          <dl className="system-status-grid">
            <div><dt>Relay server</dt><dd>{s.shuttingDown ? "Shutting down" : "Running"}</dd></div>
            <div><dt>Uptime</dt><dd>{Math.floor(s.uptimeSeconds / 3600)}h {Math.floor(s.uptimeSeconds / 60) % 60}m {s.uptimeSeconds % 60}s</dd></div>
            <div><dt>Activity</dt><dd>{s.activity.active ? s.activity.phase : "Idle"}</dd></div>
            <div><dt>Server RAM (not GPU)</dt><dd>{s.memoryMiB} MiB</dd></div>
          </dl>
          <div className="system-status-model"><strong>{m?.runtime || "Local model"}</strong><span>{runtime.isError ? "Status unavailable" : runtime.isFetching && !m ? "Checking…" : m?.connected ? "Reachable" : "Not reachable"}</span><small>{m?.modelOverride || m?.models?.join(", ") || "No model reported"}{m?.context ? ` · ${m.context.toLocaleString()} context` : ""}</small></div>
        </> : <p role="status">Loading status…</p>}
        {(error || s?.shutdownError) && <div role="alert" className="error-banner">{error || s?.shutdownError}</div>}
        {stopping && !status.isError && <div role="status" className="info-banner">Shutdown requested. Reopen with start-relay.cmd after Relay stops.</div>}
        {s?.localLogs && !stopping && <section className="system-status-logs">
          <div className="system-status-toolbar"><label htmlFor="system-log-service">Recent logs</label><select id="system-log-service" value={service} onChange={e => setService(e.target.value)}><option value="server">Relay server</option><option value="model">Model server</option></select><button className="icon-button" aria-label="Refresh status and logs" onClick={refresh}><RefreshCw size={16}/></button></div>
          <p>Last 32 KiB per stream, refreshed while open. Logs may contain project details. Models started outside Relay may not write here.</p>
          {logs.isError ? <p role="alert">Logs could not be loaded.</p> : logs.data ? (["stderr", "stdout"] as const).map(stream => <details key={`${service}-${stream}`} open={stream === "stderr"}><summary>{stream === "stderr" ? "Diagnostics / errors" : "Standard output"}{logs.data![stream].truncated ? " (recent tail)" : ""}</summary><pre tabIndex={0}>{logs.data![stream].text || "No output yet."}</pre></details>) : <p>Loading logs…</p>}
        </section>}
        {s && !s.localLogs && <p>Raw logs and shutdown are available only when this page is opened on the Relay PC.</p>}
        <div className="dialog-footer">
          {s?.canShutdown && !stopping && (confirm ? <div className="system-status-confirm"><p>Stop Relay and the model it started? Saved sessions remain on this PC. Externally started models are left running.</p><button className="button secondary" onClick={() => setConfirm(false)}>Cancel</button><button className="button secondary" onClick={stop} disabled={s.activity.active}>Confirm shutdown</button></div> : <button className="button secondary" disabled={s.activity.active || status.isError} title={s.activity.active ? "Pause or stop the active task and wait for it to save first." : "Stop background processes"} onClick={() => { setRequested(false); setConfirm(true); }}><Power size={14}/>Shut down Relay</button>)}
          {!confirm && <button className="button secondary" onClick={() => setOpen(false)}>Close status</button>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
