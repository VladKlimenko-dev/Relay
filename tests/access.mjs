// Targeted owner-access checks. Isolated DB, secrets, TLS certificate and server.
// No real account, firewall or internet listener is changed by this test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { checkServerIdentity } from "node:tls";
import { spawn, execFileSync } from "node:child_process";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-access-"));
const port = 15443, httpPort = 15000;
const cert = path.join(dir, "cert.pem"), key = path.join(dir, "key.pem"), pfx = path.join(dir, "test.pfx");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
  "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
execFileSync("openssl", ["pkcs12", "-export", "-out", pfx, "-inkey", key, "-in", cert, "-passout", "pass:fixture-pass"], { stdio: "ignore" });
const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: `${httpPort}`,
  DATA_FILE: path.join(dir, "data.db"), RELAY_SECRETS_DIR: path.join(dir, "secrets") };
const password = "test-only-long-password!";
execFileSync(process.execPath, ["dist/configure-access.mjs"], { env, input: JSON.stringify({
  username: "owner", password, publicOrigin: `https://127.0.0.1:${port}`, port, pfx, passphrase: "fixture-pass",
}), stdio: ["pipe", "pipe", "pipe"] });
const raw = fs.readFileSync(path.join(dir, "secrets/remote-access.secret"), "utf8");
assert.ok(!raw.includes(password), "plain password must not be stored");
const origin = `https://127.0.0.1:${port}`;
const ca = fs.readFileSync(cert);
let log = "", server;
function launch() {
  server = spawn(process.execPath, ["dist/index.cjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", b => { log += b; });
  server.stderr.on("data", b => { log += b; });
}
function call(url, method = "GET", body, headers = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(origin + url, { method, ca,
      // Verify the actual test endpoint even when testing a malicious HTTP Host header.
      checkServerIdentity: (_name, certificate) => checkServerIdentity("127.0.0.1", certificate), headers: {
      ...(text ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) } : {}), ...headers,
    } }, res => {
      let data = ""; res.on("data", c => { data += c; });
      res.on("end", () => { let json; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, headers: res.headers, json, text: data }); });
    });
    req.on("error", reject); req.end(text);
  });
}
async function ready() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try { if ((await call("/api/health")).status === 200) return; } catch {}
    if (server.exitCode !== null) throw new Error(log);
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error(`Startup timeout: ${log}`);
}
async function stop() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(r => server.once("exit", r)); server.kill(); await exited;
}
try {
  launch(); await ready();
  assert.equal((await fetch(`http://127.0.0.1:${httpPort}/api/auth/status`)).status, 426);
  assert.equal((await call("/")).status, 200, "public login shell");
  assert.equal((await call("/api/auth/status")).json.authenticated, false);
  for (const route of ["/api/projects", "/api/runs", "/api/agents", "/api/github/status", "/api/progress", "/api/search/status", "/api/remote/status", "/api/remote/public-ip", "/api/remote/certificate"]) {
    assert.equal((await call(route)).status, 401, route);
  }
  assert.equal((await call("/api/github/token", "DELETE")).status, 401);
  assert.equal((await call("/api/projects", "GET", undefined, { Host: "attacker.invalid" })).status, 403);
  assert.equal((await call("/api/auth/login", "POST", { username: "owner", password }, { Origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await call("/api/auth/login", "POST", { username: "owner", password: "incorrect" }, { Origin: origin })).status, 401);
  const login = await call("/api/auth/login", "POST", { username: "owner", password }, { Origin: origin });
  assert.equal(login.status, 200, login.text);
  const cookieLine = login.headers["set-cookie"][0], cookie = cookieLine.split(";")[0], csrf = login.json.csrf;
  for (const attribute of ["__Host-relay=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(cookieLine.includes(attribute), attribute);
  assert.equal(login.headers["cache-control"], "no-store");
  assert.equal((await call("/api/projects", "GET", undefined, { Cookie: cookie })).status, 200);
  assert.equal((await call("/api/auth/status", "GET", undefined, { Cookie: cookie })).json.username, "owner");
  assert.equal((await call("/api/auth/logout", "POST", {}, { Cookie: cookie })).status, 403, "CSRF token required");
  assert.equal((await call("/api/auth/logout", "POST", {}, { Cookie: cookie, "X-Relay-CSRF": csrf, Origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await call("/api/auth/logout", "POST", {}, { Cookie: cookie, "X-Relay-CSRF": csrf, Origin: origin })).status, 200);
  assert.equal((await call("/api/projects", "GET", undefined, { Cookie: cookie })).status, 401, "logout invalidates session");
  const login2 = await call("/api/auth/login", "POST", { username: "owner", password }, { Origin: origin });
  const cookie2 = login2.headers["set-cookie"][0].split(";")[0];
  assert.notEqual(cookie, cookie2, "new login rotates session");
  for (let i = 0; i < 7; i++) await call("/api/auth/login", "POST", { username: "owner", password: "bad" });
  assert.equal((await call("/api/auth/login", "POST", { username: "owner", password })).status, 429, "global brute-force limit");
  await stop(); launch(); await ready();
  assert.equal((await call("/api/projects", "GET", undefined, { Cookie: cookie2 })).status, 401, "restart invalidates sessions");
  await stop();
  // Unauthenticated legacy mode still functions on loopback, not a public HTTP listener.
  fs.renameSync(path.join(dir, "secrets/remote-access.secret"), path.join(dir, "saved.secret"));
  launch();
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${httpPort}/api/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 80));
  }
  assert.equal((await fetch(`http://127.0.0.1:${httpPort}/api/projects`)).status, 200, "local-only mode preserved");
  await stop();
  const refused = spawn(process.execPath, ["dist/index.cjs"], { env: { ...env, HOST: "0.0.0.0" }, stdio: "ignore" });
  const exit = await new Promise(resolve => refused.once("exit", resolve));
  assert.notEqual(exit, 0, "insecure non-loopback HTTP fails closed");
  assert.ok(!log.includes(password), "password not logged");
  console.log("PASS: isolated HTTPS, anonymous API denial, login, hashed credentials, secure cookies, CSRF/origin/Host checks, logout, session rotation/restart invalidation, throttling and refusal of public HTTP.");
} finally {
  if (server) await stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
