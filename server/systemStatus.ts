import type { Express, Request } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

const local = (req: Request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "");
const files = { server: ["relay.stdout.log", "relay.stderr.log"], model: ["model.stdout.log", "model.stderr.log"] } as const;
export function redactLog(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b(?:github_pat_[a-zA-Z0-9_]+|gh[pousr]_[a-zA-Z0-9]+)\b/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:password|passphrase|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
export async function logTail(file: string) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat(), size = Math.min(stat.size, 32768);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, Math.max(0, stat.size - size));
    return { text: redactLog(buffer.subarray(0, bytesRead).toString("utf8")), truncated: stat.size > size };
  } catch (e: any) {
    return { text: e.code === "ENOENT" ? "No log recorded for this stream yet." : "This log could not be read.", truncated: false };
  } finally { await handle?.close(); }
}
async function shutdownWindows() {
  await new Promise<void>((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.resolve("setup/stop-model.ps1")], { windowsHide: true, timeout: 15000, maxBuffer: 8192 },
    error => error ? reject(new Error("The model could not be stopped. Check the local logs and retry.")) : resolve());
  });
  await fs.rm(path.resolve(".relay-server.json"), { force: true });
  process.exit(0); // No active task or business write is allowed at this point; sessions are already persisted.
}
export function registerSystemStatus(app: Express, activity: () => { active: boolean; phase: string },
  deps: { managed?: boolean; stop?: () => Promise<void>; logDir?: string } = {}) {
  const managed = deps.managed ?? (process.platform === "win32" && process.env.RELAY_BACKGROUND === "1");
  const stop = deps.stop || shutdownWindows;
  const logDir = deps.logDir || path.resolve("logs");
  let shuttingDown = false, shutdownError = "", writes = 0;
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (shuttingDown) return res.status(503).json({ message: "Relay is shutting down. Start it again before making changes." });
    writes++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; writes--; } };
    res.once("finish", finish); res.once("close", finish);
    next();
  });
  app.get("/api/system/status", (req, res) => res.json({
    server: "running", uptimeSeconds: Math.floor(process.uptime()),
    memoryMiB: Math.round(process.memoryUsage().rss / 1048576),
    activity: activity(), localLogs: local(req), canShutdown: local(req) && managed,
    shuttingDown, shutdownError, checkedAt: new Date().toISOString(),
  }));
  app.get("/api/system/logs", async (req, res) => {
    if (!local(req)) return res.status(403).json({ message: "Raw logs are available only on the Relay PC." });
    const name = req.query.service;
    if (name !== "server" && name !== "model") return res.status(400).json({ message: "Choose server or model logs." });
    const [stdout, stderr] = await Promise.all(files[name].map(file => logTail(path.join(logDir, file))));
    res.json({ service: name, stdout, stderr, checkedAt: new Date().toISOString() });
  });
  app.post("/api/system/shutdown", (req, res) => {
    if (!local(req) || !managed) return res.status(403).json({ message: "Shutdown is available on the Relay PC when started with start-relay.cmd." });
    if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirm shutdown first." });
    if (activity().active || writes > 1) return res.status(409).json({ message: "A task or write is active. Pause or stop it and wait for it to save before shutting down." });
    shuttingDown = true; shutdownError = "";
    res.status(202).json({ message: "Shutdown requested. Reopen Relay with start-relay.cmd." });
    setTimeout(() => { stop().catch(e => { shutdownError = e.message; shuttingDown = false; }); }, 500).unref();
  });
}
