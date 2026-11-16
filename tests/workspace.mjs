// Projects/conversations, example migration, retained files, local folders, sources, thinking buffer and inference-device evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFileSync } from "node:child_process";
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-workspace-"));
// ---- unit: inference device from the running model's own log
const bundle = path.join(root, "node_modules/.relay-unit/inference.mjs");
execFileSync(path.join(root, "node_modules/.bin/esbuild"), ["server/inferenceDevice.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=error"]);
const { parseModelLog, detectInference } = await import(bundle);
const vulkan = "ggml_vulkan: Found 2 Vulkan devices:\nggml_vulkan: 0 = NVIDIA GeForce RTX 3070 (NVIDIA) | uma: 0\nggml_vulkan: 1 = Intel(R) Arc(TM) Pro B60 Graphics (Intel Corporation) | uma: 0\nllama_model_load_from_file_impl: using device Vulkan1 (Intel(R) Arc(TM) Pro B60 Graphics) - 24000 MiB free\nload_tensors: offloaded 65/65 layers to GPU\n";
assert.deepEqual(parseModelLog(vulkan).used, [{ id: "Vulkan1", name: "Intel(R) Arc(TM) Pro B60 Graphics" }], "only the device actually used, not every installed GPU");
const cuda = "ggml_cuda_init: found 1 CUDA devices:\n  Device 0: NVIDIA GeForce RTX 3070, compute capability 8.6, VMM: yes\nload_tensors:        CUDA0 model buffer size =  6000.00 MiB\nload_tensors: offloaded 20/49 layers to GPU\n";
assert.equal(parseModelLog(cuda).used[0].name, "NVIDIA GeForce RTX 3070");
assert.equal(parseModelLog("load_tensors: offloaded 0/49 layers to GPU\n").offloaded.done, 0);
const gpuRoot = path.join(temp, "gpu"); fs.mkdirSync(path.join(gpuRoot, "logs"), { recursive: true });
assert.equal(detectInference({ root: gpuRoot, connected: true }).state, "unknown", "no process record -> unknown");
fs.writeFileSync(path.join(gpuRoot, ".relay-model.json"), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 1000).toISOString() }));
fs.writeFileSync(path.join(gpuRoot, "logs/model.stderr.log"), vulkan);
const found = detectInference({ root: gpuRoot, connected: true });
assert.equal(found.state, "confirmed"); assert.match(found.devices[0], /B60/); assert.doesNotMatch(found.devices.join(), /3070/);
const old = new Date(Date.now() - 3600_000); fs.utimesSync(path.join(gpuRoot, "logs/model.stderr.log"), old, old);
assert.equal(detectInference({ root: gpuRoot, connected: true }).state, "unknown", "stale log from an earlier launch is not trusted");
assert.equal(detectInference({ root: gpuRoot, connected: false }).state, "unknown");
fs.writeFileSync(path.join(gpuRoot, "logs/model.stderr.log"), cuda.replace("20/49", "0/49"));
assert.equal(detectInference({ root: gpuRoot, connected: true }).state, "cpu");

// ---- legacy database with the seeded example
const EXAMPLE = "# Example project\nA local-first task API. This is sample context, not your repository.\nUse Python and FastAPI. Store task IDs, titles and completion status. Include validation and tests.";
const db = new DatabaseSync(path.join(temp, "data.db"));
db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL)");
const put = (kind, data) => db.prepare("INSERT INTO records(kind,data) VALUES(?,?)").run(kind, JSON.stringify(data));
const baseRun = { mode: "ollama", status: "complete", steps: [], events: [], createdAt: "2026-01-01T00:00:00Z" };
put("project", { name: "Getting started", language: "Python", description: "A small example project to explore the workflow.", sample: true, files: [{ name: "README.md", content: EXAMPLE }, { name: "mine.py", content: "print('user file')" }] }); // id 1, used
put("project", { name: "Getting started", language: "Python", description: "x", sample: true, files: [{ name: "README.md", content: EXAMPLE }] }); // id 2, untouched
put("run", { ...baseRun, request: "Real conversation in the example project", projectId: 1, projectName: "Getting started" }); // id 3
put("run", { ...baseRun, request: "Conversation without a project", projectId: null, projectName: "No project" }); // id 4
db.close();

// ---- streaming model fixture: 400 reasoning lines, then an answer
const prompts = [];
const model = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") return res.end('{"data":[{"id":"fixture"}]}');
  let raw = ""; for await (const chunk of req) raw += chunk;
  const prompt = JSON.parse(raw).messages.find(m => m.role === "user").content; prompts.push(prompt);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  if (prompt.includes("Return ONLY JSON")) send({ content: JSON.stringify({ steps: [{ role: "coder", title: "Fix notes" }] }) });
  else { for (let i = 0; i < 400; i++) send({ reasoning_content: `reasoning line ${i}\n` }); send({ content: "GENERATED ANSWER unique" }); }
  res.end("data: [DONE]\n\n");
});
await new Promise(r => model.listen(0, "127.0.0.1", r));
const port = 15511, base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DATA_FILE: path.join(temp, "data.db"),
  RELAY_SECRETS_DIR: path.join(temp, "secrets"), RELAY_RUNTIME: "openai", OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, RELAY_THINK: "0" };
let server, log = "";
const wait = async (check, label) => { const until = Date.now() + 15000; while (Date.now() < until) { const r = await check(); if (r) return r; await new Promise(r => setTimeout(r, 40)); } throw Error(`Timeout: ${label}\n${log}`); };
const call = async (route, body, method = body === undefined ? "GET" : "POST") => {
  const r = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data = text; try { data = JSON.parse(text); } catch { } return { status: r.status, data };
};
const launch = async () => { server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); server.stdout.on("data", b => log += b); server.stderr.on("data", b => log += b);
  await wait(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "start"); };
const stop = async () => { if (server?.exitCode === null) { const d = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await d; } };
try {
  await launch();
  let projects = (await call("/api/projects")).data;
  assert.ok(!projects.some(p => p.sample || p.name === "Getting started"), "example removed");
  assert.ok(!projects.some(p => p.id === 2), "untouched example deleted");
  const general = projects.find(p => p.id === 1);
  assert.equal(general.name, "General"); assert.deepEqual(general.files.map(f => f.name), ["mine.py"], "user file kept, example README dropped");
  const runs = (await call("/api/runs")).data;
  assert.equal(runs.find(r => r.id === 3).projectId, 1, "conversation kept in migrated project");
  assert.equal(runs.find(r => r.id === 4).projectId, 1, "unassigned conversation moved to General");
  await stop(); await launch();
  assert.equal((await call("/api/projects")).data.length, projects.length, "example never reseeded");

  // project + local folder
  const alpha = (await call("/api/projects", { name: "Alpha", description: "", language: "Mixed", files: [] })).data;
  const folder = path.join(temp, "proj"); fs.mkdirSync(path.join(folder, "sub"), { recursive: true });
  fs.writeFileSync(path.join(folder, "notes.txt"), "FOLDER CONTENT 42"); fs.writeFileSync(path.join(folder, ".env"), "TOKEN=x");
  fs.writeFileSync(path.join(temp, "outside.txt"), "OUTSIDE"); fs.symlinkSync(path.join(temp, "outside.txt"), path.join(folder, "link.txt"));
  assert.equal((await call(`/api/projects/${alpha.id}/folders`, { path: "relative/dir" })).status, 400);
  assert.equal((await call(`/api/projects/${alpha.id}/folders`, { path: "/" })).status, 400, "filesystem root rejected");
  const reg = await call(`/api/projects/${alpha.id}/folders`, { path: folder }); assert.equal(reg.status, 201);
  assert.equal((await call(`/api/folders/${reg.data.id}/file?path=notes.txt`)).data, "FOLDER CONTENT 42");
  for (const bad of ["../outside.txt", "link.txt", ".env", "/etc/passwd", "sub/../../outside.txt"]) assert.equal((await call(`/api/folders/${reg.data.id}/file?path=${encodeURIComponent(bad)}`)).status, 403, bad);

  // pending upload attached to the first message; sources and generated file
  const up = await call("/api/files", { name: "spec.md", dataBase64: Buffer.from("UPLOADED SPEC 7").toString("base64"), runId: null, projectId: alpha.id });
  assert.equal(up.status, 201);
  const run = (await call("/api/runs", { request: "Please inspect notes.txt and fix it.", mode: "ollama", projectId: alpha.id, attachments: [up.data.id] })).data;
  const planned = await wait(async () => { const r = (await call(`/api/runs/${run.id}`)).data; return r.status === "approval" && r; }, "approval");
  assert.match(prompts[0], /FOLDER CONTENT 42/); assert.match(prompts[0], /UPLOADED SPEC 7/);
  assert.doesNotMatch(prompts[0], /OUTSIDE|TOKEN=x|link\.txt/, "no symlink escape or sensitive files");
  assert.deepEqual(planned.localSources.filter(s => s.kind === "file").map(s => s.path), ["notes.txt"]);
  assert.equal(planned.connectorSources, undefined, "no fabricated connector sources");
  await call(`/api/runs/${run.id}/start`, {});
  await wait(async () => (await call(`/api/runs/${run.id}`)).data.status === "complete", "complete");
  let files = (await call(`/api/files?runId=${run.id}`)).data;
  assert.deepEqual(files.map(f => f.origin).sort(), ["generated", "uploaded"]);
  const generated = files.find(f => f.origin === "generated");
  assert.match((await call(`/api/files/${generated.id}/download`)).data, /GENERATED ANSWER unique/);
  // thinking buffer: latest 300 lines, kept after the generation ends
  const progress = (await call("/api/progress")).data;
  assert.equal(progress.active, false); assert.equal(progress.last.runId, run.id);
  const lines = progress.last.log.split("\n"); assert.ok(lines.length <= 300, `${lines.length} lines`);
  assert.match(progress.last.log, /reasoning line 399/); assert.doesNotMatch(progress.last.log, /reasoning line 10\n/);

  // rename, move, archive
  assert.equal((await call(`/api/runs/${run.id}`, { title: "Notes fix" }, "PATCH")).data.title, "Notes fix");
  assert.equal((await call(`/api/runs/${run.id}`, { projectId: 999 }, "PATCH")).status, 404);
  const moved = (await call(`/api/runs/${run.id}`, { projectId: 1 }, "PATCH")).data;
  assert.equal(moved.projectId, 1); assert.equal(moved.projectName, "General");
  assert.equal((await call(`/api/runs/${run.id}`, { archived: true }, "PATCH")).data.archived, true);
  assert.equal((await call(`/api/projects/${alpha.id}`, { archived: true }, "PATCH")).data.archived, true);
  assert.equal((await call("/api/runs", { request: "new in archived", mode: "ollama", projectId: alpha.id })).status, 409);

  // deleting a conversation keeps retained files unless explicitly requested
  const del = (await call(`/api/runs/${run.id}`, undefined, "DELETE")).data;
  assert.equal(del.filesRetained, 2);
  files = (await call("/api/files")).data.filter(f => f.runId === run.id);
  assert.equal(files.length, 2); assert.ok(files.every(f => f.conversationExists === false));
  assert.equal((await call(`/api/files/${generated.id}`, undefined, "DELETE")).status, 200);
  assert.ok(!fs.readdirSync(path.join(temp, "files")).some(n => n.startsWith(`${generated.id}-`)), "explicit delete removes the file");
  // project deletion with its conversations; registered folder contents untouched
  const second = (await call("/api/runs", { request: "General follow-up conversation", mode: "ollama", projectId: 1 })).data;
  await wait(async () => (await call(`/api/runs/${second.id}`)).data.status === "approval", "approval 2");
  await call(`/api/runs/${second.id}/cancel`, {});
  const delProject = (await call("/api/projects/1?files=delete", undefined, "DELETE")).data;
  assert.equal(delProject.deleted, true); assert.ok(delProject.conversations >= 3);
  assert.equal((await call(`/api/runs/${second.id}`)).status, 404);
  assert.equal((await call(`/api/projects/${alpha.id}`, undefined, "DELETE")).data.deleted, true);
  assert.equal(fs.readFileSync(path.join(folder, "notes.txt"), "utf8"), "FOLDER CONTENT 42", "folder contents never deleted");
  console.log("PASS: GPU-from-running-log evidence, example migration without loss or reseed, project/conversation create-move-rename-archive-delete, retained files (generated/uploaded, download, explicit delete), local-folder root/traversal/symlink/sensitive guards and request-scoped reads, honest sources, 300-line thinking buffer kept after generation.");
} finally { await stop(); model.close(); }
