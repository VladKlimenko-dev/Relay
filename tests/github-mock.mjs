// Test fixture: a small GitHub REST API (backed by local bare repositories) and a Tavily search API.
// Not GitHub. Usage: REMOTES=/tmp/gh-remotes PORT=5099 node tests/github-mock.mjs
import http from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";

const REMOTES = process.env.REMOTES || "/tmp/gh-remotes";
const TOKEN = process.env.MOCK_TOKEN || "ghp_testtoken_1234567890abcdef";
const TAVILY_KEY = "tvly-test-key-123456";
const user = { login: "vklim", id: 42, name: "Vladislav Klimenko" };
const pulls = []; const calls = [];
const bare = (o, r) => path.join(REMOTES, o, `${r}.git`);
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const branches = (o, r) => git(bare(o, r), "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);
const prJson = (o, r, p) => ({ number: p.number, title: p.title, body: p.body, draft: p.draft, state: p.state, merged_at: p.merged ? "2026-11-15T00:00:00Z" : null, user: { login: user.login },
  head: { ref: p.head, repo: { full_name: `${o}/${r}` } }, base: { ref: p.base }, html_url: `https://github.com/${o}/${r}/pull/${p.number}`, updated_at: "2026-11-15T00:00:00Z" });

http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, "http://x"); const p = url.pathname;
  const send = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(data === undefined ? "" : JSON.stringify(data)); };
  calls.push(`${req.method} ${p}`);
  if (p === "/_state") return send(200, { pulls, calls });
  if (p === "/tavily/search") {
    if (req.headers.authorization !== `Bearer ${TAVILY_KEY}`) return send(401, { detail: { error: "Unauthorized" } });
    return send(200, { results: [
      { title: "std::filesystem::path - cppreference.com", url: "https://en.cppreference.com/w/cpp/filesystem/path", content: "Objects of type path represent paths on a filesystem.", raw_content: `# std::filesystem::path\n\nObjects of type path represent paths on a filesystem. Query: ${body.query}\n\n\`\`\`cpp\nstd::filesystem::path p{"C:\\\\data"};\n\`\`\`\n\nUnrelated paragraph about something else entirely.` },
      { title: "Second result", url: "https://example.org/b", content: "snippet two", raw_content: `Domains: ${(body.include_domains || []).join(",") || "any"}` },
    ] });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Bad credentials" });
  if (p === "/user") return send(200, user);
  if (p === "/user/repos") return send(200, url.searchParams.get("page") === "1" ? [{ full_name: "vklim/cadlib", private: true, default_branch: "main", description: "Geometry kernel", language: "C++", pushed_at: "2026-11-14T00:00:00Z", size: 10 }] : []);
  if (p === "/search/code") return send(200, { items: [{ repository: { full_name: "octo/geom" }, path: "src/offset.cpp", html_url: "https://github.com/octo/geom/blob/main/src/offset.cpp" }] });
  if (p === "/repos/octo/geom/contents/src/offset.cpp") return send(200, { encoding: "base64", content: Buffer.from("// offset curve example\nint offset() { return 1; }\n").toString("base64") });
  let m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return send(404, { message: "Not Found" });
  const [, o, r, rest = ""] = m;
  if (o !== "vklim" || r !== "cadlib") return send(404, { message: "Not Found" });
  if (rest === "" ) return send(200, { full_name: `${o}/${r}`, default_branch: "main" });
  if (rest === "/branches") return send(200, url.searchParams.get("page") === "1" ? branches(o, r).map(name => ({ name })) : []);
  if (rest === "/pulls" && req.method === "GET") return send(200, pulls.filter(x => x.state === "open").map(x => prJson(o, r, x)));
  if (rest === "/pulls" && req.method === "POST") {
    if (!branches(o, r).includes(body.head)) return send(422, { message: "Validation Failed", errors: [{ message: `No commits between main and ${body.head}` }] });
    const pr = { number: pulls.length + 11, title: body.title, body: body.body, draft: !!body.draft, head: body.head, base: body.base, state: "open", merged: false };
    pulls.push(pr); return send(201, prJson(o, r, pr));
  }
  if ((m = rest.match(/^\/pulls\/(\d+)(\/files|\/merge)?$/))) {
    const pr = pulls.find(x => x.number === Number(m[1])); if (!pr) return send(404, { message: "Not Found" });
    if (m[2] === "/files") return send(200, git(bare(o, r), "diff", "--name-only", `${pr.base}...${pr.head}`).split("\n").filter(Boolean).map(filename => ({ filename })));
    if (m[2] === "/merge") { if (pr.state !== "open") return send(405, { message: "Pull Request is not mergeable" }); pr.merged = true; pr.state = "closed"; pr.mergeMethod = body.merge_method; return send(200, { merged: true, sha: "abcdef1234567" }); }
    if (req.method === "PATCH") { if (body.state === "open" && pr.merged) return send(422, { message: "merged pull requests cannot be reopened" }); pr.state = body.state; return send(200, prJson(o, r, pr)); }
    return send(200, prJson(o, r, pr));
  }
  if ((m = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && req.method === "DELETE") {
    const b = decodeURIComponent(m[1]); if (!branches(o, r).includes(b)) return send(422, { message: "Reference does not exist" });
    git(bare(o, r), "update-ref", "-d", `refs/heads/${b}`); return send(204);
  }
  send(404, { message: "Not Found" });
}).listen(Number(process.env.PORT || 5099), "127.0.0.1");
