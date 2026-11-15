import type { Express, Request } from "express";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { passwordHash, readAccess, type AccessConfig } from "./access";
import { saveSecret } from "./secrets";

export function publicIPv4(value: unknown): value is string {
  if (typeof value !== "string" || !net.isIPv4(value)) return false;
  const [a, b, c] = value.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
    (a === 203 && b === 0 && c === 113));
}
const loopback = (req: Request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "");
type Certificate = { pfx: string; passphrase: string; certificate: string };
type IpResult = { ip: string | null; checkedAt: string; error?: string; stale: boolean };

export function createIpLookup(fetcher: typeof fetch = fetch) {
  let cached: IpResult | null = null, pending: Promise<IpResult> | null = null;
  return async (refresh = false): Promise<IpResult> => {
    if (pending) return pending;
    const age = cached ? Date.now() - Date.parse(cached.checkedAt) : Infinity;
    if (cached && age < (refresh || cached.error ? 15_000 : 300_000)) return cached;
    pending = (async () => {
      const checkedAt = new Date().toISOString();
      try {
        // Executed by Relay on its host PC, NOT by the visiting browser.
        // Fixed destination, no credentials, no supplied URL, no redirects.
        const res = await fetcher("https://api.ipify.org", {
          signal: AbortSignal.timeout(8_000), redirect: "error",
          headers: { Accept: "text/plain" },
        });
        if (!res.ok) throw new Error("Lookup failed");
        const reader = res.body?.getReader();
        if (!reader) throw new Error("Empty response");
        let raw = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            raw += Buffer.from(value).toString("utf8");
            if (raw.length > 128) throw new Error("Invalid response");
          }
        } finally { await reader.cancel().catch(() => {}); }
        const ip = raw.trim();
        if (!publicIPv4(ip)) throw new Error("Invalid IPv4");
        cached = { ip, checkedAt, stale: false };
      } catch {
        cached = { ip: cached?.ip || null, checkedAt, stale: !!cached?.ip,
          error: "Public IP lookup failed. Check the PC's internet connection, retry, or enter the address manually." };
      }
      return cached;
    })();
    try { return await pending; } finally { pending = null; }
  };
}

async function makeCertificate(address: string, reuse: AccessConfig | null): Promise<Certificate> {
  const dir = path.resolve(process.env.RELAY_SECRETS_DIR ||
    path.join(path.dirname(path.resolve(process.env.DATA_FILE || "data.db")), "secrets"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return await new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.resolve("setup/create-remote-cert.ps1")], { env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", settled = false;
    const fail = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill();
      reject(new Error("Windows could not prepare the HTTPS certificate. No login changes were saved. You can also use configure-remote.cmd."));
    };
    const timer = setTimeout(fail, 60_000);
    child.on("error", fail); child.stdin.on("error", fail);
    child.stderr.resume(); // No secret-bearing exception text in responses or logs.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s: string) => { output += s; if (output.length > 30_000) fail(); });
    child.on("close", code => {
      if (settled) return;
      try {
        if (code !== 0) return fail();
        const result = JSON.parse(output.replace(/^\uFEFF/, "").trim());
        if (!result.pfx || !result.passphrase || !result.certificate) return fail();
        clearTimeout(timer); settled = true; resolve(result);
      } catch { fail(); }
    });
    child.stdin.end(JSON.stringify({ address, directory: dir,
      ...(reuse ? { pfx: reuse.pfx, passphrase: reuse.passphrase } : {}) }));
  });
}

function certificateInfo(config: AccessConfig | null) {
  if (!config?.publicCertificate) return null;
  try {
    const cert = new X509Certificate(Buffer.from(config.publicCertificate, "base64"));
    return { fingerprint: cert.fingerprint256, expires: cert.validTo };
  } catch { return null; }
}

// Dependency arguments are for isolated tests, never request-controlled or environment bypasses.
export function registerRemoteSettings(app: Express, active: AccessConfig | null, localPort: number,
  deps: { platform?: string; lookup?: ReturnType<typeof createIpLookup>; certificate?: typeof makeCertificate } = {}) {
  const platform = deps.platform || process.platform;
  const lookup = deps.lookup || createIpLookup();
  let saving = false, attempts: number[] = [];
  app.get("/api/remote/status", (req, res) => {
    try {
      const saved = readAccess();
      res.json({
        computerName: os.hostname(), platform, localSetupAllowed: platform === "win32" && loopback(req),
        localAddresses: Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a!.address),
        configured: !!saved, active: !!active, username: saved?.username || "",
        publicOrigin: saved?.publicOrigin || "", port: saved?.port || 5443,
        pendingRestart: !!saved && (!active || saved.sessionSecret !== active.sessionSecret ||
          saved.publicOrigin !== active.publicOrigin || saved.port !== active.port),
        certificate: certificateInfo(saved),
      });
    } catch { res.status(500).json({ message: "Cannot read remote access settings. Existing protection was not changed." }); }
  });
  app.get("/api/remote/public-ip", async (req, res) => {
    res.json({ ...await lookup(req.query.refresh === "1"), service: "https://api.ipify.org" });
  });
  app.get("/api/remote/certificate", (_req, res) => {
    try {
      const config = readAccess();
      if (!certificateInfo(config)) return res.status(404).json({ message: "No exported public certificate. Save remote access settings on the PC first." });
      res.type("application/pkix-cert").attachment("relay-public.cer").send(Buffer.from(config!.publicCertificate!, "base64"));
    } catch { res.status(500).json({ message: "Cannot export the public certificate." }); }
  });
  app.post("/api/remote/settings", async (req, res) => {
    // Initial HTTP configuration is loopback-only. Existing auth/CSRF gate still applies after enabling HTTPS.
    if (!loopback(req)) return res.status(403).json({ message: "Change remote login settings on the Relay PC using its localhost address." });
    if (req.get("origin") !== `${req.protocol}://${req.get("host")}`) return res.status(403).json({ message: "Open Settings on the Relay PC before saving." });
    if (platform !== "win32") return res.status(400).json({ message: "Automatic HTTPS setup is supported by the Windows installation." });
    if (saving) return res.status(409).json({ message: "Remote access configuration is already being saved." });
    const b = req.body || {};
    if (typeof b.username !== "string" || !/^[A-Za-z0-9._-]{3,64}$/.test(b.username) ||
        typeof b.password !== "string" || b.password.length < 15 || b.password.length > 256 ||
        b.password !== b.confirmPassword || b.confirmEnable !== true) {
      return res.status(400).json({ message: "Use a username of 3-64 letters/digits/dot/underscore/hyphen, matching passwords of 15-256 characters, and confirm enabling owner access." });
    }
    if (!Number.isInteger(b.port) || b.port < 1024 || b.port > 65535 || [localPort, 8080, 11434].includes(b.port)) {
      return res.status(400).json({ message: "Choose an HTTPS port from 1024-65535, different from Relay HTTP and model ports." });
    }
    saving = true;
    try {
      const previous = readAccess();
      const address = typeof b.address === "string" ? b.address.trim() : "";
      const sameHost = !!previous && new URL(previous.publicOrigin).hostname === address;
      if (!publicIPv4(address) && !(sameHost && b.renewCertificate !== true)) {
        return res.status(400).json({ message: "Enter a public IPv4 address. To configure a new hostname with your own certificate, use configure-remote.cmd." });
      }
      if (previous) {
        attempts = attempts.filter(t => t > Date.now() - 15 * 60_000);
        if (attempts.length >= 5) return res.status(429).json({ message: "Too many password checks. Wait 15 minutes." });
        attempts.push(Date.now());
        if (typeof b.currentPassword !== "string" || b.currentPassword.length > 256 ||
            !timingSafeEqual(await passwordHash(b.currentPassword, previous.salt), Buffer.from(previous.hash, "hex"))) {
          return res.status(401).json({ message: "Enter the current Relay password to change remote access." });
        }
      }
      const cert = await (deps.certificate || makeCertificate)(address, sameHost && !b.renewCertificate ? previous : null);
      createSecureContext({ pfx: fs.readFileSync(cert.pfx), passphrase: cert.passphrase });
      const parsed = new X509Certificate(Buffer.from(cert.certificate, "base64"));
      if (!(net.isIP(address) ? parsed.checkIP(address) : parsed.checkHost(address)) ||
          Date.parse(parsed.validTo) <= Date.now() || Date.parse(parsed.validFrom) > Date.now()) {
        throw new Error("The HTTPS certificate does not cover this address or is outside its validity dates.");
      }
      const salt = randomBytes(16).toString("hex");
      const publicOrigin = `https://${address}${b.port === 443 ? "" : `:${b.port}`}`;
      const config: AccessConfig = { username: b.username, salt, hash: (await passwordHash(b.password, salt)).toString("hex"),
        sessionSecret: randomBytes(32).toString("hex"), publicOrigin, port: b.port,
        pfx: cert.pfx, passphrase: cert.passphrase, publicCertificate: cert.certificate };
      // Save launcher hints first. Restore them if encrypted credential persistence fails.
      const files = ["remote-access.json", "relay-public.cer"].map(f => path.resolve(f));
      const old = files.map(f => fs.existsSync(f) ? fs.readFileSync(f) : null);
      try {
        fs.writeFileSync(files[0], JSON.stringify({ url: publicOrigin, port: b.port }, null, 2));
        fs.writeFileSync(files[1], parsed.raw);
        saveSecret("remote-access", JSON.stringify(config));
      } catch (e) {
        files.forEach((f, i) => { if (old[i]) fs.writeFileSync(f, old[i]!); else fs.rmSync(f, { force: true }); });
        throw e;
      }
      attempts = [];
      res.json({ ok: true, publicOrigin, pendingRestart: true,
        message: "Saved. Restart Relay to activate this login and HTTPS address. Existing login settings remain active until restart. Trust relay-public.cer on your client devices before signing in. Firewall and router rules were not changed." });
    } catch {
      res.status(500).json({ message: "Could not save remote access. Check certificate availability and write permissions; no firewall or router settings were changed." });
    } finally { saving = false; }
  });
}
