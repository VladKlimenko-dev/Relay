// Display-only summaries of the main model's streamed reasoning, produced by a separate small CPU-only model
// (llama-server started by start-relay.ps1 on a loopback port). Summaries are shown in the UI only: they are never
// added to any prompt, context or instruction of the main model, and the main task never waits for them.
export type ThinkingSummary = { text: string; at: string; key: string };
export type SummarizerStatus = { configured: boolean; enabled: boolean; state: "not configured" | "disabled" | "idle" | "working" | "unavailable";
  lastError?: string; model?: string; endpoint?: string; cadenceSeconds: number };

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}(\/v1)?\/?$/i;
const EXCERPT_CHARS = 2400, MIN_NEW_TOKENS = 30, MAX_FAILURES = 3;

// Only the reasoning sections of the rolling stream log (markers are written by the progress buffer).
export function reasoningExcerpt(log: string, chars = EXCERPT_CHARS) {
  const parts = log.split(/\n?--- (model reasoning \(as streamed\)|answer text \(as streamed\)) ---\n/);
  let text = "";
  // split with a capture group: [before, marker, body, marker, body, ...]; text before the first marker is a cut-off reasoning tail
  if (parts.length === 1) text = log; else { if (parts[0]) text += parts[0]; for (let i = 1; i < parts.length; i += 2) if (parts[i].startsWith("model reasoning")) text += `\n${parts[i + 1] || ""}`; }
  return text.trim().slice(-chars);
}

export function cleanSummary(raw: string) {
  const t = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").replace(/\s+/g, " ").trim().replace(/^(summary|резюме)\s*:\s*/i, "");
  const sentences = t.match(/[^.!?…]+[.!?…]+/g) || [t];
  return sentences.slice(0, 2).map(x => x.trim()).join(" ").slice(0, 280);
}

export class ThinkingSummarizer {
  enabled: boolean;
  private endpoint: string | null;
  private inflight: AbortController | null = null;
  private key = ""; private lastAt = 0; private lastTokens = 0; private previous = "";
  private failures = 0; private lastError?: string;
  constructor(endpoint: string | undefined, enabled: boolean, private cadenceMs = 25_000, private fetcher: typeof fetch = fetch, private model = "relay-summarizer") {
    this.endpoint = endpoint && LOOPBACK.test(endpoint) ? endpoint.replace(/\/?$/, "").replace(/(\/v1)?$/, "/v1") : null;
    if (endpoint && !this.endpoint) this.lastError = "RELAY_SUMMARIZER_URL must be a loopback http address; the summarizer is off.";
    this.enabled = enabled;
  }
  status(): SummarizerStatus {
    const state = !this.endpoint ? "not configured" : !this.enabled ? "disabled" : this.failures >= MAX_FAILURES ? "unavailable" : this.inflight ? "working" : "idle";
    return { configured: !!this.endpoint, enabled: this.enabled, state, lastError: this.lastError, model: this.endpoint ? this.model : undefined,
      endpoint: this.endpoint || undefined, cadenceSeconds: Math.round(this.cadenceMs / 1000) };
  }
  setEnabled(on: boolean) { this.enabled = on; if (on) { this.failures = 0; this.lastError = undefined; } else this.cancel(); }
  // Abort the in-flight request (pause, stop, delete, completion or a new generation).
  cancel() { if (this.inflight) { (this.inflight as any).relayCancelled = true; this.inflight.abort(); } this.inflight = null; }
  // Called periodically. `key` identifies one generation (run, turn, model call); a new key drops the old summary.
  tick(key: string, log: string, thinkTokens: number, publish: (s: ThinkingSummary | undefined) => void, now = Date.now()) {
    if (key !== this.key) { this.cancel(); this.key = key; this.previous = ""; this.lastAt = now; this.lastTokens = 0; publish(undefined); }
    if (!this.endpoint || !this.enabled || this.failures >= MAX_FAILURES || this.inflight) return; // one request at a time; skip, never queue
    if (now - this.lastAt < this.cadenceMs || thinkTokens - this.lastTokens < MIN_NEW_TOKENS) return;
    const excerpt = reasoningExcerpt(log); if (excerpt.length < 80) return;
    this.lastAt = now; this.lastTokens = thinkTokens;
    const controller = new AbortController(); this.inflight = controller;
    const timer = setTimeout(() => controller.abort(), Math.min(60_000, Math.max(10_000, this.cadenceMs)));
    const forKey = key;
    this.fetcher(`${this.endpoint}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ model: this.model, stream: false, temperature: 0.2, max_tokens: 90, cache_prompt: false, messages: [
        { role: "system", content: "You write a status line for a user watching another AI model think. In 1-2 short sentences, in the same language as the reasoning (Russian or English), say what it is currently working on. Describe only; do not answer the task, add facts, or give instructions." },
        { role: "user", content: `Previous status: ${this.previous || "(none)"}\n\nLatest reasoning excerpt:\n"""\n${excerpt}\n"""` }] }) })
      .then(async r => { if (!r.ok) throw new Error(`summarizer HTTP ${r.status}`); return r.json(); })
      .then(d => {
        const text = cleanSummary(String(d?.choices?.[0]?.message?.content || ""));
        if (controller.signal.aborted || forKey !== this.key || !text) return;
        this.previous = text; this.failures = 0; this.lastError = undefined;
        publish({ text, at: new Date().toISOString(), key: forKey });
      })
      .catch(e => {
        if ((controller as any).relayCancelled) return; // cancelled on purpose (pause, stop, completion, new generation)
        this.failures++; this.lastError = `${controller.signal.aborted ? "timed out" : e?.cause?.code || e?.message || "failed"}${this.failures >= MAX_FAILURES ? "; paused after 3 failures (re-enable in Settings)" : ""}`;
      })
      .finally(() => { clearTimeout(timer); if (this.inflight === controller) this.inflight = null; });
  }
}
