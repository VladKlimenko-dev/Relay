import { useEffect, useLayoutEffect, useRef } from "react";
import { Brain } from "lucide-react";

// Shows only text the local runtime actually streamed (reasoning and answer), latest 300 lines.
// Mouse-wheel/trackpad gestures over the pane scroll the page; the pane scrolls only via its scrollbar.
export function ThinkingPane({ log, label, live }: { log: string; label?: string; live: boolean }) {
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
  return <div className="thinking-pane" data-testid="thinking-pane">
    <div className="thinking-head"><Brain size={13}/><strong>Model thinking and progress</strong><span>{label ? `${label} · ` : ""}{live ? "streaming" : "last generation"} · {lines} of max 300 lines</span></div>
    <p className="thinking-note">Text streamed by your local runtime. Not the final response; hidden internal reasoning that the runtime does not emit is not shown.</p>
    <pre ref={box} tabIndex={0} aria-label="Model thinking and progress text" onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>{log || "No text streamed yet."}</pre>
  </div>;
}
