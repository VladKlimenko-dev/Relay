// Owner-only access for the local Windows installation. No cloud identity service.
import express, { type Express } from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSecret } from "./secrets";

export type AccessConfig = {
  username: string; salt: string; hash: string; sessionSecret: string;
  publicOrigin: string; port: number; pfx: string; passphrase: string;
  publicCertificate?: string; // DER, base64; public certificate only, never the private key.
};
declare module "express-session" {
  interface SessionData { owner?: boolean; born?: number; csrf?: string }
}
export async function passwordHash(password: string, salt: string) {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}
export function readAccess(): AccessConfig | null {
  // A corrupt or undecryptable config must stop startup, never disable authentication.
  const raw = loadSecret("remote-access");
  if (!raw) return null;
  const c = JSON.parse(raw) as AccessConfig;
  const u = new URL(c.publicOrigin);
  if (u.protocol !== "https:" || u.origin !== c.publicOrigin || !c.username ||
      !/^[a-f0-9]{128}$/.test(c.hash) || !/^[a-f0-9]{32}$/.test(c.salt) ||
      !/^[a-f0-9]{64}$/.test(c.sessionSecret) || !Number.isInteger(c.port) ||
      c.port < 1024 || c.port > 65535 || !c.pfx || !c.passphrase) {
    throw new Error("Invalid remote access configuration. Run configure-remote.cmd again.");
  }
  c.pfx = path.resolve(c.pfx);
  fs.accessSync(c.pfx);
  return c;
}
export function registerAccess(app: Express, config: AccessConfig | null, localPort: number) {
  app.disable("x-powered-by");
  // No forwarded-header trust: TLS terminates here, not at an arbitrary proxy.
  app.set("trust proxy", false);
  app.get("/api/health", (_req, res) => res.json({ ready: true }));
  const localHosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`];
  const hosts = new Set(config
    ? [new URL(config.publicOrigin).host, `127.0.0.1:${config.port}`, `localhost:${config.port}`]
    : localHosts);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    if (config && !req.secure) return res.status(426).json({ message: "Use the configured HTTPS address to sign in." });
    if (!hosts.has(req.get("host") || "")) return res.status(403).json({ message: "Unrecognized host." });
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const origin = req.get("origin");
    if ((origin && origin !== `${req.protocol}://${req.get("host")}`) ||
        req.get("sec-fetch-site") === "cross-site") {
      return res.status(403).json({ message: "Cross-site request refused." });
    }
    next();
  });
  if (!config) {
    app.get("/api/auth/status", (_req, res) => res.json({ enabled: false, authenticated: true }));
    return;
  }
  const Store = createMemoryStore(session);
  app.use(session({
    name: "__Host-relay", secret: config.sessionSecret, resave: false, saveUninitialized: false,
    rolling: true, store: new Store({ checkPeriod: 60_000 }),
    cookie: { secure: true, httpOnly: true, sameSite: "strict", path: "/", maxAge: 30 * 60_000 },
  }));
  app.use((req, _res, next) => {
    if (req.session.owner && Date.now() - (req.session.born || 0) > 12 * 60 * 60_000) {
      req.session.owner = false;
    }
    next();
  });
  app.get("/api/auth/status", (req, res) => res.json({
    enabled: true, authenticated: !!req.session.owner,
    ...(req.session.owner ? { username: config.username, csrf: req.session.csrf } : {}),
  }));
  // Shared owner account: global limiter also prevents bypass through rotating IPs.
  let attempts: number[] = [];
  let checking = false;
  app.post("/api/auth/login", (req, res, next) => {
    attempts = attempts.filter(t => t > Date.now() - 15 * 60_000);
    if (attempts.length >= 10 || checking) {
      res.setHeader("Retry-After", "900");
      return res.status(429).json({ message: "Too many login attempts. Wait 15 minutes and try again." });
    }
    attempts.push(Date.now());
    next();
  }, express.json({ limit: "2kb" }), async (req, res, next) => {
    const username = req.body?.username, password = req.body?.password;
    if (typeof username !== "string" || typeof password !== "string" || password.length > 256) {
      return res.status(400).json({ message: "Enter a username and password." });
    }
    checking = true;
    try {
      const hash = await passwordHash(password, config.salt);
      if (!timingSafeEqual(hash, Buffer.from(config.hash, "hex")) || username !== config.username) {
        return res.status(401).json({ message: "Incorrect username or password." });
      }
      req.session.regenerate(err => {
        if (err) return next(err);
        req.session.owner = true;
        req.session.born = Date.now();
        req.session.csrf = randomBytes(32).toString("hex");
        req.session.save(err => err ? next(err) : res.json({
          enabled: true, authenticated: true, username: config.username, csrf: req.session.csrf,
        }));
      });
    } catch (e) { next(e); }
    finally { checking = false; }
  });
  // All business APIs, including GitHub/search/settings, sit behind this gate.
  app.use("/api", (req, res, next) => {
    if (!req.session.owner) {
      res.setHeader("X-Relay-Login", "required");
      return res.status(401).json({ message: "Sign in to Relay." });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        (!req.session.csrf || req.get("X-Relay-CSRF") !== req.session.csrf)) {
      return res.status(403).json({ message: "Session verification failed. Reload and sign in again." });
    }
    next();
  });
  app.post("/api/auth/logout", (req, res, next) => {
    req.session.destroy(err => {
      if (err) return next(err);
      res.clearCookie("__Host-relay", { secure: true, httpOnly: true, sameSite: "strict", path: "/" });
      res.json({ ok: true });
    });
  });
}
