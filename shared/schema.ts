import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export type Role = "architect" | "coder" | "tester" | "data" | "analyst";
export type ModelRequest = { url: string; runtime: "openai" | "ollama"; body: Record<string, any>; label: string; timeoutMinutes: number; priorChars: number };
export type RuntimeOptions = { runtime: "openai" | "ollama"; endpoint: string; modelOverride: string; context: number; maxTokens: number; think: boolean; keepAlive: string; timeoutMinutes: number; priorChars: number };
export type Step = { role: Role; title: string; status: "queued" | "running" | "paused" | "complete" | "failed" | "cancelled"; output?: string; tokens?: number; elapsed?: number; modelRequest?: ModelRequest; lastRequest?: ModelRequest };
export type RunBody = { request: string; mode: "demo" | "ollama"; projectId: number | null; projectName: string; status: "planning" | "approval" | "running" | "pausing" | "paused" | "complete" | "failed" | "cancelled"; steps: Step[]; events: { time: string; message: string }[]; createdAt: string; error?: string; context?: string; agents?: Agent[];
  turns?: RunTurn[]; messageAt?: string; title?: string; archived?: boolean;
  connectorSources?: { repo: string; branch: string; path: string; url: string }[];
  route?: "direct" | "plan"; answer?: { text: string; status: "running" | "complete"; tokens?: number; elapsed?: number }; answerRequest?: ModelRequest;
  thinkingSummary?: { text: string; at: string; key: string }; // display only; never part of any prompt
  inventory?: { repo: string; branch: string; commit: string; exts: string[]; total: number; treeFiles: number; partial: boolean; text: string };
  localSources?: { folderId: number; root: string; path: string; kind: "listing" | "file"; bytes?: number }[];
  phase?: "planning" | "execution"; contextReady?: boolean; planningOutput?: string; savedAt?: string;
  plannerRequest?: ModelRequest; progress?: Record<string, any>; projectSnapshot?: Project;
  runtimeOptions?: RuntimeOptions;
  repo?: string; workflow?: "pull_request" | "direct";
  gitActions?: { type: "close_pr" | "reopen_pr" | "merge_pr" | "delete_branch"; number?: number; branch?: string; deleteBranch?: boolean; method?: string; status?: "queued" | "running" | "uncertain" | "complete" | "failed"; result?: string }[];
  research?: { items: { q: string; where: "web" | "docs" | "github" }[]; done?: boolean; sources?: { title: string; url: string; query: string }[] }; webContext?: string;
  applied?: { branch: string; applied: string[]; failed: string[]; problems: string[]; at: string } };
export type Agent = { role: Role | "orchestrator"; name: string; model: string; enabled: boolean; prompt: string };
export type SourceFile = { name: string; content: string };
export type RepoInfo = { fullName: string; owner: string; name: string; branch: string; dir: string; commit: string; indexedAt: string; fileCount: number; totalBytes: number;
  skipped: Record<string, number>; workflow?: "pull_request" | "direct"; activeWorkflow?: "pull_request" | "direct" };
export type ProjectBody = { name: string; description: string; language: string; files: SourceFile[]; sample?: boolean; archived?: boolean; repo?: RepoInfo };
export const records = sqliteTable("records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  data: text("data").notNull(),
});
export const insertRecordSchema = createInsertSchema(records).omit({ id: true });
export type InsertRecord = z.infer<typeof insertRecordSchema>;
export type RecordRow = typeof records.$inferSelect;
export type Run = RunBody & { id: number };
export type RunTurn = Omit<RunBody, "turns">;
export type Project = ProjectBody & { id: number };
export const sourceSchema = z.object({ name: z.string().min(1).max(220), content: z.string().max(80000) });
export const projectSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).default(""), language: z.string().max(50), files: z.array(sourceSchema).max(25).default([]) });
export const agentSchema = z.object({ role: z.enum(["orchestrator", "architect", "coder", "tester", "data", "analyst"]), name: z.string().min(1).max(60), model: z.string().regex(/^[a-zA-Z0-9._:/-]+$/).max(160), enabled: z.boolean(), prompt: z.string().min(10).max(3000) });
export const runInputSchema = z.object({ request: z.string().trim().min(3).max(6000), projectId: z.number().nullable(), mode: z.enum(["demo", "ollama"]), attachments: z.array(z.number().int().positive()).max(20).optional() });
export type FileAsset = { id: number; runId: number | null; projectId: number | null; origin: "generated" | "uploaded"; name: string; size: number; sha256: string; createdAt: string; conversationExists?: boolean };
export type LocalFolder = { id: number; projectId: number; root: string; label: string; addedAt: string };
export type Evaluation = { id: number; name: string; language: string; candidate: "pending" | "pass" | "fail"; reference: "pending" | "pass" | "fail"; note: string };
