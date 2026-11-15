// Web research: built-in search, optional Tavily/SearXNG, documentation, GitHub and page reading.
// Query strings leave the PC. Review them before approval: they may reflect project context.
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import { saveSecret, loadSecret, deleteSecret } from "./secrets";
import { gh, token as githubToken } from "./github";
import { nativeSearch, nativeSearchStatus } from "./nativeSearch";

const SETTINGS = path.join(path.dirname(path.resolve(process.env.DATA_FILE || "data.db")), "search-settings.json");
const TAVILY = process.env.TAVILY_API || "https://api.tavily.com";
const KEY = "tavily-key";
export const DOC_SITES = ["en.cppreference.com", "learn.microsoft.com", "docs.python.org", "developer.mozilla.org", "doc.qt.io", "cmake.org", "docs.github.com", "nodejs.org", "react.dev", "fastapi.tiangolo.com", "docs.djangoproject.com", "numpy.org", "pandas.pydata.org"];

type Settings = { version: 2; provider: "builtin" | "tavily" | "searxng" | "off"; searxng: string };
export function getSettings(): Settings {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    // Upgrade the old manually-configured search to built-in; preserve Off and saved URLs/keys.
    const provider = s.provider === "off" ? "off" : s.version !== 2 ? "builtin" : s.provider;
    return { version: 2, provider: ["builtin", "tavily", "searxng", "off"].includes(provider) ? provider : "builtin", searxng: String(s.searxng || "") };
  } catch { return { version: 2, provider: "builtin", searxng: "" }; }
}
function putSettings(s: Settings) { fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2)); }
const tavilyKey = () => process.env.TAVILY_API_KEY || loadSecret(KEY) || "";
export function searchEnabled() {
  const s = getSettings();
  return s.provider === "builtin" ? nativeSearchStatus().ready : s.provider === "tavily" ? !!tavilyKey() : s.provider === "searxng" ? !!s.searxng : false;
}

export type Hit = { title: string; url: string; snippet: string; content?: string };

async function getJson(url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (!r.ok) {
    let m = text.slice(0, 300); try { const j = JSON.parse(text); m = j.detail?.error || j.error || j.message || m; } catch {}
    throw new Error(r.status === 401 || r.status === 403 ? "The search service rejected the API key. Check it in Settings → Web search." : r.status === 429 || r.status === 432 ? "Search limit reached (free plan credits or rate limit). Try later or check your plan." : `Search failed (${r.status}): ${m}`);
  }
  return JSON.parse(text);
}

// sites: restrict to these domains (documentation search). content: ask for page text with the results.
export async function search(query: string, opts: { max?: number; sites?: string[]; content?: boolean } = {}): Promise<Hit[]> {
  const s = getSettings(); const max = Math.min(opts.max || 5, 10);
  if (s.provider === "builtin") return nativeSearch(query, opts);
  if (s.provider === "tavily") {
    const key = tavilyKey(); if (!key) throw new Error("Add a Tavily API key in Settings → Web search.");
    const j = await getJson(`${TAVILY}/search`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: query.slice(0, 400), max_results: max, search_depth: "basic", include_raw_content: opts.content ? "markdown" : false, ...(opts.sites?.length ? { include_domains: opts.sites } : {}) }) });
    return (j.results || []).map((r: any) => ({ title: String(r.title || r.url), url: String(r.url), snippet: String(r.content || "").slice(0, 600), content: r.raw_content ? String(r.raw_content) : undefined }));
  }
  if (s.provider === "searxng") {
    if (!s.searxng) throw new Error("Set the SearXNG URL in Settings → Web search.");
    const qq = opts.sites?.length ? `${query} ${opts.sites.slice(0, 4).map(d => `site:${d}`).join(" OR ")}` : query;
    const j = await getJson(`${s.searxng.replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(qq)}`).catch((e: any) => {
      throw new Error(/\(403\)/.test(e.message) ? "SearXNG refused JSON output. Add `json` to search.formats in its settings.yml." : e.message);
    });
    return (j.results || []).slice(0, max).map((r: any) => ({ title: String(r.title || r.url), url: String(r.url), snippet: String(r.content || "").slice(0, 600) }));
  }
  throw new Error("Web search is off. Turn it on in Settings → Web search.");
}

// ---- page reader ----
function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:") && privateAddress(v.slice(7));
}
async function assertPublic(u: URL) {
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) pages can be read.");
  if (process.env.RELAY_ALLOW_PRIVATE_FETCH === "1") return; // tests only
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => privateAddress(a.address))) throw new Error(`Refusing to read ${u.hostname}: it resolves to a local or private address.`);
}
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entities[e.toLowerCase()] ?? m);
export function htmlToText(html: string) {
  let h = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, "");
  const main = h.match(/<(main|article)\b[\s\S]*?<\/\1>/i); if (main && main[0].length > 2000) h = main[0];
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code) => `\n\`\`\`\n${decode(code.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))}\n\`\`\`\n`);
  h = h.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => `\`${c.replace(/<[^>]+>/g, "")}\``);
  h = h.replace(/<h([1-6])\b[^>]*>/gi, (_m, n) => `\n\n${"#".repeat(Number(n))} `).replace(/<li\b[^>]*>/gi, "\n- ").replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/table|\/ul|\/ol)\b[^>]*>/gi, "\n").replace(/<\/t[dh]>/gi, " | ");
  const parts = h.split(/(```[\s\S]*?```)/g).map(p => p.startsWith("```") ? p : decode(p.replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n"));
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}
export async function readPage(url: string, maxChars = 60_000): Promise<{ title: string; text: string }> {
  let u = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(u);
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Relay/1.0", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = new URL(r.headers.get("location")!, u); continue; }
    if (!r.ok) throw new Error(`${u.hostname} answered ${r.status}.`);
    const type = r.headers.get("content-type") || "";
    if (!/text|json|xml|javascript/.test(type)) throw new Error(`${u.pathname} is not a text page (${type || "unknown type"}).`);
    const reader = r.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (size < 3_000_000) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
    reader.cancel().catch(() => {});
    const raw = Buffer.concat(chunks).toString("utf8");
    const title = decode((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || u.hostname).trim()).slice(0, 200);
    return { title, text: (/html/.test(type) ? htmlToText(raw) : raw).slice(0, maxChars) };
  }
  throw new Error("Too many redirects.");
}

// ---- GitHub code search (uses the GitHub token) ----
export async function githubCode(query: string, max = 3): Promise<Hit[]> {
  if (!githubToken()) throw new Error("GitHub code search needs the GitHub sign-in (Settings → GitHub).");
  const j = await gh(`/search/code?per_page=${Math.min(max * 2, 10)}&q=${encodeURIComponent(query.slice(0, 250))}`);
  const out: Hit[] = [];
  for (const it of (j.items || []).slice(0, max)) {
    const file = await gh(`/repos/${it.repository.full_name}/contents/${it.path.split("/").map(encodeURIComponent).join("/")}`).catch(() => null);
    const content = file?.content && file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : "";
    out.push({ title: `${it.repository.full_name}/${it.path}`, url: it.html_url, snippet: "", content });
  }
  return out;
}

// ---- research for a run ----
export const researchSchema = z.object({ q: z.string().trim().min(3).max(300), where: z.enum(["web", "docs", "github"]).default("web") });
export type ResearchItem = z.infer<typeof researchSchema>;

const termsOf = (s: string) => Array.from(new Set(s.toLowerCase().match(/[\p{L}\p{N}_:#+.]{3,}/gu) || []));
// Keep the paragraphs and code blocks that best match the query, in page order.
export function excerpt(text: string, query: string, budget: number) {
  if (text.length <= budget) return text;
  const terms = termsOf(query);
  const blocks = text.split(/\n{2,}/);
  const scored = blocks.map((b, i) => { const l = b.toLowerCase(); let s = 0; for (const t of terms) if (l.includes(t)) s += 1; if (b.startsWith("```")) s += 0.5; return { i, b, s }; });
  const keep = new Set<number>(); let used = 0;
  for (const x of [...scored].sort((a, b) => b.s - a.s || a.i - b.i)) { if (used + x.b.length > budget) continue; keep.add(x.i); used += x.b.length + 2; }
  return blocks.filter((_, i) => keep.has(i)).join("\n\n");
}

export async function research(items: ResearchItem[], budget: number, onEvent: (m: string) => void, signal?: AbortSignal) {
  const sources: { title: string; url: string; query: string }[] = []; const blocks: string[] = []; const seen = new Set<string>();
  const perQuery = Math.floor(budget / Math.max(items.length, 1));
  for (const it of items) {
    if (signal?.aborted) break;
    onEvent(`Research (${it.where}): ${it.q}`);
    let hits: Hit[] = [];
    try { hits = it.where === "github" ? await githubCode(it.q) : await search(it.q, { max: 5, content: true, sites: it.where === "docs" ? DOC_SITES : undefined }); }
    catch (e: any) { onEvent(`Research failed: ${e.message}`); continue; }
    const fresh = hits.filter(h => !seen.has(h.url)).slice(0, 3); fresh.forEach(h => seen.add(h.url));
    if (!fresh.length) { onEvent("Research: no results"); continue; }
    const perPage = Math.floor(perQuery / fresh.length);
    for (const h of fresh) {
      let text = h.content || "";
      if (!text && it.where !== "github") text = await readPage(h.url).then(p => p.text).catch(() => "");
      text = excerpt(text || h.snippet, it.q, perPage);
      if (!text.trim()) continue;
      sources.push({ title: h.title, url: h.url, query: it.q });
      blocks.push(`SOURCE [${sources.length}]: ${h.title}\nURL: ${h.url}\n${text}`);
    }
    onEvent(`Research: ${fresh.length} source(s) read`);
  }
  return { text: blocks.join("\n\n").slice(0, budget), sources };
}

// ---- routes ----
export function registerSearchRoutes(app: any) {
  app.get("/api/search/status", (_req: any, res: any) => {
    const s = getSettings(); let tavily = false, error: string | undefined;
    try { tavily = !!tavilyKey(); } catch (e: any) { error = e.message; }
    res.json({ ...s, tavily, enabled: searchEnabled(), builtin: nativeSearchStatus(), error });
  });
  app.post("/api/search/settings", (req: any, res: any) => {
    try {
      const s = getSettings(), b = req.body || {};
      if (b.provider !== undefined) { if (!["builtin", "tavily", "searxng", "off"].includes(b.provider)) throw new Error("Unknown provider."); s.provider = b.provider; }
      if (b.searxng !== undefined) { const v = String(b.searxng).trim(); if (v && !/^https?:\/\/[^\s]+$/.test(v)) throw new Error("Enter the SearXNG address, e.g. http://127.0.0.1:8888"); s.searxng = v; }
      if (b.tavilyKey !== undefined) { const k = String(b.tavilyKey).trim(); if (!k) deleteSecret(KEY); else if (!/^[\w-]{10,200}$/.test(k)) throw new Error("That does not look like a Tavily key (tvly-…)."); else saveSecret(KEY, k); }
      putSettings(s); res.json({ ...s, tavily: !!tavilyKey(), enabled: searchEnabled() });
    } catch (e: any) { res.status(400).json({ message: e.message }); }
  });
  app.post("/api/search/test", async (req: any, res: any) => {
    try { res.json({ results: await search(String(req.body?.query || "").slice(0, 300) || "python pathlib", { max: 5 }) }); }
    catch (e: any) { res.status(502).json({ message: e.message }); }
  });
}
