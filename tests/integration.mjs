import assert from "node:assert/strict";
const base = "http://127.0.0.1:5001";
async function call(path, data, method = "POST") {
  const res = await fetch(base + path, {method:data === undefined ? "GET" : method, headers:{"Content-Type":"application/json"}, ...(data === undefined ? {} : {body:JSON.stringify(data)})});
  const body = await res.json(); return {status:res.status, body};
}
assert.equal((await call("/api/runtime")).body.connected, true);
const bad = await call("/api/runs", {request:"x", projectId:null, mode:"demo"});
assert.equal(bad.status,400);
const secret = await call("/api/projects",{name:"Invalid",language:"Python",files:[{name:"credentials.json",content:"not a secret"}]});
assert.equal(secret.status,400);
const create = await call("/api/runs",{request:"Write a tested addition function.",projectId:null,mode:"ollama"});
assert.equal(create.status,201); assert.equal(create.body.status,"approval"); assert.equal(create.body.steps.length,3);
assert.equal("context" in create.body,false); assert.equal("agents" in create.body,false);
const id=create.body.id;
assert.equal((await call(`/api/runs/${id}/start`,{})).status,200);
let result;
for (let i=0;i<100;i++){
  result=(await call(`/api/runs/${id}`)).body;
  if (result.status !== "running") break;
  await new Promise(r=>setTimeout(r,50));
}
assert.equal(result.status,"complete");
assert.equal(result.steps.every(s=>s.status === "complete"),true);
assert.match(result.steps[1].output,/Prior context present: true/);
assert.equal(result.steps.reduce((n,s)=>n+s.tokens,0),36);
assert.equal((await call(`/api/runs/${id}/start`,{})).status,409);
assert.equal((await call(`/api/runs/${id}/cancel`,{})).status,409);
const demo = (await call("/api/runs",{request:"Test cancellation.",projectId:null,mode:"demo"})).body;
await call(`/api/runs/${demo.id}/start`,{});
assert.equal((await call("/api/runs",{request:"Concurrent run rejected.",projectId:null,mode:"demo"})).status,409);
await call(`/api/runs/${demo.id}/cancel`,{});
assert.equal((await call(`/api/runs/${demo.id}`)).body.status,"cancelled");
console.log("PASS: validation, sensitive filename rejection, local adapter protocol, plan approval, sequential context handoff, token counts, output redaction, terminal-state guards, cancellation and concurrency limit. Mock only; no real model benchmark.");
