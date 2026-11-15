import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-search-test-"));
const bundled = path.join(root, "node_modules/.relay-unit/native-search-test.mjs");
execFileSync(path.join(root, "node_modules/.bin/esbuild"), [
  "server/websearch.ts", "--bundle", "--platform=node", "--format=esm",
  `--outfile=${bundled}`, "--packages=external", "--log-level=error",
]);
process.env.DATA_FILE = path.join(temp, "data.db");
process.env.RELAY_SEARCH_PYTHON ||= "python3";
// Resolve a real absolute interpreter: the wrapper deliberately requires a local executable.
process.env.RELAY_SEARCH_PYTHON = execFileSync(process.env.RELAY_SEARCH_PYTHON, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
process.env.TAVILY_API_KEY = "fixture-token-never-pass-to-worker";
process.env.GITHUB_TOKEN = "fixture-token-never-pass-to-worker";
process.chdir(temp);
try {
  fs.mkdirSync("setup");
  fs.mkdirSync("tools/search", { recursive: true });
  fs.copyFileSync(path.join(root, "tests/search-fixture.py"), "setup/search-worker.py");
  const ws = await import(bundled);
  assert.equal(ws.getSettings().provider, "builtin");
  assert.equal(ws.searchEnabled(), false);
  await assert.rejects(() => ws.search("python paths"), /not installed/);
  fs.writeFileSync("tools/search/relay-ready", "9.16.1\n");
  assert.equal(ws.searchEnabled(), true);
  fs.writeFileSync("search-settings.json", JSON.stringify({ provider: "searxng", searxng: "http://localhost:8888" }));
  assert.equal(ws.getSettings().provider, "builtin");
  assert.equal(ws.getSettings().searxng, "http://localhost:8888");
  fs.writeFileSync("search-settings.json", '{"provider":"off"}');
  assert.equal(ws.getSettings().provider, "off");
  const routes = new Map();
  ws.registerSearchRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  let saved;
  routes.get("/api/search/settings")({ body: { provider: "builtin" } }, { json: x => saved = x, status: () => { throw Error("Unexpected route failure"); } });
  assert.equal(saved.provider, "builtin");
  assert.equal(JSON.parse(fs.readFileSync("search-settings.json")).version, 2);
  const query = 'Python пути "$(echo injected)"';
  const hits = await ws.search(query, { sites: ["docs.python.org"], max: 3 });
  assert.equal(hits.length, 1); assert.equal(hits[0].title, query);
  // Cache avoids invoking a worker that was removed after the first request.
  fs.renameSync("setup/search-worker.py", "setup/worker-away.py");
  // Readiness is intentionally checked before cache reuse.
  await assert.rejects(() => ws.search(query), /not installed/);
  fs.renameSync("setup/worker-away.py", "setup/search-worker.py");
  assert.deepEqual(await ws.search(query, { sites: ["docs.python.org"], max: 3 }), hits);
  await assert.rejects(() => ws.search("bad json"), /JSON|Unexpected/);
  await assert.rejects(() => ws.search("engine failure"), /Fixture blocked/);
  await assert.rejects(() => ws.search("oversized"), /too much data/);
  await assert.rejects(() => ws.search("x"), /3-400/);
  let reply;
  await routes.get("/api/search/test")({ body: { query: "public documentation" } }, { json: x => reply = x, status: () => { throw Error("Unexpected test failure"); } });
  assert.equal(reply.results[0].title, "public documentation");
  fs.writeFileSync("search-settings.json", '{"version":2,"provider":"searxng","searxng":"http://localhost:8888"}');
  assert.equal(ws.getSettings().provider, "searxng");
  console.log("PASS: default/migration/Off, installed state, settings/test routes, UTF-8 stdin, token isolation, URL/domain filtering, cache, invalid output, engine failure, output cap, query validation.");
} finally {
  process.chdir(root);
  fs.rmSync(temp, { recursive: true, force: true });
}
