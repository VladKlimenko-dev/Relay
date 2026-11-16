// Read-first repository analysis (mock GitHub + mock local model): "read/summarize MD files of <repo URL>" fetches real
// file contents at a pinned commit and answers directly; list-only stays a tree listing; limits are disclosed; errors are
// honest; the model only picks paths from the real tree; stale plans, pause/resume and new turns behave. GitHub is GET-only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reader-"));
const URL_MD = "[https://github.com/VladKlimenko-dev/parametric3d-rep](https://github.com/VladKlimenko-dev/parametric3d-rep)";
const SHA = "c0ffee1234567890";
const repos = {
  "VladKlimenko-dev/parametric3d-rep": { "README.md": "# Parametric3D\nMARKER_README_7731 kernel overview\n", "docs/Guide.MD": "Guide\nMARKER_GUIDE_4410\n",
    "docs/deep/notes.md": "notes MARKER_NOTES_9902\n", "src/kernel.cs": "class Kernel { /* MARKER_KERNEL_5150 */ }\n", "logo.png": "\u0000PNG" },
  "big/docs": { "A.md": "A".repeat(20000) + "\nMARKER_BIG_TAIL\n", "B.md": "MARKER_B\n", "C.md": "MARKER_C\n" },
  "broken/repo": { "README.md": "x" },
  "slow/repo": { "README.md": "MARKER_SLOW_1\n", "two.md": "MARKER_SLOW_2\n" },
};
const calls = [];
let slowGate = null;
const gh = http.createServer(async (req, res) => {
  calls.push({ method: req.method, url: req.url });
  const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)(.*)$/); const files = m && repos[`${m[1]}/${m[2]}`];
  if (!files) return json(404, { message: "Not Found" });
  const rest = m[3];
  if (rest === "") return json(200, { full_name: `${m[1]}/${m[2]}`, default_branch: "main", private: false });
  if (rest.startsWith("/branches/")) return json(200, { commit: { sha: SHA, commit: { tree: { sha: "root" } } } });
  if (rest === "/git/trees/root?recursive=1") return json(200, { truncated: false, tree: Object.keys(files).map(p => ({ path: p, type: "blob" })) });
  const c = rest.match(/^\/contents\/(.+)\?ref=([^&]+)$/);
  if (c) {
    assert.equal(c[2], SHA, "contents pinned to the listed commit"); assert.equal(req.headers.accept, "application/vnd.github.raw+json");
    if (m[1] === "broken") return json(500, { message: "Server Error" });
    if (m[1] === "slow" && slowGate) await slowGate;
    const p = c[1].split("/").map(decodeURIComponent).join("/");
    if (!(p in files)) return json(404, { message: "Not Found" });
    res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(Buffer.from(files[p], "utf8"));
  }
  json(404, { message: "Not Found" });
});
await new Promise(r => gh.listen(0, "127.0.0.1", r));
const prompts = [];
const model = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") return res.end('{"data":[{"id":"fixture"}]}');
  let raw = ""; for await (const c of req) raw += c; const body = JSON.parse(raw); prompts.push(body);
  const user = body.messages.find(m => m.role === "user").content;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = content => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  if (user.startsWith("Choose which repository files to read")) send(JSON.stringify({ paths: user.includes("ALREADY READ: none") ? ["src/kernel.cs", "invented/x.cs"] : [] }));
  else if (user.includes("Return ONLY JSON")) send(JSON.stringify({ route: "plan", steps: [{ role: "coder", title: "Implement" }] }));
  else if (user.startsWith("USER MESSAGE:")) send("SUMMARY OK");
  else send("SPECIALIST OUTPUT");
  res.end("data: [DONE]\n\n");
});
await new Promise(r => model.listen(0, "127.0.0.1", r));

const READ_ALL = `Check the repo at web address ${URL_MD} and read all MD-files, then summarize them.`;
const db = new DatabaseSync(path.join(temp, "data.db"));
db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL)");
const agents = [{ role: "orchestrator", name: "Orchestrator", model: "m", enabled: true, prompt: "orchestrate the work" }, { role: "architect", name: "Architect", model: "m", enabled: true, prompt: "design the solution" }];
db.prepare("INSERT INTO records(kind,data) VALUES(?,?)").run("run", JSON.stringify({ request: READ_ALL, mode: "ollama", projectId: null, projectName: "General", agents, status: "approval", phase: "planning",
  steps: [{ role: "architect", title: "Define the plan to read all MD-files", status: "queued" }], events: [], createdAt: "2026-11-01T00:00:00Z", context: "FastAPI service", contextReady: true })); // id 1
db.close();
fs.mkdirSync(path.join(temp, "secrets"), { recursive: true });

const port = 15561, base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DATA_FILE: path.join(temp, "data.db"), RELAY_SECRETS_DIR: path.join(temp, "secrets"),
  RELAY_WORKSPACE: path.join(temp, "ws"), GITHUB_API: `http://127.0.0.1:${gh.address().port}`, RELAY_RUNTIME: "openai", OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, RELAY_THINK: "1", RELAY_CTX: "8192" };
let server, log = "";
const wait = async (check, label) => { const until = Date.now() + 15000; while (Date.now() < until) { const r = await check(); if (r) return r; await new Promise(r => setTimeout(r, 40)); } throw Error(`Timeout: ${label}\n${log}`); };
const call = async (route, body) => { const r = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data = text; try { data = JSON.parse(text); } catch { } return { status: r.status, data }; };
const settle = id => wait(async () => { const r = (await call(`/api/runs/${id}`)).data; return ["complete", "failed", "approval", "paused"].includes(r.status) && r; }, `run ${id}`);
const start = async request => settle((await call("/api/runs", { request, mode: "ollama", projectId: null })).data.id);
const contents = () => calls.filter(c => c.url.includes("/contents/")).map(c => decodeURIComponent(c.url.split("/contents/")[1].split("?")[0]));
const userOf = p => p.messages.find(m => m.role === "user").content;
const planner = () => prompts.filter(p => userOf(p).includes("Return ONLY JSON") && !userOf(p).startsWith("Choose which"));
try {
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", b => log += b); server.stderr.on("data", b => log += b);
  await wait(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "start");

  // 1) exact Markdown URL, read + summarize all MD files: blobs fetched at the commit, contents reach the model, no plan
  let r = await start(READ_ALL);
  assert.equal(r.status, "complete", r.error); assert.equal(r.steps.length, 0); assert.equal(planner().length, 0, "no planner/architect");
  assert.deepEqual(contents(), ["README.md", "docs/Guide.MD", "docs/deep/notes.md"]);
  const answerPrompt = prompts.find(p => userOf(p).startsWith("USER MESSAGE:"));
  for (const mk of ["MARKER_README_7731", "MARKER_GUIDE_4410", "MARKER_NOTES_9902"]) assert.ok(userOf(answerPrompt).includes(mk), mk);
  assert.ok(!userOf(answerPrompt).includes("MARKER_KERNEL"), "only requested files");
  assert.match(userOf(answerPrompt), /untrusted data/); assert.equal(answerPrompt.chat_template_kwargs.enable_thinking, true, "final answer keeps thinking");
  assert.match(r.answer.text, /^SUMMARY OK\n\n---\nFiles read by the Relay backend/); assert.match(r.answer.text, /All requested files were read in full/);
  assert.ok(r.events.some(e => /^Reading docs\/Guide\.MD at c0ffee1: \d+ bytes, \d+ lines/.test(e.message)));
  assert.equal(r.connectorSources.filter(s => s.url.includes(`/blob/${SHA}/`)).length, 3);

  // 2) list-only request stays a tree listing (no contents, no model)
  calls.length = 0; prompts.length = 0;
  r = await start(`Check the repo at web address ${URL_MD} and list all MD-files.`);
  assert.equal(r.inventory.total, 3); assert.equal(contents().length, 0); assert.equal(prompts.length, 0);

  // 3) named file is read first and only; 4) generic analysis: model picks from the real tree, invented path ignored, stops on no progress
  calls.length = 0; prompts.length = 0;
  r = await start(`Read docs/Guide.MD from ${URL_MD} and explain it.`);
  assert.deepEqual(contents(), ["docs/Guide.MD"]); assert.equal(r.status, "complete");
  calls.length = 0; prompts.length = 0;
  r = await start(`Analyze the architecture of ${URL_MD}.`);
  const sel = prompts.filter(p => userOf(p).startsWith("Choose which"));
  assert.equal(sel.length, 2, "bounded: second round returned nothing"); assert.equal(sel[0].chat_template_kwargs.enable_thinking, false, "selection without thinking");
  assert.ok(sel[0].max_tokens <= 1024); assert.deepEqual(contents(), ["src/kernel.cs"]);
  assert.ok(r.events.some(e => /1 path\(s\) not in the tree were ignored/.test(e.message))); assert.equal(planner().length, 0);

  // 5) limits: oversized file truncated, remaining files disclosed as not read, never "complete"
  calls.length = 0; prompts.length = 0;
  r = await start("Read all MD files of https://github.com/big/docs and summarize.");
  assert.equal(r.status, "complete", r.error); assert.match(r.answer.text, /A\.md` - \d+ bytes, \d+ lines, TRUNCATED/);
  assert.match(r.answer.text, /NOT READ \(context limit\): 2 matching file\(s\)/); assert.match(r.answer.text, /Coverage is INCOMPLETE/);
  assert.ok(!userOf(prompts.at(-1)).includes("MARKER_BIG_TAIL"));

  // 6) honest errors: private/missing repo (404), GitHub HTTP failure on contents; the model is not asked
  prompts.length = 0;
  r = await start("Read all MD files in https://github.com/ghost/private-repo and summarize them.");
  assert.equal(r.status, "failed"); assert.match(r.error, /GitHub 404/);
  r = await start("Read all MD files in https://github.com/broken/repo and summarize them.");
  assert.equal(r.status, "failed"); assert.match(r.error, /GitHub request failed \(500/); assert.equal(prompts.length, 0);

  // 7) stale architect plan for a read request: approving it reads files and answers instead
  calls.length = 0; prompts.length = 0;
  assert.equal((await call("/api/runs/1/start", {})).status, 200);
  r = await wait(async () => { const x = (await call("/api/runs/1")).data; return x.status === "complete" && x; }, "stale");
  assert.equal(r.steps.length, 0); assert.equal(contents().length, 3); assert.equal(planner().length, 0); assert.ok(!userOf(prompts.at(-1)).includes("FastAPI"));

  // 8) new turn is not contaminated by the previous turn's file contents
  prompts.length = 0;
  assert.equal((await call(`/api/runs/1/messages`, { request: "Implement a STEP parser with tests.", expectedTurn: 0 })).status, 202);
  r = await settle(1); assert.equal(r.status, "approval");
  assert.ok(planner().length === 1 && !userOf(planner()[0]).includes("MARKER_README_7731"), "old file contents not in the new turn");

  // 9) coding request with a pasted URL: relevant files are read before planning and reach the planner
  prompts.length = 0; calls.length = 0;
  r = await start(`Implement a STEP importer for ${URL_MD}.`);
  assert.equal(r.status, "approval"); assert.ok(userOf(planner()[0]).includes("MARKER_KERNEL_5150")); assert.deepEqual(contents(), ["src/kernel.cs"]);

  // 10) pause during reading cancels it; resume reads again and answers
  let release; slowGate = new Promise(res => { release = res; });
  const slow = (await call("/api/runs", { request: "Read all MD files of https://github.com/slow/repo and summarize.", mode: "ollama", projectId: null })).data;
  await wait(async () => calls.some(c => c.url.includes("/repos/slow/repo/contents/")), "slow read started");
  assert.equal((await call(`/api/runs/${slow.id}/pause`, {})).status, 200);
  r = await settle(slow.id); assert.equal(r.status, "paused"); slowGate = null; release();
  assert.equal((await call(`/api/runs/${slow.id}/resume`, {})).status, 200);
  r = await wait(async () => { const x = (await call(`/api/runs/${slow.id}`)).data; return x.status === "complete" && x; }, "resumed");
  assert.match(r.answer.text, /README\.md/); assert.match(r.answer.text, /two\.md/);

  assert.ok(calls.every(c => c.method === "GET"), "GitHub is read-only");
  console.log("PASS: read-first: exact Markdown URL read+summarize fetched 3 .md blobs at the pinned commit and answered directly with their markers and a backend file report; list-only unchanged; named file read alone; generic analysis used 2 bounded thinking-off selection rounds from the real tree (invented path ignored); truncation/not-read disclosed; 404/500 surfaced without model call; stale plan rerouted; new turn uncontaminated; pasted-URL coding request planned with real files; pause/resume during reads; GitHub GET-only.");
} finally {
  if (server?.exitCode === null) server.kill("SIGTERM");
  gh.close(); model.close();
}
