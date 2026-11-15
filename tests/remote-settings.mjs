// Isolated Settings/API tests. Windows certificate generation is mocked; TLS validation is real.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import express from "express";
const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-remote-settings-"));
const bundle = path.join(root, "node_modules/.relay-unit/remote-settings.mjs");
execFileSync(path.join(root, "node_modules/.bin/esbuild"), ["server/remoteSettings.ts", "--bundle", "--platform=node", "--format=esm",
  `--outfile=${bundle}`, "--packages=external", "--log-level=error"]);
const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem"), pfx = path.join(dir, "test.pfx"), der = path.join(dir, "cert.der");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
  "-subj", "/CN=8.8.8.8", "-addext", "subjectAltName=IP:8.8.8.8,IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
execFileSync("openssl", ["pkcs12", "-export", "-out", pfx, "-inkey", key, "-in", cert, "-passout", "pass:fixture-only"], { stdio: "ignore" });
execFileSync("openssl", ["x509", "-in", cert, "-outform", "DER", "-out", der], { stdio: "ignore" });
process.env.DATA_FILE = path.join(dir, "data.db"); process.env.RELAY_SECRETS_DIR = path.join(dir, "secrets");
process.chdir(dir);
const server = http.createServer();
try {
  const { publicIPv4, createIpLookup, registerRemoteSettings } = await import(bundle);
  for (const value of ["", "127.0.0.1", "192.168.1.1", "100.64.0.1", "203.0.113.1", "::1", "not-ip"]) assert.equal(publicIPv4(value), false, value);
  assert.equal(publicIPv4("8.8.8.8"), true);
  let requests = 0;
  const lookup = createIpLookup(async (url, options) => {
    assert.equal(url, "https://api.ipify.org"); assert.equal(options.redirect, "error");
    requests++; return new Response("8.8.8.8\n");
  });
  assert.equal((await lookup()).ip, "8.8.8.8");
  await lookup(true); assert.equal(requests, 1, "refresh cooldown");
  const bad = createIpLookup(async () => new Response("127.0.0.1"));
  assert.equal((await bad()).ip, null); assert.ok((await bad()).error);
  const offline = createIpLookup(async () => { throw Error("offline"); });
  assert.ok((await offline()).error);
  let certificateCalls = 0, reused = false;
  const certificate = async (_address, reuse) => {
    certificateCalls++; reused = !!reuse;
    return { pfx, passphrase: "fixture-only", certificate: fs.readFileSync(der).toString("base64") };
  };
  const app = express(); app.use(express.json());
  server.on("request", app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  registerRemoteSettings(app, null, port, { platform: "win32", lookup, certificate });
  const call = async (route, body, originHeader = origin) => {
    const r = await fetch(origin + route, { method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Origin: originHeader }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  let status = await call("/api/remote/status");
  assert.equal(status.data.configured, false); assert.equal(status.data.localSetupAllowed, true);
  assert.equal((await call("/api/remote/public-ip")).data.ip, "8.8.8.8");
  const password = "test-only-new-password!";
  const payload = { address: "8.8.8.8", port: 16443, username: "owner", password, confirmPassword: password, confirmEnable: true };
  assert.equal((await call("/api/remote/settings", payload, "https://evil.invalid")).status, 403);
  for (const change of [{ address: "127.0.0.1" }, { port: 8080 }, { password: "short" }, { confirmPassword: "different" }, { confirmEnable: false }]) {
    assert.equal((await call("/api/remote/settings", { ...payload, ...change })).status, 400);
  }
  assert.equal(certificateCalls, 0);
  assert.equal((await call("/api/remote/settings", payload)).status, 200);
  const raw = fs.readFileSync(path.join(dir, "secrets/remote-access.secret"), "utf8");
  assert.ok(!raw.includes(password)); assert.match(JSON.parse(raw).hash, /^[a-f0-9]{128}$/);
  assert.equal(JSON.parse(fs.readFileSync("remote-access.json")).url, "https://8.8.8.8:16443");
  status = await call("/api/remote/status");
  assert.equal(status.data.pendingRestart, true); assert.equal(status.data.active, false);
  assert.equal(status.data.username, "owner"); assert.ok(status.data.certificate.fingerprint);
  for (const secret of ["password", "hash", "salt", "passphrase", "sessionSecret", "pfx"]) assert.ok(!(secret in status.data), secret);
  const exported = await fetch(origin + "/api/remote/certificate");
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()), fs.readFileSync(der));
  assert.equal((await call("/api/remote/settings", { ...payload, currentPassword: "wrong" })).status, 401);
  assert.equal(certificateCalls, 1);
  assert.equal((await call("/api/remote/settings", { ...payload, currentPassword: password, username: "new-owner" })).status, 200);
  assert.equal(reused, true); assert.equal(certificateCalls, 2);
  // Verify remote-write rejection without trusting a spoofed forwarded header.
  const handlers = {};
  registerRemoteSettings({ get() {}, post(p, fn) { handlers[p] = fn; } }, null, port, { platform: "win32", lookup, certificate });
  let rejected;
  await handlers["/api/remote/settings"]({ socket: { remoteAddress: "192.168.1.2" }, body: payload },
    { status(n) { rejected = n; return this; }, json() {} });
  assert.equal(rejected, 403);
  console.log("PASS: server-side IP lookup/cache/failure/validation, local-only origin guard, owner confirmation, password validation/hash/current-password check, certificate export/reuse, redacted status, restart-required state.");
} finally {
  await new Promise(r => server.close(r));
  process.chdir(root); fs.rmSync(dir, { recursive: true, force: true });
}
