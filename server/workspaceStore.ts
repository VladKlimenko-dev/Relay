// Retained file assets and explicitly registered local folders on the Relay SERVER PC.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { storage } from "./storage";

export type Asset = { id: number; runId: number | null; projectId: number | null; origin: "generated" | "uploaded";
  name: string; storedName: string; size: number; sha256: string; createdAt: string };
export type Folder = { id: number; projectId: number; root: string; label: string; addedAt: string };
export type LocalSource = { folderId: number; root: string; path: string; kind: "listing" | "file"; bytes?: number };

export const assetDirectory = () => path.join(path.dirname(path.resolve(process.env.DATA_FILE || "data.db")), "files");
const safeName = (name: string) => (path.basename(name.replace(/\\/g, "/")).replace(/[^\w.\- ()\[\]]+/g, "_").replace(/^\.+/, "").slice(0, 160) || "file");
export const assetPath = (a: Asset) => path.join(assetDirectory(), a.storedName);

export function saveAsset(input: { runId: number | null; projectId: number | null; origin: Asset["origin"]; name: string; content: Buffer }): Asset {
  const dir = assetDirectory();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = safeName(input.name);
  const record = storage.create("asset", { runId: input.runId, projectId: input.projectId, origin: input.origin, name,
    storedName: "", size: input.content.length, sha256: createHash("sha256").update(input.content).digest("hex"), createdAt: new Date().toISOString() }) as Asset;
  record.storedName = `${record.id}-${name}`;
  const file = assetPath(record), temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, input.content, { mode: 0o600 }); fs.renameSync(temp, file);
  } catch (e) { fs.rmSync(temp, { force: true }); storage.remove(record.id, "asset"); throw e; }
  return storage.update(record.id, { ...record, id: undefined }) as Asset;
}
export const listAssets = (): Asset[] => storage.list("asset");
export function deleteAsset(asset: Asset) {
  fs.rmSync(assetPath(asset), { force: true }); // file first; the record stays if this throws
  storage.remove(asset.id, "asset");
}
export const isText = (b: Buffer) => !b.subarray(0, 8192).includes(0);

// ---- Local folders -------------------------------------------------------------------------------
const win = process.platform === "win32";
const norm = (p: string) => (win ? p.toLowerCase() : p);
const SKIP = /^(\.git|node_modules|secrets|sessions|\.venv|venv|__pycache__|dist|build|bin|obj)$/i;
const SENSITIVE = /(^\.env($|\.))|(\.(pem|key|pfx|p12|crt|db|db-wal|db-shm|sqlite)$)|^id_(rsa|ed25519)|secret|credential|password/i;
export function within(root: string, target: string) {
  const r = norm(root), t = norm(target);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
export function validateRoot(input: string) {
  const raw = input.trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error("Enter an absolute folder path on the Relay server PC, for example C:\\Projects\\MyApp.");
  let real: string;
  try { real = fs.realpathSync.native(raw); } catch { throw new Error("That folder does not exist on the Relay server PC or cannot be read."); }
  if (!fs.statSync(real).isDirectory()) throw new Error("That path is a file. Register a folder.");
  if (path.parse(real).root === real) throw new Error("Register a specific folder, not a whole drive or filesystem root.");
  return real;
}
// Resolve a path relative to a registered root; rejects traversal and symlink/junction escapes.
export function resolveInside(root: string, relative: string) {
  const rel = String(relative || "").replace(/\\/g, "/");
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error("Invalid path.");
  const lexical = path.resolve(root, rel);
  if (!within(root, lexical)) throw new Error("Path is outside the registered folder.");
  const realRoot = fs.realpathSync.native(root);
  const real = fs.realpathSync.native(lexical);
  if (!within(realRoot, real)) throw new Error("Path resolves outside the registered folder.");
  if (rel.split("/").some(part => SKIP.test(part) || SENSITIVE.test(part))) throw new Error("This file is excluded for safety.");
  return real;
}
export function listFolder(root: string, maxEntries = 400) {
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (out.length >= maxEntries || depth > 8) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.isSymbolicLink() || SKIP.test(e.name) || SENSITIVE.test(e.name)) continue; // never follow links
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel, depth + 1);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(root, "", 0);
  return out;
}
export const foldersFor = (projectId: number | null): Folder[] => storage.list("folder").filter((f: Folder) => f.projectId === projectId);

// Files are read only when the request names them (relative path or file name). Nothing else is claimed as accessed.
export function folderContext(folders: Folder[], request: string, budget: number) {
  const sources: LocalSource[] = []; let text = "";
  const lower = request.toLowerCase().replace(/\\/g, "/");
  for (const f of folders) {
    if (text.length >= budget) break;
    let files: string[];
    try { files = listFolder(validateRoot(f.root)); } catch (e: any) { text += `\nLOCAL FOLDER ${f.root}: unavailable (${e.message})\n`; continue; }
    const listing = `\nLOCAL FOLDER (registered on the Relay server PC): ${f.root}\nFiles (${files.length}${files.length >= 400 ? "+, truncated" : ""}):\n${files.join("\n")}\n`;
    const listPart = listing.slice(0, Math.floor((budget - text.length) / 3));
    text += listPart; sources.push({ folderId: f.id, root: f.root, path: "", kind: "listing" });
    const named = files.filter(rel => { const base = path.posix.basename(rel).toLowerCase(); return lower.includes(rel.toLowerCase()) || (base.length >= 3 && base.includes(".") && lower.includes(base)); }).slice(0, 8);
    for (const rel of named) {
      const room = budget - text.length; if (room < 200) break;
      try {
        const real = resolveInside(f.root, rel), stat = fs.statSync(real);
        if (stat.size > 512_000) continue;
        const data = fs.readFileSync(real); if (!isText(data)) continue;
        const body = data.toString("utf8");
        const block = `\nLOCAL FILE ${f.root}${path.sep}${rel}${body.length > room - 120 ? " (truncated)" : ""}:\n${body.slice(0, Math.max(0, room - 120))}\n`;
        text += block; sources.push({ folderId: f.id, root: f.root, path: rel, kind: "file", bytes: stat.size });
      } catch { /* skipped: excluded, unreadable or outside the root */ }
    }
  }
  return { text: text.slice(0, budget), sources };
}
