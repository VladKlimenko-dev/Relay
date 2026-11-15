import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes, systemActivity } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import fs from "node:fs";
import { readAccess, registerAccess } from "./access";
import { registerRemoteSettings } from "./remoteSettings";
import { registerSystemStatus } from "./systemStatus";

const app = express();
const httpServer = createServer(app);
const access = readAccess();
const port = Number(process.env.PORT || "5000");
if (!["127.0.0.1", "localhost", "::1"].includes(process.env.HOST || "127.0.0.1")) {
  throw new Error("Plain HTTP must remain on loopback. Use configure-remote.cmd for HTTPS access.");
}
registerAccess(app, access, port);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "60mb", // local app; file uploads to repositories,
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      log(logLine);
    }
  });

  next();
});

(async () => {
  registerSystemStatus(app, systemActivity);
  registerRemoteSettings(app, access, port);
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  httpServer.listen(
    {
      port,
      host: process.env.HOST || "127.0.0.1",
      // SO_REUSEPORT exists only on Linux; on Windows listen() fails with ENOTSUP.
      reusePort: process.platform === "linux",
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
  if (access) {
    const secureServer = createHttpsServer({
      pfx: fs.readFileSync(access.pfx), passphrase: access.passphrase, minVersion: "TLSv1.2",
    }, app);
    secureServer.requestTimeout = 120_000;
    secureServer.headersTimeout = 30_000;
    secureServer.listen(access.port, "0.0.0.0", () => log(`Owner login required: ${access.publicOrigin}`));
    secureServer.on("error", e => { console.error("HTTPS startup failed:", e.message); process.exit(1); });
  }
})();
