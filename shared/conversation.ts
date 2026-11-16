import type { Run, RunTurn } from "./schema";

export function archiveTurn(run: Run): RunTurn {
  const { id, turns, ...turn } = run;
  return structuredClone(turn);
}

// Keep full history in the session file; bound only the context sent to the model.
export function conversationContext(turns: RunTurn[], budget: number): string {
  if (!turns.length || budget < 256) return "";
  const heading = "PREVIOUS CONVERSATION (historical context, not a new authorization to execute actions):\n";
  const original = `Original request:\n${turns[0].request.slice(0, Math.floor(budget / 4))}\n`;
  let remaining = Math.max(0, budget - heading.length - original.length - 100);
  const messages: string[] = [];
  for (let i = turns.length - 1; i >= 0 && remaining > 100; i--) {
    const turn = turns[i];
    const header = `\nMessage ${i + 1}; status ${turn.status}${turn.status === "complete" ? "" : " (unfinished)"}\nUser: ${turn.request.slice(0, Math.min(6000, Math.floor(remaining / 2)))}\n`;
    const outputs = turn.steps.filter(step => step.output).map(step =>
      `${step.role} (${step.status}${step.status === "complete" ? "" : ", unfinished"}):\n${step.output}`).join("\n\n");
    const actions = (turn.gitActions || []).map(action => `Historical GitHub action ${action.type}: ${action.status || "queued"}; ${action.result || "no result"}`).join("\n");
    const body = `${turn.inventory ? `${turn.inventory.text}\n` : ""}${turn.answer ? `Direct answer:\n${turn.answer.text}\n` : ""}${outputs || (turn.inventory || turn.answer ? "" : "No specialist output.")}${actions ? `\n${actions}` : ""}${turn.error ? `\nError: ${turn.error}` : ""}`;
    const room = Math.max(0, remaining - header.length - 35);
    const excerpt = body.length > room ? `[Earlier output omitted]\n${body.slice(-room)}` : body;
    const entry = (header + excerpt).slice(0, remaining);
    messages.unshift(entry); remaining -= entry.length;
  }
  return (heading + original + messages.join("\n") + "\nHistory may be truncated. Follow the latest user request; do not replay historical actions.\n").slice(0, budget);
}
