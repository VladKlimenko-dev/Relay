import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const python = process.env.RELAY_SEARCH_PYTHON || path.join(root, "tools", "search", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const worker = path.join(root, "setup/search-worker.py");
type Hit = { title: string; url: string; snippet: string };
const cache = new Map<string, { until: number; results: Hit[] }>();
let running: Promise<Hit[]> | null = null;
export function nativeSearchStatus() {
  let installed = false;
  try { installed = fs.readFileSync(path.join(root, "tools/search/relay-ready"), "utf8").trim() === "9.16.1"; } catch {}
  const ready = installed && fs.existsSync(python) && fs.existsSync(worker);
  return { ready, message: ready
    ? "Built-in search installed. No key or server address required."
    : "Built-in search is not installed yet. Restart with start-relay.cmd to install it automatically." };
}
export async function nativeSearch(query: string, opts: { max?: number; sites?: string[] } = {}): Promise<Hit[]> {
  const state = nativeSearchStatus();
  if (!state.ready) throw new Error(state.message);
  if (query.trim().length < 3 || query.length > 400) throw new Error("Enter a search query of 3-400 characters.");
  const input = { query, max: Math.min(opts.max || 5, 10), sites: opts.sites || [] };
  const key = JSON.stringify(input), saved = cache.get(key);
  if (saved && saved.until > Date.now()) return saved.results;
  if (running) throw new Error("Another web search is running. Try again after it finishes.");
  running = new Promise<Hit[]>((resolve, reject) => {
    // Only runtime/network environment, not the model/GitHub/Tavily credential environment.
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA",
      "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      if (process.env[k]) env[k] = process.env[k];
    }
    const child = spawn(python, ["-I", worker], { windowsHide: true, shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill(); reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Search timed out. Engines may be unavailable; try again later."), 40_000);
    child.on("error", () => fail("Cannot start built-in search. Restart Relay to repair the search component."));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > 200_000) fail("Search returned too much data.");
    });
    child.stderr.resume(); // Never log queries or provider exception details.
    child.stdin.on("error", () => fail("Search worker stopped before accepting the request."));
    child.on("close", code => {
      if (settled) return;
      clearTimeout(timer);
      try {
        const data = JSON.parse(out);
        if (code !== 0 || data.error) throw new Error(data.error || "Built-in search failed.");
        if (!Array.isArray(data.results)) throw new Error("Invalid search response.");
        const hits: Hit[] = data.results.filter((r: any) => {
          try {
            const u = new URL(r.url);
            return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password &&
              typeof r.title === "string" && typeof r.snippet === "string" &&
              (!input.sites.length || input.sites.some(s => u.hostname === s || u.hostname.endsWith("." + s)));
          } catch { return false; }
        }).slice(0, input.max);
        if (!hits.length) throw new Error("No usable search results.");
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(key, { until: Date.now() + 10 * 60_000, results: hits });
        settled = true; resolve(hits);
      } catch (e: any) { fail(e.message || "Invalid search response."); }
    });
    child.stdin.end(JSON.stringify(input));
  });
  try { return await running; } finally { running = null; }
}
