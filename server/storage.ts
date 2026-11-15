import type { Agent, ProjectBody } from "@shared/schema";
import { DatabaseSync } from "node:sqlite";
import { readSessions, writeSession, deleteSession } from "./sessions";

// Built-in SQLite (Node >= 22.13): no native module to compile on Windows.
const sqlite = new DatabaseSync(process.env.DATA_FILE || "data.db");
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL)");
type Row = { id: number; kind: string; data: string };
const unpack = (row: Row) => ({ ...JSON.parse(row.data), id: Number(row.id) });
const q = {
  list: sqlite.prepare("SELECT * FROM records WHERE kind = ? ORDER BY id DESC"),
  get: sqlite.prepare("SELECT * FROM records WHERE id = ?"),
  create: sqlite.prepare("INSERT INTO records (kind, data) VALUES (?, ?) RETURNING *"),
  update: sqlite.prepare("UPDATE records SET data = ? WHERE id = ? RETURNING *"),
  delete: sqlite.prepare("DELETE FROM records WHERE id = ? AND kind = ?"),
};
export interface IStorage {
  list(kind: string): any[];
  get(id: number, kind: string): any | undefined;
  create(kind: string, data: unknown): any;
  update(id: number, data: unknown): any;
  deleteRun(id: number): void;
}
class DatabaseStorage implements IStorage {
  deleteRun(id: number) {
    // Remove the restore copy first. On failure the database record remains available.
    deleteSession(id);
    q.delete.run(id, "run");
  }
  list(kind: string) { return (q.list.all(kind) as Row[]).map(unpack); }
  get(id: number, kind: string) { const r = q.get.get(id) as Row | undefined; return r?.kind === kind ? unpack(r) : undefined; }
  create(kind: string, data: unknown) {
    const record = unpack(q.create.get(kind, JSON.stringify(data)) as Row);
    if (kind === "run") writeSession(record);
    return record;
  }
  update(id: number, data: unknown) {
    const row = q.update.get(JSON.stringify(data), id) as Row;
    const record = unpack(row);
    if (row.kind === "run") writeSession(record);
    return record;
  }
}
export const storage = new DatabaseStorage();
// Files can restore missing run records (for example after restoring data.db from an older backup).
// Never overwrite an existing record or collide with a project/agent record.
const restoreRun = sqlite.prepare("INSERT INTO records(id,kind,data) VALUES(?, 'run', ?)");
for (const run of readSessions()) {
  if (!q.get.get(run.id)) restoreRun.run(run.id, JSON.stringify(run));
}
const defaultAgents: Agent[] = [
  { role: "orchestrator", name: "Orchestrator", model: "qwen3.8:27b", enabled: true, prompt: "Coordinate a team of programming specialists. Break the user's request into a short, dependency-ordered plan. Preserve the user's requirements and language (Russian or English)." },
  { role: "architect", name: "Architect", model: "qwen3.8:27b", enabled: true, prompt: "You are a software architect. Produce a concise implementation specification grounded in the provided source files. Identify interfaces, dependencies, edge cases and acceptance criteria. Do not invent repository contents." },
  { role: "coder", name: "Developer", model: "qwen3.8:27b", enabled: true, prompt: "You implement maintainable code in C++, C#, Python and web languages. Follow the task and architecture. Provide complete proposed files or explicit unified diffs in fenced code blocks. Never claim code has been saved, compiled or run. This environment has no execution tools." },
  { role: "tester", name: "Test engineer", model: "qwen3.8:27b", enabled: true, prompt: "Review the proposed implementation and write runnable tests and exact commands. Cover happy paths, edge cases and regressions. You cannot execute code. Clearly mark all tests NOT EXECUTED and do not invent pass rates, coverage or execution results." },
  { role: "data", name: "Data specialist", model: "qwen3.8:27b", enabled: true, prompt: "Analyze only supplied datasets, or generate explicitly labeled synthetic data as requested. Include provenance and assumptions. No internet or database access is available. Never fabricate collected observations, sources or statistical measurements. Provide reproducible scripts when computation is needed." },
  { role: "analyst", name: "Reviewer", model: "qwen3.8:27b", enabled: true, prompt: "Independently review all prior outputs against the user's request. Find concrete issues, suggest fixes and summarize deliverables and remaining work. Distinguish generated proposals from verified results. No tools are available to compile, execute or collect data. Reply in the user's language." },
];
if (!storage.list("agents").length) storage.create("agents", { items: defaultAgents });
if (!storage.list("project").length) storage.create("project", {
  name: "Getting started", language: "Python", description: "A small example project to explore the workflow.", sample: true,
  files: [{ name: "README.md", content: "# Example project\nA local-first task API. This is sample context, not your repository.\nUse Python and FastAPI. Store task IDs, titles and completion status. Include validation and tests." }],
} satisfies ProjectBody);
if (!storage.list("evaluation").length) {
  for (const [name, language] of [["Implement a thread-safe work queue", "C++"], ["Fix async cancellation and add tests", "C#"], ["Build a validated REST endpoint", "Python"], ["Implement an accessible CRUD interface", "Web"]]) {
    storage.create("evaluation", { name, language, candidate: "pending", reference: "pending", note: "" });
  }
}
// Recover interrupted work without executing anything automatically.
for (const run of storage.list("run")) {
  if (["planning", "running", "pausing"].includes(run.status)) {
    const uncertain = (run.gitActions || []).some((a: any) => a.status === "running");
    storage.update(run.id, { ...run, status: "paused", phase: run.phase || (run.status === "planning" ? "planning" : "execution"),
      savedAt: new Date().toISOString(),
      error: uncertain ? "A GitHub action was interrupted; verify its outcome in GitHub before creating another request. Automatic resume is blocked to prevent repeating it." : undefined,
      steps: run.steps.map((s: any) => s.status === "running" ? { ...s, status: "paused" } : s),
      gitActions: run.gitActions?.map((a: any) => a.status === "running" ? { ...a, status: "uncertain" } : a),
      events: [...run.events, { time: new Date().toISOString(), message: "Relay restarted. Saved request and partial outputs restored; choose Resume." }] });
  }
}
