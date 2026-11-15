// Isolated status/log/shutdown API checks. Does not stop real processes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import express from "express";
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-status-"));
const bundle = path.join(root, "node_modules/.relay-unit/system-status.mjs");
execFileSync(path.join(root, "node_modules/.bin/esbuild"), ["server/systemStatus.ts", "--bundle", "--platform=node", "--format=esm",
  `--outfile=${bundle}`, "--packages=external", "--log-level=error"]);
const { registerSystemStatus, logTail, redactLog } = await import(bundle);
let active = false, stops = 0, failStop = true, held;
const app = express(); app.use(express.json());
registerSystemStatus(app, () => ({ active, phase: active ? "writing" : "idle" }), {
  managed: true, logDir: temp, stop: async () => { stops++; if (failStop) throw Error("mock stop failure"); },
});
app.post("/api/test-write", (_req, res) => res.json({ ok: true }));
app.post("/api/held-write", (_req, res) => { held = res; });
const server = http.createServer(app);
try {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body) => {
    const result = await fetch(base + route, { method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: result.status, data: await result.json() };
  };
  const state = await call("/api/system/status");
  assert.equal(state.status, 200); assert.equal(state.data.server, "running"); assert.equal(state.data.canShutdown, true);
  assert.equal(state.data.localLogs, true); assert.equal(state.data.activity.active, false);
  assert.ok(state.data.memoryMiB > 0); assert.ok(state.data.uptimeSeconds >= 0);
  fs.writeFileSync(path.join(temp, "relay.stderr.log"), "x".repeat(100000) + "\nAuthorization: Bearer secret-value\npassword=private\n");
  fs.writeFileSync(path.join(temp, "model.stdout.log"), "model is ready");
  const logs = await call("/api/system/logs?service=server");
  assert.equal(logs.status, 200); assert.equal(logs.data.stderr.truncated, true);
  assert.ok(logs.data.stderr.text.length <= 32800);
  assert.ok(!logs.data.stderr.text.includes("secret-value")); assert.ok(!logs.data.stderr.text.includes("private"));
  assert.equal((await call("/api/system/logs?service=model")).data.stdout.text, "model is ready");
  assert.match((await logTail(path.join(temp, "missing.log"))).text, /No log/);
  assert.equal((await call("/api/system/logs?service=../../secrets/token")).status, 400);
  assert.ok(!redactLog("ghp_exampleToken123 github_pat_example123").includes("example"));
  assert.equal((await call("/api/system/shutdown", {})).status, 400);
  active = true;
  assert.equal((await call("/api/system/shutdown", { confirm: true })).status, 409);
  active = false;
  const holding = fetch(base + "/api/held-write", { method: "POST" });
  while (!held) await new Promise(r => setTimeout(r, 10));
  assert.equal((await call("/api/system/shutdown", { confirm: true })).status, 409);
  held.json({ ok: true }); await holding;
  assert.equal((await call("/api/system/shutdown", { confirm: true })).status, 202);
  assert.equal((await call("/api/test-write", {})).status, 503);
  assert.equal((await call("/api/system/shutdown", { confirm: true })).status, 503);
  while (!stops || (await call("/api/system/status")).data.shuttingDown) await new Promise(r => setTimeout(r, 20));
  assert.equal((await call("/api/system/status")).data.shutdownError, "mock stop failure");
  assert.equal((await call("/api/test-write", {})).status, 200);
  failStop = false;
  assert.equal((await call("/api/system/shutdown", { confirm: true })).status, 202);
  while (stops < 2) await new Promise(r => setTimeout(r, 20));
  assert.equal((await call("/api/system/status")).data.shuttingDown, true);
  const handlers = {};
  registerSystemStatus({ use() {}, get(p, fn) { handlers[p] = fn; }, post(p, fn) { handlers[p] = fn; } },
    () => ({ active: false, phase: "idle" }), { managed: true, stop: async () => { throw Error("must not stop"); } });
  for (const route of ["/api/system/logs", "/api/system/shutdown"]) {
    let statusCode;
    await handlers[route]({ socket: { remoteAddress: "192.168.1.2" }, headers: { "x-forwarded-for": "127.0.0.1" }, query: { service: "server" }, body: { confirm: true } },
      { status(code) { statusCode = code; return this; }, json() {} });
    assert.equal(statusCode, 403);
  }
  console.log("PASS: status, bounded logs, common-token redaction, missing logs, path whitelist, local-only access, confirmation, active-task/write protection, shutdown write barrier and failure recovery.");
} finally {
  await new Promise(r => server.close(r));
  fs.rmSync(temp, { recursive: true, force: true });
}
