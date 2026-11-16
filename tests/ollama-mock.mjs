import fs from "node:fs";
// Isolated API-contract fixture. This is not a real model or a capability test.
// Serves the Ollama API (/api/tags, /api/chat) and the llama-server OpenAI API (/v1/models, /v1/chat/completions),
// streaming the reply in small pieces. MOCK_DELAY_MS adds a pause between pieces so progress can be observed.
import http from "node:http";
const delay = Number(process.env.MOCK_DELAY_MS || 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let active = 0;
http.createServer(async (req, res) => {
  if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qa-fixture:1b" }] }));
  if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "qa-fixture:1b" }] }));
  if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [] }));
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const openai = req.url === "/v1/chat/completions";
  if (active > 0) { res.writeHead(429); return res.end(JSON.stringify({ error: "Calls were not sequential" })); }
  if (!body.messages?.[0]?.content || !body.messages?.[1]?.content || (!openai && body.keep_alive === undefined) || !body.stream) {
    res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid adapter contract" }));
  }
  active++;
  const planning = body.messages[1].content.includes("Return ONLY JSON");
  // Optional test hooks: MOCK_LOG records prompts; MOCK_PLAN replaces the plan; MOCK_CHANGES is the coder's reply.
  if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ system: body.messages[0].content, user: body.messages[1].content }) + "\n");
  const coder = body.messages[1].content.includes("ASSIGNED STEP:\nDraft code");
  const content = planning
    ? "Plan: " + (process.env.MOCK_PLAN ? fs.readFileSync(process.env.MOCK_PLAN, "utf8") : JSON.stringify({ steps: [{ role: "coder", title: "Draft code" }, { role: "tester", title: "Propose tests" }, { role: "analyst", title: "Review" }] }))
    : coder && process.env.MOCK_CHANGES ? fs.readFileSync(process.env.MOCK_CHANGES, "utf8")
    : `QA mock output. Prior context present: ${body.messages[1].content.includes("QA mock output")}. No code executed.`;
  const thinking = planning ? "" : "considering the request step by step";
  const pieces = s => s.match(/.{1,6}/gs) || [];
  res.writeHead(200, { "Content-Type": openai ? "text/event-stream" : "application/x-ndjson" });
  const send = o => res.write(openai ? `data: ${JSON.stringify(o)}\n\n` : JSON.stringify(o) + "\n");
  if (openai) { send({ prompt_progress: { total: 100, processed: 50 } }); await sleep(delay); send({ prompt_progress: { total: 100, processed: 100 } }); }
  for (const p of pieces(thinking)) { await sleep(delay); send(openai ? { choices: [{ delta: { reasoning_content: p } }] } : { message: { thinking: p }, done: false }); }
  for (const p of pieces(content)) { await sleep(delay); send(openai ? { choices: [{ delta: { content: p } }] } : { message: { content: p }, done: false }); }
  if (openai) { send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 12 } }); res.write("data: [DONE]\n\n"); }
  else send({ message: { content: "" }, done: true, eval_count: 12 });
  res.end();
  active--;
}).listen(11435, "127.0.0.1");
