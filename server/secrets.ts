// Local secret storage. On Windows the value is encrypted with DPAPI for the current Windows user
// (only this user on this PC can decrypt it). Elsewhere (development/tests) it is a file readable only by the owner.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.RELAY_SECRETS_DIR || path.join(path.dirname(path.resolve(process.env.DATA_FILE || "data.db")), "secrets");
const windows = process.platform === "win32";
const file = (name: string) => path.join(DIR, `${name}.${windows ? "dpapi" : "secret"}`);
const cache = new Map<string, string>();

function dpapi(mode: "Protect" | "Unprotect", input: string): string {
  // The value travels in an environment variable of the child process, never on the command line.
  const script = mode === "Protect"
    ? "Add-Type -AssemblyName System.Security; $b = [Text.Encoding]::UTF8.GetBytes($env:RELAY_SECRET_IN); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser'))"
    : "Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String($env:RELAY_SECRET_IN); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'))";
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, RELAY_SECRET_IN: input }, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`Windows DPAPI ${mode} failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
  return r.stdout.trim();
}

export function saveSecret(name: string, value: string) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(name), windows ? dpapi("Protect", value) : value, { mode: 0o600 });
  cache.set(name, value);
}

export function loadSecret(name: string): string | null {
  if (cache.has(name)) return cache.get(name)!;
  if (!fs.existsSync(file(name))) return null;
  const raw = fs.readFileSync(file(name), "utf8").trim();
  const value = windows ? dpapi("Unprotect", raw) : raw;
  cache.set(name, value);
  return value;
}

export function deleteSecret(name: string) {
  cache.delete(name);
  fs.rmSync(file(name), { force: true });
}
