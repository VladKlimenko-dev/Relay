// Real isolated Relay API with a streaming model fixture. No real model or GitHub actions.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conversation-"));
const bundle = path.join(root, "node_modules/.relay-unit/conversation.mjs");
execFileSync(path.join(root, "node_modules/.bin/esbuild"), ["shared/conversation.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=error"]);
const { archiveTurn, conversationContext } = await import(bundle);
const fixture = { id: 1, request: "Original question", createdAt: "2026-01-01", status: "failed",
  steps: [{ role: "coder", status: "failed", output: "a".repeat(50000) }], events: [], turns: [] };
const archived = archiveTurn(fixture);
assert.ok(!("turns" in archived)); assert.ok(!("id" in archived));
archived.steps[0].output = "independent";
assert.equal(fixture.steps[0].output.length, 50000, "history is a deep copy");
for (const budget of [0, 100, 256, 1000, 10000]) {
  assert.ok(conversationContext([archiveTurn(fixture)], budget).length <= budget);
}
assert.match(conversationContext([archiveTurn(fixture)], 1000), /Original question/);
assert.match(conversationContext([archiveTurn(fixture)], 1000), /unfinished/);
const calls = [];
let executions = 0, server, serverLog = "", releaseFirst;
const model = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") return res.end('{"data":[{"id":"fixture"}]}');
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), prompt = body.messages.find(m => m.role === "user").content;
  const planning = prompt.includes("Return ONLY JSON");
  calls.push({ planning, prompt });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const text = planning ? JSON.stringify({ steps: [{ role: "coder", title: "Implement the reply" }] })
    : ++executions === 1 ? "FIRST PARTIAL RESPONSE unique" : "SECOND COMPLETE RESPONSE unique";
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  if (!planning && executions === 1) {
    releaseFirst = () => res.end('data: {"error":{"message":"fixture interruption"}}\n\n');
  } else res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
const port = 15509, base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
  DATA_FILE: path.join(temp, "data.db"), RELAY_SECRETS_DIR: path.join(temp, "secrets"),
  RELAY_RUNTIME: "openai", OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, RELAY_THINK: "0" };
async function wait(check, label) {
  const until = Date.now() + 12000;
  while (Date.now() < until) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 30)); }
  throw Error(`Timeout: ${label}\n${serverLog}`);
}
async function call(route, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + route, { method,
    headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function launch() {
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", b => serverLog += b); server.stderr.on("data", b => serverLog += b);
  await wait(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "server start");
}
async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const done = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await done;
  }
}
const untilStatus = (id, status) => wait(async () => {
  const run = (await call(`/api/runs/${id}`)).data; return run.status === status && run;
}, status);
try {
  await launch();
  const first = await call("/api/runs", { request: "Original request: build a C++ geometry library.", mode: "ollama", projectId: null });
  assert.equal(first.status, 202); const id = first.data.id;
  await untilStatus(id, "approval");
  assert.equal((await call(`/api/runs/${id}/messages`, { request: "premature reply", expectedTurn: 0 })).status, 409);
  assert.equal((await call(`/api/runs/${id}/start`, {})).status, 200);
  await wait(() => releaseFirst, "first streaming response");
  assert.equal((await call(`/api/runs/${id}`, undefined, "DELETE")).status, 409, "cannot delete active work");
  releaseFirst();
  releaseFirst = undefined;
  const failed = await untilStatus(id, "failed");
  assert.equal(failed.steps[0].output, "FIRST PARTIAL RESPONSE unique");
  const next = await call(`/api/runs/${id}/messages`, { request: "Explain the previous output and correct it.", expectedTurn: 0 });
  assert.equal(next.status, 202); assert.equal(next.data.id, id);
  assert.equal(next.data.turns.length, 1); assert.equal(next.data.turns[0].status, "failed");
  assert.equal(next.data.turns[0].steps[0].output, failed.steps[0].output);
  assert.equal(next.data.createdAt, first.data.createdAt);
  assert.ok(!next.data.error); assert.ok(!next.data.gitActions); assert.deepEqual(next.data.steps, []);
  assert.ok(!next.data.turns[0].context); assert.ok(!next.data.turns[0].steps[0].modelRequest);
  await untilStatus(id, "approval");
  const secondPlan = calls.filter(c => c.planning)[1].prompt;
  assert.match(secondPlan, /Original request: build a C\+\+ geometry library/);
  assert.match(secondPlan, /FIRST PARTIAL RESPONSE unique/);
  assert.match(secondPlan, /unfinished/);
  assert.equal(executions, 1, "follow-up never bypasses approval");
  assert.equal((await call("/api/runs")).data.length, 1, "follow-up does not create a separate history row");
  await call(`/api/runs/${id}/start`, {});
  await untilStatus(id, "complete");
  const secondExecution = calls.filter(c => !c.planning)[1].prompt;
  assert.match(secondExecution, /FIRST PARTIAL RESPONSE unique/);
  assert.match(secondExecution, /Explain the previous output and correct it/);
  assert.equal((await call(`/api/runs/${id}/messages`, { request: "stale duplicate", expectedTurn: 0 })).status, 409);
  const saved = JSON.parse(fs.readFileSync(path.join(temp, "sessions", `session-${id}.json`), "utf8")).run;
  assert.equal(saved.turns.length, 1);
  assert.ok(saved.turns[0].steps[0].modelRequest, "full earlier prompt retained on server");
  assert.equal(saved.steps[0].output, "SECOND COMPLETE RESPONSE unique");
  await stop(); await launch();
  const restored = (await call(`/api/runs/${id}`)).data;
  assert.equal(restored.turns[0].request, first.data.request);
  assert.equal(restored.steps[0].output, saved.steps[0].output);
  const third = await call(`/api/runs/${id}/messages`, { request: "Now add a test to this conversation.", expectedTurn: 1 });
  assert.equal(third.status, 202); assert.equal(third.data.id, id); assert.equal(third.data.turns.length, 2);
  assert.ok(third.data.turns.every(turn => !turn.turns), "history is not recursively duplicated");
  await untilStatus(id, "approval");
  const thirdPlan = calls.filter(c => c.planning).at(-1).prompt;
  assert.match(thirdPlan, /FIRST PARTIAL RESPONSE unique/); assert.match(thirdPlan, /SECOND COMPLETE RESPONSE unique/);
  await call(`/api/runs/${id}/cancel`, {});
  const separate = await call("/api/runs", { request: "A genuinely separate new task.", mode: "demo", projectId: null });
  assert.equal(separate.status, 202); assert.notEqual(separate.data.id, id);
  assert.equal((await call("/api/runs")).data.length, 2);
  await untilStatus(separate.data.id, "approval");
  const projectsBefore = (await call("/api/projects")).data;
  const deleted = await call(`/api/runs/${id}`, undefined, "DELETE");
  assert.equal(deleted.status, 200); assert.equal(deleted.data.deleted, true);
  assert.equal(fs.existsSync(path.join(temp, "sessions", `session-${id}.json`)), false);
  assert.equal((await call(`/api/runs/${id}`)).status, 404);
  assert.equal((await call(`/api/runs/${id}`, undefined, "DELETE")).status, 404);
  assert.equal((await call("/api/runs/not-an-id", undefined, "DELETE")).status, 400);
  assert.equal((await call(`/api/runs/${projectsBefore[0].id}`, undefined, "DELETE")).status, 404);
  assert.deepEqual((await call("/api/projects")).data, projectsBefore, "deletion leaves project files untouched");
  await stop(); await launch();
  assert.equal((await call(`/api/runs/${id}`)).status, 404, "deleted conversations do not return after restart");
  assert.equal((await call("/api/runs")).data.length, 1, "other conversation retained");
  assert.equal((await call(`/api/runs/${separate.data.id}`, undefined, "DELETE")).status, 200, "can delete an unapproved conversation");
  assert.equal((await call("/api/runs")).data.length, 0);
  console.log("PASS: same-session follow-ups, failed/partial output preserved, history in planner and specialist context, bounded context, approval guard, stale-message rejection, restart persistence, explicit new task, active-delete guard, deletion of database/session file, restart without resurrection and project preservation.");
} finally {
  releaseFirst?.();
  await stop(); await new Promise(resolve => model.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
