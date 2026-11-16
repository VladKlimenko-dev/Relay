// Display-only thinking summaries from a separate CPU summarizer (mock): cadence, one request at a time, stale
// generations dropped, failures -> unavailable, loopback only, never part of the main model's prompts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-summarizer-"));
const bundle = path.join(root, "node_modules/.relay-unit/summarizer.mjs");
execFileSync(path.join(root, "node_modules/.bin/esbuild"), ["server/summarizer.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=error"]);
const { ThinkingSummarizer, reasoningExcerpt, cleanSummary } = await import(bundle);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- unit
const log = "--- model reasoning (as streamed) ---\nПроверяю структуру репозитория и ищу файлы.\n--- answer text (as streamed) ---\nANSWER PART";
assert.equal(reasoningExcerpt(log), "Проверяю структуру репозитория и ищу файлы.", "reasoning only, no answer text");
assert.equal(cleanSummary("<think>x</think>Summary: One. Two! Three."), "One. Two!");
assert.equal(new ThinkingSummarizer("http://10.0.0.5:8091/v1", true).status().configured, false, "non-loopback rejected");
assert.equal(new ThinkingSummarizer("http://127.0.0.1:8091", true).status().endpoint, "http://127.0.0.1:8091/v1");
const reqs = []; let release;
const fake = (url, init) => { reqs.push({ url, body: JSON.parse(init.body), signal: init.signal });
  return new Promise((resolve, reject) => { release = text => resolve({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) });
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }); };
const s = new ThinkingSummarizer("http://127.0.0.1:9999/v1", true, 1000, fake);
const got = []; const pub = x => got.push(x);
const long = "--- model reasoning (as streamed) ---\n" + "reasoning about the parser ".repeat(20);
s.tick("a", long, 100, pub, 0); assert.equal(reqs.length, 0, "waits for the cadence");
s.tick("a", long, 100, pub, 1500); assert.equal(reqs.length, 1);
s.tick("a", long, 500, pub, 5000); assert.equal(reqs.length, 1, "one request in flight; later ticks are skipped, not queued");
assert.match(reqs[0].body.messages[1].content, /Previous status: \(none\)/);
release("It is analysing the parser. Extra. More."); await sleep(10);
assert.equal(got.at(-1).text, "It is analysing the parser. Extra.");
s.tick("a", long, 120, pub, 7000); assert.equal(reqs.length, 1, "needs new reasoning tokens");
s.tick("a", long, 600, pub, 7000); assert.equal(reqs.length, 2); assert.match(reqs[1].body.messages[1].content, /Previous status: It is analysing/);
s.tick("b", long, 10, pub, 7100); // new generation: abort and clear
assert.equal(reqs[1].signal.aborted, true); assert.equal(got.at(-1), undefined, "stale summary cleared");
release("Stale text."); await sleep(10); assert.equal(got.at(-1), undefined, "late reply for the old generation dropped");
assert.equal(s.status().state, "idle", "a deliberate cancel is not a failure");
const down = new ThinkingSummarizer("http://127.0.0.1:9999/v1", true, 0, () => Promise.reject(new Error("ECONNREFUSED")));
for (let i = 0; i < 3; i++) { down.tick("k", long, 100 * (i + 1), () => {}, 1000 * (i + 1)); await sleep(5); }
assert.equal(down.status().state, "unavailable"); assert.match(down.status().lastError, /paused after 3 failures/);

// ---- integration: main model streams reasoning slowly; the summarizer mock answers
const mainPrompts = [], sumPrompts = [];
const model = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") return res.end('{"data":[{"id":"fixture"}]}');
  let raw = ""; for await (const c of req) raw += c; mainPrompts.push(raw);
  const user = JSON.parse(raw).messages.find(m => m.role === "user").content;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  if (user.includes("Return ONLY JSON")) send({ content: JSON.stringify({ route: "direct", steps: [] }) });
  else { for (let i = 0; i < 60; i++) { send({ reasoning_content: `step ${i}: comparing B-rep edge cases carefully\n` }); await sleep(100); } send({ content: "FINAL ANSWER" }); }
  res.end("data: [DONE]\n\n");
});
const summ = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c; sumPrompts.push(raw);
  await sleep(200);
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "SUMMARY-MARK: the model compares B-rep edge cases." } }] }));
});
await new Promise(r => model.listen(0, "127.0.0.1", r)); await new Promise(r => summ.listen(0, "127.0.0.1", r));
const port = 15541, base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DATA_FILE: path.join(temp, "data.db"), RELAY_SECRETS_DIR: path.join(temp, "secrets"),
  RELAY_RUNTIME: "openai", OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, RELAY_SUMMARIZER_URL: `http://127.0.0.1:${summ.address().port}/v1`, RELAY_SUMMARY_SECONDS: "2" };
let server, out = "";
const call = async (route, body, method = body === undefined ? "GET" : "POST") => { const r = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
const wait = async (check, label) => { const until = Date.now() + 20000; while (Date.now() < until) { const r = await check(); if (r) return r; await sleep(100); } throw Error(`Timeout: ${label}\n${out}`); };
try {
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", b => out += b); server.stderr.on("data", b => out += b);
  await wait(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "start");
  assert.equal((await call("/api/summarizer")).data.state, "idle");
  const run = (await call("/api/runs", { request: "What does a B-rep edge mean?", mode: "ollama", projectId: null })).data;
  const live = await wait(async () => { const p = (await call("/api/progress")).data; return p.active && p.summary && p; }, "summary while streaming");
  assert.match(live.summary.text, /SUMMARY-MARK/); assert.match(live.log, /comparing B-rep/, "raw thinking still available");
  const done = await wait(async () => { const r = (await call(`/api/runs/${run.id}`)).data; return r.status === "complete" && r; }, "complete");
  assert.equal(done.answer.text, "FINAL ANSWER"); assert.match(done.thinkingSummary.text, /SUMMARY-MARK/, "persisted with the conversation");
  assert.match((await call("/api/progress")).data.last.summary.text, /SUMMARY-MARK/);
  assert.ok(sumPrompts.length >= 1 && sumPrompts.every(p => !p.includes("PREVIOUS CONVERSATION") && !p.includes("What does a B-rep edge mean")), "summarizer gets only the reasoning excerpt");
  assert.equal(JSON.parse(sumPrompts[0]).max_tokens, 90);
  // follow-up: no stale summary, and summaries never reach the main model
  const f = await call(`/api/runs/${run.id}/messages`, { request: "And a B-rep face?", expectedTurn: 0 });
  assert.equal(f.status, 202); assert.equal(f.data.thinkingSummary, undefined, "no stale summary in the next turn");
  await wait(async () => (await call(`/api/runs/${run.id}`)).data.status === "complete", "follow-up");
  assert.ok(mainPrompts.every(p => !p.includes("SUMMARY-MARK")), "summaries never in main prompts");
  // disable
  assert.equal((await call("/api/summarizer", { enabled: false }, "PUT")).data.state, "disabled");
  console.log(`PASS: display-only thinking summaries (${sumPrompts.length} summarizer calls): cadence, single in-flight request, skip instead of queue, stale generation dropped, failures -> unavailable, loopback only, persisted with the run, never in main prompts, enable/disable.`);
} finally { if (server?.exitCode === null) server.kill("SIGTERM"); model.close(); summ.close(); }
