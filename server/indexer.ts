// Repository index and per-request context selection.
// The index records every source file with its size, language and top-level symbols (classes, functions, ...).
// For each request, files are ranked by how well the request's terms match their path, symbols and content,
// and the best ones are sent to the model in full, after a compact repository map.
import fs from "node:fs";
import path from "node:path";

export type IndexedFile = { p: string; size: number; lines: number; lang: string; sym: string[] };
export type RepoIndex = { root: string; builtAt: string; files: IndexedFile[]; totalBytes: number;
  skipped: { ignoredDirs: number; unsupported: number; sensitive: number; large: number; binary: number; overLimit: number } };

const IGNORED_DIRS = new Set([".git", "node_modules", "bin", "obj", "build", "out", "dist", ".vs", ".vscode", ".idea", "packages",
  "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", "target", "Debug", "Release", "x64", "x86", "ipch", ".gradle", "coverage", ".next", ".cache"]);
const LANG: Record<string, string> = {
  c: "c", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp", inl: "cpp", ipp: "cpp", ixx: "cpp",
  cs: "csharp", csproj: "xml", sln: "text", props: "xml", targets: "xml", xaml: "xml", axaml: "xml", resx: "xml", config: "xml",
  py: "python", pyi: "python", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript",
  vue: "vue", svelte: "svelte", html: "html", htm: "html", css: "css", scss: "scss", json: "json", md: "markdown", txt: "text",
  yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", cfg: "ini", cmake: "cmake", sql: "sql", sh: "bash", ps1: "powershell",
  bat: "bat", cmd: "bat", xml: "xml", glsl: "glsl", hlsl: "hlsl", vert: "glsl", frag: "glsl", rs: "rust", go: "go", java: "java", kt: "kotlin",
};
const SPECIAL_FILES: Record<string, string> = { "CMakeLists.txt": "cmake", Makefile: "make", Dockerfile: "docker", ".gitignore": "text", ".gitattributes": "text",
  ".gitmodules": "ini", ".editorconfig": "ini", CODEOWNERS: "text", LICENSE: "text", "Directory.Build.props": "xml" };
const SENSITIVE = /secret|credential|password|(^|[\\/])\.env($|\.)|\.pem$|\.pfx$|\.p12$|\.key$|\.snk$|id_rsa|id_ed25519|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|\.min\.(js|css)$/i;
const MAX_FILE = 512 * 1024, MAX_FILES = 20000;

const SYMBOLS: Record<string, RegExp[]> = {
  cpp: [/^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union|enum(?:\s+class)?|namespace)\s+([A-Za-z_]\w*)/gm,
    /^[A-Za-z_][\w:<>,*&\s~]*?\b([A-Za-z_~][\w~]*(?:::[A-Za-z_~][\w~]*)*)\s*\([^;{)]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{/gm],
  c: [/^\s*(?:struct|enum|union)\s+([A-Za-z_]\w*)/gm, /^[A-Za-z_][\w\s*]*?\b([A-Za-z_]\w*)\s*\([^;{)]*\)\s*\{/gm],
  csharp: [/\b(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/g,
    /^\s*(?:public|private|protected|internal)(?:\s+(?:static|virtual|override|abstract|async|sealed|partial|new|unsafe|extern))*\s+[\w<>\[\],.?\s]+?\s([A-Za-z_]\w*)\s*\(/gm],
  python: [/^\s*(?:class|def|async\s+def)\s+([A-Za-z_]\w*)/gm],
  javascript: [/\b(?:class|function)\s+([A-Za-z_$][\w$]*)/g, /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm],
  typescript: [/\b(?:class|interface|function|type|enum)\s+([A-Za-z_$][\w$]*)/g, /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm],
};
const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "catch", "sizeof", "else", "do", "new", "delete"]);

function symbolsOf(lang: string, text: string) {
  const found: string[] = [];
  for (const re of SYMBOLS[lang] || []) {
    for (const m of text.matchAll(re)) { const s = m[1]; if (s && !KEYWORDS.has(s) && !found.includes(s)) found.push(s); if (found.length >= 40) return found; }
  }
  return found;
}

function langOf(name: string) {
  if (SPECIAL_FILES[name]) return SPECIAL_FILES[name];
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANG[ext];
}

export function buildIndex(root: string): RepoIndex {
  const files: IndexedFile[] = [];
  const skipped = { ignoredDirs: 0, unsupported: 0, sensitive: 0, large: 0, binary: 0, overLimit: 0 };
  let totalBytes = 0;
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (IGNORED_DIRS.has(entry.name)) skipped.ignoredDirs++; else walk(p); continue; }
      if (!entry.isFile()) continue;
      const lang = langOf(entry.name);
      if (!lang) { skipped.unsupported++; continue; }
      if (SENSITIVE.test(p)) { skipped.sensitive++; continue; }
      const full = path.join(root, p), size = fs.statSync(full).size;
      if (size > MAX_FILE) { skipped.large++; continue; }
      if (files.length >= MAX_FILES) { skipped.overLimit++; continue; }
      const buf = fs.readFileSync(full);
      if (buf.subarray(0, 8192).includes(0)) { skipped.binary++; continue; }
      const text = buf.toString("utf8");
      files.push({ p, size, lines: text.split("\n").length, lang, sym: symbolsOf(lang, text) });
      totalBytes += size;
    }
  };
  walk("");
  files.sort((a, b) => a.p.localeCompare(b.p));
  return { root, builtAt: new Date().toISOString(), files, totalBytes, skipped };
}

const STOP = new Set(("the and for with that this from into have has are was were will would should could can not but you your our all any add make " +
  "use using code file files project please need want new fix change update implement create write function class method " +
  "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему " +
  "теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между нужно сделать добавить код файл").split(" "));

// Split identifiers (camelCase, snake_case, paths) and plain words into lowercase search terms.
export function termsOf(text: string) {
  const out = new Set<string>();
  for (const word of text.match(/[\p{L}\p{N}_]+/gu) || []) {
    const parts = [word, ...word.split("_"), ...word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ")];
    for (const part of parts) { const t = part.toLowerCase(); if (t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)) out.add(t); }
  }
  return [...out].slice(0, 60);
}

const fence = (lang: string) => (lang === "text" ? "" : lang);
const ENTRY = /(^|\/)(readme(\.\w+)?|main\.\w+|program\.cs|app\.\w+|index\.\w+|cmakelists\.txt|[^/]+\.sln|[^/]+\.csproj|package\.json|pyproject\.toml|setup\.py|requirements\.txt)$/i;

// Choose files for a request within a character budget.
export function selectContext(index: RepoIndex, request: string, budget: number, header: string) {
  const terms = termsOf(request);
  const lowerReq = request.toLowerCase();
  const docs = index.files.map(f => {
    let text = ""; try { text = fs.readFileSync(path.join(index.root, f.p), "utf8"); } catch { }
    return { f, text, lower: text.toLowerCase(), pathLower: f.p.toLowerCase(), symLower: f.sym.map(s => s.toLowerCase()) };
  }).filter(d => d.text);
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, docs.filter(d => d.lower.includes(t) || d.pathLower.includes(t)).length);
  const N = docs.length || 1;
  const scored = docs.map(d => {
    let score = 0;
    const base = d.f.p.split("/").pop()!.toLowerCase();
    if (lowerReq.includes(d.pathLower) || (base.length > 4 && lowerReq.includes(base))) score += 100; // file named in the request
    for (const t of terms) {
      const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
      if (d.pathLower.includes(t)) score += 6 * idf;
      if (d.symLower.some(s => s === t)) score += 5 * idf; else if (d.symLower.some(s => s.includes(t))) score += 2.5 * idf;
      let count = 0, at = d.lower.indexOf(t);
      while (at >= 0 && count < 30) { count++; at = d.lower.indexOf(t, at + t.length); }
      if (count) score += Math.log1p(count) * idf;
    }
    if (ENTRY.test(d.f.p)) score += 0.5; // small preference for entry points and project files
    return { ...d, score: score / (1 + Math.log10(1 + d.text.length / 40000)) };
  }).sort((a, b) => b.score - a.score);

  // Repository map: every path with its first symbols, capped to about 15% of the budget.
  const mapBudget = Math.min(Math.floor(budget * 0.15), 24000);
  let map = "";
  for (const f of index.files) {
    const line = `${f.p} (${f.lines} lines)${f.sym.length ? ": " + f.sym.slice(0, 8).join(", ") : ""}\n`;
    if (map.length + line.length > mapBudget) { map += `... ${index.files.length - map.split("\n").length + 1} more files not listed\n`; break; }
    map += line;
  }
  let text = `${header}\n\nREPOSITORY MAP (path, lines, main symbols):\n${map}\nSELECTED FILES (ranked by relevance to the request):\n`;
  const chosen: string[] = [];
  const anyMatch = scored.some(d => d.score >= 1);
  const order = anyMatch ? scored : scored.slice().sort((a, b) => Number(ENTRY.test(b.f.p)) - Number(ENTRY.test(a.f.p)) || a.text.length - b.text.length);
  for (const d of order) {
    if (anyMatch && d.score < 0.3) break;
    const block = `\nFILE: ${d.f.p}\n\`\`\`${fence(d.f.lang)}\n${d.text}\n\`\`\`\n`;
    if (text.length + block.length > budget) { if (budget - text.length < 3000) break; continue; }
    text += block; chosen.push(d.f.p);
  }
  return { text, chosen, terms };
}
