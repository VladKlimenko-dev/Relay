// "List all MD files" for a GitHub repository URL or the linked repository: real read-only tree listing from the
// backend (mock GitHub), not a model plan. Covers nested .md/.MD, truncated trees, 404, token handling and URL parsing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFileSync } from "node:child_process";
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inventory-"));

// ---- unit: URL parsing and intent
const bundle = path.join(root, "node_modules/.relay-unit/inventory.mjs");
execFileSync(path.join(root, "node_modules/.bin/esbuild"), ["server/repoInventory.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=error"]);
const { parseGitHubUrl, inventoryIntent, inventoryTarget } = await import(bundle);
const REQUEST = "Check the repo at web address https://github.com/VladKlimenko-dev/parametric3d-rep and list all MD-files.";
assert.deepEqual(parseGitHubUrl(REQUEST), { owner: "VladKlimenko-dev", repo: "parametric3d-rep" });
assert.deepEqual(parseGitHubUrl("see [repo](https://github.com/a/b.git)."), { owner: "a", repo: "b" });
assert.deepEqual(parseGitHubUrl("<https://github.com/a/b/tree/dev>"), { owner: "a", repo: "b", branch: "dev" });
for (const bad of ["https://evilgithub.com/a/b", "https://github.com.evil.io/a/b", "https://x.github.com/a/b", "http://127.0.0.1/a/b"]) assert.equal(parseGitHubUrl(bad), null, bad);
assert.deepEqual(inventoryIntent(REQUEST), ["md"]);
assert.deepEqual(inventoryIntent("Show all *.cs and .md files"), ["cs", "md"]);
assert.deepEqual(inventoryIntent("List all files"), []);
assert.equal(inventoryIntent("Fix the README and list changed files"), null, "write requests keep the normal plan");
assert.equal(inventoryIntent("Explain the parser"), null);
assert.equal(inventoryTarget("List all md files", null), null, "no URL and no linked repo -> normal path");

// ---- mock GitHub API
const calls = [];
const trees = {
  "VladKlimenko-dev/parametric3d-rep": { branch: "main", sha: "c0ffee1234567890", tree: [
    { path: "README.md", type: "blob" }, { path: "docs", type: "tree", sha: "d1" }, { path: "docs/Guide.MD", type: "blob" },
    { path: "docs/deep/nested/notes.md", type: "blob" }, { path: "src/kernel.cs", type: "blob" }, { path: "src/md.txt", type: "blob" },
    { path: "CHANGELOG.markdown", type: "blob" }, { path: "a.mdx", type: "blob" }] },
  "someone/other": { branch: "dev", sha: "beef000011112222", truncated: true, root: [
    { path: "TOP.md", type: "blob" }, { path: "sub", type: "tree", sha: "sub1" }, { path: "lib", type: "commit" }],
    sub: [{ path: "inner.Md", type: "blob" }, { path: "x.js", type: "blob" }] },
};
const gh = http.createServer((req, res) => {
  calls.push({ url: req.url, auth: req.headers.authorization || "" });
  const json = (status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)(.*)$/); const repo = m && trees[`${m[1]}/${m[2]}`];
  if (m?.[1] === "limited") return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" });
  if (!repo) return json(404, { message: "Not Found" });
  const rest = m[3];
  if (rest === "") return json(200, { full_name: `${m[1]}/${m[2]}`, default_branch: repo.branch, private: false });
  if (rest.startsWith("/branches/")) return json(200, { commit: { sha: repo.sha, commit: { tree: { sha: "root" } } } });
  if (rest === "/git/trees/root?recursive=1") return repo.truncated ? json(200, { tree: [], truncated: true }) : json(200, { tree: repo.tree, truncated: false });
  if (rest === "/git/trees/root") return json(200, { tree: repo.root, truncated: false });
  if (rest === "/git/trees/sub1") return json(200, { tree: repo.sub, truncated: false });
  json(404, { message: "Not Found" });
});
await new Promise(r => gh.listen(0, "127.0.0.1", r));
// model fixture: the inventory request must never reach it
const prompts = [];
const model = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") return res.end('{"data":[{"id":"fixture"}]}');
  let raw = ""; for await (const c of req) raw += c; prompts.push(raw);
  const user = JSON.parse(raw).messages.find(m => m.role === "user").content;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = content => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  if (user.includes("Return ONLY JSON")) send(JSON.stringify(user.includes("What does B-rep mean") ? { route: "direct", steps: [] }
    : user.includes("Implement a STEP parser") ? { route: "plan", steps: [{ role: "coder", title: "Implement the parser" }, { role: "tester", title: "Write tests" }] }
    : { steps: [{ role: "architect", title: "Define the plan" }] }));
  else if (user.startsWith("USER MESSAGE:")) { send("B-rep means "); send("boundary representation."); }
  else send("SPECIALIST OUTPUT");
  res.end("data: [DONE]\n\n");
});
await new Promise(r => model.listen(0, "127.0.0.1", r));

// project 1 is linked to a different repository
const db = new DatabaseSync(path.join(temp, "data.db"));
db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL)");
const linked = { fullName: "someone/other", owner: "someone", name: "other", branch: "dev", dir: path.join(temp, "ws"), commit: "old", indexedAt: "2026-01-01T00:00:00Z", fileCount: 0, totalBytes: 0, skipped: [] };
db.prepare("INSERT INTO records(kind,data) VALUES(?,?)").run("project", JSON.stringify({ name: "Linked", language: "Mixed", description: "", files: [], repo: linked }));
db.close();
fs.mkdirSync(path.join(temp, "secrets"), { recursive: true });

const port = 15531, base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DATA_FILE: path.join(temp, "data.db"), RELAY_SECRETS_DIR: path.join(temp, "secrets"),
  RELAY_WORKSPACE: path.join(temp, "ws"), GITHUB_API: `http://127.0.0.1:${gh.address().port}`, RELAY_RUNTIME: "openai", OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, RELAY_THINK: "0" };
let server, log = "";
const wait = async (check, label) => { const until = Date.now() + 15000; while (Date.now() < until) { const r = await check(); if (r) return r; await new Promise(r => setTimeout(r, 40)); } throw Error(`Timeout: ${label}\n${log}`); };
const call = async (route, body) => { const r = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data = text; try { data = JSON.parse(text); } catch { } return { status: r.status, data }; };
const settle = id => wait(async () => { const r = (await call(`/api/runs/${id}`)).data; return ["complete", "failed", "approval"].includes(r.status) && r; }, `run ${id}`);
try {
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", b => log += b); server.stderr.on("data", b => log += b);
  await wait(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "start");
  const projects = (await call("/api/projects")).data;
  const general = { id: null }, linkedProject = projects.find(p => p.repo);

  // 1) exact request, project without a repository, public access (no token saved)
  const run = (await call("/api/runs", { request: REQUEST, mode: "ollama", projectId: general.id })).data;
  const done = await settle(run.id);
  assert.equal(done.status, "complete", done.error); assert.equal(done.steps.length, 0, "no specialist plan");
  assert.equal(prompts.length, 0, "the model was not asked to plan a listing");
  assert.deepEqual(done.inventory.text.match(/`[^`]+\.(md|MD|markdown)`/g).map(s => s.slice(1, -1)), ["docs/deep/nested/notes.md", "docs/Guide.MD", "README.md"]);
  assert.equal(done.inventory.total, 3); assert.equal(done.inventory.treeFiles, 7); assert.equal(done.inventory.partial, false);
  assert.match(done.inventory.text, /Branch: `main` \(default\) at commit `c0ffee123456`/);
  assert.match(done.inventory.text, /Complete listing/); assert.doesNotMatch(done.inventory.text, /`src\/kernel\.cs`|`src\/md\.txt`|`a\.mdx`|CHANGELOG/);
  assert.equal(done.connectorSources.length, 1); assert.match(done.connectorSources[0].url, /parametric3d-rep\/tree\/c0ffee/);
  const files = (await call(`/api/files?runId=${run.id}`)).data;
  assert.equal(files.length, 1); assert.equal(files[0].origin, "generated");
  assert.equal((await call(`/api/files/${files[0].id}/download`)).data.trim().split("\n").slice(2).join(","), "docs/deep/nested/notes.md,docs/Guide.MD,README.md");
  assert.ok(calls.every(c => c.auth === ""), "no token -> unauthenticated public request");

  // 2) same request in a project linked to another repo: the URL wins, the link is untouched
  fs.writeFileSync(path.join(temp, "secrets", "github-token.secret"), "ghp_fixturetoken000000000000000000");
  calls.length = 0;
  const other = (await call("/api/runs", { request: REQUEST, mode: "ollama", projectId: linkedProject.id })).data;
  const otherDone = await settle(other.id);
  assert.equal(otherDone.inventory.repo, "VladKlimenko-dev/parametric3d-rep");
  assert.ok(calls.every(c => c.url.startsWith("/repos/VladKlimenko-dev/parametric3d-rep")));
  assert.deepEqual((await call("/api/projects")).data.find(p => p.id === linkedProject.id).repo, linked, "project link not changed");

  // 3) follow-up in the same conversation without a URL -> linked repo, linked branch, truncated tree walked
  const follow = await call(`/api/runs/${other.id}/messages`, { request: "Now list all MD files in the linked repository", expectedTurn: 0 });
  assert.equal(follow.status, 202, JSON.stringify(follow.data));
  const f = await settle(other.id);
  assert.equal(f.id, other.id); assert.equal(f.inventory.repo, "someone/other"); assert.equal(f.inventory.branch, "dev");
  assert.match(f.inventory.text, /`sub\/inner\.Md`/); assert.match(f.inventory.text, /`TOP\.md`/); assert.equal(f.inventory.total, 2);
  assert.match(f.inventory.text, /1 submodule/); assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].inventory.repo, "VladKlimenko-dev/parametric3d-rep", "prior source history kept");
  assert.ok(calls.some(c => c.url === "/repos/someone/other/git/trees/sub1"), "walked directory after truncation");

  // 4) inaccessible repository and rate limit: real GitHub errors, not "no internet"
  const missing = await settle((await call("/api/runs", { request: "List all MD files in https://github.com/ghost/private-repo", mode: "ollama", projectId: general.id })).data.id);
  assert.equal(missing.status, "failed"); assert.match(missing.error, /GitHub 404.*not accessible with the saved GitHub token/);
  const limited = await settle((await call("/api/runs", { request: "List all .md files in github.com/limited/repo", mode: "ollama", projectId: general.id })).data.id);
  assert.match(limited.error, /rate limit/);
  assert.equal(prompts.length, 0);

  // 5) non-GitHub host is never contacted and goes through the normal model path
  calls.length = 0;
  const evil = await settle((await call("/api/runs", { request: "List all MD files in https://evilgithub.com/a/b", mode: "ollama", projectId: general.id })).data.id);
  assert.equal(evil.status, "approval"); assert.equal(calls.length, 0); assert.equal(evil.inventory, undefined);
  assert.match(prompts[0], /Relay's backend may supply verified data/); assert.doesNotMatch(prompts[0], /proposal-only environment/);
  // 6) routing: simple question -> one direct answer, zero specialist calls, no approval
  prompts.length = 0;
  const q = (await call("/api/runs", { request: "What does B-rep mean in CAD?", mode: "ollama", projectId: null })).data;
  const qa = await wait(async () => { const r = (await call(`/api/runs/${q.id}`)).data; return ["complete", "failed", "approval"].includes(r.status) && r; }, "direct");
  assert.equal(qa.status, "complete", qa.error); assert.equal(qa.route, "direct"); assert.equal(qa.steps.length, 0);
  assert.equal(qa.answer.text, "B-rep means boundary representation."); assert.equal(qa.answer.status, "complete");
  assert.equal(prompts.length, 2, "planner route + one answer"); assert.ok(!prompts.some(p => p.includes("ASSIGNED STEP")), "no specialist call");
  assert.ok((await call(`/api/files?runId=${q.id}`)).data.some(f => f.name.endsWith("-answer.md")));
  // explicit "answer only" skips even the planner
  prompts.length = 0;
  const only0 = (await call(`/api/runs/${q.id}/messages`, { request: "Explain why this matters, answer only, do not modify files.", expectedTurn: 0 })).data;
  const only = await wait(async () => { const r = (await call(`/api/runs/${only0.id}`)).data; return r.status === "complete" && r.answer?.status === "complete" && r; }, "answer only");
  assert.equal(only.id, q.id); assert.equal(only.turns[0].answer.text, "B-rep means boundary representation.", "history kept");
  assert.equal(prompts.length, 1, "no planner call for an explicit answer-only request"); assert.match(prompts[0], /PREVIOUS CONVERSATION[\s\S]*boundary representation/);
  // real coding request: only the needed specialists, approval still required before anything runs
  prompts.length = 0;
  const code = await settle((await call("/api/runs", { request: "Implement a STEP parser for the kernel with tests.", mode: "ollama", projectId: null })).data.id);
  assert.equal(code.status, "approval"); assert.deepEqual(code.steps.map(s => s.role), ["coder", "tester"]); assert.equal(code.answer, undefined);
  assert.equal(prompts.length, 1, "nothing executed before approval");
  console.log("PASS: exact request listed real nested .md/.MD paths with branch/commit and downloadable file; URL overrides linked project without relinking; linked repo + truncated tree walk on follow-up; 404/rate-limit errors surfaced; non-GitHub hosts ignored; orchestrator routing: simple question = one direct answer with zero specialist calls, answer-only skips the planner, coding request keeps selected specialists and approval.");
} finally {
  if (server?.exitCode === null) server.kill("SIGTERM");
  gh.close(); model.close();
}
