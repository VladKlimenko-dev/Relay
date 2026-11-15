// Called only from the local PowerShell prompt. Secret input is stdin, not argv.
import { randomBytes } from "node:crypto";
import { createSecureContext } from "node:tls";
import fs from "node:fs";
import { passwordHash } from "../server/access";
import { saveSecret } from "../server/secrets";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16000) throw new Error("Input too large.");
}
const c = JSON.parse(input.replace(/^\uFEFF/, ""));
if (!/^[A-Za-z0-9._-]{3,64}$/.test(c.username)) throw new Error("Username: 3-64 letters, digits, dots, underscores or hyphens.");
if (typeof c.password !== "string" || c.password.length < 15 || c.password.length > 256) throw new Error("Use a unique password of 15-256 characters.");
const url = new URL(c.publicOrigin);
if (url.protocol !== "https:" || url.origin !== c.publicOrigin || !Number.isInteger(c.port) ||
    c.port < 1024 || c.port > 65535) throw new Error("Invalid HTTPS origin or listening port.");
createSecureContext({ pfx: fs.readFileSync(c.pfx), passphrase: c.passphrase });
const salt = randomBytes(16).toString("hex");
saveSecret("remote-access", JSON.stringify({
  username: c.username, salt, hash: (await passwordHash(c.password, salt)).toString("hex"),
  sessionSecret: randomBytes(32).toString("hex"), publicOrigin: c.publicOrigin,
  port: c.port, pfx: c.pfx, passphrase: c.passphrase,
}));
console.log("Owner login saved. Restart Relay. Existing sessions will be invalidated.");
