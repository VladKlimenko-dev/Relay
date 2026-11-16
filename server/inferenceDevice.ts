// Which device the RUNNING model server actually uses, from its own startup log. Never inferred from installed hardware.
import fs from "node:fs";
import path from "node:path";

export type InferenceDevice = { state: "confirmed" | "cpu" | "unknown"; devices: string[]; backend: string | null;
  offloaded: string | null; evidence: string; note: string };

export function parseModelLog(text: string) {
  const enumerated: Record<string, string> = {};
  for (const m of text.matchAll(/ggml_vulkan: (\d+) = (.+?) \|/g)) enumerated[`Vulkan${m[1]}`] = m[2].trim();
  for (const m of text.matchAll(/Device (\d+): (.+?), compute capability/g)) enumerated[`CUDA${m[1]}`] = m[2].trim();
  const used = new Map<string, string>();
  for (const m of text.matchAll(/using device (\S+) \((.+?)\)(?: - \d+ MiB free)?\s*$/gm)) used.set(m[1], m[2].trim());
  for (const m of text.matchAll(/\b((?:Vulkan|CUDA|SYCL|ROCm|Metal)\d+) model buffer size\s*=\s*([\d.]+) MiB/g)) {
    if (Number(m[2]) > 0 && !used.has(m[1])) used.set(m[1], enumerated[m[1]] || m[1]);
  }
  const offload = [...text.matchAll(/offloaded (\d+)\/(\d+) layers to GPU/g)].pop();
  return { used: [...used.entries()].map(([id, name]) => ({ id, name })), offloaded: offload ? { done: Number(offload[1]), total: Number(offload[2]) } : null };
}

function readHead(file: string, bytes = 512_000) {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(bytes); const n = fs.readSync(fd, b, 0, bytes, 0); return b.subarray(0, n).toString("utf8"); }
  finally { fs.closeSync(fd); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; } };

export function detectInference(opts: { root: string; connected: boolean; ollamaVram?: { size: number; vram: number } | null }): InferenceDevice {
  const unknown = (note: string, evidence = ""): InferenceDevice => ({ state: "unknown", devices: [], backend: null, offloaded: null, evidence, note });
  if (!opts.connected) return unknown("The model server is not reachable, so no device is in use for inference.");
  const marker = path.join(opts.root, ".relay-model.json"), log = path.join(opts.root, "logs", "model.stderr.log");
  let saved: { pid: number; startedAt: string } | null = null;
  try { saved = JSON.parse(fs.readFileSync(marker, "utf8").replace(/^\uFEFF/, "")); } catch { }
  if (!saved?.pid || !alive(saved.pid)) return unknown("The running model server was not started by start-relay.cmd (or its process record is missing), so its startup log cannot be attributed to it. Device unknown.");
  let stat: fs.Stats;
  try { stat = fs.statSync(log); } catch { return unknown("No model startup log was found (logs\\model.stderr.log). Device unknown."); }
  const started = Date.parse(saved.startedAt);
  if (Number.isFinite(started) && stat.mtimeMs < started - 2000) return unknown("The model log predates the running model process, so it may describe an earlier launch. Device unknown.");
  const parsed = parseModelLog(readHead(log));
  const evidence = `logs/model.stderr.log of model process ${saved.pid} (started ${saved.startedAt})`;
  const offloaded = parsed.offloaded ? `${parsed.offloaded.done}/${parsed.offloaded.total} layers on GPU` : null;
  if (parsed.offloaded?.done === 0) return { state: "cpu", devices: ["CPU"], backend: "CPU", offloaded, evidence, note: "The running model reports 0 layers offloaded: inference runs on the CPU." };
  if (!parsed.used.length) {
    const vram = opts.ollamaVram;
    if (vram && vram.size > 0) return { ...unknown(`Ollama reports ${(vram.vram / 2 ** 30).toFixed(1)} of ${(vram.size / 2 ** 30).toFixed(1)} GiB of the loaded model in GPU memory, but its log does not name the device.`, "Ollama /api/ps"), offloaded };
    return { ...unknown("The model log does not identify an inference device (it may not have loaded a model yet).", evidence), offloaded };
  }
  const backend = [...new Set(parsed.used.map(d => d.id.replace(/\d+$/, "")))].join(" + ");
  return { state: "confirmed", devices: parsed.used.map(d => `${d.name} (${d.id})`), backend, offloaded, evidence,
    note: offloaded && parsed.offloaded!.done < parsed.offloaded!.total ? "Partly offloaded: remaining layers run on the CPU." : "" };
}
