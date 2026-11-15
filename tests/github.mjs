// End-to-end GitHub + web research test against fixtures (local bare repos, a GitHub API mock, a Tavily mock, the model mock).
// Run after `npm run build`: node tests/github.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const T = "/tmp/relay-gh-test", REMOTES = `${T}/remotes`, TOKEN = "ghp_testtoken_1234567890abcdef";
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(`${REMOTES}/vklim`, { recursive: true });
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Seed", GIT_AUTHOR_EMAIL: "seed@x", GIT_COMMITTER_NAME: "Seed", GIT_COMMITTER_EMAIL: "seed@x" } }).trim();

// ---- unit checks (bundled TypeScript) ----
const esb = path.resolve("node_modules/.bin/esbuild");
for (const f of ["intent", "changes", "websearch"]) execFileSync(esb, [`server/${f}.ts`, "--bundle", "--platform=node", "--format=esm", `--outfile=node_modules/.relay-unit/${f}.mjs`, "--packages=external", "--log-level=error"]);
const intent = await import(path.resolve("node_modules/.relay-unit/intent.mjs"));
const W = intent.detectWorkflow;
for (const s of ["Fix the bug, no PR needed", "Don't create an additional pull request, work on the repo itself", "commit directly to main", "Исправь без пулл реквеста", "Не создавай новый PR, работай напрямую", "залей прямо в main"]) assert.equal(W(s), "direct", s);
for (const s of ["Fix it and open a pull request", "Сделай PR с исправлением"]) assert.equal(W(s), "pull_request", s);
assert.equal(W("Refactor the tessellator"), null);
const A = s => intent.detectGitActions(s).map(({ status, ...a }) => a);
assert.deepEqual(A("Delete PR #12"), [{ type: "close_pr", number: 12, deleteBranch: true }]);
assert.deepEqual(A("close pull request 7"), [{ type: "close_pr", number: 7, deleteBranch: false }]);
assert.deepEqual(A("Закрой PR #5 и #6"), [{ type: "close_pr", number: 5, deleteBranch: false }, { type: "close_pr", number: 6, deleteBranch: false }]);
assert.deepEqual(A("удали пулл реквест 9"), [{ type: "close_pr", number: 9, deleteBranch: true }]);
assert.deepEqual(A("squash merge PR #4"), [{ type: "merge_pr", number: 4, method: "squash" }]);
assert.deepEqual(A("reopen PR 3"), [{ type: "reopen_pr", number: 3 }]);
assert.deepEqual(A("delete branch old-feature"), [{ type: "delete_branch", branch: "old-feature" }]);
assert.deepEqual(A("Improve the PR description template"), []);
const ch = await import(path.resolve("node_modules/.relay-unit/changes.mjs"));
const parsed = ch.parseChanges("text\nEDIT: src/a.cpp\n<<<<<<< SEARCH\nint a = 1;\n=======\nint a = 2;\n>>>>>>> REPLACE\nDELETE: old.txt\nRENAME: x.h -> y.h\n");
assert.deepEqual(parsed.changes.map(c => c.op), ["edit", "delete", "rename"]);
assert.throws(() => ch.safeRel("../etc/passwd")); assert.throws(() => ch.safeRel(".git/config")); assert.throws(() => ch.safeRel("a/b<c.txt"));
const ws = await import(path.resolve("node_modules/.relay-unit/websearch.mjs"));
const txt = ws.htmlToText("<html><head><title>T</title><script>x()</script></head><body><nav>menu</nav><h2>Use</h2><p>Call <code>f()</code> &amp; done.</p><pre><span>int</span> x = 1 &lt; 2;</pre></body></html>");
assert.match(txt, /## Use/); assert.match(txt, /`f\(\)` & done/); assert.match(txt, /```\nint x = 1 < 2;\n```/); assert.doesNotMatch(txt, /menu|x\(\)/);
assert.equal(ws.excerpt("alpha\n\nbeta gamma\n\ndelta", "gamma", 12), "beta gamma");
console.log("unit: intent EN/RU, change parsing, path safety, HTML reader, excerpt");

// ---- seed remote: vklim/cadlib (main with CRLF file, plus branch old-feature) ----
const seed = `${T}/seed`; fs.mkdirSync(`${seed}/src`, { recursive: true });
git(T, "init", "-q", "--bare", "-b", "main", `${REMOTES}/vklim/cadlib.git`);
git(seed, "init", "-q", "-b", "main");
fs.writeFileSync(`${seed}/src/geometry.cpp`, "#include \"geometry.h\"\r\n\r\ndouble offsetTolerance() {\r\n    return 1e-6;\r\n}\r\n");
fs.writeFileSync(`${seed}/src/mesh.cs`, "namespace Cad { public class Mesh { public int Triangles; } }\n");
fs.writeFileSync(`${seed}/README.md`, "# cadlib\nGeometry kernel.\n");
fs.writeFileSync(`${seed}/.env`, "SECRET=1\n");
git(seed, "add", "-A"); git(seed, "commit", "-qm", "Initial kernel"); git(seed, "remote", "add", "origin", `${REMOTES}/vklim/cadlib.git`); git(seed, "push", "-q", "origin", "main");
git(seed, "checkout", "-qb", "old-feature"); fs.writeFileSync(`${seed}/old.txt`, "x\n"); git(seed, "add", "-A"); git(seed, "commit", "-qm", "Old"); git(seed, "push", "-q", "origin", "old-feature");

// ---- processes ----
const procs = []; const start = (args, env) => { const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] }); p.stderr.on("data", d => process.stderr.write(d)); procs.push(p); return p; };
process.on("exit", () => procs.forEach(p => p.kill()));
const plan = `${T}/plan.json`, changes = `${T}/changes.txt`, log = `${T}/prompts.ndjson`;
fs.writeFileSync(plan, JSON.stringify({ steps: [{ role: "coder", title: "Draft code" }] }));
start(["tests/github-mock.mjs"], { REMOTES, PORT: "5099" });
start(["tests/ollama-mock.mjs"], { MOCK_PLAN: plan, MOCK_CHANGES: changes, MOCK_LOG: log });
start(["dist/index.cjs"], { NODE_ENV: "production", PORT: "5006", OLLAMA_HOST: "http://127.0.0.1:11435", DATA_FILE: `${T}/data.db`, RELAY_SECRETS_DIR: `${T}/secrets`, RELAY_WORKSPACE: `${T}/workspace`,
  GITHUB_API: "http://127.0.0.1:5099", GITHUB_GIT_BASE: `file://${REMOTES}`, TAVILY_API: "http://127.0.0.1:5099/tavily", GIT_CONFIG_GLOBAL: `${T}/gitconfig` });
fs.writeFileSync(`${T}/gitconfig`, ""); // no global identity: Relay must take it from the GitHub account
const base = "http://127.0.0.1:5006";
const call = async (p, data, method = data === undefined ? "GET" : "POST") => { const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : {} }; };
for (let i = 0; i < 100; i++) { try { if ((await call("/api/runtime")).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body; };
async function runToEnd(request, projectId) {
  let run = ok(await call("/api/runs", { request, projectId, mode: "ollama" }), 202);
  for (let i = 0; i < 200 && run.status === "planning"; i++) {
    await new Promise(r => setTimeout(r, 50));
    run = (await call(`/api/runs/${run.id}`)).body;
  }
  assert.equal(run.status, "approval", run.error || "Plan did not finish");
  ok(await call(`/api/runs/${run.id}/start`, {}));
  for (let i = 0; i < 200; i++) { const r = (await call(`/api/runs/${run.id}`)).body; if (r.status !== "running") return { plan: run, done: r }; await new Promise(r => setTimeout(r, 50)); }
  throw new Error("run did not finish");
}

// sign-in
assert.equal((await call("/api/github/status")).body.connected, false);
assert.equal((await call("/api/github/token", { token: "ghp_wrongtoken_0000000000000" })).status, 401);
assert.equal(ok(await call("/api/github/token", { token: TOKEN })).login, "vklim");
assert.equal(fs.readdirSync(`${T}/secrets`).length, 1);
assert.equal(ok(await call("/api/github/status")).connected, true);
// picker + import + index
const repos = ok(await call("/api/github/repos")); assert.equal(repos[0].fullName, "vklim/cadlib");
assert.deepEqual(ok(await call("/api/github/repos/vklim/cadlib/branches")).sort(), ["main", "old-feature"]);
const project = ok(await call("/api/github/import", { fullName: "vklim/cadlib", branch: "main", description: "Geometry kernel", language: "C++" }), 201);
assert.equal(project.repo.fileCount, 3, "secret .env must not be indexed");
const files = ok(await call(`/api/projects/${project.id}/files`)).files.map(f => f.path).sort();
assert.deepEqual(files, ["README.md", "src/geometry.cpp", "src/mesh.cs"]);
assert.match(ok(await call(`/api/projects/${project.id}/file?path=src/geometry.cpp`)).content, /offsetTolerance/);
assert.equal((await call(`/api/projects/${project.id}/file?path=../../etc/passwd`)).status >= 400, true);

// run 1: pull request workflow; context must contain the relevant file; agent gets the repository guide
fs.writeFileSync(changes, "Done.\nEDIT: src/geometry.cpp\n<<<<<<< SEARCH\n    return 1e-6;\n=======\n    return 1e-9;\n>>>>>>> REPLACE\nFILE: src/offset.h\n```cpp\n#pragma once\ndouble offsetTolerance();\n```\nDELETE: README.md\n");
let { done } = await runToEnd("Tighten offsetTolerance in geometry.cpp", project.id);
assert.equal(done.status, "complete", done.error); assert.equal(done.workflow, "pull_request");
const prompts = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
assert.match(prompts.at(-2).user, /FILE: src\/geometry\.cpp/); // planning prompt has the file
assert.match(prompts.at(-1).system, /Workflow for this run: PULL REQUEST/); assert.match(prompts.at(-1).system, /do not mention Relay, AI/);
const applied = ok(await call(`/api/runs/${done.id}/apply`, {}));
assert.equal(applied.applied.length, 3, JSON.stringify(applied)); assert.match(applied.branch, /^vklim\/\d{12}-/);
const wsDir = `${T}/workspace/vklim/cadlib`;
assert.equal(fs.readFileSync(`${wsDir}/src/geometry.cpp`, "utf8"), "#include \"geometry.h\"\r\n\r\ndouble offsetTolerance() {\r\n    return 1e-9;\r\n}\r\n", "CRLF kept");
let st = ok(await call(`/api/projects/${project.id}/changes`));
assert.equal(st.uncommitted.length, 3); assert.match(st.diff, /\+    return 1e-9;/);
assert.equal((await call(`/api/projects/${project.id}/push`, {})).status, 409, "push with uncommitted changes is refused");
ok(await call(`/api/projects/${project.id}/commit`, { message: "Tighten offset tolerance\n\nThe old value merged distinct vertices." }));
const author = git(wsDir, "log", "-1", "--format=%an <%ae>|%B");
assert.equal(author.split("|")[0], "Vladislav Klimenko <42+vklim@users.noreply.github.com>");
assert.doesNotMatch(author, /Relay|Perplexity|Co-authored|AI/i);
ok(await call(`/api/projects/${project.id}/push`, {}));
assert.ok(git(`${REMOTES}/vklim/cadlib.git`, "branch", "--list", applied.branch));
assert.equal(git(`${REMOTES}/vklim/cadlib.git`, "rev-parse", "main"), git(seed, "rev-parse", "main"), "main untouched in PR workflow");
const pr = ok(await call(`/api/projects/${project.id}/pull-request`, { title: "Tighten offset tolerance", body: "Lower tolerance.", draft: false }));
let state = (await (await fetch("http://127.0.0.1:5099/_state")).json());
assert.equal(state.pulls[0].body, "Lower tolerance.", "PR body exactly as the user wrote it");
const act = ok(await call(`/api/projects/${project.id}/activity`)); assert.equal(act.pulls[0].number, pr.number); assert.ok(act.pulls[0].files.includes("src/geometry.cpp"));
ok(await call(`/api/projects/${project.id}/discard`, {})); // back to main; pushed branch stays
assert.equal(ok(await call(`/api/projects/${project.id}/changes`)).branch, "main");

// run 2: "delete PR" from chat = close + delete branch, no agent steps needed
fs.writeFileSync(plan, JSON.stringify({ steps: [], git_actions: [] }));
({ done } = await runToEnd(`Delete PR #${pr.number}`, project.id));
assert.equal(done.status, "complete", done.error); assert.equal(done.steps.length, 0);
assert.equal(done.gitActions[0].status, "complete"); assert.match(done.gitActions[0].result, /closed, branch .* deleted/);
assert.equal(git(`${REMOTES}/vklim/cadlib.git`, "branch", "--list", applied.branch), "");
state = await (await fetch("http://127.0.0.1:5099/_state")).json(); assert.equal(state.pulls[0].state, "closed");
assert.equal((await call(`/api/projects/${project.id}/pulls/${pr.number}/reopen`, {})).status, 200);
assert.equal((await call(`/api/projects/${project.id}/pulls/${pr.number}/merge`, { method: "squash" })).status, 200);

// run 3: direct workflow from the request + web research with sources
ok(await call("/api/search/settings", { provider: "tavily", tavilyKey: "tvly-test-key-123456" }));
assert.equal(ok(await call("/api/search/status")).enabled, true);
assert.match(ok(await call("/api/search/test", { query: "std::filesystem::path" })).results[0].url, /cppreference/);
fs.writeFileSync(plan, JSON.stringify({ steps: [{ role: "coder", title: "Draft code" }], research: [{ q: "std::filesystem::path windows", where: "docs" }, { q: "offset curve", where: "github" }] }));
fs.writeFileSync(changes, "EDIT: src/mesh.cs\n<<<<<<< SEARCH\npublic int Triangles;\n=======\npublic int Triangles; public int Vertices;\n>>>>>>> REPLACE\n");
({ done } = await runToEnd("Add a Vertices counter to Mesh. Don't create a pull request, commit directly to main.", project.id));
assert.equal(done.status, "complete", done.error); assert.equal(done.workflow, "direct");
assert.equal(done.research.done, true); assert.ok(done.research.sources.some(s => /cppreference/.test(s.url))); assert.ok(done.research.sources.some(s => /octo\/geom/.test(s.title)));
const last = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).at(-1);
assert.match(last.user, /WEB RESEARCH/); assert.match(last.user, /Domains: en\.cppreference\.com/); assert.match(last.user, /offset curve example/); assert.match(last.system, /Workflow for this run: DIRECT/);
assert.equal("webContext" in done, false);
const a3 = ok(await call(`/api/runs/${done.id}/apply`, {})); assert.equal(a3.branch, "main");
ok(await call(`/api/projects/${project.id}/commit`, { message: "Count mesh vertices" }));
// someone pushed to main meanwhile: Relay rebases, never forces
git(seed, "checkout", "-q", "main"); fs.writeFileSync(`${seed}/NOTES.md`, "n\n"); git(seed, "add", "-A"); git(seed, "commit", "-qm", "Notes"); git(seed, "push", "-q", "origin", "main");
const pushed = ok(await call(`/api/projects/${project.id}/push`, {}));
assert.equal(pushed.rebased, true);
assert.equal(git(`${REMOTES}/vklim/cadlib.git`, "log", "-2", "--format=%s", "main"), "Count mesh vertices\nNotes");
// file editing, upload, delete through the UI endpoints (direct mode stays on main)
ok(await call(`/api/projects/${project.id}/workflow`, { workflow: "direct" }, "PATCH"));
ok(await call(`/api/projects/${project.id}/file`, { path: "docs/usage.md", content: "# Usage\n" }, "PUT"));
ok(await call(`/api/projects/${project.id}/upload`, { folder: "assets", files: [{ name: "logo.bin", base64: Buffer.from([0, 1, 2]).toString("base64") }] }));
ok(await call(`/api/projects/${project.id}/file?path=README.md`, undefined, "DELETE"));
st = ok(await call(`/api/projects/${project.id}/changes`)); assert.ok(st.uncommitted.some(f => f.path === "docs/usage.md") && st.uncommitted.some(f => f.path === "assets/logo.bin") && st.uncommitted.some(f => f.path === "README.md" && f.status === "D"));
ok(await call(`/api/projects/${project.id}/discard`, {}));
assert.equal(ok(await call(`/api/projects/${project.id}/changes`)).uncommitted.length, 0);
// delete a branch from chat; the default branch is protected
fs.writeFileSync(plan, JSON.stringify({ steps: [], git_actions: [{ type: "delete_branch", branch: "main" }] }));
({ done } = await runToEnd("delete branch old-feature", project.id));
assert.equal(done.status, "failed", "model-proposed deletion of main must fail"); assert.match(done.error, /default branch/);
assert.equal(git(`${REMOTES}/vklim/cadlib.git`, "branch", "--list", "old-feature"), "", "old-feature deleted first");
assert.ok(git(`${REMOTES}/vklim/cadlib.git`, "branch", "--list", "main"));
// sign-out removes the stored token
ok(await call("/api/github/token", undefined, "DELETE")); assert.deepEqual(fs.readdirSync(`${T}/secrets`).filter(f => f.startsWith("github")), []);
console.log("PASS: GitHub sign-in, repository picker, import and index (secrets skipped), relevant-file context, repository guide, change apply with CRLF, commit as the GitHub user without AI marks, push to a working branch, pull request, close + delete branch from chat, reopen, merge, direct workflow from the request with rebase (no force), file edit/upload/discard, default-branch protection, web research (docs + GitHub code) with sources, token removal. Fixtures only: not real GitHub or Tavily.");
process.exit(0);
