import { useEffect, useLayoutEffect, useRef } from "react";
import { Brain } from "lucide-react";

// Shows only text the local runtime actually streamed (reasoning and answer), latest 300 lines.
// Mouse-wheel/trackpad gestures over the pane scroll the page; the pane scrolls only via its scrollbar.
type Summary = { text: string; at: string } | undefined;
type SummarizerStatus = { configured: boolean; enabled: boolean; state: string; lastError?: string } | undefined;
// Summary-first view: the small CPU model's display-only summary, or a truthful status when there is none.
function SummaryLine({ summary, status, live }: { summary: Summary; status: SummarizerStatus; live: boolean }) {
  const cadence = (status as any)?.cadenceSeconds || 25;
  const note = summary ? "" : !status || !status.configured ? "Thinking summary is not set up on this PC."
    : !status.enabled ? "Thinking summary is turned off in Settings."
    : status.state === "unavailable" ? `Summary unavailable: ${status.lastError || "the summarizer is not responding"}.`
    : live ? `Waiting for the first summary (about every ${cadence} s).` : "No summary was produced for this generation.";
  return <div className="thinking-summary" data-testid="thinking-summary">
    <small>Summary by a small CPU model · display only, may be inaccurate{summary ? ` · ${new Date(summary.at).toLocaleTimeString()}` : ""}</small>
    {summary ? <p>{summary.text}</p> : <p className="thinking-note">{note}</p>}
  </div>;
}
export function ThinkingPane({ log, label, live, summary, summarizer }: { log: string; label?: string; live: boolean; summary?: Summary; summarizer?: SummarizerStatus }) {
  const box = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // keep browser zoom
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      window.scrollBy({ top: e.deltaY * unit, left: e.deltaX * unit });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  useLayoutEffect(() => { const el = box.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [log]);
  const lines = log ? log.split("\n").length : 0;
  // Raw text stays mounted inside a closed <details>, so the wheel listener and scroll position work once opened.
  return <div className="thinking-pane" data-testid="thinking-pane">
    <div className="thinking-head"><Brain size={13}/><strong>Model thinking</strong><span>{label ? `${label} · ` : ""}{live ? "streaming" : "last generation"}</span></div>
    <SummaryLine summary={summary} status={summarizer} live={live}/>
    <details className="thinking-raw" data-testid="thinking-raw" onToggle={e => { const el = box.current; if ((e.currentTarget as HTMLDetailsElement).open && el && follow.current) el.scrollTop = el.scrollHeight; }}>
      <summary>Show full thinking ({lines} of max 300 lines)</summary>
      <p className="thinking-note">Text streamed by your local runtime. Not the final response; hidden internal reasoning that the runtime does not emit is not shown.</p>
      <pre ref={box} tabIndex={0} aria-label="Model thinking and progress text" onScroll={e => { const el = e.currentTarget; if (el.clientHeight) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>{log || "No text streamed yet."}</pre>
    </details>
  </div>;
}
