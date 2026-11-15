// Real Relay process + SQLite + controlled streaming model fixture. No real model/GitHub/network changes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pause-"));
const selectionBundle = path.join(root, "node_modules/.relay-unit/session-selection.mjs");
execFileSync(path.join(root, "node_modules/.bin/esbuild"), ["shared/sessionSelection.ts", "--bundle", "--platform=node",
  "--format=esm", `--outfile=${selectionBundle}`, "--log-level=error"]);
const { sessionToRestore } = await import(selectionBundle);
const savedRuns = [
  { id: 1, status: "paused", createdAt: "2026-01-01", savedAt: "2026-01-02" },
  { id: 2, status: "cancelled", createdAt: "2026-01-01", savedAt: "2026-01-04" },
  { id: 3, status: "complete", createdAt: "2026-01-03" },
];
assert.equal(sessionToRestore(savedRuns).id, 2, "stopped run reopens without browser storage");
assert.equal(sessionToRestore(savedRuns, "3").id, 3, "completed remembered run reopens");
assert.equal(sessionToRestore(savedRuns, "999").id, 2, "stale browser selection falls back to latest saved");
assert.equal(sessionToRestore([]), undefined);
const port = 15506, base = `http://127.0.0.1:${port}`, logs = [];
const output = "```python\n" + "print('saved response')\n".repeat(14) + "```\nDone.";
let activeCalls = 0;
const model = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") return res.end('{"data":[{"id":"fixture"}]}');
  let raw = ""; for await (const c of req) raw += c;
  const body = JSON.parse(raw), prompt = body.messages[1].content;
  const planning = prompt.includes("Return ONLY JSON"), architect = prompt.includes("ASSIGNED STEP:\nArchitecture");
  const prefix = body.messages.find(m => m.role === "assistant")?.content || "";
  logs.push({ planning, architect, prefix, request: prompt, model: body.model });
  assert.equal(activeCalls, 0, "model calls remain sequential");
  activeCalls++;
  const text = planning ? JSON.stringify({ steps: [{ role: "architect", title: "Architecture" }, { role: "coder", title: "Draft code" }] })
    : architect ? "Architecture complete." : output.slice(prefix.length);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let at = 0, closed = false;
  const timer = setInterval(() => {
    if (at >= text.length) {
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); res.end(); return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(at, at + 9) } }] })}\n\n`);
    at += 9;
  }, planning ? 100 : architect ? 15 : 50);
  res.on("close", () => { clearInterval(timer); if (!closed) { activeCalls--; closed = true; } });
});
await new Promise(r => model.listen(0, "127.0.0.1", r));
const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
  DATA_FILE: path.join(dir, "data.db"), RELAY_SECRETS_DIR: path.join(dir, "secrets"),
  RELAY_RUNTIME: "openai", OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, RELAY_THINK: "0" };
let server, serverLog = "";
const wait = async (fn, label) => {
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 60)); }
  throw Error(`Timeout: ${label}\n${serverLog}`);
};
const api = async (route, data) => {
  const r = await fetch(base + route, { method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: r.status, body: await r.json() };
};
const get = async id => (await api(`/api/runs/${id}`)).body;
const until = (id, predicate) => wait(async () => { const r = await get(id); if (r.status === "failed") throw Error(r.error); return predicate(r) && r; }, "run checkpoint");
async function launch() {
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", b => serverLog += b); server.stderr.on("data", b => serverLog += b);
  await wait(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "startup");
}
async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const done = new Promise(r => server.once("exit", r)); server.kill("SIGKILL"); await done;
  }
  await wait(() => activeCalls === 0, "model cancellation");
}
async function newRun(request) {
  const r = await api("/api/runs", { request, projectId: null, mode: "ollama" });
  assert.equal(r.status, 202); assert.equal(r.body.status, "planning"); return r.body.id;
}
try {
  await launch();
  const id = await newRun("Сохрани текущий ответ and continue after restart");
  await until(id, r => r.planningOutput?.length > 8);
  assert.equal((await api(`/api/runs/${id}/pause`, {})).status, 200);
  const plannedPause = await until(id, r => r.status === "paused");
  assert.ok(plannedPause.planningOutput); assert.ok(plannedPause.savedAt);
  await stop(); await launch();
  assert.equal((await get(id)).status, "paused");
  assert.equal((await get(id)).planningOutput, plannedPause.planningOutput);
  assert.equal((await api(`/api/runs/${id}/resume`, {})).status, 200);
  await until(id, r => r.status === "approval");
  assert.equal((await api(`/api/runs/${id}/start`, {})).status, 200);
  await until(id, r => r.steps[0].status === "complete" && r.steps[1].output?.length > 30);
  await api(`/api/runs/${id}/pause`, {});
  const paused = await until(id, r => r.status === "paused");
  const prefix = paused.steps[1].output, architecture = paused.steps[0].output;
  assert.ok(prefix); assert.equal(paused.steps[1].status, "paused");
  const sessionFile = path.join(dir, "sessions", `session-${id}.json`);
  const snapshot = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(snapshot.format, "relay-session"); assert.equal(snapshot.run.status, "paused");
  assert.equal(snapshot.run.steps[1].output, prefix);
  assert.equal(snapshot.run.steps[1].modelRequest.runtime, "openai");
  assert.match(snapshot.run.steps[1].modelRequest.body.messages[1].content, /Сохрани текущий ответ/);
  assert.ok(snapshot.run.agents.length); assert.ok(snapshot.run.progress.outTokens > 0);
  assert.ok(snapshot.run.plannerRequest.body.messages[0].content);
  const savedModel = snapshot.run.steps[1].modelRequest.body.model;
  // A successful pause is durable immediately, before shutting down the process.
  const db = new DatabaseSync(env.DATA_FILE, { readOnly: true });
  assert.deepEqual(db.prepare("PRAGMA table_info(records)").all().map(r => r.name), ["id", "kind", "data"]);
  const stored = JSON.parse(db.prepare("SELECT data FROM records WHERE id=?").get(id).data);
  assert.equal(stored.status, "paused"); assert.equal(stored.steps[1].output, prefix); db.close();
  await stop();
  env.RELAY_MODEL = "changed-after-pause";
  env.RELAY_RUNTIME = "ollama"; env.OLLAMA_HOST = "http://127.0.0.1:1";
  await launch();
  assert.equal((await get(id)).steps[1].output, prefix);
  await api(`/api/runs/${id}/resume`, {});
  await until(id, r => r.steps[1].output?.length > prefix.length + 20);
  await api(`/api/runs/${id}/pause`, {});
  const pausedAgain = await until(id, r => r.status === "paused");
  assert.ok(pausedAgain.steps[1].output.startsWith(prefix));
  await api(`/api/runs/${id}/resume`, {});
  const done = await until(id, r => r.status === "complete");
  assert.equal(done.steps[0].output, architecture);
  assert.equal(done.steps[1].output, output);
  assert.equal(logs.filter(x => x.architect).length, 1, "completed agent not rerun");
  assert.ok(logs.some(x => x.prefix === prefix), "partial response supplied to resumed model call");
  assert.equal(logs.find(x => x.prefix === prefix).model, savedModel, "saved model overrides changed defaults");
  await stop(); env.RELAY_RUNTIME = "openai"; await launch();
  // Crash recovery uses periodic checkpoints and does not automatically generate.
  const crash = await newRun("Crash recovery fixture request");
  await until(crash, r => r.status === "approval"); await api(`/api/runs/${crash}/start`, {});
  await until(crash, r => r.steps[1].output?.length > 30);
  await stop(); await launch();
  const recovered = await get(crash);
  assert.equal(recovered.status, "paused"); assert.ok(recovered.steps[1].output);
  const stopped = (await api(`/api/runs/${crash}/cancel`, {})).body;
  assert.equal(stopped.status, "cancelled");
  assert.ok(stopped.savedAt >= recovered.savedAt);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "sessions", `session-${crash}.json`))).run.status, "cancelled");
  await stop(); await launch();
  const restoredStop = await get(crash);
  assert.equal(restoredStop.status, "cancelled");
  assert.equal(restoredStop.steps[1].output, stopped.steps[1].output);
  assert.equal((await api(`/api/runs/${crash}/resume`, {})).status, 200);
  assert.equal((await until(crash, r => r.status === "complete")).steps[1].output, output);
  // Stopping before approval must never grant permission to execute agents.
  const discarded = await newRun("Discard and restore a plan");
  await until(discarded, r => r.status === "approval");
  await api(`/api/runs/${discarded}/cancel`, {});
  const previousSpecialistCalls = logs.filter(x => !x.planning).length;
  assert.equal((await api(`/api/runs/${discarded}/resume`, {})).status, 200);
  await until(discarded, r => r.status === "approval");
  assert.equal(logs.filter(x => !x.planning).length, previousSpecialistCalls);
  // A GitHub write whose outcome was not saved must not be replayed after a crash.
  await stop();
  const edit = new DatabaseSync(env.DATA_FILE);
  const uncertain = { ...done, status: "running", phase: "execution",
    gitActions: [{ type: "merge_pr", number: 12, status: "running" }] };
  const uncertainId = Number(edit.prepare("INSERT INTO records(kind,data) VALUES('run',?)").run(JSON.stringify(uncertain)).lastInsertRowid);
  edit.close(); await launch();
  assert.equal((await get(uncertainId)).gitActions[0].status, "uncertain");
  assert.equal((await api(`/api/runs/${uncertainId}/resume`, {})).status, 409);
  // Files alone restore missing runs on the server; keep the original test DB as a backup.
  await stop();
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = env.DATA_FILE + suffix;
    if (fs.existsSync(file)) fs.renameSync(file, file + ".backup");
  }
  await launch();
  assert.equal((await get(id)).steps[1].output, output);
  assert.equal((await get(uncertainId)).gitActions[0].status, "uncertain");
  console.log("PASS: stopped/completed session reopening, stopped-session file save/restart/resume, approval preserved after discarded-plan restoration, planning pause, durable snapshots, saved runtime defaults, partial continuation, completed-agent skipping, crash recovery, uncertain GitHub replay prevention, and file-only restoration.");
} finally {
  await stop(); await new Promise(r => model.close(r)); fs.rmSync(dir, { recursive: true, force: true });
}
