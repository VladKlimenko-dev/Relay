// Complete application checkpoints on the Relay SERVER PC. No browser storage dependency.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Run } from "@shared/schema";
export const sessionDirectory = path.join(path.dirname(path.resolve(process.env.DATA_FILE || "data.db")), "sessions");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const sessionPath = (id: number) => path.join(sessionDirectory, `session-${id}.json`);
export function writeSession(run: Run) {
  const raw = JSON.stringify(run);
  const document = JSON.stringify({ format: "relay-session", version: 1, checksum: digest(raw), run }, null, 2);
  fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  const file = sessionPath(run.id), temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, "w", 0o600);
  try { fs.writeFileSync(fd, document); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
export function readSessions(): Run[] {
  if (!fs.existsSync(sessionDirectory)) return [];
  return fs.readdirSync(sessionDirectory).filter(n => /^session-\d+\.json$/.test(n)).map(name => {
    const file = path.join(sessionDirectory, name);
    if (fs.statSync(file).size > 100_000_000) throw new Error(`Session file too large: ${name}`);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc.format !== "relay-session" || doc.version !== 1 || digest(JSON.stringify(doc.run)) !== doc.checksum ||
        !Number.isSafeInteger(doc.run?.id) || doc.run.id <= 0 || name !== `session-${doc.run.id}.json` ||
        typeof doc.run.request !== "string" || !Array.isArray(doc.run.steps) || !Array.isArray(doc.run.events)) {
      throw new Error(`Invalid or damaged session file: ${name}. Restore a valid copy before restarting Relay.`);
    }
    return doc.run as Run;
  });
}
